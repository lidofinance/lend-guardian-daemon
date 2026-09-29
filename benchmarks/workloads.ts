// Turns one scenario into SDK calls over a synthetic world, and assembles what the run measured. Each
// family isolates one boundary: discovery, reconstruction, screening, submission, a whole cycle, the
// blockhash budget a submission consumes, the HTTP transport, or what the daemon adds to a cycle. Every
// family states checks about its own result, so a benchmark that measured the wrong behaviour fails
// instead of reporting numbers.

import { Guardian, GuardianStop } from '../src/core/index.ts';
import type {
  CycleOutcome,
  PositionKey,
  ScanPlan,
  ScreeningResult,
  SdkEvent,
  SupplyAnchor,
} from '../src/core/index.ts';
import { Screened, Work } from '../src/core/outcomes.ts';
import type { PendingTarget } from '../src/core/outcomes.ts';
import { PhaseTimer, ProviderMeter, ResourceWindow, RpcMeter, amplificationOf, check } from './metrics.ts';
import type { Check, ProviderPlan, ResourceUsage, RunReport, WorkCounts } from './metrics.ts';
import type {
  CycleProfile,
  CycleScenario,
  Decision,
  DiscoveryScenario,
  LivenessScenario,
  ReconstructionScenario,
  ReportsScenario,
  Scenario,
  ScreeningScenario,
  SubmissionFault,
} from './scenarios.ts';
import { SyntheticClient } from './synthetic-client.ts';
import type { Delivery } from './synthetic-client.ts';
import { BLOCKHASH_LOOKBACK, CHAIN_ID, SLOT_SECONDS, measuredNode, timestampOf } from './synthetic-rpc.ts';
import type { RpcLatency, SyntheticChain, VirtualClock } from './synthetic-rpc.ts';
import { runAnvil } from './anvil.ts';
import { runDaemon } from './daemon.ts';
import { runTransport } from './transport.ts';
import {
  CORE,
  CYCLE_MARKETS,
  DELEGATE,
  GUARDIAN,
  REGISTRY,
  REPORT_BLOCK,
  REPORT_BLOCK_LAG,
  buildWorld,
  cycleWorld,
  discoveryWorld,
  positionAt,
  quietWorld,
  reconstructionWorld,
  syntheticAnchor,
} from './worlds.ts';
import type { CycleWorld } from './worlds.ts';

const HEARTBEAT_RESERVE_BLOCKS = 8;

const IDLE_HEARTBEAT_INTERVAL_SECONDS = 12 * 60 * 60;

const SCREENING_MARKETS = 10;

const CLEAN: ScreeningResult = { status: 'judged', requiresSuspect: false, requiresFlag: false };

const DECISIONS: Readonly<Record<Decision, ScreeningResult>> = {
  clean: CLEAN,
  suspect: { status: 'judged', requiresSuspect: true, requiresFlag: false },
  flag: { status: 'judged', requiresSuspect: false, requiresFlag: true },
  both: { status: 'judged', requiresSuspect: true, requiresFlag: true },
};

const REPORT_KINDS: Readonly<Record<Decision, number>> = { clean: 0, suspect: 1, flag: 1, both: 2 };

const NO_LATENCY: RpcLatency = { everyRequestMs: 0, byLabelMs: new Map() };

interface RunContext {
  readonly clock: VirtualClock;
  readonly seed: number;
}

interface GuardianSettings {
  readonly maxLogBlockRange: number;
  readonly flaggerReadConcurrency: number;
  readonly historyReadConcurrency: number;
  readonly maxSignalBatchSize: number;
  readonly txConfirmationBlocks: number;
  readonly interBatchConfirmationBlocks: number;
  readonly inclusionBlocks: number;
  readonly rpcLatency: RpcLatency;
  readonly provider: ProviderPlan;
  readonly onIncluded: ((delivery: Delivery) => void) | undefined;
}

