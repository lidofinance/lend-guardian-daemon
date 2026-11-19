// Synthetic deployments and histories for every benchmark family. A world depends only on its
// scenario parameters and seed, so the chain server and a loopback server process build it from a
// description that the benchmark child sends.

import type { Address, PositionKey, SupplyAnchor } from '../src/core/index.ts';
import type {
  CycleProfile,
  CycleScenario,
  DiscoveryScenario,
  GriefingScenario,
  HistoryPattern,
  ReconstructionScenario,
  ScreeningScenario,
} from './scenarios.ts';
import { HistoryBuilder, SeededRandom, borrowerAt, controllerAt, marketIdAt } from './synthetic-history.ts';
import type { ActivationDelays, Classification, Market } from './synthetic-history.ts';
import { computeBlockHash, timestampOf, transactionHashOf, SyntheticChain } from './synthetic-rpc.ts';
import type { VirtualClock } from './synthetic-rpc.ts';

export const CORE: Address = '0x000000000000000000000000000000000000c0e0';

export const REGISTRY: Address = '0x000000000000000000000000000000000000a11e';

const FOREIGN_REGISTRY: Address = '0x000000000000000000000000000000000000f0e1';

export const GUARDIAN: Address = '0x0000000000000000000000000000000000009a4d';

export const DELEGATE: Address = '0x000000000000000000000000000000000000de1e';

/** The report block every synthetic plan selects when no time has passed. */
export const REPORT_BLOCK = 2_000_000;

export const REPORT_BLOCK_LAG = 2;

/** Core and registry history of every world that does not choose its own range. */
export const HISTORY_BLOCKS = 50_400;

export const CYCLE_MARKETS = 10;

export const SCREENING_MARKETS = 10;

const MINIMUM_ACTIVATION = 10n;

/**
 * The controller's delay rule with a cap of two minutes, below the due margin, so every lot a history
 * writes is due at its report block. The conformance fixture's own cap of an hour would leave dense
 * histories mostly not yet due.
 */
const ACTIVATION_DELAYS: ActivationDelays = {
  minActivationDelay: 60,
  maxActivationDelay: 120,
  maxDelayInflow: 10_000n,
};

/** Lots end at least this many blocks, four minutes, before the report block, longer than any delay. */
const DUE_MARGIN_BLOCKS = 20;

/** The previous heartbeat of a steady-state cycle, which covers every supply before it. */
const PREVIOUS_HEARTBEAT_BLOCK = REPORT_BLOCK - 30;

/** A market index far from the target-registry markets, for supplies another registry governs. */
const FOREIGN_MARKET_INDEX = 1_000_000;

/** The world the chain server builds for one scenario or probe. */
export type WorldSpec =
  | { readonly kind: 'quiet' }
  | { readonly kind: 'discovery'; readonly parameters: DiscoveryScenario; readonly seed: number }
  | { readonly kind: 'reconstruction'; readonly parameters: ReconstructionScenario }
  | { readonly kind: 'screening'; readonly parameters: ScreeningScenario }
  | { readonly kind: 'cycle'; readonly parameters: CycleScenario }
  | { readonly kind: 'liveness'; readonly positions: number; readonly markets: number }
  | { readonly kind: 'griefing'; readonly parameters: GriefingScenario; readonly operations: number };

/** A built world, and the numbers the benchmark child reads about it. */
export interface BuiltWorld {
  readonly chain: SyntheticChain;
  /** The history's size and build time. */
  readonly stats: Readonly<Record<string, number>>;
  /** The deployment blocks and what the scenario's checks expect. */
  readonly facts: Readonly<Record<string, number>>;
}

export interface DiscoveryWorld {
  readonly chain: SyntheticChain;
  readonly candidates: number;
  readonly markets: number;
  readonly controllers: number;
  /** Controllers of this Guardian's registry with a supply in the window, whose lifecycle events discovery reads. */
  readonly targetControllers: number;
}

export interface ReconstructionWorld {
  readonly chain: SyntheticChain;
  readonly supplies: number;
  readonly anchors: number;
  readonly events: number;
}

