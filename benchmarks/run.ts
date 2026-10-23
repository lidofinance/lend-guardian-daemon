// Benchmark runner. Every measured run starts a fresh child process, so heap, garbage collection and
// peak RSS belong to that run alone, and a crash or an out-of-memory stops only that run. Results go
// to a new directory under benchmarks/results/ and are never overwritten. The runner runs no Git
// command; pass the measured revision with --commit or BENCHMARK_COMMIT.
//
//   node benchmarks/run.ts --preset smoke
//   node benchmarks/run.ts --preset full --commit <revision> [--filter <text>] [--repeat 5] [--warmup 2]
//   node benchmarks/run.ts --profile --from <results.json> | --profile --preset full --scenario <id>

import { fork } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_SERVER_MAX_OLD_SPACE_MB } from './chain-client.ts';
import { isPassing, markdownSummary, parseRunReport, summarizeMetrics } from './metrics.ts';
import type { RunReport, SummaryRow } from './metrics.ts';
import { profileTargetsOf } from './profiles.ts';
import type { ProfileSelection } from './profiles.ts';
import { presetNamed } from './scenarios.ts';
import type { Preset, Scenario } from './scenarios.ts';

const CHILD = new URL('./child.ts', import.meta.url);

const DEFAULT_OUTPUT = fileURLToPath(new URL('./results/', import.meta.url));

interface Options {
  readonly preset: string;
  readonly filter: string | undefined;
  readonly repeat: number | undefined;
  readonly warmup: number | undefined;
  readonly commit: string;
  readonly output: string;
  readonly timeoutMs: number;
  readonly maxOldSpaceMb: number;
  readonly serverMaxOldSpaceMb: number;
  /** Re-run chosen scenarios once with CPU and heap profiling instead of measuring a preset. */
  readonly profile: boolean;
  readonly from: string | undefined;
  readonly scenarios: readonly string[];
}

type RunResult =
  | { readonly status: 'measured'; readonly report: RunReport }
  | { readonly status: 'failed'; readonly reason: string };

interface ScenarioRecord {
  readonly id: string;
  readonly family: string;
  readonly realTimeScale: number;
  readonly parameters: Scenario['parameters'];
  readonly runs: readonly RunResult[];
}

async function main(): Promise<void> {
  const options = parseOptions();
  await (options.profile ? profile(options) : measurePreset(options));
}

/** Measure every selected scenario of the preset and write the results and summary. */
async function measurePreset(options: Options): Promise<void> {
  const preset = presetNamed(options.preset);
  const filter = options.filter;
  const scenarios = preset.scenarios.filter((scenario) => filter === undefined || scenario.id.includes(filter));
  const directory = await resultDirectory(options.output, preset.name);
  const startedAt = new Date().toISOString();
  const records: ScenarioRecord[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const record = await measureScenario(scenario, preset, options);
    records.push(record);
    console.error(`[${String(index + 1)}/${String(scenarios.length)}] ${progressOf(record)}`);
  }
  const rows = records.map(summaryRowOf);
  const document = {
    format: 'guardian-sdk-benchmark-v1',
    environment: environmentOf(options.commit),
    preset: { name: preset.name, filter: filter ?? null, ...runCounts(preset, options) },
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios: records.map((record) => ({ ...record, summary: summaryOf(record) })),
  };
  await writeFile(join(directory, 'results.json'), `${JSON.stringify(document, null, 2)}\n`);
  const summary = markdownSummary(rows);
  await writeFile(join(directory, 'summary.md'), `${summary}\n`);
  console.log(`${summary}\n\nResults: ${directory}`);
  if (rows.some((row) => row.failures > 0)) {
    process.exitCode = 1;
  }
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      preset: { type: 'string', default: 'smoke' },
      filter: { type: 'string' },
      repeat: { type: 'string' },
      warmup: { type: 'string' },
      commit: { type: 'string' },
      output: { type: 'string', default: DEFAULT_OUTPUT },
      'timeout-ms': { type: 'string', default: '600000' },
      'max-old-space-mb': { type: 'string', default: '4096' },
      'server-max-old-space-mb': { type: 'string', default: String(DEFAULT_SERVER_MAX_OLD_SPACE_MB) },
      profile: { type: 'boolean', default: false },
      from: { type: 'string' },
      scenario: { type: 'string', multiple: true, default: [] },
    },
    strict: true,
  });
  return {
    preset: values.preset,
    filter: values.filter,
    repeat: optionalCount('repeat', values.repeat),
    warmup: optionalCount('warmup', values.warmup),
    commit: values.commit ?? process.env.BENCHMARK_COMMIT ?? 'unspecified',
    output: values.output,
    timeoutMs: countOf('timeout-ms', values['timeout-ms']),
    maxOldSpaceMb: countOf('max-old-space-mb', values['max-old-space-mb']),
    serverMaxOldSpaceMb: countOf('server-max-old-space-mb', values['server-max-old-space-mb']),
    profile: values.profile,
    from: values.from,
    scenarios: values.scenario,
  };
}

function optionalCount(name: string, value: string | undefined): number | undefined {
  return value === undefined ? undefined : countOf(name, value);
}

function countOf(name: string, value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`--${name} must be a non-negative integer`);
  }
  return count;
}

function runCounts(preset: Preset, options: Options): { readonly warmup: number; readonly repeat: number } {
  return { warmup: options.warmup ?? preset.warmup, repeat: options.repeat ?? preset.repeat };
}

