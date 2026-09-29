// The benchmark catalogue: every scenario's parameters and the presets that select them. Scenarios
// are plain data; workloads.ts turns one into a synthetic chain and SDK calls. A preset varies one
// dimension at a time around a baseline rather than taking the full Cartesian product.

export type Decision = 'clean' | 'suspect' | 'flag' | 'both';

export interface DiscoveryScenario {
  readonly family: 'discovery';
  /** Blocks from the core deployment through the report block, which is the whole discovery range. */
  readonly rangeBlocks: number;
  readonly maxLogBlockRange: number;
  readonly supplies: number;
  readonly markets: number;
  /** One supply per evenly spaced block, or every supply in the range's first block. */
  readonly layout: 'spread' | 'one-block';
  /** Share of supplies into a market whose controller reports to another registry. */
  readonly foreignShare: number;
  /** Share of supplies that stay dust instead of activating. */
  readonly dustShare: number;
}

/**
 * - `single`: one supply that starts a lot;
 * - `drains`: a lot, then partial drains of its activating balance;
 * - `dust-drains`: dust, partial drains of that dust, then a supply that absorbs it;
 * - `top-ups`: a lot, then supplies that add to it;
 * - `long-gap`: a lot at the core deployment and one top-up near the report block.
 */
export type HistoryPattern = 'single' | 'drains' | 'dust-drains' | 'top-ups' | 'long-gap';

export interface ReconstructionScenario {
  readonly family: 'reconstruction';
  readonly pattern: HistoryPattern;
  readonly positions: number;
  /** Lifecycle events per position; `single` and `long-gap` fix their own. */
  readonly events: number;
  readonly markets: number;
  readonly rangeBlocks: number;
  readonly maxLogBlockRange: number;
}

export interface ScreeningScenario {
  readonly family: 'screening';
  readonly anchors: number;
  readonly anchorsPerTarget: number;
  /** Share of targets this Guardian had already flagged. */
  readonly ownFlagShare: number;
  readonly flaggerReadConcurrency: number;
  /** Real latency of each `getFlaggedBy` read. */
  readonly flaggerLatencyMs: number;
  /** Real latency of the provider call. */
  readonly providerLatencyMs: number;
  /** Where one incomplete result sits in the provider's answer, if anywhere. */
  readonly incomplete: 'none' | 'first' | 'last';
}

/** A fault injected after one report transaction is included. */
export type SubmissionFault =
  | 'none'
  | 'reorg-after-first'
  | 'reorg-after-middle'
  | 'reorg-after-last'
  | 'age-out-after-middle'
  | 'receipt-lost-after-last';

export interface ReportsScenario {
  readonly family: 'reports';
  readonly targets: number;
  readonly markets: number;
  readonly decision: Decision;
  readonly maxSignalBatchSize: number;
  readonly txConfirmationBlocks: number;
  readonly interBatchConfirmationBlocks: number;
  readonly fault: SubmissionFault;
}

export type CycleProfile =
  | 'empty'
  | 'clean'
  | 'reports'
  | 'deep'
  | 'wide'
  | 'provider-latency'
  | 'rpc-latency'
  | 'log-failure'
  | 'reorg-before-heartbeat'
  | 'lost-confirmation'
  | 'restart-after-stale'
  | 'steady-state';

export interface CycleScenario {
  readonly family: 'cycle';
  readonly profile: CycleProfile;
  readonly positions: number;
  /** Lifecycle events per position for the `deep` and `wide` histories. */
  readonly events: number;
  readonly decision: Decision;
  /** Provider latency in chain time only: it costs blocks, not wall-clock time. */
  readonly providerLatencyMs: number;
  /** Real latency of every RPC request. */
  readonly rpcLatencyMs: number;
  /**
   * `steady-state` only: supplies after the previous heartbeat, which is recorded thirty blocks
   * before the report block and covers every earlier supply.
   */
  readonly freshSupplies: number;
}

export interface LivenessScenario {
  readonly family: 'liveness';
  readonly markets: number;
  readonly decision: Exclude<Decision, 'clean'>;
  readonly maxSignalBatchSize: number;
  readonly txConfirmationBlocks: number;
  readonly interBatchConfirmationBlocks: number;
  readonly inclusionBlocks: number;
  /** Upper bound of the target-count search. */
  readonly maxTargets: number;
}

