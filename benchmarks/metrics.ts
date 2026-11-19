// Benchmark measurements: RPC and provider counters, phase timings, process resources, and the
// amplification ratios and summaries the runner reports. A run report crosses the process boundary
// as JSON, so its dynamic keys are plain records rather than maps.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { IntervalHistogram } from 'node:perf_hooks';
import { isRecord } from '../src/common/validation.ts';
import type {
  EventHandler,
  ScreeningProvider,
  ScreeningRequest,
  ScreeningResult,
  SdkEvent,
} from '../src/core/index.ts';
import { realDelay } from './synthetic-rpc.ts';
import type { Answer, RpcObserver, VirtualClock } from './synthetic-rpc.ts';

const BYTES_PER_MEGABYTE = 1_048_576;

const BYTES_PER_KILOBYTE = 1_024;

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const MICROSECONDS_PER_MILLISECOND = 1_000;

const EVENT_LOOP_RESOLUTION_MS = 10;

/** One expectation a scenario states about its own result. */
export interface Check {
  readonly name: string;
  readonly expected: number | string;
  readonly actual: number | string;
}

export function check(name: string, expected: number | string, actual: number | string): Check {
  return { name, expected, actual };
}

export function isPassing(entry: Check): boolean {
  return entry.expected === entry.actual;
}

export interface RpcTotals {
  readonly rpcCalls: number;
  readonly rpcFailures: number;
  readonly getLogsCalls: number;
  readonly ethCalls: number;
  readonly blockReads: number;
  readonly receiptReads: number;
  readonly logsReturned: number;
  readonly responseMb: number;
  /** Sum of the inclusive block spans of every `eth_getLogs` range. */
  readonly rangeSpanBlocks: number;
  readonly largestSpanBlocks: number;
  /** The longest log list and the largest response of a single answer. */
  readonly largestLogList: number;
  readonly largestResponseMb: number;
  /** Time the synthetic node spent answering, which is not SDK time. */
  readonly rpcHandlerMs: number;
  readonly rpcLatencyMs: number;
}

/** Counts every answer and failure of the measured node, attributed to the phase then running. */
export class RpcMeter implements RpcObserver {
  readonly #calls = new Map<string, Map<string, number>>();

  #phase = 'setup';

  #failures = 0;

  #logs = 0;

  #bytes = 0;

  #rangeSpanBlocks = 0;

  #largestSpanBlocks = 0;

  #largestLogList = 0;

  #largestResponseBytes = 0;

  #handlerMs = 0;

  #latencyMs = 0;

  enterPhase(phase: string): void {
    this.#phase = phase;
  }

  answered(answer: Answer, handlerMs: number, latencyMs: number): void {
    this.#count(answer.label);
    this.#logs += answer.logs;
    this.#bytes += answer.bytes;
    this.#rangeSpanBlocks += answer.spanBlocks;
    this.#largestSpanBlocks = Math.max(this.#largestSpanBlocks, answer.spanBlocks);
    this.#largestLogList = Math.max(this.#largestLogList, answer.logs);
    this.#largestResponseBytes = Math.max(this.#largestResponseBytes, answer.bytes);
    this.#handlerMs += handlerMs;
    this.#latencyMs += latencyMs;
  }

  failed(method: string, handlerMs: number): void {
    this.#count(`${method}:failed`);
    this.#failures += 1;
    this.#handlerMs += handlerMs;
  }

  /** Calls in `phase`, or in every phase when it is null, whose label starts with `labelPrefix`. */
  count(phase: string | null, labelPrefix: string): number {
    let total = 0;
    for (const [callPhase, labels] of this.#calls) {
      if (phase !== null && callPhase !== phase) {
        continue;
      }
      for (const [label, calls] of labels) {
        total += label.startsWith(labelPrefix) ? calls : 0;
      }
    }
    return total;
  }

  totals(): RpcTotals {
    return {
      rpcCalls: this.count(null, ''),
      rpcFailures: this.#failures,
      getLogsCalls: this.count(null, 'eth_getLogs'),
      ethCalls: this.count(null, 'eth_call'),
      blockReads: this.count(null, 'eth_getBlockByNumber'),
      receiptReads: this.count(null, 'eth_getTransactionReceipt'),
      logsReturned: this.#logs,
      responseMb: this.#bytes / BYTES_PER_MEGABYTE,
      rangeSpanBlocks: this.#rangeSpanBlocks,
      largestSpanBlocks: this.#largestSpanBlocks,
      largestLogList: this.#largestLogList,
      largestResponseMb: this.#largestResponseBytes / BYTES_PER_MEGABYTE,
      rpcHandlerMs: this.#handlerMs,
      rpcLatencyMs: this.#latencyMs,
    };
  }