export interface GriefingWorld {
  readonly chain: SyntheticChain;
}

export interface CycleWorld {
  readonly chain: SyntheticChain;
  readonly supplies: number;
  /** Positions with work: all of them, or only the fresh ones after a steady-state heartbeat. */
  readonly targets: number;
  readonly anchors: number;
}

/** Build the world `spec` describes and record the size and cost of its history. */
export function buildWorld(spec: WorldSpec, clock: VirtualClock): BuiltWorld {
  const startedAt = performance.now();
  const { chain, ...expected } = writeWorld(spec, clock);
  const size = chain.size();
  return {
    chain,
    stats: { datasetLogs: size.logs, datasetMb: size.bytes / 1_048_576, datasetBuildMs: performance.now() - startedAt },
    facts: {
      ...expected,
      coreDeploymentBlock: chain.layout.coreDeploymentBlock,
      registryDeploymentBlock: chain.layout.registryDeploymentBlock,
    },
  };
}

function writeWorld(spec: WorldSpec, clock: VirtualClock): { readonly chain: SyntheticChain } {
  switch (spec.kind) {
    case 'quiet':
      return { chain: quietWorld(clock) };
    case 'discovery':
      return discoveryWorld(spec.parameters, clock, spec.seed);
    case 'reconstruction':
      return reconstructionWorld(spec.parameters, clock);
    case 'screening':
      return { chain: screeningWorld(spec.parameters, clock) };
    case 'cycle':
      return cycleWorld(spec.parameters, clock);
    case 'liveness':
      return { chain: livenessWorld(spec.positions, spec.markets, clock) };
    case 'griefing':
      return griefingWorld(spec.parameters, spec.operations, clock);
  }
}

export function syntheticChain(historyBlocks: number, clock: VirtualClock): SyntheticChain {
  const coreDeploymentBlock = REPORT_BLOCK - historyBlocks + 1;
  return new SyntheticChain(
    {
      core: CORE,
      registry: REGISTRY,
      guardian: GUARDIAN,
      delegate: DELEGATE,
      coreDeploymentBlock,
      registryDeploymentBlock: coreDeploymentBlock,
      startHead: REPORT_BLOCK + REPORT_BLOCK_LAG,
    },
    clock,
  );
}

/** A deployment with a Guardian and no supplies: for phases that take their work directly. */
export function quietWorld(clock: VirtualClock): SyntheticChain {
  const chain = syntheticChain(HISTORY_BLOCKS, clock);
  const history = new HistoryBuilder(chain, { minimumActivation: MINIMUM_ACTIVATION, delays: ACTIVATION_DELAYS });
  history.guardianAdded(REPORT_BLOCK);
  chain.seal();
  return chain;
}

/**
 * A quiet deployment where this Guardian has flagged the first targets of a screening scenario, so
 * screening skips them.
 */
export function screeningWorld(parameters: ScreeningScenario, clock: VirtualClock): SyntheticChain {
  const chain = syntheticChain(HISTORY_BLOCKS, clock);
  const history = new HistoryBuilder(chain, { minimumActivation: MINIMUM_ACTIVATION, delays: ACTIVATION_DELAYS });
  history.guardianAdded(REPORT_BLOCK);
  const { targets, ownFlagged } = countScreeningTargets(parameters);
  for (let target = 0; target < Math.min(targets, ownFlagged); target += 1) {
    const position = positionAt(target, SCREENING_MARKETS);
    chain.flag(position.marketId, position.borrower, GUARDIAN);
  }
  chain.seal();
  return chain;
}

/** The targets a screening scenario screens, and how many of them this Guardian has flagged. */
export function countScreeningTargets(parameters: ScreeningScenario): {
  readonly targets: number;
  readonly ownFlagged: number;
} {
  const targets = Math.max(1, Math.floor(parameters.anchors / parameters.anchorsPerTarget));
  return { targets, ownFlagged: Math.round(targets * parameters.ownFlagShare) };
}