const DEFAULT_SETTINGS: GuardianSettings = {
  maxLogBlockRange: 10_000,
  flaggerReadConcurrency: 8,
  historyReadConcurrency: 8,
  maxSignalBatchSize: 50,
  txConfirmationBlocks: 12,
  interBatchConfirmationBlocks: 2,
  inclusionBlocks: 1,
  rpcLatency: NO_LATENCY,
  provider: { decide: () => CLEAN, latency: { kind: 'real', ms: 0 } },
  onIncluded: undefined,
};

/** The report blocks the cycle planned, from its `cycle.planned` events. */
class PlanRecorder {
  #first: number | undefined;

  #last: number | undefined;

  readonly onEvent = (event: SdkEvent): void => {
    if (event.event === 'cycle.planned' && event.result.kind === 'plan') {
      this.record(event.result);
    }
  };

  record(plan: ScanPlan): void {
    this.#first ??= plan.discoveryRange.to.number;
    this.#last = plan.discoveryRange.to.number;
  }

  reportBlocks(): { readonly first: number; readonly last: number } | undefined {
    const first = this.#first;
    const last = this.#last;
    if (first === undefined || last === undefined) {
      return undefined;
    }
    return { first, last };
  }
}

interface Harness {
  readonly chain: SyntheticChain;
  readonly rpc: RpcMeter;
  readonly providers: ProviderMeter;
  readonly phases: PhaseTimer;
  readonly plans: PlanRecorder;
  readonly client: SyntheticClient;
  readonly guardian: Guardian;
}

/** What a family's measured operation established. */
interface Measured {
  readonly outcome: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly checks: readonly Check[];
}

interface Settled<Result> {
  readonly outcome: string;
  readonly value: Result | undefined;
}

/** Run one scenario in this process and report what it measured. */
export function runScenario(scenario: Scenario, clock: VirtualClock, presetName: string): Promise<RunReport> {
  const context: RunContext = { clock, seed: scenario.seed };
  const { parameters } = scenario;
  switch (parameters.family) {
    case 'discovery':
      return runDiscovery(parameters, context);
    case 'reconstruction':
      return runReconstruction(parameters, context);
    case 'screening':
      return runScreening(parameters, context);
    case 'reports':
      return runReports(parameters, context);
    case 'cycle':
      return runCycle(parameters, context);
    case 'liveness':
      return runLiveness(parameters, context);
    case 'transport':
      return runTransport(parameters, { presetName, scenarioId: scenario.id });
    case 'daemon':
      return runDaemon(parameters, { presetName, scenarioId: scenario.id });
    case 'anvil':
      return runAnvil(parameters);
  }
}

// ─── Discovery: supply logs in chunks, controller bindings and paired classification reads.

async function runDiscovery(parameters: DiscoveryScenario, context: RunContext): Promise<RunReport> {
  const built = buildWorld(() => discoveryWorld(parameters, context.clock, context.seed));
  const harness = harnessOf(built.world.chain, context.clock, {
    ...DEFAULT_SETTINGS,
    maxLogBlockRange: parameters.maxLogBlockRange,
  });
  return measured(harness, built.stats, async () => {
    const plan = await planOf(harness);
    const discovered = await harness.phases.time('discovery', () => harness.guardian.discoverCandidatePositions(plan));
    const candidates = discovered.all().length;
    const { world } = built;
    return {
      outcome: 'discovered',
      counts: { supplies: parameters.supplies, candidates },
      checks: [
        check('candidate positions', world.candidates, candidates),
        check(
          'core log chunks',
          Math.ceil(parameters.rangeBlocks / parameters.maxLogBlockRange),
          harness.rpc.count('discovery', 'eth_getLogs:core-range'),
        ),
        check(
          'controller block reads',
          world.controllerBlocks,
          harness.rpc.count('discovery', 'eth_getLogs:controller-block'),
        ),
        check('market controller reads', world.markets, harness.rpc.count('discovery', 'eth_call:marketController')),
        check(
          'controller registry reads',
          world.controllers,
          harness.rpc.count('discovery', 'eth_call:guardianSignals'),
        ),
      ],
    };
  });
}

// ─── Reconstruction: backward lifecycle walks, wide or deep.