  /** Calls by phase, then by answer label, in JSON form. */
  byPhase(): Record<string, Record<string, number>> {
    return Object.fromEntries([...this.#calls].map(([phase, labels]) => [phase, Object.fromEntries(labels)]));
  }

  #count(label: string): void {
    const labels = this.#calls.get(this.#phase) ?? new Map<string, number>();
    labels.set(label, (labels.get(label) ?? 0) + 1);
    this.#calls.set(this.#phase, labels);
  }
}

/** How the synthetic provider decides, and whether its latency passes in real or chain time. */
export interface ProviderPlan {
  readonly decide: (index: number, count: number) => ScreeningResult;
  readonly latency: { readonly kind: 'real' | 'virtual'; readonly ms: number };
}

export interface ProviderTotals {
  readonly providerCalls: number;
  readonly providerAnchors: number;
  readonly providerDecisions: number;
  readonly providerLatencyMs: number;
}

/** A screening provider that answers from a plan and counts what it was asked. */
export class ProviderMeter {
  #calls = 0;

  #anchors = 0;

  #decisions = 0;

  #latencyMs = 0;

  provider(plan: ProviderPlan, clock: VirtualClock): ScreeningProvider {
    return { screen: (request) => this.#screen(request, plan, clock) };
  }

  totals(): ProviderTotals {
    return {
      providerCalls: this.#calls,
      providerAnchors: this.#anchors,
      providerDecisions: this.#decisions,
      providerLatencyMs: this.#latencyMs,
    };
  }

  async #screen(
    request: ScreeningRequest,
    plan: ProviderPlan,
    clock: VirtualClock,
  ): Promise<readonly ScreeningResult[]> {
    this.#calls += 1;
    this.#anchors += request.anchors.length;
    this.#latencyMs += plan.latency.ms;
    await (plan.latency.kind === 'virtual' ? clock.sleep(plan.latency.ms) : realDelay(plan.latency.ms));
    const results = request.anchors.map((_anchor, index) => plan.decide(index, request.anchors.length));
    this.#decisions += results.length;
    return results;
  }
}

/** The phase each cycle event opens. */
const NEXT_PHASE: Partial<Record<SdkEvent['event'], string>> = {
  'cycle.started': 'plan',
  'cycle.planned': 'discovery',
  'cycle.discovered': 'reconstruction',
  'cycle.reconstructed': 'screening',
  'cycle.screened': 'signal',
  'cycle.finished': 'after',
  'cycle.failed': 'after',
};

/** Phase durations and RPC attribution, from cycle events or from explicitly timed phase calls. */
export class PhaseTimer {
  readonly #meter: RpcMeter;

  readonly #durationsMs = new Map<string, number>();

  #phase = 'setup';

  #phaseStartedAt = performance.now();

  constructor(meter: RpcMeter) {
    this.#meter = meter;
  }

  /** An SDK event handler that switches phases as a cycle reports them. */
  readonly onEvent: EventHandler = (event) => {
    const next = NEXT_PHASE[event.event];
    if (next !== undefined) {
      this.#enter(next);
    }
  };

  /** Run one phase call, attributing its time and RPC requests to `phase`. */
  async time<Result>(phase: string, run: () => Promise<Result>): Promise<Result> {
    this.#enter(phase);
    try {
      return await run();
    } finally {
      this.#enter('between');
    }
  }