/** `supplies` supplies spread over the whole history, for log-heavy transport answers. */
export function logsWorld(supplies: number, clock: VirtualClock): SyntheticChain {
  const chain = syntheticChain(HISTORY_BLOCKS, clock);
  const history = new HistoryBuilder(chain, { minimumActivation: MINIMUM_ACTIVATION, delays: ACTIVATION_DELAYS });
  history.guardianAdded(REPORT_BLOCK);
  const market = history.market(0, REGISTRY);
  const firstBlock = chain.layout.coreDeploymentBlock;
  for (let index = 0; index < supplies; index += 1) {
    const blockNumber = firstBlock + Math.floor((index * HISTORY_BLOCKS) / Math.max(1, supplies));
    history.supply(blockNumber, { market, borrower: borrowerAt(index), assets: MINIMUM_ACTIVATION });
  }
  chain.seal();
  return chain;
}

// ─── Discovery.

/** Distinct reads discovery must make, tallied while the supplies are written. */
class DiscoveryTally {
  #candidates = 0;

  readonly #markets = new Set<string>();

  readonly #controllers = new Set<string>();

  readonly #targetControllers = new Set<string>();

  /** A supply in `market`; it is a candidate when its lot reports to the target registry and is due. */
  add(market: Market, isTargetRegistry: boolean, isDueLot: boolean): void {
    this.#markets.add(market.id);
    const { controller } = market;
    if (controller === null) {
      return;
    }
    this.#controllers.add(controller);
    if (!isTargetRegistry) {
      return;
    }
    this.#targetControllers.add(controller);
    this.#candidates += isDueLot ? 1 : 0;
  }

  world(chain: SyntheticChain): DiscoveryWorld {
    return {
      chain,
      candidates: this.#candidates,
      markets: this.#markets.size,
      controllers: this.#controllers.size,
      targetControllers: this.#targetControllers.size,
    };
  }
}

export function discoveryWorld(parameters: DiscoveryScenario, clock: VirtualClock, seed: number): DiscoveryWorld {
  const chain = syntheticChain(parameters.rangeBlocks, clock);
  const history = new HistoryBuilder(chain, { minimumActivation: MINIMUM_ACTIVATION, delays: ACTIVATION_DELAYS });
  history.guardianAdded(REPORT_BLOCK);
  const markets = marketsOf(history, parameters.markets);
  const foreign = history.market(FOREIGN_MARKET_INDEX, FOREIGN_REGISTRY);
  const random = new SeededRandom(seed);
  const tally = new DiscoveryTally();
  for (let index = 0; index < parameters.supplies; index += 1) {
    const kind = supplyKindAt(index, parameters);
    const market = kind === 'foreign' ? foreign : marketAt(markets, index);
    const blockNumber = supplyBlockAt(index, parameters, chain.layout.coreDeploymentBlock);
    const assets = kind === 'dust' ? dustAssets(random) : MINIMUM_ACTIVATION + BigInt(random.below(1_000));
    const borrower = borrowerAt(index);
    const classification = history.supply(blockNumber, { market, borrower, assets });
    // A lot whose delay ends after the report block is not due yet, so discovery leaves it out.
    const dueAt = history.dueAt({ market, borrower });
    const isDue = dueAt !== null && dueAt <= timestampOf(REPORT_BLOCK);
    tally.add(market, kind !== 'foreign', classification === 'activating' && isDue);
  }
  chain.seal();
  return tally.world(chain);
}

/** Shares are laid out at one-percent resolution, so every hundred supplies repeat the same mix. */
function supplyKindAt(index: number, parameters: DiscoveryScenario): 'foreign' | 'dust' | 'activating' {
  const slot = index % 100;
  const foreignSlots = Math.round(parameters.foreignShare * 100);
  if (slot < foreignSlots) {
    return 'foreign';
  }
  return slot < foreignSlots + Math.round(parameters.dustShare * 100) ? 'dust' : 'activating';
}

function supplyBlockAt(index: number, parameters: DiscoveryScenario, firstBlock: number): number {
  if (parameters.layout === 'one-block') {
    return firstBlock;
  }
  return firstBlock + Math.floor((index * parameters.rangeBlocks) / parameters.supplies);
}