/** How the loopback endpoints behave; see `ENDPOINTS` in loopback.ts for each condition's endpoints. */
export type TransportCondition =
  | 'healthy'
  | 'large-response'
  | 'response-limit'
  | 'http-429'
  | 'http-500'
  | 'rpc-error'
  | 'timeout'
  | 'reset'
  | 'first-down'
  | 'exhausted'
  | 'silent-omission'
  | 'log-quorum'
  | 'log-quorum-lagging'
  | 'observe-cycle'
  | 'observe-cycle-fallback';

export interface TransportScenario {
  readonly family: 'transport';
  readonly condition: TransportCondition;
  /** Logical requests; the observe-cycle conditions make whatever requests one cycle needs. */
  readonly requests: number;
  /** Requests in flight at once. */
  readonly concurrency: number;
  /** Server-side delay before every answer. */
  readonly latencyMs: number;
  /** Supply logs one `eth_getLogs` answer returns; zero requests block headers instead. */
  readonly logs: number;
  /** Timeout of one HTTP attempt. */
  readonly timeoutMs: number;
  /** Positions of the observed cycle world. */
  readonly positions: number;
}

/** The observe cycle of the transport family, run by the SDK alone or as the deployable daemon runs it. */
export interface DaemonScenario {
  readonly family: 'daemon';
  /**
   * - `sdk`: a screening provider in the same process, and events only counted;
   * - `daemon`: screening through the daemon's `HttpScreening`, and every event serialized and posted
   *   to a receiver as the daemon does.
   */
  readonly runner: 'sdk' | 'daemon';
  /** Positions of the observed cycle world. */
  readonly positions: number;
  /** Delay before the receiver answers each post. */
  readonly receiverLatencyMs: number;
}

/** A cycle over the pinned production contracts on a local Anvil chain, through the SDK's own clients. */
export interface AnvilScenario {
  readonly family: 'anvil';
  readonly mode: 'observe' | 'signal';
  /** Real supply transactions written before the cycle. */
  readonly supplies: number;
  /** Supplies credit borrowers round-robin; fewer borrowers means more top-ups per position. */
  readonly borrowers: number;
  readonly decision: Decision;
  /** Milliseconds between blocks mined in the background while a signal submission waits. */
  readonly blockIntervalMs: number;
}

export type ScenarioParameters =
  | DiscoveryScenario
  | ReconstructionScenario
  | ScreeningScenario
  | ReportsScenario
  | CycleScenario
  | LivenessScenario
  | TransportScenario
  | DaemonScenario
  | AnvilScenario;

export type Family = ScenarioParameters['family'];

export interface Scenario {
  readonly id: string;
  readonly seed: number;
  /**
   * Share of wall-clock time that also advances the synthetic chain: 0 counts only simulated waits,
   * 1 lets real processing time consume blocks as it would on a live network.
   */
  readonly realTimeScale: number;
  readonly parameters: ScenarioParameters;
}

export type PresetName = 'smoke' | 'full';

export interface Preset {
  readonly name: PresetName;
  readonly warmup: number;
  readonly repeat: number;
  readonly scenarios: readonly Scenario[];
}

const SEED = 20_260_929;

const DISCOVERY: DiscoveryScenario = {
  family: 'discovery',
  rangeBlocks: 50_400,
  maxLogBlockRange: 10_000,
  supplies: 1_000,
  markets: 10,
  layout: 'spread',
  foreignShare: 0,
  dustShare: 0,
};

const RECONSTRUCTION: ReconstructionScenario = {
  family: 'reconstruction',
  pattern: 'single',
  positions: 1,
  events: 1,
  markets: 10,
  rangeBlocks: 50_400,
  maxLogBlockRange: 10_000,
};

const SCREENING: ScreeningScenario = {
  family: 'screening',
  anchors: 1_000,
  anchorsPerTarget: 1,
  ownFlagShare: 0,
  flaggerReadConcurrency: 8,
  flaggerLatencyMs: 0,
  providerLatencyMs: 0,
  incomplete: 'none',
};

const REPORTS: ReportsScenario = {
  family: 'reports',
  targets: 100,
  markets: 1,
  decision: 'both',
  maxSignalBatchSize: 20,
  txConfirmationBlocks: 12,
  interBatchConfirmationBlocks: 2,
  fault: 'none',
};

const CYCLE: CycleScenario = {
  family: 'cycle',
  profile: 'clean',
  positions: 1_000,
  events: 1,
  decision: 'clean',
  providerLatencyMs: 0,
  rpcLatencyMs: 0,
  freshSupplies: 0,
};

const LIVENESS: LivenessScenario = {
  family: 'liveness',
  markets: 1,
  decision: 'suspect',
  maxSignalBatchSize: 20,
  txConfirmationBlocks: 12,
  interBatchConfirmationBlocks: 2,
  inclusionBlocks: 1,
  maxTargets: 20_000,
};