async function runReconstruction(parameters: ReconstructionScenario, context: RunContext): Promise<RunReport> {
  const built = buildWorld(() => reconstructionWorld(parameters, context.clock));
  const harness = harnessOf(built.world.chain, context.clock, {
    ...DEFAULT_SETTINGS,
    maxLogBlockRange: parameters.maxLogBlockRange,
  });
  return measured(harness, built.stats, async () => {
    const plan = await planOf(harness);
    const discovered = await harness.phases.time('discovery', () => harness.guardian.discoverCandidatePositions(plan));
    const work = await harness.phases.time('reconstruction', () => harness.guardian.reconstructWork(discovered));
    const { world } = built;
    return {
      outcome: 'reconstructed',
      counts: {
        supplies: world.supplies,
        candidates: discovered.all().length,
        positions: work.positions,
        anchors: work.anchors,
        historyEvents: world.events,
        controllerRangeCalls: harness.rpc.count('reconstruction', 'eth_getLogs:controller-range'),
      },
      checks: [
        check('work anchors', world.anchors, work.anchors),
        check('work positions', parameters.positions, work.positions),
      ],
    };
  });
}

// ─── Screening: own-flag reads, the provider request and positional validation.

async function runScreening(parameters: ScreeningScenario, context: RunContext): Promise<RunReport> {
  const built = buildWorld(() => quietWorld(context.clock));
  const harness = harnessOf(built.world, context.clock, {
    ...DEFAULT_SETTINGS,
    flaggerReadConcurrency: parameters.flaggerReadConcurrency,
    rpcLatency: { everyRequestMs: 0, byLabelMs: new Map([['eth_call:getFlaggedBy', parameters.flaggerLatencyMs]]) },
    provider: {
      decide: (index, count) =>
        isIncompleteAt(parameters.incomplete, index, count) ? { status: 'incomplete' } : CLEAN,
      latency: { kind: 'real', ms: parameters.providerLatencyMs },
    },
  });
  const plan = await planOf(harness);
  const input = screeningInput(parameters, plan, built.world);
  return measured(harness, built.stats, async () => {
    const result = await settle(
      () => harness.phases.time('screening', () => harness.guardian.screenWork(input.work)),
      () => 'screened',
    );
    const expectedOutcome = parameters.incomplete === 'none' ? 'screened' : 'stop:screening-result-incomplete';
    return {
      outcome: result.outcome,
      counts: {
        anchors: input.work.anchors,
        targets: input.targets,
        ownFlaggedTargets: input.ownFlagged,
        skippedTargets: result.value?.skipped.length ?? 0,
      },
      checks: [
        check('outcome', expectedOutcome, result.outcome),
        check('flagger reads', input.targets, harness.rpc.count('screening', 'eth_call:getFlaggedBy')),
        check(
          'anchors sent to the provider',
          (input.targets - input.ownFlagged) * parameters.anchorsPerTarget,
          harness.providers.totals().providerAnchors,
        ),
      ],
    };
  });
}

function isIncompleteAt(incomplete: ScreeningScenario['incomplete'], index: number, count: number): boolean {
  if (incomplete === 'first') {
    return index === 0;
  }
  return incomplete === 'last' ? index === count - 1 : false;
}

function screeningInput(
  parameters: ScreeningScenario,
  plan: ScanPlan,
  chain: SyntheticChain,
): { readonly work: Work; readonly targets: number; readonly ownFlagged: number } {
  const targets = Math.max(1, Math.floor(parameters.anchors / parameters.anchorsPerTarget));
  const ownFlagged = Math.round(targets * parameters.ownFlagShare);
  const byPosition = new Map<PositionKey, readonly SupplyAnchor[]>();
  for (let target = 0; target < targets; target += 1) {
    const position = positionAt(target, SCREENING_MARKETS);
    const anchors = Array.from({ length: parameters.anchorsPerTarget }, (_anchor, index) =>
      syntheticAnchor(position, target * parameters.anchorsPerTarget + index, chain),
    );
    byPosition.set(position, anchors);
    if (target < ownFlagged) {
      chain.flag(position.marketId, position.borrower, GUARDIAN);
    }
  }
  return { work: new Work(plan, byPosition), targets, ownFlagged };
}