/** A new directory per invocation; creating an existing one fails rather than overwriting results. */
async function resultDirectory(output: string, presetName: string): Promise<string> {
  await mkdir(output, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const directory = join(output, `${stamp}-${presetName}`);
  await mkdir(directory);
  return directory;
}

async function measureScenario(scenario: Scenario, preset: Preset, options: Options): Promise<ScenarioRecord> {
  const { warmup, repeat } = runCounts(preset, options);
  for (let run = 0; run < warmup; run += 1) {
    await runChild(preset.name, scenario.id, childFlags(options));
  }
  const runs: RunResult[] = [];
  for (let run = 0; run < repeat; run += 1) {
    runs.push(await runChild(preset.name, scenario.id, childFlags(options)));
  }
  return {
    id: scenario.id,
    family: scenario.parameters.family,
    realTimeScale: scenario.realTimeScale,
    parameters: scenario.parameters,
    runs,
  };
}

function runChild(presetName: string, scenarioId: string, execution: ChildExecution): Promise<RunResult> {
  return new Promise((resolve) => {
    const serverHeap = ['--server-max-old-space-mb', String(execution.serverMaxOldSpaceMb)];
    const child = fork(CHILD, [presetName, scenarioId, ...serverHeap], {
      execArgv: [...execution.flags],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    });
    let report: RunReport | undefined;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, execution.timeoutMs);
    child.on('message', (message: unknown) => {
      report = parseRunReport(message);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'failed', reason: error.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(
        report === undefined ? { status: 'failed', reason: exitReason(code, signal) } : { status: 'measured', report },
      );
    });
  });
}

/** How a measured child runs: its flags, its time limit and the heap of the chain server it starts. */
interface ChildExecution {
  readonly flags: readonly string[];
  readonly timeoutMs: number;
  readonly serverMaxOldSpaceMb: number;
}

/** Flags of every measured child: forced collections, virtual SDK timers and a heap ceiling. */
function childFlags(options: Options, extraFlags: readonly string[] = []): ChildExecution {
  return {
    flags: [
      '--expose-gc',
      '--experimental-test-module-mocks',
      '--disable-warning=ExperimentalWarning',
      '--disable-warning=DeprecationWarning',
      `--max-old-space-size=${String(options.maxOldSpaceMb)}`,
      ...extraFlags,
    ],
    timeoutMs: options.timeoutMs,
    serverMaxOldSpaceMb: options.serverMaxOldSpaceMb,
  };
}

/**
 * Run each chosen scenario once with Node's CPU and sampling heap profilers. The profiles are
 * written when the child exits, one directory per scenario.
 */
async function profile(options: Options): Promise<void> {
  const selection = await profileSelection(options);
  const preset = presetNamed(selection.preset);
  const directory = await resultDirectory(options.output, 'profile');
  const profiled = [];
  for (const [index, target] of selection.targets.entries()) {
    const profileDirectory = join(directory, `${String(index + 1)}-${target.reason}`);
    const flags = [
      `--cpu-prof`,
      `--cpu-prof-dir=${profileDirectory}`,
      `--heap-prof`,
      `--heap-prof-dir=${profileDirectory}`,
    ];
    const result = await runChild(preset.name, target.id, childFlags(options, flags));
    profiled.push({
      ...target,
      directory: profileDirectory,
      outcome: result.status === 'measured' ? result.report.outcome : result.reason,
    });
    console.error(`profiled ${target.id} (${target.reason}) in ${profileDirectory}`);
  }
  const document = {
    format: 'guardian-sdk-benchmark-profiles-v1',
    environment: environmentOf(options.commit),
    preset: preset.name,
    profiled,
  };
  await writeFile(join(directory, 'profiles.json'), `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Profiles: ${directory}`);
}

async function profileSelection(options: Options): Promise<ProfileSelection> {
  if (options.scenarios.length > 0) {
    return { preset: options.preset, targets: options.scenarios.map((id) => ({ id, reason: 'chosen', median: 0 })) };
  }
  if (options.from === undefined) {
    throw new RangeError('--profile needs --from <results.json> or --scenario <id>');
  }
  const document: unknown = JSON.parse(await readFile(options.from, 'utf8'));
  return profileTargetsOf(document);
}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    return `terminated by ${signal}`;
  }
  return `exited with code ${String(code ?? 'unknown')} without a report`;
}

function measuredReports(record: ScenarioRecord): RunReport[] {
  return record.runs.flatMap((run) => (run.status === 'measured' ? [run.report] : []));
}

function summaryOf(record: ScenarioRecord): Record<string, unknown> {
  return summarizeMetrics(measuredReports(record).map((report) => report.metrics));
}

function summaryRowOf(record: ScenarioRecord): SummaryRow {
  const reports = measuredReports(record);
  const correct = reports.filter((report) => report.checks.every(isPassing)).length;
  return {
    scenario: record.id,
    family: record.family,
    outcome: outcomesOf(record),
    runs: record.runs.length,
    failures: record.runs.length - correct,
    metrics: summarizeMetrics(reports.map((report) => report.metrics)),
  };
}

function outcomesOf(record: ScenarioRecord): string {
  const outcomes = record.runs.map((run) => (run.status === 'measured' ? run.report.outcome : `failed: ${run.reason}`));
  return [...new Set(outcomes)].join(' / ');
}

function progressOf(record: ScenarioRecord): string {
  const failedChecks = measuredReports(record)
    .flatMap((report) => report.checks.filter((entry) => !isPassing(entry)))
    .map((entry) => `${entry.name}: expected ${String(entry.expected)}, got ${String(entry.actual)}`);
  const details = failedChecks.length === 0 ? '' : ` — ${[...new Set(failedChecks)].join('; ')}`;
  return `${record.id}: ${outcomesOf(record)}${details}`;
}

function environmentOf(commit: string): Record<string, string | number> {
  const processors = cpus();
  return {
    commit,
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: processors[0]?.model ?? 'unknown',
    cpuCount: processors.length,
    memoryBytes: totalmem(),
  };
}

await main();