const TRANSPORT: TransportScenario = {
  family: 'transport',
  condition: 'healthy',
  requests: 200,
  concurrency: 1,
  latencyMs: 2,
  logs: 0,
  timeoutMs: 10_000,
  positions: 0,
};

const DAEMON: DaemonScenario = {
  family: 'daemon',
  runner: 'daemon',
  positions: 1_000,
  receiverLatencyMs: 0,
};

const ANVIL: AnvilScenario = {
  family: 'anvil',
  mode: 'observe',
  supplies: 200,
  borrowers: 200,
  decision: 'clean',
  blockIntervalMs: 50,
};

function fullDiscovery(): DiscoveryScenario[] {
  return [
    ...[1, 1_000, 10_000, 50_400].map((rangeBlocks) => ({ ...DISCOVERY, rangeBlocks })),
    ...[1_000, 5_000, 10_000].map((maxLogBlockRange) => ({ ...DISCOVERY, maxLogBlockRange })),
    ...[1, 100, 1_000, 5_000, 10_000].map((supplies) => ({ ...DISCOVERY, supplies })),
    ...[1, 10, 100].map((markets) => ({ ...DISCOVERY, markets })),
    { ...DISCOVERY, layout: 'one-block' },
    { ...DISCOVERY, foreignShare: 0.5 },
    { ...DISCOVERY, dustShare: 0.5 },
  ];
}

function fullReconstruction(): ReconstructionScenario[] {
  const deepPatterns = ['drains', 'dust-drains', 'top-ups'] as const;
  const longGap = (positions: number, maxLogBlockRange: number): ReconstructionScenario => ({
    ...RECONSTRUCTION,
    pattern: 'long-gap',
    positions,
    maxLogBlockRange,
  });
  return [
    ...[10, 100, 1_000, 5_000].map((positions) => ({ ...RECONSTRUCTION, positions })),
    { ...RECONSTRUCTION, positions: 1_000, markets: 1 },
    ...deepPatterns.flatMap((pattern) =>
      [10, 100, 1_000, 5_000, 10_000].map((events) => ({ ...RECONSTRUCTION, pattern, events })),
    ),
    { ...RECONSTRUCTION, pattern: 'top-ups', positions: 100, events: 10 },
    ...[1, 10, 100, 1_000].flatMap((positions) => [1_000, 10_000].map((range) => longGap(positions, range))),
    { ...longGap(100, 10_000), rangeBlocks: 60_000 },
  ];
}

function fullScreening(): ScreeningScenario[] {
  return [
    ...[1, 100, 1_000, 5_000, 10_000].map((anchors) => ({ ...SCREENING, anchors })),
    { ...SCREENING, anchors: 10_000, anchorsPerTarget: 100 },
    ...[0.5, 1].map((ownFlagShare) => ({ ...SCREENING, anchors: 5_000, ownFlagShare })),
    ...[1, 8, 32].map((flaggerReadConcurrency) => ({ ...SCREENING, flaggerReadConcurrency, flaggerLatencyMs: 2 })),
    { ...SCREENING, providerLatencyMs: 100 },
    ...(['first', 'last'] as const).map((incomplete) => ({ ...SCREENING, anchors: 10_000, incomplete })),
  ];
}

function fullReports(): ReportsScenario[] {
  const faults: readonly SubmissionFault[] = [
    'reorg-after-first',
    'reorg-after-middle',
    'reorg-after-last',
    'age-out-after-middle',
    'receipt-lost-after-last',
  ];
  return [
    ...[1, 20, 100, 1_000, 5_000].map((targets) => ({ ...REPORTS, targets })),
    ...[10, 100].map((markets) => ({ ...REPORTS, targets: 1_000, markets })),
    ...(['clean', 'suspect', 'flag'] as const).map((decision) => ({ ...REPORTS, targets: 1_000, decision })),
    ...[50, 100].map((maxSignalBatchSize) => ({ ...REPORTS, targets: 1_000, maxSignalBatchSize })),
    ...[2, 32].map((txConfirmationBlocks) => ({ ...REPORTS, txConfirmationBlocks })),
    { ...REPORTS, interBatchConfirmationBlocks: 1 },
    ...faults.map((fault) => ({ ...REPORTS, targets: 200, fault })),
  ];
}

