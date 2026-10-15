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
  GriefingAttack,
  GriefingScenario,
  LivenessScenario,
  ReconstructionScenario,
  ReportsScenario,
  Scenario,
  ScreeningScenario,
  SubmissionFault,
} from './scenarios.ts';
import { startChainServer } from './chain-client.ts';
import type { RemoteChain, WorldFacts } from './chain-client.ts';
import { SyntheticClient } from './synthetic-client.ts';
import type { Delivery } from './synthetic-client.ts';
import { BLOCKHASH_LOOKBACK, CHAIN_ID, ProviderQueue, SLOT_SECONDS, timestampOf } from './synthetic-rpc.ts';
import type { ProviderProfile, RpcLatency, VirtualClock } from './synthetic-rpc.ts';
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
  SCREENING_MARKETS,
  positionAt,
  countScreeningTargets,
  syntheticAnchor,
} from './worlds.ts';

const HEARTBEAT_RESERVE_BLOCKS = 8;

const IDLE_HEARTBEAT_INTERVAL_SECONDS = 12 * 60 * 60;

/** The SDK's bound on a screening answer; the measured providers answer within their modelled delay. */
const SCREENING_TIMEOUT_MS = 300_000;

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
  readonly presetName: string;
  readonly scenarioId: string;
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
  /** A paid shared provider's delays and log limit instead of `rpcLatency`, when set. */
  readonly providerProfile: ProviderProfile | undefined;
  readonly provider: ProviderPlan;
  readonly onIncluded: ((delivery: Delivery) => Promise<void>) | undefined;
  /** Sees every SDK event after the harness's own observers. */
  readonly onEvent: ((event: SdkEvent) => void) | undefined;
}

const DEFAULT_SETTINGS: GuardianSettings = {
  maxLogBlockRange: 10_000,
  flaggerReadConcurrency: 8,
  historyReadConcurrency: 8,
  maxSignalBatchSize: 50,
  txConfirmationBlocks: 12,
  interBatchConfirmationBlocks: 1,
  inclusionBlocks: 1,
  rpcLatency: NO_LATENCY,
  providerProfile: undefined,
  provider: { decide: () => CLEAN, latency: { kind: 'real', ms: 0 } },
  onIncluded: undefined,
  onEvent: undefined,
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
  readonly chain: RemoteChain;
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
  const context: RunContext = { clock, presetName, scenarioId: scenario.id };
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
    case 'griefing':
      return runGriefing(parameters, context);
    case 'anvil':
      return runAnvil(parameters);
  }
}

// ─── Discovery: supply logs in chunks, controller bindings and lifecycle logs in chunks.

async function runDiscovery(parameters: DiscoveryScenario, context: RunContext): Promise<RunReport> {
  return runOnChainServer(context, async (chain) => {
    const world = await chain.build(context.presetName, context.scenarioId);
    const harness = harnessOf(chain, world, context.clock, {
      ...DEFAULT_SETTINGS,
      maxLogBlockRange: parameters.maxLogBlockRange,
    });
    return measured(harness, world.stats, () => discoveryMeasurement(parameters, harness, world));
  });
}