// ─── Reports and heartbeat: batching, the shared depth wait and faults between batches.

const FAULT_OUTCOMES: Readonly<Record<SubmissionFault, string>> = {
  none: 'attested',
  'reorg-after-first': 'stale:report-block-reorged',
  'reorg-after-middle': 'stale:report-block-reorged',
  'reorg-after-last': 'stale:report-block-reorged',
  'age-out-after-middle': 'stale:report-block-aged-out',
  'receipt-lost-after-last': 'stale:report-no-longer-confirmed',
};

async function runReports(parameters: ReportsScenario, context: RunContext): Promise<RunReport> {
  const built = buildWorld(() => quietWorld(context.clock));
  const reportTransactions = expectedReportTransactions(parameters);
  const harness = harnessOf(built.world, context.clock, {
    ...DEFAULT_SETTINGS,
    maxSignalBatchSize: parameters.maxSignalBatchSize,
    txConfirmationBlocks: parameters.txConfirmationBlocks,
    interBatchConfirmationBlocks: parameters.interBatchConfirmationBlocks,
    onIncluded: faultHook(parameters.fault, reportTransactions, built.world, context.clock),
  });
  const plan = await planOf(harness);
  const screened = submissionInput(plan, parameters, built.world);
  return measured(harness, built.stats, async () => {
    const result = await settle(
      () => harness.phases.time('signal', () => harness.guardian.signalAndHeartbeat(screened)),
      outcomeOf,
    );
    return {
      outcome: result.outcome,
      counts: {
        targets: parameters.targets,
        anchors: parameters.targets,
        suspects: screened.suspects.length,
        flags: screened.flags.length,
        ...livenessCounts(harness),
      },
      checks: reportChecks(parameters, { outcome: result.outcome, harness, reportTransactions }),
    };
  });
}

/**
 * A fault must end the attempt the way the fault implies. Without a fault the scenario measures
 * whether the reports fit the blockhash budget: an attested run sent exactly the expected batches and
 * the heartbeat, and a run that ran out of budget sent no heartbeat.
 */
function reportChecks(
  parameters: ReportsScenario,
  result: { readonly outcome: string; readonly harness: Harness; readonly reportTransactions: number },
): Check[] {
  if (parameters.fault !== 'none') {
    return [check('outcome', FAULT_OUTCOMES[parameters.fault], result.outcome)];
  }
  const deliveries = result.harness.client.deliveries();
  if (result.outcome === 'stale:report-block-aged-out') {
    return [check('heartbeat withheld', 0, deliveries.filter((delivery) => delivery.method === 'heartbeat').length)];
  }
  return [
    check('outcome', 'attested', result.outcome),
    check('transactions', result.reportTransactions + 1, deliveries.length),
  ];
}

/** Report transactions the SDK should send: one batch per market and kind per `maxSignalBatchSize`. */
function expectedReportTransactions(parameters: {
  readonly targets: number;
  readonly markets: number;
  readonly decision: Decision;
  readonly maxSignalBatchSize: number;
}): number {
  const batches = targetsPerMarket(parameters.targets, parameters.markets).reduce(
    (total, targets) => total + Math.ceil(targets / parameters.maxSignalBatchSize),
    0,
  );
  return batches * REPORT_KINDS[parameters.decision];
}

function targetsPerMarket(targets: number, markets: number): number[] {
  const perMarket = Math.floor(targets / markets);
  const remainder = targets % markets;
  return Array.from({ length: markets }, (_market, index) => perMarket + (index < remainder ? 1 : 0));
}

/** Work with one anchor per target and the provider decisions already validated into `Screened`. */
function submissionInput(
  plan: ScanPlan,
  parameters: { readonly targets: number; readonly markets: number; readonly decision: Decision },
  chain: SyntheticChain,
): Screened {
  const byPosition = new Map<PositionKey, readonly SupplyAnchor[]>();
  const pending: PendingTarget[] = [];
  for (let target = 0; target < parameters.targets; target += 1) {
    const position = positionAt(target, parameters.markets);
    const anchors = [syntheticAnchor(position, target, chain)];
    byPosition.set(position, anchors);
    pending.push({ target: { marketId: position.marketId, borrower: position.borrower }, anchors });
  }
  const work = new Work(plan, byPosition);
  const answers = pending.map(() => DECISIONS[parameters.decision]);
  return Screened.fromAnswers(work, { pending, skipped: [] }, answers);
}