  /** Milliseconds per phase, keyed `<phase>Ms`. */
  durationsMs(): Record<string, number> {
    this.#enter(this.#phase);
    return Object.fromEntries([...this.#durationsMs].map(([phase, milliseconds]) => [`${phase}Ms`, milliseconds]));
  }

  #enter(phase: string): void {
    const now = performance.now();
    this.#durationsMs.set(this.#phase, (this.#durationsMs.get(this.#phase) ?? 0) + now - this.#phaseStartedAt);
    this.#phase = phase;
    this.#phaseStartedAt = now;
    this.#meter.enterPhase(phase);
  }
}

export interface ResourceUsage {
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly heapBeforeMb: number;
  readonly heapAfterMb: number;
  /** Heap still reachable after a collection at the end of the window. */
  readonly heapRetainedMb: number;
  /** Peak resident set of the whole process, including the synthetic history. */
  readonly peakRssMb: number;
  readonly eventLoopMeanMs: number;
  readonly eventLoopMaxMs: number;
  readonly eventLoopP99Ms: number;
}

/** Wall, CPU, heap and event-loop measurements around one measured operation. */
export class ResourceWindow {
  readonly #heapBefore: number;

  readonly #eventLoop: IntervalHistogram;

  readonly #cpu: NodeJS.CpuUsage;

  readonly #startedAt: number;

  constructor() {
    collectGarbage();
    this.#heapBefore = process.memoryUsage().heapUsed;
    this.#eventLoop = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
    this.#eventLoop.enable();
    this.#cpu = process.cpuUsage();
    this.#startedAt = performance.now();
  }