function fullCycle(): CycleScenario[] {
  return [
    { ...CYCLE, profile: 'empty', positions: 0 },
    { ...CYCLE, profile: 'clean', positions: 5_000 },
    { ...CYCLE, profile: 'reports', positions: 1_000, decision: 'both' },
    { ...CYCLE, profile: 'deep', positions: 3, events: 5_000 },
    { ...CYCLE, profile: 'wide', positions: 1_000, events: 10 },
    { ...CYCLE, profile: 'provider-latency', providerLatencyMs: 25 * 60_000 },
    { ...CYCLE, profile: 'provider-latency', decision: 'suspect', providerLatencyMs: 40 * 60_000 },
    { ...CYCLE, profile: 'rpc-latency', rpcLatencyMs: 1 },
    { ...CYCLE, profile: 'log-failure' },
    { ...CYCLE, profile: 'reorg-before-heartbeat', positions: 200, decision: 'both' },
    { ...CYCLE, profile: 'lost-confirmation', positions: 200, decision: 'both' },
    { ...CYCLE, profile: 'restart-after-stale', positions: 200, decision: 'both' },
    { ...CYCLE, profile: 'steady-state', positions: 5_000 },
    { ...CYCLE, profile: 'steady-state', positions: 5_000, freshSupplies: 10 },
  ];
}

function fullLiveness(): LivenessScenario[] {
  return [
    LIVENESS,
    { ...LIVENESS, decision: 'both' },
    ...[10, 100].map((markets) => ({ ...LIVENESS, markets })),
    ...[2, 32].map((txConfirmationBlocks) => ({ ...LIVENESS, txConfirmationBlocks })),
    { ...LIVENESS, interBatchConfirmationBlocks: 1 },
    { ...LIVENESS, inclusionBlocks: 2 },
    { ...LIVENESS, maxSignalBatchSize: 100 },
  ];
}

function fullTransport(): TransportScenario[] {
  const fallbacks = ['http-429', 'http-500', 'rpc-error', 'reset', 'first-down'] as const;
  return [
    TRANSPORT,
    { ...TRANSPORT, requests: 2_000, concurrency: 50 },
    { ...TRANSPORT, requests: 10, latencyMs: 500 },
    { ...TRANSPORT, condition: 'large-response', requests: 10, logs: 10_000 },
    { ...TRANSPORT, condition: 'response-limit', requests: 5, logs: 10_000 },
    ...fallbacks.map((condition) => ({ ...TRANSPORT, condition, requests: 100 })),
    { ...TRANSPORT, condition: 'timeout', requests: 20, timeoutMs: 1_000 },
    { ...TRANSPORT, condition: 'exhausted', requests: 10 },
    { ...TRANSPORT, condition: 'silent-omission', requests: 10, logs: 1_000 },
    { ...TRANSPORT, condition: 'log-quorum', requests: 20, logs: 1_000 },
    { ...TRANSPORT, condition: 'log-quorum-lagging', requests: 20, logs: 1_000 },
    { ...TRANSPORT, condition: 'observe-cycle', positions: 1_000 },
    { ...TRANSPORT, condition: 'observe-cycle-fallback', positions: 100, timeoutMs: 200 },
  ];
}

function fullDaemon(): DaemonScenario[] {
  return [{ ...DAEMON, runner: 'sdk' }, DAEMON, { ...DAEMON, receiverLatencyMs: 1_000 }];
}

function fullAnvil(): AnvilScenario[] {
  return [
    ANVIL,
    ...[1_000, 2_000].map((supplies) => ({ ...ANVIL, supplies, borrowers: supplies })),
    { ...ANVIL, supplies: 1_000, borrowers: 10 },
    { ...ANVIL, mode: 'signal', decision: 'both' },
    { ...ANVIL, mode: 'signal', supplies: 1_000, borrowers: 1_000, decision: 'suspect' },
  ];
}

