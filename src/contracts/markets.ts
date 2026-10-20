// Core and controller reads return typed market evidence; Guardian decides what the cycle covers.

import {
  encodeEventTopics,
  encodeFunctionData,
  decodeFunctionResult,
  getAbiItem,
  isAddressEqual,
  pad,
  toEventSelector,
  zeroAddress,
} from 'viem';
import type { ParseEventLogsReturnType } from 'viem';
import { MARKET_CONTROLLER_ABI } from '../../abi/MarketController.abi.ts';
import { CORE_ABI, SUPPLY_COLLATERAL_ABI, SUPPLY_COLLATERAL_TOPICS } from '../../abi/Core.abi.ts';
import { byLogPosition } from '../chain/log-order.ts';
import type { LogPosition } from '../chain/log-order.ts';
import type { RpcProvider } from '../chain/rpc.ts';
import { decodeLogs } from './decode-logs.ts';
import type { ScanPlan, Work } from '../core/outcomes.ts';
import type { PositionKey, SupplyAnchor } from '../core/types.ts';
import { GuardianStop } from '../core/stop.ts';
import { lower } from '../common/types.ts';
import type { Address, BlockRef, Bytes32, ContractDeployment, MarketId, TxHash } from '../common/types.ts';
import { mapConcurrently } from '../common/concurrency.ts';

/**
 * Where a log sits. Reconstruction walks lifecycle events strictly backwards, so it sorts them by the
 * position fields: `blockNumber`, then `transactionIndex`, then `logIndex`.
 */
interface LogRef extends LogPosition {
  readonly blockHash: Bytes32;
  readonly transactionHash: TxHash;
}

/** A borrower's delayed collateral after the event that changed it. */
interface Position {
  readonly dust: bigint;
  readonly activating: bigint;
  /** The base deadline is `activatingStart + activatingDelay`; zero start means no timer. */
  readonly activatingStart: number;
  readonly activatingDelay: number;
}

type LifecycleKind = 'dusted' | 'activating' | 'activated' | 'drained';

/** One controller event for one borrower: every change to `dust`, `activating` and the timer. */
interface LifecycleEvent {
  readonly kind: LifecycleKind;
  readonly amount: bigint;
  readonly position: Position;
  readonly at: LogRef;
}

/** One `SupplyCollateral`, reduced to what discovery and reconstruction compare. */
interface SupplyLog {
  readonly marketId: MarketId;
  readonly borrower: Address;
  readonly assets: bigint;
  readonly blockHash: Bytes32;
  readonly transactionHash: TxHash;
  readonly logIndex: number;
}

/** A `CollateralActivating` that classified a supply: the timer it set, and where it was logged. */
interface Activation {
  readonly position: Position;
  readonly blockNumber: number;
}

type LifecycleEventStream = AsyncGenerator<LifecycleEvent>;

/** A reconstructed anchor and the block where it entered `activating`. */
interface AnchorActivation {
  readonly anchor: SupplyAnchor;
  readonly activationBlock: bigint;
}

/** A `SupplyCollateral` as a log query decodes it. */
type SupplyCollateralLog = ParseEventLogsReturnType<typeof SUPPLY_COLLATERAL_ABI, undefined, true>[number];

/** One controller lifecycle event as viem decodes it. */
type LifecycleLog = ParseEventLogsReturnType<typeof MARKET_CONTROLLER_ABI, undefined, true>[number];

/** A supply to a market whose controller reports to the target registry. */
interface TargetSupply {
  readonly supply: SupplyLog;
  /** The market's controller, lowered. */
  readonly controller: Address;
}

/** A position whose activation is due and requires coverage, and the position its latest event left. */
interface Candidate {
  readonly key: PositionKey;
  readonly latestPosition: Position;
}

const LIFECYCLE_TOPICS = [
  toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDusted' })),
  toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivating' })),
  toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivated' })),
  toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDrained' })),
];

const LIFECYCLE_KINDS: Record<LifecycleLog['eventName'], LifecycleEvent['kind']> = {
  CollateralDusted: 'dusted',
  CollateralActivating: 'activating',
  CollateralActivated: 'activated',
  CollateralDrained: 'drained',
};