function dustAssets(random: SeededRandom): bigint {
  return 1n + BigInt(random.below(Number(MINIMUM_ACTIVATION) - 1));
}

// ─── Reconstruction histories.

interface PatternInput {
  readonly history: HistoryBuilder;
  readonly market: Market;
  readonly borrower: Address;
  readonly position: number;
  readonly positions: number;
  readonly events: number;
  readonly firstBlock: number;
  readonly lastBlock: number;
  readonly minimumActivation: bigint;
}

/** What one position's history adds: supplies written, work anchors expected and lifecycle events. */
interface Written {
  readonly supplies: number;
  readonly anchors: number;
  readonly events: number;
}

const PATTERNS: Readonly<Record<HistoryPattern, (input: PatternInput) => Written>> = {
  single: writeSingle,
  drains: writeDrains,
  'dust-drains': writeDustDrains,
  'top-ups': writeTopUps,
  'long-gap': writeLongGap,
};

export function reconstructionWorld(parameters: ReconstructionScenario, clock: VirtualClock): ReconstructionWorld {
  const chain = syntheticChain(parameters.rangeBlocks, clock);
  const { written } = writePositions(chain, {
    ...parameters,
    joinedAt: REPORT_BLOCK,
    lastBlock: REPORT_BLOCK - DUE_MARGIN_BLOCKS,
  });
  chain.seal();
  return {
    chain,
    supplies: sumOf(written.map((entry) => entry.supplies)),
    anchors: sumOf(written.map((entry) => entry.anchors)),
    events: sumOf(written.map((entry) => entry.events)),
  };
}

/** The history pattern of each cycle profile's positions. */
const CYCLE_PATTERNS: Readonly<Record<CycleProfile, HistoryPattern>> = {
  empty: 'single',
  clean: 'single',
  reports: 'single',
  deep: 'drains',
  wide: 'top-ups',
  'provider-latency': 'single',
  'rpc-latency': 'single',
  'log-failure': 'single',
  'reorg-before-heartbeat': 'single',
  'lost-confirmation': 'single',
  'restart-after-stale': 'single',
  'steady-state': 'single',
};

export function cycleWorld(parameters: CycleScenario, clock: VirtualClock): CycleWorld {
  const chain = syntheticChain(HISTORY_BLOCKS, clock);
  const isSteadyState = parameters.profile === 'steady-state';
  const coverageBlock = isSteadyState ? PREVIOUS_HEARTBEAT_BLOCK : REPORT_BLOCK;
  const positions = writePositions(chain, {
    pattern: CYCLE_PATTERNS[parameters.profile],
    positions: parameters.positions,
    events: parameters.events,
    markets: CYCLE_MARKETS,
    joinedAt: isSteadyState ? chain.layout.coreDeploymentBlock : REPORT_BLOCK,
    lastBlock: coverageBlock - DUE_MARGIN_BLOCKS,
  });
  const fresh = isSteadyState ? writeSteadyState(chain, positions, parameters) : 0;
  if (parameters.profile === 'log-failure') {
    // The forward supply walk reaches the report block in its last chunk.
    chain.failLogsCovering(CORE, REPORT_BLOCK);
  }
  chain.seal();
  return {
    chain,
    supplies: sumOf(positions.written.map((entry) => entry.supplies)) + fresh,
    targets: isSteadyState ? fresh : parameters.positions,
    anchors: isSteadyState ? fresh : sumOf(positions.written.map((entry) => entry.anchors)),
  };
}

/** `positions` due lots, one per borrower, spread over `markets` markets and the whole discovery window. */
export function livenessWorld(positions: number, markets: number, clock: VirtualClock): SyntheticChain {
  const chain = syntheticChain(HISTORY_BLOCKS, clock);
  writePositions(chain, {
    pattern: 'single',
    positions,
    events: 1,
    markets,
    joinedAt: REPORT_BLOCK,
    lastBlock: REPORT_BLOCK - DUE_MARGIN_BLOCKS,
  });
  chain.seal();
  return chain;
}