/** Inject one fault after the chosen report transaction is included; the heartbeat never triggers it. */
function faultHook(
  fault: SubmissionFault,
  reportTransactions: number,
  chain: SyntheticChain,
  clock: VirtualClock,
): ((delivery: Delivery) => void) | undefined {
  if (fault === 'none') {
    return undefined;
  }
  const trigger = triggerOf(fault, reportTransactions);
  let hasFired = false;
  return (delivery) => {
    const isTrigger = delivery.method !== 'heartbeat' && delivery.sequence === trigger;
    if (!isTrigger || hasFired) {
      return;
    }
    hasFired = true;
    applyFault(fault, delivery, chain, clock);
  };
}

function triggerOf(fault: SubmissionFault, reportTransactions: number): number {
  if (fault.endsWith('-first')) {
    return 0;
  }
  return fault.endsWith('-middle') ? Math.floor((reportTransactions - 1) / 2) : reportTransactions - 1;
}

function applyFault(fault: SubmissionFault, delivery: Delivery, chain: SyntheticChain, clock: VirtualClock): void {
  if (fault.startsWith('reorg-')) {
    chain.reorgFrom(REPORT_BLOCK);
    return;
  }
  if (fault.startsWith('age-out-')) {
    clock.advanceSlots(BLOCKHASH_LOOKBACK);
    return;
  }
  chain.dropTransaction(delivery.hash);
}

// ─── Whole cycles.

/** Expected final outcome, or null when the profile measures whichever outcome the budget allows. */
const CYCLE_OUTCOMES: Readonly<Record<Exclude<CycleProfile, 'steady-state'>, string | null>> = {
  empty: 'attested',
  clean: 'attested',
  reports: 'attested',
  deep: 'attested',
  wide: 'attested',
  'provider-latency': null,
  'rpc-latency': 'attested',
  'log-failure': 'error',
  'reorg-before-heartbeat': 'stale:report-block-reorged',
  'lost-confirmation': 'stale:report-no-longer-confirmed',
  'restart-after-stale': 'attested',
};

const CYCLE_FAULTS: Readonly<Record<CycleProfile, SubmissionFault>> = {
  empty: 'none',
  clean: 'none',
  reports: 'none',
  deep: 'none',
  wide: 'none',
  'provider-latency': 'none',
  'rpc-latency': 'none',
  'log-failure': 'none',
  'reorg-before-heartbeat': 'reorg-after-last',
  'lost-confirmation': 'receipt-lost-after-last',
  'restart-after-stale': 'age-out-after-middle',
  'steady-state': 'none',
};

async function runCycle(parameters: CycleScenario, context: RunContext): Promise<RunReport> {
  const built = buildWorld(() => cycleWorld(parameters, context.clock));
  const reportTransactions = expectedReportTransactions({
    targets: built.world.targets,
    markets: CYCLE_MARKETS,
    decision: parameters.decision,
    maxSignalBatchSize: DEFAULT_SETTINGS.maxSignalBatchSize,
  });
  const decision = DECISIONS[parameters.decision];
  const harness = harnessOf(built.world.chain, context.clock, {
    ...DEFAULT_SETTINGS,
    rpcLatency: { everyRequestMs: parameters.rpcLatencyMs, byLabelMs: new Map() },
    provider: { decide: () => decision, latency: { kind: 'virtual', ms: parameters.providerLatencyMs } },
    onIncluded: faultHook(CYCLE_FAULTS[parameters.profile], reportTransactions, built.world.chain, context.clock),
  });
  const attempts = parameters.profile === 'restart-after-stale' ? 2 : 1;
  return measured(harness, built.stats, async () => {
    const run = await cycleAttempts(harness, attempts);
    return cycleMeasurement(parameters, { harness, run, world: built.world, reportTransactions });
  });
}