/**
 * Reads for [discovery](../../docs/guardian-specification.md#b-discover-candidate-positions)
 * and [reconstruction](../../docs/guardian-specification.md#c-reconstruct-the-contributors).
 * Create one instance per phase call: binding caches belong to that call's report block.
 * No cache crosses calls.
 */
export class Markets {
  readonly #rpc: RpcProvider;
  readonly #core: Address;
  readonly #deploymentBlock: number;
  // Pending reads are cached, so supplies classified at once share one read per market and controller.
  readonly #controllers = new Map<MarketId, Promise<Address>>();
  readonly #registries = new Map<Address, Promise<Address>>();

  constructor(rpc: RpcProvider, deployment: ContractDeployment) {
    this.#rpc = rpc;
    this.#core = deployment.address;
    this.#deploymentBlock = deployment.deploymentBlock;
  }

  /**
   * Discover every position that may require screening under Appendix B, `concurrency` supplies or
   * controllers at a time. The window is read forwards a piece of supplies at a time, with the controllers'
   * events since the previous piece, so memory holds a piece of logs and the candidates, not the window.
   */
  async discoverCandidatePositions(
    plan: ScanPlan,
    targetRegistry: Address,
    concurrency: number,
  ): Promise<PositionKey[]> {
    const window = plan.discoveryRange;
    const candidates = new CandidatePositions();
    // Controller events are read without gaps, so no event of a candidate is missed.
    let firstUnreadBlock = window.from.number;
    const supplyFilter = {
      address: this.#core,
      topics: SUPPLY_COLLATERAL_TOPICS,
      fromBlock: window.from.number,
      toBlock: window.to.number,
    };
    for await (const supplyLogs of this.#rpc.logBatches(supplyFilter, 'forward')) {
      const supplies = decodeLogs(SUPPLY_COLLATERAL_ABI, supplyLogs).map((log) => this.#supplyOf(log));
      if (supplies.length === 0) {
        continue;
      }
      const lastSupplyBlock = supplyLogs.reduce(
        (last, log) => Math.max(last, Number(log.blockNumber)),
        firstUnreadBlock,
      );
      const targetSupplies = await this.#filterTargetSupplies(supplies, targetRegistry, window.to.hash, concurrency);
      const blocksToRead = { fromBlock: firstUnreadBlock, toBlock: lastSupplyBlock };
      await this.#pairSuppliesAndApplyEvents(plan, candidates, targetSupplies, blocksToRead, concurrency);
      firstUnreadBlock = lastSupplyBlock + 1;
    }
    // Events after the last supply can still withdraw, activate or extend a candidate.
    const blocksAfterLastSupply = { fromBlock: firstUnreadBlock, toBlock: window.to.number };
    await this.#applyCandidateEvents(candidates, blocksAfterLastSupply, concurrency);

    // [Scan phase 3](../../docs/guardian-specification.md#scan-cycle) discards a position that is not base-due at
    // the report block. Its newest event lies in the window with its classification, so a lot withdrawn, activated
    // or extended since is discarded here without a history walk; the work stays the same.
    return candidates
      .list()
      .filter((candidate) => this.#isBaseActivationDeadlineReached(candidate.latestPosition, window.to.timestamp))
      .map((candidate) => candidate.key);
  }

  /**
   * Reconstruct the uncovered contributors for every candidate position under Appendix C,
   * `concurrency` positions at a time. A position of `reusableWork` that its controller logged no event
   * for after that work's report block keeps its anchors instead.
   */
  async reconstructWork(
    plan: ScanPlan,
    positions: readonly PositionKey[],
    concurrency: number,
    reusableWork?: Work,
  ): Promise<ReadonlyMap<PositionKey, readonly SupplyAnchor[]>> {
    const unchangedAnchors =
      reusableWork === undefined
        ? new Map<string, readonly SupplyAnchor[]>()
        : await this.#findUnchangedAnchors(reusableWork, plan.discoveryRange.to.number, concurrency);
    const walks = await mapConcurrently(concurrency, positions, async (position) => ({
      position,
      anchors:
        unchangedAnchors.get(`${position.controller}:${position.borrower}`) ??
        (await this.#reconstructPosition(plan, position)),
    }));
    const byPosition = new Map<PositionKey, readonly SupplyAnchor[]>();
    for (const { position, anchors } of walks) {
      if (anchors.length > 0) {
        byPosition.set(position, anchors);
      }
    }
    return byPosition;
  }

  controllerOf(marketId: MarketId, at: Bytes32): Promise<Address> {
    const cachedController = this.#controllers.get(marketId);
    if (cachedController !== undefined) {
      return cachedController;
    }

    const request = {
      abi: CORE_ABI,
      functionName: 'marketController',
      args: [marketId],
    } as const;
    const controller = this.#rpc
      .call(this.#core, encodeFunctionData(request), at)
      .then((data) => decodeFunctionResult({ ...request, data }));

    this.#controllers.set(marketId, controller);
    return controller;
  }

  registryOf(controller: Address, at: Bytes32): Promise<Address> {
    const cachedRegistry = this.#registries.get(controller);
    if (cachedRegistry !== undefined) {
      return cachedRegistry;
    }

    const request = {
      abi: MARKET_CONTROLLER_ABI,
      functionName: 'guardianSignals',
    } as const;
    const registry = this.#rpc
      .call(controller, encodeFunctionData(request), at)
      .then((data) => decodeFunctionResult({ ...request, data }));

    this.#registries.set(controller, registry);
    return registry;
  }

  /**
   * Establish the [supply pairing](../../docs/guardian-specification.md#core-and-controllers-supply-and-activation-events)
   * from the controller's lifecycle events read with the supply's piece, instead of Appendix B's transaction
   * receipt. One read per controller serves a piece of supplies, so supplies do not multiply requests;
   * transaction, adjacent log index, block hash and borrower still identify the same classification event.
   */
  activationBefore(supply: SupplyLog, controller: Address, logs: readonly LifecycleLog[]): Activation | null {
    const before = logs.filter(
      (log) => log.transactionHash === supply.transactionHash && log.logIndex === supply.logIndex - 1,
    );
    const log = before.length === 1 ? before[0] : undefined;
    if (log === undefined) {
      throw new GuardianStop('supply-without-controller-event');
    }
    const isSameSource = isAddressEqual(log.address, controller) && log.blockHash === supply.blockHash;
    if (!isSameSource || log.removed) {
      throw new GuardianStop('supply-without-controller-event');
    }

    return this.#activationOf(log, supply.borrower);
  }

  /**
   * The zero-boundary shortcut requires exactly one core supply paired with the activation. The
   * query names the position's market and borrower, so a block of many borrowers' supplies returns
   * only this position's; the pairing below checks them as before.
   */
  async supplyAfter(position: PositionKey, activation: LifecycleEvent): Promise<SupplyLog> {
    const block = Number(activation.at.blockNumber);
    const raw = await this.#rpc.getLogs({
      address: this.#core,
      topics: encodeEventTopics({
        abi: SUPPLY_COLLATERAL_ABI,
        eventName: 'SupplyCollateral',
        args: { id: position.marketId, onBehalf: position.borrower },
      }),
      fromBlock: block,
      toBlock: block,
    });
    const supplies = decodeLogs(SUPPLY_COLLATERAL_ABI, raw).map((log) => this.#supplyOf(log));
    const paired = supplies.filter((supply) => this.#isPairedWith(supply, activation, position));
    const supply = paired.length === 1 ? paired[0] : undefined;
    if (supply === undefined) {
      throw new GuardianStop('position-history-broken');
    }
    return supply;
  }

  /** The controller's lifecycle events for one borrower, newest first. */
  async *lifecycleBack(position: PositionKey, until: BlockRef): AsyncGenerator<LifecycleEvent> {
    const floor = this.#deploymentBlock;
    const borrower = pad(position.borrower, { size: 32 });
    for await (const logs of this.#rpc.logBatches(
      {
        address: position.controller,
        topics: [LIFECYCLE_TOPICS, borrower],
        fromBlock: floor,
        toBlock: until.number,
      },
      'backward',
    )) {
      yield* decodeLogs(MARKET_CONTROLLER_ABI, logs)
        .map((log) => this.#lifecycleOf(log))
        .sort((left, right) => byLogPosition(right.at, left.at));
    }
  }

  /** Keep the supplies to markets whose controller reports to the target registry, each with that controller. */
  async #filterTargetSupplies(
    supplies: readonly SupplyLog[],
    targetRegistry: Address,
    at: Bytes32,
    concurrency: number,
  ): Promise<TargetSupply[]> {
    const controllers = await mapConcurrently(concurrency, supplies, (supply) =>
      this.#findTargetController(supply.marketId, targetRegistry, at),
    );
    return supplies.flatMap((supply, index) => {
      const controller = controllers[index] ?? null;
      return controller === null ? [] : [{ supply, controller }];
    });
  }

  /** The market's controller, lowered, when it reports to the target registry; otherwise null. */
  async #findTargetController(marketId: MarketId, targetRegistry: Address, at: Bytes32): Promise<Address | null> {
    const controller = await this.controllerOf(marketId, at);
    if (controller === zeroAddress) {
      return null;
    }
    const reportsTo = await this.registryOf(controller, at);
    if (!isAddressEqual(reportsTo, targetRegistry)) {
      return null;
    }
    return lower(controller);
  }

  /**
   * Read the lifecycle events in `blocksToRead` of the target supplies' controllers and of the candidates'
   * controllers, a piece at a time: pair each supply with the event logged right before it, and apply every
   * event to the candidates. A supply left without its event stops the attempt. The events are read by
   * block number like the supplies, so a reorg between the two reads leaves a supply without its event.
   */
  async #pairSuppliesAndApplyEvents(
    plan: ScanPlan,
    candidates: CandidatePositions,
    targetSupplies: readonly TargetSupply[],
    blocksToRead: { readonly fromBlock: number; readonly toBlock: number },
    concurrency: number,
  ): Promise<void> {
    const unpairedSupplies = new Map(
      targetSupplies.map((target) => [`${target.supply.transactionHash}:${String(target.supply.logIndex)}`, target]),
    );
    const controllers = new Set([
      ...targetSupplies.map((target) => target.controller),
      ...candidates.listControllers(),
    ]);
    await mapConcurrently(concurrency, [...controllers], async (controller) => {
      const eventFilter = { address: controller, topics: [LIFECYCLE_TOPICS], ...blocksToRead };
      for await (const eventLogs of this.#rpc.logBatches(eventFilter, 'forward')) {
        const events = decodeLogs(MARKET_CONTROLLER_ABI, eventLogs);
        this.#pairSupplies(plan, candidates, unpairedSupplies, events);
        candidates.applyEvents(events);
      }
    });
    if (unpairedSupplies.size > 0) {
      throw new GuardianStop('supply-without-controller-event');
    }
  }

  /**
   * The anchors of `reusableWork`'s positions, by controller and borrower, less those whose controller
   * logged an event for them after that work's report block, through `reportBlockNumber`.
   */
  async #findUnchangedAnchors(
    reusableWork: Work,
    reportBlockNumber: number,
    concurrency: number,
  ): Promise<Map<string, readonly SupplyAnchor[]>> {
    const unchangedAnchors = new Map<string, readonly SupplyAnchor[]>();
    const controllers = new Set<Address>();
    for (const [position, anchors] of reusableWork.entries()) {
      unchangedAnchors.set(`${position.controller}:${position.borrower}`, anchors);
      controllers.add(position.controller);
    }
    const blocksToRead = { fromBlock: reusableWork.reportBlock.number + 1, toBlock: reportBlockNumber };
    await mapConcurrently(concurrency, [...controllers], async (controller) => {
      const eventFilter = { address: controller, topics: [LIFECYCLE_TOPICS], ...blocksToRead };
      for await (const eventLogs of this.#rpc.logBatches(eventFilter, 'forward')) {
        for (const event of decodeLogs(MARKET_CONTROLLER_ABI, eventLogs)) {
          unchangedAnchors.delete(`${lower(event.address)}:${lower(event.args.borrower)}`);
        }
      }
    });
    return unchangedAnchors;
  }