/** Positions written by one builder, which later supplies can extend. */
interface WrittenPositions {
  readonly written: Written[];
  readonly history: HistoryBuilder;
  readonly markets: Market[];
  readonly minimumActivation: bigint;
}

/** A Guardian that joined at `joinedAt`, `markets` target markets and one history per position. */
function writePositions(
  chain: SyntheticChain,
  shape: {
    readonly pattern: HistoryPattern;
    readonly positions: number;
    readonly events: number;
    readonly markets: number;
    readonly joinedAt: number;
    readonly lastBlock: number;
  },
): WrittenPositions {
  // Dust in `dust-drains` must survive its drains and still sit below the activation minimum.
  const minimumActivation = BigInt(Math.max(Number(MINIMUM_ACTIVATION), shape.events + 10));
  const history = new HistoryBuilder(chain, { minimumActivation, delays: ACTIVATION_DELAYS });
  history.guardianAdded(shape.joinedAt);
  const markets = marketsOf(history, shape.markets);
  const write = PATTERNS[shape.pattern];
  const written = Array.from({ length: shape.positions }, (_position, position) =>
    write({
      history,
      market: marketAt(markets, position),
      borrower: borrowerAt(position),
      position,
      positions: shape.positions,
      events: shape.events,
      firstBlock: chain.layout.coreDeploymentBlock + 1,
      lastBlock: shape.lastBlock,
      minimumActivation,
    }),
  );
  return { written, history, markets, minimumActivation };
}

/**
 * The previous heartbeat of a steady-state Guardian, due work before it already covered, then
 * `freshSupplies` new borrowers after it. Returns the fresh supplies, which are the cycle's only work.
 */
function writeSteadyState(chain: SyntheticChain, positions: WrittenPositions, parameters: CycleScenario): number {
  chain.recordHeartbeat(PREVIOUS_HEARTBEAT_BLOCK, PREVIOUS_HEARTBEAT_BLOCK + 1);
  for (let index = 0; index < parameters.freshSupplies; index += 1) {
    const position = parameters.positions + index;
    positions.history.supply(PREVIOUS_HEARTBEAT_BLOCK + 2 + index, {
      market: marketAt(positions.markets, position),
      borrower: borrowerAt(position),
      assets: positions.minimumActivation,
    });
  }
  return parameters.freshSupplies;
}

/** Event `step` of a position, interleaved with the other positions across the history. */
function eventBlock(input: PatternInput, step: number, steps: number): number {
  const slot = step * input.positions + input.position;
  const slots = steps * input.positions;
  return input.firstBlock + Math.floor((slot * (input.lastBlock - input.firstBlock)) / slots);
}

function supplyAt(input: PatternInput, blockNumber: number, assets: bigint): Classification {
  return input.history.supply(blockNumber, {
    market: input.market,
    borrower: input.borrower,
    assets,
  });
}

function writeSingle(input: PatternInput): Written {
  supplyAt(input, eventBlock(input, 0, 1), input.minimumActivation);
  return { supplies: 1, anchors: 1, events: 1 };
}

function writeDrains(input: PatternInput): Written {
  const events = Math.max(1, input.events);
  supplyAt(input, eventBlock(input, 0, events), input.minimumActivation + BigInt(events));
  for (let step = 1; step < events; step += 1) {
    input.history.drain(eventBlock(input, step, events), {
      market: input.market,
      borrower: input.borrower,
      amount: 1n,
    });
  }
  return { supplies: 1, anchors: 1, events };
}

function writeDustDrains(input: PatternInput): Written {
  const events = Math.max(2, input.events);
  supplyAt(input, eventBlock(input, 0, events), BigInt(events + 5));
  for (let step = 1; step < events - 1; step += 1) {
    input.history.drain(eventBlock(input, step, events), {
      market: input.market,
      borrower: input.borrower,
      amount: 1n,
    });
  }
  supplyAt(input, eventBlock(input, events - 1, events), input.minimumActivation);
  return { supplies: 2, anchors: 2, events };
}