/** Small, deterministic instances of every family: correctness evidence without timing claims. */
function smokeParameters(): ScenarioParameters[] {
  return [
    { ...DISCOVERY, rangeBlocks: 10_000, maxLogBlockRange: 1_000, supplies: 100, foreignShare: 0.2, dustShare: 0.2 },
    { ...DISCOVERY, rangeBlocks: 10_000, maxLogBlockRange: 1_000, supplies: 100, layout: 'one-block' },
    { ...RECONSTRUCTION, positions: 50, rangeBlocks: 10_000, maxLogBlockRange: 1_000 },
    { ...RECONSTRUCTION, pattern: 'drains', events: 100, rangeBlocks: 10_000, maxLogBlockRange: 1_000 },
    { ...RECONSTRUCTION, pattern: 'dust-drains', events: 100, rangeBlocks: 10_000, maxLogBlockRange: 1_000 },
    { ...RECONSTRUCTION, pattern: 'top-ups', events: 50, rangeBlocks: 10_000, maxLogBlockRange: 1_000 },
    { ...RECONSTRUCTION, pattern: 'long-gap', positions: 10, rangeBlocks: 60_000, maxLogBlockRange: 10_000 },
    { ...SCREENING, anchors: 200, anchorsPerTarget: 2, ownFlagShare: 0.5 },
    { ...SCREENING, anchors: 200, incomplete: 'last' },
    { ...REPORTS, targets: 45, markets: 3 },
    { ...REPORTS, targets: 60, fault: 'reorg-after-middle' },
    { ...REPORTS, targets: 60, fault: 'receipt-lost-after-last' },
    { ...CYCLE, profile: 'empty', positions: 0 },
    { ...CYCLE, profile: 'reports', positions: 60, decision: 'both' },
    { ...CYCLE, profile: 'log-failure', positions: 60 },
    { ...CYCLE, profile: 'restart-after-stale', positions: 60, decision: 'both' },
    { ...CYCLE, profile: 'steady-state', positions: 100 },
    { ...CYCLE, profile: 'steady-state', positions: 100, freshSupplies: 5 },
    { ...LIVENESS, maxTargets: 5_000 },
    { ...TRANSPORT, requests: 20 },
    { ...TRANSPORT, condition: 'timeout', requests: 3, timeoutMs: 200 },
    { ...TRANSPORT, condition: 'first-down', requests: 5 },
    { ...TRANSPORT, condition: 'silent-omission', requests: 3, logs: 100 },
    { ...TRANSPORT, condition: 'log-quorum-lagging', requests: 3, logs: 100 },
    { ...TRANSPORT, condition: 'observe-cycle', positions: 50 },
    { ...DAEMON, runner: 'sdk', positions: 50 },
    { ...DAEMON, positions: 50 },
    { ...ANVIL, supplies: 50, borrowers: 50 },
    { ...ANVIL, mode: 'signal', supplies: 20, borrowers: 20, decision: 'both' },
  ];
}

const BASELINES: Readonly<Record<Family, ScenarioParameters>> = {
  discovery: DISCOVERY,
  reconstruction: RECONSTRUCTION,
  screening: SCREENING,
  reports: REPORTS,
  cycle: CYCLE,
  liveness: LIVENESS,
  transport: TRANSPORT,
  daemon: DAEMON,
  anvil: ANVIL,
};

/** A stable name: the family and every parameter that differs from the family's baseline. */
export function scenarioId(parameters: ScenarioParameters): string {
  const baseline: Readonly<Record<string, unknown>> = { ...BASELINES[parameters.family] };
  const { family, ...fields } = parameters;
  const record: Readonly<Record<string, unknown>> = { ...fields };
  const differences = Object.entries(record)
    .filter(([key, value]) => baseline[key] !== value)
    .map(([key, value]) => `${key}=${String(value)}`);
  return differences.length === 0 ? `${family}/baseline` : `${family}/${differences.join(',')}`;
}

function scenariosOf(parameters: readonly ScenarioParameters[], realTimeScale: number): Scenario[] {
  const byId = new Map<string, Scenario>();
  for (const entry of parameters) {
    const id = scenarioId(entry);
    // Liveness capacity is a pure chain-time search; transport, daemon and Anvil runs use no synthetic clock.
    const isClockFree = ['liveness', 'transport', 'daemon', 'anvil'].includes(entry.family);
    const scale = isClockFree ? 0 : realTimeScale;
    byId.set(id, { id, seed: SEED, realTimeScale: scale, parameters: entry });
  }
  return [...byId.values()];
}

export function presetNamed(name: string): Preset {
  if (name === 'smoke') {
    return { name, warmup: 0, repeat: 1, scenarios: scenariosOf(smokeParameters(), 0) };
  }
  if (name === 'full') {
    const parameters: ScenarioParameters[] = [
      ...fullDiscovery(),
      ...fullReconstruction(),
      ...fullScreening(),
      ...fullReports(),
      ...fullCycle(),
      ...fullLiveness(),
      ...fullTransport(),
      ...fullDaemon(),
      ...fullAnvil(),
    ];
    return { name, warmup: 2, repeat: 5, scenarios: scenariosOf(parameters, 1) };
  }
  throw new RangeError(`Unknown preset ${name}; use smoke or full`);
}

export function scenarioById(preset: Preset, id: string): Scenario {
  const scenario = preset.scenarios.find((entry) => entry.id === id);
  if (scenario === undefined) {
    throw new RangeError(`Preset ${preset.name} has no scenario ${id}`);
  }
  return scenario;
}