async function discoveryMeasurement(
  parameters: DiscoveryScenario,
  harness: Harness,
  world: WorldFacts,
): Promise<Measured> {
  const plan = await planOf(harness);
  const discovered = await harness.phases.time('discovery', () => harness.guardian.discoverCandidatePositions(plan));
  const candidates = discovered.all().length;
  const targetControllers = readFact(world, 'targetControllers');
  const chunks = Math.ceil(parameters.rangeBlocks / parameters.maxLogBlockRange);
  // Each piece of supplies reads its controllers from the first unread block through its last supply, and
  // the candidates' controllers are read once more through the report block. Those reads span at most the
  // window and each adds at most one partial chunk, so they never grow with the number of supplies.
  const controllerReads = harness.rpc.count('discovery', 'eth_getLogs:controller-range');
  const readBounds = `${String(targetControllers)} to ${String(targetControllers * (2 * chunks + 1))}`;
  const isWithinBounds =
    controllerReads >= targetControllers && controllerReads <= targetControllers * (2 * chunks + 1);
  return {
    outcome: 'discovered',
    counts: { supplies: parameters.supplies, candidates },
    checks: [
      check('candidate positions', readFact(world, 'candidates'), candidates),
      check('core log chunks', chunks, harness.rpc.count('discovery', 'eth_getLogs:core-range')),
      check('controller log reads', readBounds, isWithinBounds ? readBounds : controllerReads),
      check(
        'market controller reads',
        readFact(world, 'markets'),
        harness.rpc.count('discovery', 'eth_call:marketController'),
      ),
      check(
        'controller registry reads',
        readFact(world, 'controllers'),
        harness.rpc.count('discovery', 'eth_call:guardianSignals'),
      ),
    ],
  };
}

// ─── Reconstruction: backward lifecycle walks, wide or deep.

async function runReconstruction(parameters: ReconstructionScenario, context: RunContext): Promise<RunReport> {
  return runOnChainServer(context, async (chain) => {
    const world = await chain.build(context.presetName, context.scenarioId);
    const harness = harnessOf(chain, world, context.clock, {
      ...DEFAULT_SETTINGS,
      maxLogBlockRange: parameters.maxLogBlockRange,
    });
    return measured(harness, world.stats, async () => {
      const plan = await planOf(harness);
      const discovered = await harness.phases.time('discovery', () =>
        harness.guardian.discoverCandidatePositions(plan),
      );
      const work = await harness.phases.time('reconstruction', () => harness.guardian.reconstructWork(discovered));
      return {
        outcome: 'reconstructed',
        counts: {
          supplies: readFact(world, 'supplies'),
          candidates: discovered.all().length,
          positions: work.positions,
          anchors: work.anchors,
          historyEvents: readFact(world, 'events'),
          controllerRangeCalls: harness.rpc.count('reconstruction', 'eth_getLogs:controller-range'),
        },
        checks: [
          check('work anchors', readFact(world, 'anchors'), work.anchors),
          check('work positions', parameters.positions, work.positions),
        ],
      };
    });
  });
}

// ─── Screening: own-flag reads, the provider request and positional validation.