interface CycleRun {
  readonly outcomes: readonly string[];
  readonly anchorsByAttempt: readonly number[];
}

async function cycleAttempts(harness: Harness, attempts: number): Promise<CycleRun> {
  const outcomes: string[] = [];
  const anchorsByAttempt: number[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const anchorsBefore = harness.providers.totals().providerAnchors;
    const result = await settle(() => harness.guardian.cycle(null), outcomeOf);
    outcomes.push(result.outcome);
    anchorsByAttempt.push(harness.providers.totals().providerAnchors - anchorsBefore);
    if (result.outcome === 'attested') {
      break;
    }
  }
  return { outcomes, anchorsByAttempt };
}

function cycleMeasurement(
  parameters: CycleScenario,
  input: {
    readonly harness: Harness;
    readonly run: CycleRun;
    readonly world: CycleWorld;
    readonly reportTransactions: number;
  },
): Measured {
  const outcome = input.run.outcomes.at(-1) ?? 'error:no attempt';
  const [original = 0, reprocessed = 0] = input.run.anchorsByAttempt;
  return {
    outcome,
    counts: {
      supplies: input.world.supplies,
      anchors: input.world.anchors,
      targets: input.world.targets,
      restarts: input.run.outcomes.length - 1,
      originalAnchors: original,
      reprocessedAnchors: reprocessed,
      ...livenessCounts(input.harness),
    },
    checks: cycleChecks(parameters, outcome, input),
  };
}

function cycleChecks(
  parameters: CycleScenario,
  outcome: string,
  input: { readonly harness: Harness; readonly run: CycleRun; readonly reportTransactions: number },
): Check[] {
  const checks = [outcomeCheck(expectedCycleOutcome(parameters), outcome)];
  if (parameters.profile === 'restart-after-stale') {
    checks.push(check('first attempt', 'stale:report-block-aged-out', input.run.outcomes[0] ?? 'none'));
  }
  const isCleanAttestation = outcome === 'attested' && input.run.outcomes.length === 1;
  if (isCleanAttestation) {
    checks.push(check('transactions', input.reportTransactions + 1, input.harness.client.deliveries().length));
    checks.push(heartbeatCheck(input.harness));
  }
  return checks;
}

/** A quiet steady-state cycle owes no heartbeat until the idle interval passes. */
function expectedCycleOutcome(parameters: CycleScenario): string | null {
  if (parameters.profile === 'steady-state') {
    return parameters.freshSupplies > 0 ? 'attested' : 'nothing-due:no-work-and-idle-heartbeat-not-due';
  }
  return CYCLE_OUTCOMES[parameters.profile];
}

function outcomeCheck(expected: string | null, outcome: string): Check {
  if (expected === null) {
    const kind = outcomeKind(outcome);
    const isSettled = kind === 'attested' || kind === 'stale';
    return check('outcome', 'attested or stale', isSettled ? 'attested or stale' : outcome);
  }
  const actual = expected === 'error' ? outcomeKind(outcome) : outcome;
  return check('outcome', expected, actual);
}

function heartbeatCheck(harness: Harness): Check {
  const reportBlocks = harness.plans.reportBlocks();
  const expected = reportBlocks === undefined ? 0 : timestampOf(reportBlocks.last);
  return check('stored heartbeat', expected, harness.chain.heartbeatTimestamp());
}

// ─── Liveness: how many targets one submission can confirm before the report block ages out.

interface Probe {
  readonly targets: number;
  readonly harness: Harness;
  readonly outcome: string;
}

async function runLiveness(parameters: LivenessScenario, context: RunContext): Promise<RunReport> {
  const window = new ResourceWindow();
  const capacity = await capacityOf(parameters, context);
  const atCapacity = await submissionProbe(parameters, capacity, context);
  const beyond =
    capacity < parameters.maxTargets ? await submissionProbe(parameters, capacity + 1, context) : undefined;
  return reportOf(atCapacity.harness, {
    usage: window.close(),
    stats: {},
    result: {
      outcome: `capacity ${String(capacity)}`,
      counts: {
        capacityTargets: capacity,
        capacityBatches: expectedReportTransactions({ ...parameters, targets: capacity }),
        targets: capacity,
        anchors: capacity,
        ...livenessCounts(atCapacity.harness),
      },
      checks: [
        check('capacity attests', 'attested', atCapacity.outcome),
        ...(beyond === undefined ? [] : [check('one more target', 'stale:report-block-aged-out', beyond.outcome)]),
      ],
    },
  });
}