  /** Read the candidates' controllers' lifecycle events in `blocksToRead`, a piece at a time, and apply them. */
  async #applyCandidateEvents(
    candidates: CandidatePositions,
    blocksToRead: { readonly fromBlock: number; readonly toBlock: number },
    concurrency: number,
  ): Promise<void> {
    await mapConcurrently(concurrency, candidates.listControllers(), async (controller) => {
      const eventFilter = { address: controller, topics: [LIFECYCLE_TOPICS], ...blocksToRead };
      for await (const eventLogs of this.#rpc.logBatches(eventFilter, 'forward')) {
        candidates.applyEvents(decodeLogs(MARKET_CONTROLLER_ABI, eventLogs));
      }
    });
  }

  /**
   * Pair each unpaired supply whose event is among `events`, with the checks of `activationBefore`, and add
   * the positions whose activation is due and not covered by the previous heartbeat to the candidates.
   */
  #pairSupplies(
    plan: ScanPlan,
    candidates: CandidatePositions,
    unpairedSupplies: Map<string, TargetSupply>,
    events: readonly LifecycleLog[],
  ): void {
    // A controller event pairs with the supply logged right after it in the same transaction.
    const eventsBySupply = new Map<TargetSupply, LifecycleLog[]>();
    for (const event of events) {
      const target = unpairedSupplies.get(`${event.transactionHash}:${String(event.logIndex + 1)}`);
      if (target === undefined) {
        continue;
      }
      const supplyEvents = eventsBySupply.get(target);
      if (supplyEvents === undefined) {
        eventsBySupply.set(target, [event]);
      } else {
        supplyEvents.push(event);
      }
    }
    for (const [{ supply, controller }, supplyEvents] of eventsBySupply) {
      unpairedSupplies.delete(`${supply.transactionHash}:${String(supply.logIndex)}`);
      const activation = this.activationBefore(supply, controller, supplyEvents);
      if (activation === null) {
        continue;
      }
      const deadline = activation.position.activatingStart + activation.position.activatingDelay;
      if (deadline > plan.discoveryRange.to.timestamp) {
        continue;
      }
      if (!this.#requiresCurrentCoverage(plan.previousHeartbeatBlock, activation.blockNumber, deadline)) {
        continue;
      }
      candidates.add({ controller, marketId: supply.marketId, borrower: supply.borrower }, activation.position);
    }
  }

  #requiresCurrentCoverage(
    previousHeartbeatBlock: BlockRef | null,
    activationBlockNumber: number,
    deadline: number,
  ): boolean {
    return (
      previousHeartbeatBlock === null ||
      activationBlockNumber > previousHeartbeatBlock.number ||
      deadline > previousHeartbeatBlock.timestamp
    );
  }

  async #reconstructPosition(plan: ScanPlan, position: PositionKey): Promise<SupplyAnchor[]> {
    const events = this.lifecycleBack(position, plan.discoveryRange.to);
    const activationBlockByAnchor = new Map<string, AnchorActivation>();
    let positionAtPreviousHeartbeat: Position | null = null;
    let current = await this.#readOlderLifecycleEvent(events);
    if (current === null) {
      throw new GuardianStop('position-without-history');
    }
    if (!this.#isBaseActivationDeadlineReached(current.position, plan.discoveryRange.to.timestamp)) {
      return [];
    }

    while (true) {
      if (plan.previousHeartbeatBlock !== null && positionAtPreviousHeartbeat === null) {
        const isAtOrBeforePreviousHeartbeat = current.at.blockNumber <= BigInt(plan.previousHeartbeatBlock.number);
        if (isAtOrBeforePreviousHeartbeat) {
          positionAtPreviousHeartbeat = current.position;
        }
      }

      if (current.kind === 'activating') {
        if (current.position.dust !== 0n || current.position.activating < current.amount) {
          throw new GuardianStop('position-history-broken');
        }

        const activationBlock = current.at.blockNumber;
        const directAnchor = this.#supplyAnchorFromLifecycleEvent(current, position);
        activationBlockByAnchor.set(`${directAnchor.transactionHash}:${directAnchor.logIndex}`, {
          anchor: directAnchor,
          activationBlock,
        });
        const startedFromZero = current.position.activating === current.amount;
        const pairedSupply = startedFromZero ? await this.supplyAfter(position, current) : null;
        if (pairedSupply?.assets === current.amount) {
          break;
        }

        const previousEvent = await this.#readOlderLifecycleEvent(events);
        if (pairedSupply !== null && current.amount !== pairedSupply.assets + (previousEvent?.position.dust ?? 0n)) {
          throw new GuardianStop('position-history-broken');
        }
        const hasAbsorbedDust = previousEvent !== null && previousEvent.position.dust > 0n;
        if (hasAbsorbedDust) {
          const dust = await this.#findAbsorbedDustEvent(events, previousEvent, plan.previousHeartbeatBlock);
          positionAtPreviousHeartbeat ??= dust.positionAtPreviousHeartbeat;
          const dustAnchor = this.#supplyAnchorFromLifecycleEvent(dust.event, position);
          activationBlockByAnchor.set(`${dustAnchor.transactionHash}:${dustAnchor.logIndex}`, {
            anchor: dustAnchor,
            activationBlock,
          });
        }

        if (startedFromZero) {
          break;
        }
        current = hasAbsorbedDust ? await this.#readOlderLifecycleEvent(events) : previousEvent;
        if (current === null) {
          throw new GuardianStop('position-history-broken');
        }
        continue;
      }

      if (current.position.activating <= 0n) {
        throw new GuardianStop('position-history-broken');
      }
      current = await this.#readOlderLifecycleEvent(events);
      if (current === null) {
        throw new GuardianStop('position-history-broken');
      }
    }

    const contributors = [...activationBlockByAnchor.values()];
    const wasDueAtPreviousHeartbeat =
      plan.previousHeartbeatBlock !== null &&
      positionAtPreviousHeartbeat !== null &&
      this.#isBaseActivationDeadlineReached(positionAtPreviousHeartbeat, plan.previousHeartbeatBlock.timestamp);
    if (!wasDueAtPreviousHeartbeat) {
      return contributors.map((contributor) => contributor.anchor);
    }
    const previousHeartbeatBlockNumber = BigInt(plan.previousHeartbeatBlock.number);
    return contributors
      .filter((contributor) => contributor.activationBlock > previousHeartbeatBlockNumber)
      .map((contributor) => contributor.anchor);
  }

  async #readOlderLifecycleEvent(events: LifecycleEventStream): Promise<LifecycleEvent | null> {
    const next = await events.next();
    return next.done === true ? null : next.value;
  }

  async #findAbsorbedDustEvent(
    events: LifecycleEventStream,
    newest: LifecycleEvent,
    previousHeartbeatBlock: BlockRef | null,
  ): Promise<{ readonly event: LifecycleEvent; readonly positionAtPreviousHeartbeat: Position | null }> {
    let positionAtPreviousHeartbeat: Position | null = null;
    let current: LifecycleEvent | null = newest;
    while (true) {
      if (current === null || current.position.dust <= 0n) {
        throw new GuardianStop('position-history-broken');
      }
      if (previousHeartbeatBlock !== null && positionAtPreviousHeartbeat === null) {
        const isAtOrBeforePreviousHeartbeat = current.at.blockNumber <= BigInt(previousHeartbeatBlock.number);
        if (isAtOrBeforePreviousHeartbeat) {
          positionAtPreviousHeartbeat = current.position;
        }
      }
      if (current.kind === 'dusted') {
        if (current.position.dust !== current.amount) {
          throw new GuardianStop('position-history-broken');
        }
        return { event: current, positionAtPreviousHeartbeat };
      }
      current = await this.#readOlderLifecycleEvent(events);
    }
  }

  #isBaseActivationDeadlineReached(position: Position, at: number): boolean {
    return position.activating > 0n && position.activatingStart + position.activatingDelay <= at;
  }

  #supplyAnchorFromLifecycleEvent(event: LifecycleEvent, position: PositionKey): SupplyAnchor {
    return {
      core: this.#core,
      blockHash: event.at.blockHash,
      transactionHash: event.at.transactionHash,
      logIndex: event.at.logIndex + 1,
      marketId: position.marketId,
      borrower: position.borrower,
    };
  }

  /** The activation named by the classification immediately before a supply. */
  #activationOf(log: LifecycleLog, borrower: Address): Activation | null {
    const isClassification = log.eventName !== 'CollateralDrained' && isAddressEqual(log.args.borrower, borrower);
    if (!isClassification) {
      throw new GuardianStop('supply-without-controller-event');
    }
    if (log.eventName !== 'CollateralActivating') {
      return null;
    }
    return { position: log.args.position, blockNumber: Number(log.blockNumber) };
  }

  #supplyOf(log: SupplyCollateralLog): SupplyLog {
    return {
      marketId: log.args.id,
      borrower: lower(log.args.onBehalf),
      assets: log.args.assets,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    };
  }

  #isPairedWith(supply: SupplyLog, activation: LifecycleEvent, position: PositionKey): boolean {
    const isSameTransaction =
      supply.blockHash === activation.at.blockHash && supply.transactionHash === activation.at.transactionHash;
    if (!isSameTransaction) {
      return false;
    }
    if (supply.logIndex !== activation.at.logIndex + 1) {
      return false;
    }
    if (!isAddressEqual(supply.borrower, position.borrower)) {
      return false;
    }
    return supply.marketId === position.marketId;
  }

  #lifecycleOf(log: LifecycleLog): LifecycleEvent {
    return {
      kind: LIFECYCLE_KINDS[log.eventName],
      amount: log.args.amount,
      position: log.args.position,
      at: {
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
      },
    };
  }
}