async function runScreening(parameters: ScreeningScenario, context: RunContext): Promise<RunReport> {
  return runOnChainServer(context, async (chain) => {
    const world = await chain.build(context.presetName, context.scenarioId);
    const harness = harnessOf(chain, world, context.clock, {
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
    return measured(harness, world.stats, () => screeningMeasurement(parameters, harness, plan));
  });
}

async function screeningMeasurement(
  parameters: ScreeningScenario,
  harness: Harness,
  plan: ScanPlan,
): Promise<Measured> {
  const input = screeningInput(parameters, plan);
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
}

function isIncompleteAt(incomplete: ScreeningScenario['incomplete'], index: number, count: number): boolean {
  if (incomplete === 'first') {
    return index === 0;
  }
  return incomplete === 'last' ? index === count - 1 : false;
}

/** The screening scenario's work; the chain server's world holds this Guardian's flags on the first targets. */
function screeningInput(
  parameters: ScreeningScenario,
  plan: ScanPlan,
): { readonly work: Work; readonly targets: number; readonly ownFlagged: number } {
  const { targets, ownFlagged } = countScreeningTargets(parameters);
  const byPosition = new Map<PositionKey, readonly SupplyAnchor[]>();
  for (let target = 0; target < targets; target += 1) {
    const position = positionAt(target, SCREENING_MARKETS);
    const anchors = Array.from({ length: parameters.anchorsPerTarget }, (_anchor, index) =>
      syntheticAnchor(position, target * parameters.anchorsPerTarget + index),
    );
    byPosition.set(position, anchors);
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
  'receipt-lost-after-last': 'attested',
};

async function runReports(parameters: ReportsScenario, context: RunContext): Promise<RunReport> {
  return runOnChainServer(context, async (chain) => {
    const world = await chain.build(context.presetName, context.scenarioId);
    const reportTransactions = expectedReportTransactions(parameters);
    const harness = harnessOf(chain, world, context.clock, {
      ...DEFAULT_SETTINGS,
      maxSignalBatchSize: parameters.maxSignalBatchSize,
      txConfirmationBlocks: parameters.txConfirmationBlocks,
      interBatchConfirmationBlocks: parameters.interBatchConfirmationBlocks,
      onIncluded: faultHook(parameters.fault, reportTransactions, chain, context.clock),
    });
    const plan = await planOf(harness);
    const screened = submissionInput(plan, parameters);
    return measured(harness, world.stats, async () => {
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
          ...(await livenessCounts(harness)),
        },
        checks: reportChecks(parameters, { outcome: result.outcome, harness, reportTransactions }),
      };
    });
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
): Screened {
  const byPosition = new Map<PositionKey, readonly SupplyAnchor[]>();
  const pending: PendingTarget[] = [];
  for (let target = 0; target < parameters.targets; target += 1) {
    const position = positionAt(target, parameters.markets);
    const anchors = [syntheticAnchor(position, target)];
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
  chain: RemoteChain,
  clock: VirtualClock,
): ((delivery: Delivery) => Promise<void>) | undefined {
  if (fault === 'none') {
    return undefined;
  }
  const trigger = triggerOf(fault, reportTransactions);
  let hasFired = false;
  return async (delivery) => {
    const isTrigger = delivery.method !== 'heartbeat' && delivery.sequence === trigger;
    if (!isTrigger || hasFired) {
      return;
    }
    hasFired = true;
    await applyFault(fault, delivery, chain, clock);
  };
}

function triggerOf(fault: SubmissionFault, reportTransactions: number): number {
  if (fault.endsWith('-first')) {
    return 0;
  }
  return fault.endsWith('-middle') ? Math.floor((reportTransactions - 1) / 2) : reportTransactions - 1;
}

async function applyFault(
  fault: SubmissionFault,
  delivery: Delivery,
  chain: RemoteChain,
  clock: VirtualClock,
): Promise<void> {
  if (fault.startsWith('reorg-')) {
    await chain.reorgFrom(REPORT_BLOCK);
    return;
  }
  if (fault.startsWith('age-out-')) {
    clock.advanceSlots(BLOCKHASH_LOOKBACK);
    return;
  }
  await chain.dropTransaction(delivery.hash);
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
  'lost-confirmation': 'attested',
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
  return runOnChainServer(context, async (chain) => {
    const world = await chain.build(context.presetName, context.scenarioId);
    const reportTransactions = expectedReportTransactions({
      targets: readFact(world, 'targets'),
      markets: CYCLE_MARKETS,
      decision: parameters.decision,
      maxSignalBatchSize: DEFAULT_SETTINGS.maxSignalBatchSize,
    });
    const decision = DECISIONS[parameters.decision];
    const harness = harnessOf(chain, world, context.clock, {
      ...DEFAULT_SETTINGS,
      rpcLatency: { everyRequestMs: parameters.rpcLatencyMs, byLabelMs: new Map() },
      provider: { decide: () => decision, latency: { kind: 'virtual', ms: parameters.providerLatencyMs } },
      onIncluded: faultHook(CYCLE_FAULTS[parameters.profile], reportTransactions, chain, context.clock),
    });
    const attempts = parameters.profile === 'restart-after-stale' ? 2 : 1;
    return measured(harness, world.stats, async () => {
      const run = await cycleAttempts(harness, attempts);
      return cycleMeasurement(parameters, { harness, run, world, reportTransactions });
    });
  });
}

interface CycleRun {
  readonly outcomes: readonly string[];
  readonly anchorsByAttempt: readonly number[];
}

async function cycleAttempts(harness: Harness, attempts: number): Promise<CycleRun> {
  const outcomes: string[] = [];
  const anchorsByAttempt: number[] = [];
  // A stale attempt hands its work to the next one, as the daemon's replan does.
  let earlierWork: Work | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const anchorsBefore = harness.providers.totals().providerAnchors;
    const result = await settle(() => harness.guardian.cycle(null, earlierWork), outcomeOf);
    outcomes.push(result.outcome);
    anchorsByAttempt.push(harness.providers.totals().providerAnchors - anchorsBefore);
    if (result.outcome === 'attested') {
      break;
    }
    earlierWork = result.value?.kind === 'stale' ? result.value.work : undefined;
  }
  return { outcomes, anchorsByAttempt };
}

async function cycleMeasurement(
  parameters: CycleScenario,
  input: {
    readonly harness: Harness;
    readonly run: CycleRun;
    readonly world: WorldFacts;
    readonly reportTransactions: number;
  },
): Promise<Measured> {
  const outcome = input.run.outcomes.at(-1) ?? 'error:no attempt';
  const [original = 0, reprocessed = 0] = input.run.anchorsByAttempt;
  return {
    outcome,
    counts: {
      supplies: readFact(input.world, 'supplies'),
      anchors: readFact(input.world, 'anchors'),
      targets: readFact(input.world, 'targets'),
      restarts: input.run.outcomes.length - 1,
      originalAnchors: original,
      reprocessedAnchors: reprocessed,
      ...(await livenessCounts(input.harness)),
    },
    checks: await cycleChecks(parameters, outcome, input),
  };
}

async function cycleChecks(
  parameters: CycleScenario,
  outcome: string,
  input: { readonly harness: Harness; readonly run: CycleRun; readonly reportTransactions: number },
): Promise<Check[]> {
  const checks = [outcomeCheck(expectedCycleOutcome(parameters), outcome)];
  if (parameters.profile === 'restart-after-stale') {
    checks.push(check('first attempt', 'stale:report-block-aged-out', input.run.outcomes[0] ?? 'none'));
  }
  const isCleanAttestation = outcome === 'attested' && input.run.outcomes.length === 1;
  if (isCleanAttestation) {
    // The report whose receipt the fault drops is sent once more before the heartbeat.
    const resends = CYCLE_FAULTS[parameters.profile] === 'receipt-lost-after-last' ? 1 : 0;
    const transactions = input.reportTransactions + resends + 1;
    checks.push(check('transactions', transactions, input.harness.client.deliveries().length));
    checks.push(await heartbeatCheck(input.harness));
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

async function heartbeatCheck(harness: Harness): Promise<Check> {
  const reportBlocks = harness.plans.reportBlocks();
  const expected = reportBlocks === undefined ? 0 : timestampOf(reportBlocks.last);
  return check('stored heartbeat', expected, await harness.chain.heartbeatTimestamp());
}

// ─── Liveness: how many targets one submission can confirm before the report block ages out.

interface Probe {
  readonly targets: number;
  readonly harness: Harness;
  readonly outcome: string;
  /** Stale plans replanned before the outcome. */
  readonly restarts: number;
}

async function runLiveness(parameters: LivenessScenario, context: RunContext): Promise<RunReport> {
  return runOnChainServer(context, async (chain) => {
    const window = new ResourceWindow();
    const capacity = await capacityOf(parameters, context, chain);
    const atCapacity = await cycleProbe(parameters, capacity, context, chain);
    const atCapacityCounts = await livenessCounts(atCapacity.harness);
    const isBelowBound = capacity < parameters.maxTargets;
    const beyond = isBelowBound ? await cycleProbe(parameters, capacity + 1, context, chain) : undefined;
    return reportOf(atCapacity.harness, {
      usage: window.close(),
      stats: {},
      result: {
        outcome: `capacity ${String(capacity)}`,
        counts: {
          capacityTargets: capacity,
          capacityBatches: expectedReportTransactions({ ...parameters, targets: capacity }),
          restarts: atCapacity.restarts,
          targets: capacity,
          anchors: capacity,
          ...atCapacityCounts,
        },
        checks: [
          check('capacity attests', 'attested', atCapacity.outcome),
          ...(beyond === undefined ? [] : [check('one more target', 'stale:report-block-aged-out', beyond.outcome)]),
        ],
      },
    });
  });
}

/** The largest target count that still attests, by bisection: more targets never need fewer blocks. */
async function capacityOf(parameters: LivenessScenario, context: RunContext, chain: RemoteChain): Promise<number> {
  if ((await cycleProbe(parameters, parameters.maxTargets, context, chain)).outcome === 'attested') {
    return parameters.maxTargets;
  }
  let attests = 0;
  let fails = parameters.maxTargets;
  while (fails - attests > 1) {
    const middle = Math.floor((attests + fails) / 2);
    const probe = await cycleProbe(parameters, middle, context, chain);
    if (probe.outcome === 'attested') {
      attests = middle;
    } else {
      fails = middle;
    }
  }
  return attests;
}

/**
 * A Guardian's first cycle over `targets` due positions against the modelled provider: it reads every
 * position's history, screens it with the scenario's decision and delay, then reports and attests.
 */
async function cycleProbe(
  parameters: LivenessScenario,
  targets: number,
  context: RunContext,
  chain: RemoteChain,
): Promise<Probe> {
  // The provider's delays are shorter than a slot, so every probe starts at a slot boundary; otherwise
  // where in its first slot a probe began could move its outcome near the capacity.
  context.clock.advanceSlots(1);
  const world = await chain.build(context.presetName, context.scenarioId, targets);
  const harness = harnessOf(chain, world, context.clock, {
    ...DEFAULT_SETTINGS,
    maxSignalBatchSize: parameters.maxSignalBatchSize,
    txConfirmationBlocks: parameters.txConfirmationBlocks,
    interBatchConfirmationBlocks: parameters.interBatchConfirmationBlocks,
    inclusionBlocks: parameters.inclusionBlocks,
    providerProfile: { queue: new ProviderQueue(context.clock), logLimit: undefined },
    provider: {
      decide: () => DECISIONS[parameters.decision],
      latency: { kind: 'virtual', ms: parameters.screeningLatencyMs },
    },
  });
  // A stale plan is replanned at once, up to the budget, from the work of the stale attempt.
  let earlierWork: Work | undefined;
  let restarts = 0;
  while (true) {
    const result = await settle(() => harness.guardian.cycle(null, earlierWork), outcomeOf);
    if (result.value?.kind !== 'stale' || restarts === parameters.restarts) {
      return { targets, harness, outcome: result.outcome, restarts };
    }
    restarts += 1;
    earlierWork = result.value.work;
  }
}

// ─── Griefing: the largest attack a first cycle still attests through, and what exceeding it costs.

/** The log list limit of a capped provider, as major public providers set it. */
const PROVIDER_LOG_LIMIT = 10_000;

/**
 * Memory a cycle may add to the process before the attack counts as exceeding the Guardian: the
 * daemon's default heap of 3,072 MB less the about 270 MB an idle daemon holds in its container.
 */
const MEMORY_LIMIT_MB = 2_800;

const MEMORY_SAMPLE_INTERVAL_MS = 50;

/**
 * Mainnet base fees over 30 days of 2026, in gwei: the 10th percentile, which an attacker who waits for
 * cheap blocks pays, and the median.
 */
const CHEAP_BASE_FEE_GWEI = 0.07;

const MEDIAN_BASE_FEE_GWEI = 0.35;

const GWEI_PER_ETH = 1e9;

/**
 * Gas of one attacker operation on the pinned contracts, measured on Anvil with single transactions:
 * a dust deposit to its own address and its withdrawal; a lot deposit to a new address and its
 * withdrawal; a lot deposit to a new address.
 */
const OPERATION_GAS: Readonly<Record<GriefingAttack, number>> = {
  'discovery-flood': 156_846 + 106_119,
  'candidate-flood': 205_320 + 109_868,
  'report-flood': 205_320,
};

/** The first attack size tried; the search doubles it until the cycle breaks. */
const FIRST_PROBE_OPERATIONS = 100;

/** The search stops once the break lies within this share above the largest attack that attested. */
const SEARCH_PRECISION = 0.02;

/** One attack of `operations` against a Guardian's first cycle. */
interface GriefingProbe {
  readonly operations: number;
  readonly outcome: string;
  /** Why the attack exceeded the Guardian, or null when the cycle attested within the memory limit. */
  readonly failure: string | null;
  readonly candidates: number;
  readonly metrics: Readonly<Record<string, number>>;
}

async function runGriefing(parameters: GriefingScenario, context: RunContext): Promise<RunReport> {
  const window = new ResourceWindow();
  const search = await runOnChainServer(context, (chain) => searchCapacity(parameters, context, chain));
  const usage = window.close();
  const { fits, breaks } = search;
  const capacity = fits?.operations ?? 0;
  const beyond = breaks === undefined ? 'search bound reached' : `beyond: ${breaks.failure ?? 'none'}`;
  // The attack that attested must have made the scan do the work the attack stands for.
  const checks =
    fits === undefined
      ? []
      : [
          check('capacity probe', 'attested', fits.outcome),
          check('positions scanned', expectedCandidates(parameters.attack, capacity), fits.candidates),
        ];
  return {
    outcome: `capacity ${String(capacity)}; ${beyond}`,
    metrics: {
      ...usage,
      ...fits?.metrics,
      capacity,
      probes: search.probes,
      ...attackCost(parameters.attack, capacity + 1),
    },
    rpcByPhase: {},
    checks,
  };
}

/** Only kept lots stay candidates: discovery discards dust and lots withdrawn in full. */
function expectedCandidates(attack: GriefingAttack, operations: number): number {
  return attack === 'report-flood' ? operations : 0;
}

/** The probes that bracket a Guardian's capacity, and how many the search ran. */
interface CapacitySearch {
  readonly fits: GriefingProbe | undefined;
  readonly breaks: GriefingProbe | undefined;
  readonly probes: number;
}

/**
 * The largest attack that still attests: double from a hundred operations until one breaks the cycle
 * or the bound is reached, then bisect to within two percent.
 */
async function searchCapacity(
  parameters: GriefingScenario,
  context: RunContext,
  chain: RemoteChain,
): Promise<CapacitySearch> {
  const doubled = await doubleUntilBreak(parameters, context, chain);
  const { breaks } = doubled;
  return breaks === undefined ? doubled : bisect(parameters, { context, chain }, { ...doubled, breaks });
}

async function doubleUntilBreak(
  parameters: GriefingScenario,
  context: RunContext,
  chain: RemoteChain,
): Promise<CapacitySearch> {
  let fits: GriefingProbe | undefined;
  let probes = 0;
  const bound = searchBound(parameters);
  let operations = Math.min(FIRST_PROBE_OPERATIONS, bound);
  while (true) {
    const probe = await griefingProbe(parameters, operations, context, chain);
    probes += 1;
    if (probe.failure !== null) {
      return { fits, breaks: probe, probes };
    }
    fits = probe;
    if (operations === bound) {
      return { fits, breaks: undefined, probes };
    }
    operations = Math.min(operations * 2, bound);
  }
}

/** The largest attack the search tries: the scenario's operations, or fewer when its gas budget buys fewer. */
function searchBound(parameters: GriefingScenario): number {
  const gweiPerOperation = OPERATION_GAS[parameters.attack] * CHEAP_BASE_FEE_GWEI;
  const affordable = Math.floor((parameters.maxAttackCostEth * GWEI_PER_ETH) / gweiPerOperation);
  return Math.min(parameters.maxOperations, affordable);
}

async function bisect(
  parameters: GriefingScenario,
  run: { readonly context: RunContext; readonly chain: RemoteChain },
  bracket: CapacitySearch & { readonly breaks: GriefingProbe },
): Promise<CapacitySearch> {
  let { fits, breaks, probes } = bracket;
  while (true) {
    const low = fits?.operations ?? 0;
    if (breaks.operations - low <= Math.max(1, Math.floor(low * SEARCH_PRECISION))) {
      return { fits, breaks, probes };
    }
    const probe = await griefingProbe(parameters, Math.floor((low + breaks.operations) / 2), run.context, run.chain);
    probes += 1;
    if (probe.failure === null) {
      fits = probe;
    } else {
      breaks = probe;
    }
  }
}

/** Build the attack, run a first cycle against it over the provider, and record what it cost. */
async function griefingProbe(
  parameters: GriefingScenario,
  operations: number,
  context: RunContext,
  chain: RemoteChain,
): Promise<GriefingProbe> {
  const world = await chain.build(context.presetName, context.scenarioId, operations);
  let candidates = 0;
  const harness = harnessOf(chain, world, context.clock, {
    ...DEFAULT_SETTINGS,
    providerProfile: {
      queue: new ProviderQueue(context.clock),
      logLimit: parameters.provider === 'capped' ? PROVIDER_LOG_LIMIT : undefined,
    },
    provider: {
      decide: () => DECISIONS[parameters.attack === 'report-flood' ? 'suspect' : 'clean'],
      latency: { kind: 'virtual', ms: parameters.screeningLatencyMs },
    },
    onEvent: (event) => {
      if (event.event === 'cycle.discovered') {
        candidates = event.positions.length;
      }
    },
  });
  const memory = new MemoryPeak();
  const cpuBefore = process.cpuUsage();
  const outcome = await harness.guardian.cycle(null).then(outcomeOf, griefingFailure);
  const cpu = process.cpuUsage(cpuBefore);
  const memoryGrowthMb = memory.stop();
  const failure = outcome === 'attested' ? memoryFailure(memoryGrowthMb) : outcome;
  return {
    operations,
    outcome,
    failure,
    candidates,
    metrics: {
      ...(await livenessCounts(harness)),
      ...harness.rpc.totals(),
      memoryGrowthMb,
      cycleCpuMs: (cpu.user + cpu.system) / 1_000,
      reportTransactions: transactionCounts(harness.client.deliveries()).reportTransactions,
    },
  };
}

function memoryFailure(memoryGrowthMb: number): string | null {
  return memoryGrowthMb > MEMORY_LIMIT_MB ? `memory above ${String(MEMORY_LIMIT_MB)} MB` : null;
}

/** A provider's or transport's refusal is named by its limit; any other failure keeps its outcome. */
function griefingFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('query returned more than')) {
    return 'provider log limit';
  }
  if (message.includes('exceeds the transport limit')) {
    return 'transport response limit';
  }
  return outcomeOfError(error);
}

/** The attacker's gas to reach `operations`, and its price at both base fees. */
function attackCost(attack: GriefingAttack, operations: number): Record<string, number> {
  const gas = operations * OPERATION_GAS[attack];
  return {
    attackGasMillions: gas / 1e6,
    costEthCheapFee: (gas * CHEAP_BASE_FEE_GWEI) / GWEI_PER_ETH,
    costEthMedianFee: (gas * MEDIAN_BASE_FEE_GWEI) / GWEI_PER_ETH,
    ...(attack === 'report-flood' ? { lotsLocked: operations } : {}),
  };
}

/**
 * Heap in use above what the process held when sampling began, sampled until stopped. Earlier probes
 * leave the process holding free heap pages, so resident memory would hide what a later cycle adds;
 * heap in use also counts garbage between collections, which errs towards a smaller capacity.
 */
class MemoryPeak {
  readonly #baseline: number;

  readonly #timer: ReturnType<typeof setInterval>;

  #peak: number;

  constructor() {
    globalThis.gc?.();
    this.#baseline = process.memoryUsage().heapUsed;
    this.#peak = this.#baseline;
    this.#timer = setInterval(() => {
      this.#peak = Math.max(this.#peak, process.memoryUsage().heapUsed);
    }, MEMORY_SAMPLE_INTERVAL_MS);
  }

  /** Megabytes of the peak above the baseline. */
  stop(): number {
    clearInterval(this.#timer);
    this.#peak = Math.max(this.#peak, process.memoryUsage().heapUsed);
    return (this.#peak - this.#baseline) / 1_048_576;
  }
}

// ─── Shared construction and measurement.

function harnessOf(chain: RemoteChain, world: WorldFacts, clock: VirtualClock, settings: GuardianSettings): Harness {
  const rpc = new RpcMeter();
  const providers = new ProviderMeter();
  const phases = new PhaseTimer(rpc);
  const plans = new PlanRecorder();
  const node = chain.createNodeRequest(rpc, { latency: settings.rpcLatency, provider: settings.providerProfile });
  const client = new SyntheticClient({
    node,
    chain,
    signer: DELEGATE,
    maxLogBlockRange: settings.maxLogBlockRange,
    inclusionBlocks: settings.inclusionBlocks,
    onIncluded: settings.onIncluded,
    providerQueue: settings.providerProfile?.queue,
  });
  const guardian = new Guardian({
    client,
    expectedDelegate: DELEGATE,
    guardian: GUARDIAN,
    deployment: {
      chainId: CHAIN_ID,
      slotSeconds: SLOT_SECONDS,
      lidoLend: { address: CORE, deploymentBlock: readFact(world, 'coreDeploymentBlock') },
      guardianSignals: { address: REGISTRY, deploymentBlock: readFact(world, 'registryDeploymentBlock') },
    },
    screening: providers.provider(settings.provider, clock),
    onEvent: (event) => {
      phases.onEvent(event);
      plans.onEvent(event);
      settings.onEvent?.(event);
    },
    reportBlockLag: REPORT_BLOCK_LAG,
    flaggerReadConcurrency: settings.flaggerReadConcurrency,
    historyReadConcurrency: settings.historyReadConcurrency,
    interBatchConfirmationBlocks: settings.interBatchConfirmationBlocks,
    maxSignalBatchSize: settings.maxSignalBatchSize,
    idleHeartbeatInterval: IDLE_HEARTBEAT_INTERVAL_SECONDS,
    heartbeatReserveBlocks: HEARTBEAT_RESERVE_BLOCKS,
    txConfirmationBlocks: settings.txConfirmationBlocks,
    screeningTimeoutMs: SCREENING_TIMEOUT_MS,
  });
  return { chain, rpc, providers, phases, plans, client, guardian };
}

/** Run `operation` against a chain server of its own, and stop the server afterwards. */
async function runOnChainServer<Result>(
  context: RunContext,
  operation: (chain: RemoteChain) => Promise<Result>,
): Promise<Result> {
  const server = await startChainServer(context.clock);
  try {
    return await operation(server.chain);
  } finally {
    server.stop();
  }
}

/** A number the chain server reported about the world it built. */
function readFact(world: WorldFacts, name: string): number {
  const value = world.facts[name];
  if (value === undefined) {
    throw new Error(`The chain server reported no ${name}`);
  }
  return value;
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
async function livenessCounts(harness: Harness): Promise<Record<string, number>> {
  const reportBlocks = harness.plans.reportBlocks();
  if (reportBlocks === undefined) {
    return {};
  }
  const deliveries = harness.client.deliveries();
  const heartbeat = deliveries.find((delivery) => delivery.method === 'heartbeat');
  const headAtPlanning = reportBlocks.first + REPORT_BLOCK_LAG;
  const headAtHeartbeat = heartbeat?.headAtBroadcast ?? (await harness.chain.head());
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