/** The largest target count that still attests, by bisection: more targets never need fewer blocks. */
async function capacityOf(parameters: LivenessScenario, context: RunContext): Promise<number> {
  if ((await submissionProbe(parameters, parameters.maxTargets, context)).outcome === 'attested') {
    return parameters.maxTargets;
  }
  let attests = 0;
  let fails = parameters.maxTargets;
  while (fails - attests > 1) {
    const middle = Math.floor((attests + fails) / 2);
    const probe = await submissionProbe(parameters, middle, context);
    if (probe.outcome === 'attested') {
      attests = middle;
    } else {
      fails = middle;
    }
  }
  return attests;
}

async function submissionProbe(parameters: LivenessScenario, targets: number, context: RunContext): Promise<Probe> {
  const chain = quietWorld(context.clock);
  const harness = harnessOf(chain, context.clock, {
    ...DEFAULT_SETTINGS,
    maxSignalBatchSize: parameters.maxSignalBatchSize,
    txConfirmationBlocks: parameters.txConfirmationBlocks,
    interBatchConfirmationBlocks: parameters.interBatchConfirmationBlocks,
    inclusionBlocks: parameters.inclusionBlocks,
  });
  const plan = await planOf(harness);
  const screened = submissionInput(
    plan,
    { targets, markets: parameters.markets, decision: parameters.decision },
    chain,
  );
  const result = await settle(() => harness.guardian.signalAndHeartbeat(screened), outcomeOf);
  return { targets, harness, outcome: result.outcome };
}

// ─── Shared construction and measurement.

function harnessOf(chain: SyntheticChain, clock: VirtualClock, settings: GuardianSettings): Harness {
  const rpc = new RpcMeter();
  const providers = new ProviderMeter();
  const phases = new PhaseTimer(rpc);
  const plans = new PlanRecorder();
  const client = new SyntheticClient({
    node: measuredNode(chain, rpc, settings.rpcLatency),
    chain,
    signer: DELEGATE,
    maxLogBlockRange: settings.maxLogBlockRange,
    inclusionBlocks: settings.inclusionBlocks,
    onIncluded: settings.onIncluded,
  });
  const guardian = new Guardian({
    client,
    expectedDelegate: DELEGATE,
    guardian: GUARDIAN,
    deployment: {
      chainId: CHAIN_ID,
      slotSeconds: SLOT_SECONDS,
      lidoLend: { address: CORE, deploymentBlock: chain.layout.coreDeploymentBlock },
      guardianSignals: { address: REGISTRY, deploymentBlock: chain.layout.registryDeploymentBlock },
    },
    screening: providers.provider(settings.provider, clock),
    onEvent: (event) => {
      phases.onEvent(event);
      plans.onEvent(event);
    },
    reportBlockLag: REPORT_BLOCK_LAG,
    flaggerReadConcurrency: settings.flaggerReadConcurrency,
    historyReadConcurrency: settings.historyReadConcurrency,
    interBatchConfirmationBlocks: settings.interBatchConfirmationBlocks,
    maxSignalBatchSize: settings.maxSignalBatchSize,
    idleHeartbeatInterval: IDLE_HEARTBEAT_INTERVAL_SECONDS,
    heartbeatReserveBlocks: HEARTBEAT_RESERVE_BLOCKS,
    txConfirmationBlocks: settings.txConfirmationBlocks,
  });
  return { chain, rpc, providers, phases, plans, client, guardian };
}

async function planOf(harness: Harness): Promise<ScanPlan> {
  const plan = await harness.phases.time('plan', () => harness.guardian.buildScanPlan());
  if (plan.kind !== 'plan') {
    throw new Error(`Expected a scan plan, got ${plan.reason}`);
  }
  harness.plans.record(plan);
  return plan;
}