/**
 * The candidates of one discovery call: every position whose activation is due and requires coverage,
 * with the position its latest event read so far left.
 */
class CandidatePositions {
  readonly #candidatesById = new Map<string, Candidate>();

  /** Add a position with the position its activation left; a position already added keeps its record. */
  add(key: PositionKey, position: Position): void {
    const id = `${key.controller}:${key.marketId}:${key.borrower}`;
    if (!this.#candidatesById.has(id)) {
      this.#candidatesById.set(id, { key, latestPosition: position });
    }
  }

  /**
   * Move each candidate to the position its newest event in `events` left. A candidate left with nothing
   * activating is removed: it is not base-due, and a later supply adds it again.
   */
  applyEvents(events: readonly LifecycleLog[]): void {
    const newestEventByControllerAndBorrower = new Map<string, LifecycleLog>();
    for (const event of events) {
      const id = `${lower(event.address)}:${lower(event.args.borrower)}`;
      const newest = newestEventByControllerAndBorrower.get(id);
      if (newest === undefined || byLogPosition(event, newest) > 0) {
        newestEventByControllerAndBorrower.set(id, event);
      }
    }
    for (const [id, candidate] of this.#candidatesById) {
      const newest = newestEventByControllerAndBorrower.get(`${candidate.key.controller}:${candidate.key.borrower}`);
      if (newest === undefined) {
        continue;
      }
      if (newest.args.position.activating === 0n) {
        this.#candidatesById.delete(id);
      } else {
        this.#candidatesById.set(id, { key: candidate.key, latestPosition: newest.args.position });
      }
    }
  }

  /** The controllers of the candidates, each once. */
  listControllers(): Address[] {
    return [...new Set([...this.#candidatesById.values()].map((candidate) => candidate.key.controller))];
  }

  list(): Candidate[] {
    return [...this.#candidatesById.values()];
  }
}