function writeTopUps(input: PatternInput): Written {
  const events = Math.max(1, input.events);
  for (let step = 0; step < events; step += 1) {
    supplyAt(input, eventBlock(input, step, events), input.minimumActivation);
  }
  return { supplies: events, anchors: events, events };
}

/** A lot at the core deployment and one late top-up: the walk reads every chunk in between. */
function writeLongGap(input: PatternInput): Written {
  supplyAt(input, input.firstBlock, input.minimumActivation);
  supplyAt(input, input.lastBlock - input.position, input.minimumActivation);
  return { supplies: 2, anchors: 2, events: 2 };
}

// ─── Griefing: an attacker's operations in the discovery window of a Guardian's first cycle.

/** The attacker's own borrower, which recycles one deposit through dust and withdrawal. */
const ATTACKER_INDEX = 10_000_000;

/**
 * `operations` of the scenario's attack, spread evenly over the first `spreadBlocks` blocks of the
 * discovery window:
 * - `discovery-flood`: a dust deposit to the attacker's own address and its withdrawal;
 * - `candidate-flood`: a lot deposited to a new address and withdrawn in full;
 * - `report-flood`: a lot deposited to a new address and kept.
 */
export function griefingWorld(parameters: GriefingScenario, operations: number, clock: VirtualClock): GriefingWorld {
  const chain = syntheticChain(HISTORY_BLOCKS, clock);
  const history = new HistoryBuilder(chain, { minimumActivation: MINIMUM_ACTIVATION, delays: ACTIVATION_DELAYS });
  history.guardianAdded(REPORT_BLOCK);
  const [market] = marketsOf(history, 1);
  if (market === undefined) {
    throw new RangeError('A griefing world needs its market');
  }
  const firstBlock = chain.layout.coreDeploymentBlock;
  const spreadBlocks = Math.min(parameters.spreadBlocks, REPORT_BLOCK - DUE_MARGIN_BLOCKS - firstBlock);
  for (let index = 0; index < operations; index += 1) {
    const blockNumber = firstBlock + Math.floor((index * spreadBlocks) / operations);
    writeAttack(history, { attack: parameters.attack, market, index, blockNumber });
  }
  chain.seal();
  return { chain };
}

function writeAttack(
  history: HistoryBuilder,
  operation: {
    readonly attack: GriefingScenario['attack'];
    readonly market: Market;
    readonly index: number;
    readonly blockNumber: number;
  },
): void {
  const { market, blockNumber } = operation;
  const isDust = operation.attack === 'discovery-flood';
  const borrower = borrowerAt(isDust ? ATTACKER_INDEX : operation.index);
  const assets = isDust ? 1n : MINIMUM_ACTIVATION;
  history.supply(blockNumber, { market, borrower, assets });
  if (operation.attack !== 'report-flood') {
    history.drain(blockNumber, { market, borrower, amount: assets });
  }
}

// ─── Shared identities.

export function marketsOf(history: HistoryBuilder, count: number): Market[] {
  return Array.from({ length: count }, (_market, index) => history.market(index, REGISTRY));
}

export function marketAt(markets: readonly Market[], index: number): Market {
  const market = markets[index % markets.length];
  if (market === undefined) {
    throw new RangeError('A synthetic history needs at least one market');
  }
  return market;
}

export function positionAt(index: number, markets: number): PositionKey {
  const market = index % markets;
  return { controller: controllerAt(market), marketId: marketIdAt(market), borrower: borrowerAt(index) };
}

/** A plausible anchor in a world without reorgs, for work that is built directly rather than reconstructed. */
export function syntheticAnchor(position: PositionKey, sequence: number): SupplyAnchor {
  const blockNumber = REPORT_BLOCK - DUE_MARGIN_BLOCKS - (sequence % 10_000);
  return {
    core: CORE,
    blockHash: computeBlockHash(blockNumber, 0),
    transactionHash: transactionHashOf(blockNumber, sequence),
    logIndex: 1,
    marketId: position.marketId,
    borrower: position.borrower,
  };
}

export function sumOf(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