async function measured(
  harness: Harness,
  stats: Readonly<Record<string, number>>,
  operation: () => Promise<Measured>,
): Promise<RunReport> {
  const window = new ResourceWindow();
  const result = await operation().catch((error: unknown): Measured => {
    const outcome = outcomeOfError(error);
    return { outcome, counts: {}, checks: [check('operation completed', 'completed', outcome)] };
  });
  return reportOf(harness, { usage: window.close(), stats, result });
}

function reportOf(
  harness: Harness,
  input: {
    readonly usage: ResourceUsage;
    readonly stats: Readonly<Record<string, number>>;
    readonly result: Measured;
  },
): RunReport {
  const rpc = harness.rpc.totals();
  const provider = harness.providers.totals();
  const transactions = transactionCounts(harness.client.deliveries());
  const { counts } = input.result;
  const work: WorkCounts = {
    supplies: counts.supplies ?? 0,
    anchors: counts.anchors ?? 0,
    targets: counts.targets ?? 0,
    reportTransactions: transactions.reportTransactions,
    originalAnchors: counts.originalAnchors ?? 0,
    reprocessedAnchors: counts.reprocessedAnchors ?? 0,
  };
  return {
    outcome: input.result.outcome,
    metrics: {
      ...input.usage,
      ...input.stats,
      ...rpc,
      ...provider,
      ...transactions,
      ...harness.phases.durationsMs(),
      ...counts,
      ...amplificationOf(rpc, provider, work),
    },
    rpcByPhase: harness.rpc.byPhase(),
    checks: input.result.checks,
  };
}

function transactionCounts(deliveries: readonly Delivery[]): {
  readonly transactions: number;
  readonly reportTransactions: number;
  readonly heartbeatTransactions: number;
  readonly revertedTransactions: number;
} {
  const heartbeats = deliveries.filter((delivery) => delivery.method === 'heartbeat').length;
  return {
    transactions: deliveries.length,
    reportTransactions: deliveries.length - heartbeats,
    heartbeatTransactions: heartbeats,
    revertedTransactions: deliveries.filter((delivery) => delivery.status === 'reverted').length,
  };
}

/** Where the blockhash budget went: from planning to the heartbeat broadcast, or to the stop. */
function livenessCounts(harness: Harness): Record<string, number> {
  const reportBlocks = harness.plans.reportBlocks();
  if (reportBlocks === undefined) {
    return {};
  }
  const deliveries = harness.client.deliveries();
  const heartbeat = deliveries.find((delivery) => delivery.method === 'heartbeat');
  const headAtPlanning = reportBlocks.first + REPORT_BLOCK_LAG;
  const headAtHeartbeat = heartbeat?.headAtBroadcast ?? harness.chain.head();
  return {
    reportBlock: reportBlocks.last,
    headAtPlanning,
    headAtHeartbeat,
    blocksConsumed: headAtHeartbeat - headAtPlanning,
    remainingBudgetBlocks: BLOCKHASH_LOOKBACK - HEARTBEAT_RESERVE_BLOCKS - (headAtHeartbeat - reportBlocks.last),
  };
}

async function settle<Result>(run: () => Promise<Result>, label: (result: Result) => string): Promise<Settled<Result>> {
  try {
    const value = await run();
    return { outcome: label(value), value };
  } catch (error) {
    return { outcome: outcomeOfError(error), value: undefined };
  }
}

function outcomeOf(outcome: CycleOutcome): string {
  switch (outcome.kind) {
    case 'attested':
      return 'attested';
    case 'stale':
      return `stale:${outcome.reason}`;
    case 'nothing-due':
      return `nothing-due:${outcome.reason}`;
    case 'observed':
      return 'observed';
  }
}

function outcomeOfError(error: unknown): string {
  if (error instanceof GuardianStop) {
    return `stop:${error.reason}`;
  }
  const message = error instanceof Error ? error.message : 'unknown failure';
  return `error:${message.slice(0, 100)}`;
}

function outcomeKind(outcome: string): string {
  return outcome.split(':')[0] ?? outcome;
}