  close(): ResourceUsage {
    const wallMs = performance.now() - this.#startedAt;
    const cpu = process.cpuUsage(this.#cpu);
    this.#eventLoop.disable();
    const heapAfter = process.memoryUsage().heapUsed;
    collectGarbage();
    const heapRetained = process.memoryUsage().heapUsed;
    return {
      wallMs,
      cpuMs: (cpu.user + cpu.system) / MICROSECONDS_PER_MILLISECOND,
      cpuUserMs: cpu.user / MICROSECONDS_PER_MILLISECOND,
      cpuSystemMs: cpu.system / MICROSECONDS_PER_MILLISECOND,
      heapBeforeMb: this.#heapBefore / BYTES_PER_MEGABYTE,
      heapAfterMb: heapAfter / BYTES_PER_MEGABYTE,
      heapRetainedMb: heapRetained / BYTES_PER_MEGABYTE,
      peakRssMb: (process.resourceUsage().maxRSS * BYTES_PER_KILOBYTE) / BYTES_PER_MEGABYTE,
      eventLoopMeanMs: finiteOrZero(this.#eventLoop.mean) / NANOSECONDS_PER_MILLISECOND,
      eventLoopMaxMs: this.#eventLoop.max / NANOSECONDS_PER_MILLISECOND,
      eventLoopP99Ms: this.#eventLoop.percentile(99) / NANOSECONDS_PER_MILLISECOND,
    };
  }
}

/** The work a run produced, for the amplification ratios. */
export interface WorkCounts {
  readonly supplies: number;
  readonly anchors: number;
  readonly targets: number;
  readonly reportTransactions: number;
  readonly originalAnchors: number;
  readonly reprocessedAnchors: number;
}

/** Cost per unit of useful work; a ratio whose denominator is zero is omitted. */
export function amplificationOf(rpc: RpcTotals, provider: ProviderTotals, work: WorkCounts): Record<string, number> {
  const ratios: readonly (readonly [string, number, number])[] = [
    ['rpcPerSupply', rpc.rpcCalls, work.supplies],
    ['rpcPerAnchor', rpc.rpcCalls, work.anchors],
    ['logsPerAnchor', rpc.logsReturned, work.anchors],
    ['kilobytesPerAnchor', rpc.responseMb * BYTES_PER_KILOBYTE, work.anchors],
    ['decisionsPerAnchor', provider.providerDecisions, work.anchors],
    ['reportTransactionsPerTarget', work.reportTransactions, work.targets],
    ['reprocessedAnchorShare', work.reprocessedAnchors, work.originalAnchors],
  ];
  return Object.fromEntries(
    ratios.flatMap(([name, numerator, denominator]) => (denominator > 0 ? [[name, numerator / denominator]] : [])),
  );
}

/** What one child process reports about one run. */
export interface RunReport {
  readonly outcome: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly rpcByPhase: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly checks: readonly Check[];
}

/** Validate a run report received from a child process. */
export function parseRunReport(value: unknown): RunReport | undefined {
  if (!isRecord(value) || typeof value.outcome !== 'string') {
    return undefined;
  }
  const metrics = numberRecordOf(value.metrics);
  if (metrics === undefined) {
    return undefined;
  }
  const rpcByPhase = nestedNumberRecordOf(value.rpcByPhase);
  if (rpcByPhase === undefined) {
    return undefined;
  }
  const checks = checksOf(value.checks);
  return checks === undefined ? undefined : { outcome: value.outcome, metrics, rpcByPhase, checks };
}

export interface Spread {
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

export function spreadOf(values: readonly number[]): Spread {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const isOdd = sorted.length % 2 === 1;
  const median = isOdd ? valueAt(sorted, middle) : (valueAt(sorted, middle - 1) + valueAt(sorted, middle)) / 2;
  return { median, min: valueAt(sorted, 0), max: valueAt(sorted, sorted.length - 1) };
}

/** Median, minimum and maximum of every metric the runs share. */
export function summarizeMetrics(runs: readonly Readonly<Record<string, number>>[]): Record<string, Spread> {
  const names = new Set(runs.flatMap((metrics) => Object.keys(metrics)));
  return Object.fromEntries(
    [...names].map((name) => [name, spreadOf(runs.flatMap((metrics) => valuesOf(metrics, name)))]),
  );
}

/** One scenario's line in the printed summary. */
export interface SummaryRow {
  readonly scenario: string;
  readonly family: string;
  readonly outcome: string;
  readonly runs: number;
  readonly failures: number;
  readonly metrics: Readonly<Record<string, Spread>>;
}

interface Column {
  readonly header: string;
  readonly metric: string;
  readonly digits: number;
}

const COMMON_COLUMNS: readonly Column[] = [
  { header: 'wall ms', metric: 'wallMs', digits: 0 },
  { header: 'CPU ms', metric: 'cpuMs', digits: 0 },
  { header: 'peak RSS MB', metric: 'peakRssMb', digits: 0 },
  { header: 'RPC', metric: 'rpcCalls', digits: 0 },
  { header: 'getLogs', metric: 'getLogsCalls', digits: 0 },
  { header: 'logs', metric: 'logsReturned', digits: 0 },
  { header: 'response MB', metric: 'responseMb', digits: 1 },
  { header: 'anchors', metric: 'anchors', digits: 0 },
  { header: 'RPC/anchor', metric: 'rpcPerAnchor', digits: 2 },
  { header: 'tx', metric: 'transactions', digits: 0 },
  { header: 'blocks used', metric: 'blocksConsumed', digits: 0 },
  { header: 'budget left', metric: 'remainingBudgetBlocks', digits: 0 },
];

const FAMILY_COLUMNS: Readonly<Record<string, readonly Column[]>> = {
  liveness: [
    { header: 'max targets', metric: 'capacityTargets', digits: 0 },
    { header: 'max batches', metric: 'capacityBatches', digits: 0 },
    { header: 'blocks used', metric: 'blocksConsumed', digits: 0 },
    { header: 'budget left', metric: 'remainingBudgetBlocks', digits: 0 },
    { header: 'wall ms', metric: 'wallMs', digits: 0 },
  ],
  anvil: [
    { header: 'wall ms', metric: 'wallMs', digits: 0 },
    { header: 'CPU ms', metric: 'cpuMs', digits: 0 },
    { header: 'peak RSS MB', metric: 'peakRssMb', digits: 0 },
    { header: 'HTTP attempts', metric: 'httpAttempts', digits: 0 },
    { header: 'response MB', metric: 'responseMb', digits: 2 },
    { header: 'anchors', metric: 'anchors', digits: 0 },
    { header: 'attempts/anchor', metric: 'rpcPerAnchor', digits: 2 },
    { header: 'tx', metric: 'transactions', digits: 0 },
    { header: 'blocks used', metric: 'blocksConsumed', digits: 0 },
    { header: 'setup ms', metric: 'datasetBuildMs', digits: 0 },
  ],
  transport: [
    { header: 'wall ms', metric: 'wallMs', digits: 0 },
    { header: 'requests', metric: 'requests', digits: 0 },
    { header: 'HTTP attempts', metric: 'httpAttempts', digits: 0 },
    { header: 'failed', metric: 'failedRequests', digits: 0 },
    { header: 'p50 ms', metric: 'latencyP50Ms', digits: 1 },
    { header: 'p95 ms', metric: 'latencyP95Ms', digits: 1 },
    { header: 'switch ms', metric: 'endpointSwitchMs', digits: 1 },
    { header: 'response MB', metric: 'responseMb', digits: 2 },
  ],
  griefing: [
    { header: 'capacity', metric: 'capacity', digits: 0 },
    { header: 'blocks used', metric: 'blocksConsumed', digits: 0 },
    { header: 'RPC', metric: 'rpcCalls', digits: 0 },
    { header: 'largest log list', metric: 'largestLogList', digits: 0 },
    { header: 'largest response MB', metric: 'largestResponseMb', digits: 1 },
    { header: 'memory growth MB', metric: 'memoryGrowthMb', digits: 0 },
    { header: 'attack gas M', metric: 'attackGasMillions', digits: 0 },
    { header: 'ETH at 0.07 gwei', metric: 'costEthCheapFee', digits: 2 },
    { header: 'ETH at 0.35 gwei', metric: 'costEthMedianFee', digits: 2 },
  ],
  daemon: [
    { header: 'wall ms', metric: 'wallMs', digits: 0 },
    { header: 'CPU ms', metric: 'cpuMs', digits: 0 },
    { header: 'peak RSS MB', metric: 'peakRssMb', digits: 0 },
    { header: 'anchors', metric: 'anchors', digits: 0 },
    { header: 'events', metric: 'events', digits: 0 },
    { header: 'event KB', metric: 'eventKb', digits: 0 },
    { header: 'largest event KB', metric: 'largestEventKb', digits: 1 },
    { header: 'max concurrent posts', metric: 'maxConcurrentPosts', digits: 0 },
    { header: 'screening request KB', metric: 'screeningRequestKb', digits: 1 },
  ],
};

/** Markdown tables of median values, one table per scenario family. */
export function markdownSummary(rows: readonly SummaryRow[]): string {
  const families = [...new Set(rows.map((row) => row.family))];
  return families
    .map((family) =>
      familyTable(
        family,
        rows.filter((row) => row.family === family),
      ),
    )
    .join('\n\n');
}

function familyTable(family: string, rows: readonly SummaryRow[]): string {
  const columns = FAMILY_COLUMNS[family] ?? COMMON_COLUMNS;
  const header = ['scenario', 'outcome', 'runs', ...columns.map((column) => column.header)];
  const lines = rows.map((row) => [
    row.scenario,
    row.failures === 0 ? row.outcome : `${row.outcome} (${row.failures} failed)`,
    String(row.runs),
    ...columns.map((column) => cellOf(row.metrics[column.metric], column.digits)),
  ]);
  return [
    `### ${family}`,
    '',
    markdownRow(header),
    markdownRow(header.map(() => '---')),
    ...lines.map(markdownRow),
  ].join('\n');
}

function markdownRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function cellOf(spread: Spread | undefined, digits: number): string {
  return spread === undefined ? '–' : spread.median.toFixed(digits);
}

function collectGarbage(): void {
  globalThis.gc?.();
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function valueAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError('A spread needs at least one value');
  }
  return value;
}

function valuesOf(metrics: Readonly<Record<string, number>>, name: string): number[] {
  const value = metrics[name];
  return value === undefined ? [] : [value];
}

/** The value as a record of numbers, or undefined when any entry is not a number. */
export function numberRecordOf(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  const numeric = entries.filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  return numeric.length === entries.length ? Object.fromEntries(numeric) : undefined;
}

function nestedNumberRecordOf(value: unknown): Record<string, Record<string, number>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, nested]) => {
    const record = numberRecordOf(nested);
    return record === undefined ? [] : [[key, record] as const];
  });
  return entries.length === Object.keys(value).length ? Object.fromEntries(entries) : undefined;
}

function checksOf(value: unknown): Check[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const checks = value.flatMap((entry: unknown) => {
    const parsed = checkOf(entry);
    return parsed === undefined ? [] : [parsed];
  });
  return checks.length === value.length ? checks : undefined;
}

function checkOf(value: unknown): Check | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return undefined;
  }
  const { expected, actual } = value;
  const isExpectedValid = typeof expected === 'string' || typeof expected === 'number';
  const isActualValid = typeof actual === 'string' || typeof actual === 'number';
  if (!isExpectedValid || !isActualValid) {
    return undefined;
  }
  return { name: value.name, expected, actual };
}
