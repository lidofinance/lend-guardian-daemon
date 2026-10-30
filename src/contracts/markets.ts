// Core and controller evidence, and the discovery and reconstruction algorithms that read it.

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
import type { DiscoveredPosition, LifecycleEventRef, PositionKey, SupplyAnchor } from '../core/types.ts';
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

/** A `CollateralActivating` that classified a supply: the timer it set, and the log itself. */
interface Activation {
  readonly position: Position;
  readonly blockNumber: number;
  readonly log: LifecycleLog;
}

/**
 * A lifecycle event as the history walk reads it. An activation carries the assets of the `SupplyCollateral`
 * paired with it, or `null` when the read found no paired supply or more than one. The walk stops on that
 * where it uses the supply, so the checks of the walk's first event come first.
 */
type WalkedEvent =
  | (LifecycleEvent & { readonly kind: 'activating'; readonly supplied: bigint | null })
  | (LifecycleEvent & { readonly kind: Exclude<LifecycleKind, 'activating'> });

type LifecycleEventStream = AsyncGenerator<WalkedEvent>;

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

/** A position whose activation is due and requires coverage, with the newest event read for it so far. */
interface Candidate {
  readonly key: PositionKey;
  readonly newestEvent: LifecycleLog;
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
  ): Promise<DiscoveredPosition[]> {
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
      .filter((candidate) =>
        this.#isBaseActivationDeadlineReached(candidate.newestEvent.args.position, window.to.timestamp),
      )
      .map(({ key, newestEvent }) => ({
        position: key,
        newestEvent: {
          blockNumber: Number(newestEvent.blockNumber),
          logIndex: newestEvent.logIndex,
          blockHash: newestEvent.blockHash,
        },
      }));
  }

  /**
   * Reconstruct the uncovered contributors for every candidate position under Appendix C,
   * `concurrency` positions at a time. A position of `reusableWork` keeps its anchors instead when
   * discovery read for it the newest event that the work's reconstruction started from. The result is keyed
   * by the candidates' own `position` objects.
   */
  async reconstructWork(
    plan: ScanPlan,
    candidates: readonly DiscoveredPosition[],
    concurrency: number,
    reusableWork?: Work,
  ): Promise<ReadonlyMap<PositionKey, readonly SupplyAnchor[]>> {
    const reusableAnchors = new Map<string, readonly SupplyAnchor[]>();
    for (const [position, anchors] of reusableWork?.entries() ?? []) {
      reusableAnchors.set(`${position.controller}:${position.borrower}`, anchors);
    }
    const reusableNewestEventByPosition = new Map<string, LifecycleEventRef>();
    for (const [position, newestEvent] of reusableWork?.newestEvents() ?? []) {
      reusableNewestEventByPosition.set(`${position.controller}:${position.borrower}`, newestEvent);
    }
    const walks = await mapConcurrently(concurrency, candidates, async (candidate) => {
      const key = `${candidate.position.controller}:${candidate.position.borrower}`;
      const earlierNewestEvent = reusableNewestEventByPosition.get(key);
      const isUnchanged = earlierNewestEvent !== undefined && isSameEventRef(earlierNewestEvent, candidate.newestEvent);
      const anchors = isUnchanged ? reusableAnchors.get(key) : undefined;
      return { position: candidate.position, anchors: anchors ?? (await this.#reconstructPosition(plan, candidate)) };
    });
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
   * The controller's lifecycle events for one borrower, newest first. Logs are read back from `until` one range
   * at a time, only as far as the walk asks. Each activation comes with the assets of its paired `SupplyCollateral`;
   * the supplies of all activations in a range come in one read, however many activations the range holds.
   *
   * Each event after the first is also checked against the event yielded before it: when the position it records
   * cannot directly precede that event, the walk stops with `position-history-broken`. The check defends against
   * a node that leaves logs out of the history it returns. The walk takes each older event as the position right
   * before the newer one, as [Appendix C](../../docs/guardian-specification.md#c-reconstruct-the-contributors)
   * does, so a missing log would make it drop an anchor or take an older supply in its place. A complete history
   * always passes, so the check costs no reads and changes no work; an inconsistent one stops, as
   * [Failure handling](../../docs/guardian-specification.md#failure-handling) requires.
   */
  async *lifecycleBack(position: PositionKey, until: BlockRef): AsyncGenerator<WalkedEvent> {
    const floor = this.#deploymentBlock;
    const borrower = pad(position.borrower, { size: 32 });
    let newer: LifecycleEvent | null = null;
    for await (const logs of this.#rpc.logBatches(
      {
        address: position.controller,
        topics: [LIFECYCLE_TOPICS, borrower],
        fromBlock: floor,
        toBlock: until.number,
      },
      'backward',
    )) {
      const events = decodeLogs(MARKET_CONTROLLER_ABI, logs)
        .map((log) => this.#lifecycleOf(log))
        .sort((left, right) => byLogPosition(right.at, left.at));
      const suppliesByLog = await this.#readActivationSupplies(position, events);
      for (const event of events) {
        if (newer !== null && !this.#canPrecede(event.position, newer)) {
          throw new GuardianStop('position-history-broken');
        }
        yield this.#attachSupply(event, suppliesByLog, position);
        newer = event;
      }
    }
  }

  /**
   * The position's `SupplyCollateral` logs across the blocks of these events' activations, in one read, by the
   * transaction and log index where each sits.
   */
  async #readActivationSupplies(
    position: PositionKey,
    events: readonly LifecycleEvent[],
  ): Promise<ReadonlyMap<string, readonly SupplyLog[]>> {
    const activationBlocks = events
      .filter((event) => event.kind === 'activating')
      .map((event) => Number(event.at.blockNumber));
    if (activationBlocks.length === 0) {
      return new Map();
    }
    const raw = await this.#rpc.getLogs({
      address: this.#core,
      topics: encodeEventTopics({
        abi: SUPPLY_COLLATERAL_ABI,
        eventName: 'SupplyCollateral',
        args: { id: position.marketId, onBehalf: position.borrower },
      }),
      fromBlock: activationBlocks.reduce((oldest, block) => Math.min(oldest, block)),
      toBlock: activationBlocks.reduce((newest, block) => Math.max(newest, block)),
    });
    const suppliesByLog = new Map<string, SupplyLog[]>();
    for (const supply of decodeLogs(SUPPLY_COLLATERAL_ABI, raw).map((log) => this.#supplyOf(log))) {
      const key = `${supply.transactionHash}:${supply.logIndex}`;
      suppliesByLog.set(key, [...(suppliesByLog.get(key) ?? []), supply]);
    }
    return suppliesByLog;
  }

  /** An activation with the assets of the one supply paired with it, if there is one; any other event unchanged. */
  #attachSupply(
    event: LifecycleEvent,
    suppliesByLog: ReadonlyMap<string, readonly SupplyLog[]>,
    position: PositionKey,
  ): WalkedEvent {
    if (event.kind !== 'activating') {
      return { ...event, kind: event.kind };
    }
    const candidates = suppliesByLog.get(`${event.at.transactionHash}:${event.at.logIndex + 1}`) ?? [];
    const paired = candidates.filter((supply) => this.#isPairedWith(supply, event, position));
    const supply = paired.length === 1 ? paired[0] : undefined;
    return { ...event, kind: event.kind, supplied: supply?.assets ?? null };
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
      candidates.add({ controller, marketId: supply.marketId, borrower: supply.borrower }, activation);
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

  async #reconstructPosition(plan: ScanPlan, candidate: DiscoveredPosition): Promise<SupplyAnchor[]> {
    const { position } = candidate;
    const events = this.lifecycleBack(position, plan.discoveryRange.to);
    const activationBlockByAnchor = new Map<string, AnchorActivation>();
    let positionAtPreviousHeartbeat: Position | null = null;
    let current: WalkedEvent | null = await this.#readNewestLifecycleEvent(events, candidate.newestEvent);
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
        const supplied = current.supplied;
        if (supplied === null) {
          throw new GuardianStop('position-history-broken');
        }
        // Appendix C reads the previous event to learn whether a lot started from zero absorbed dust. The paired
        // supply shows it too: when it carries the whole amount there was no dust, and the walk ends here.
        const startedFromZero = current.position.activating === current.amount;
        if (startedFromZero && supplied === current.amount) {
          break;
        }

        // `credit` records the supply plus all the dust before it as `amount`, so a dust supply left out of the
        // history right before this activation stops the walk here.
        const previousEvent = await this.#readOlderLifecycleEvent(events);
        if (current.amount !== supplied + (previousEvent?.position.dust ?? 0n)) {
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

  /**
   * The first event of a walk, which must be the newest event discovery read for the position through
   * the same report block, and must sit in the canonical block at its number. A walk whose first event
   * differs, or came from a branch the chain does not hold, read another history, so no decision is
   * taken from it.
   */
  async #readNewestLifecycleEvent(events: LifecycleEventStream, newestEvent: LifecycleEventRef): Promise<WalkedEvent> {
    const newest = await this.#readOlderLifecycleEvent(events);
    if (newest === null) {
      throw new GuardianStop('position-without-history');
    }
    if (!isSameEvent(newest.at, newestEvent)) {
      throw new GuardianStop('position-history-broken');
    }
    const canonical = await this.#rpc.getBlock(Number(newest.at.blockNumber));
    if (canonical.hash !== newest.at.blockHash) {
      throw new GuardianStop('log-not-canonical');
    }
    return newest;
  }

  async #readOlderLifecycleEvent(events: LifecycleEventStream): Promise<WalkedEvent | null> {
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

  /**
   * Whether `event` can directly follow the event that recorded `before`. Each case mirrors the
   * `CollateralActivationLib` write that emits that kind of event, compared on `dust` and `activating`; the
   * controller changes a position only through these writes, so a complete history always passes.
   */
  #canPrecede(before: Position, event: LifecycleEvent): boolean {
    const after = event.position;
    switch (event.kind) {
      case 'dusted':
        // `credit` keeps a supply below the activation threshold as dust.
        return after.dust === before.dust + event.amount && after.activating === before.activating;
      case 'activating':
        // `credit` moves the supply and all the dust into `activating`, so the dust before it cannot exceed `amount`.
        return after.activating === before.activating + event.amount && before.dust <= event.amount;
      case 'activated': {
        // `CollateralActivated` comes from an instant `credit`, which leaves the position as it was, or from a
        // maturity in `sync`, which moves all of `activating` out as `amount`. Neither changes dust.
        const isDustUnchanged = after.dust === before.dust;
        const isInstantActivation = after.activating === before.activating;
        const isMaturation = after.activating === 0n && event.amount === before.activating;
        return isDustUnchanged && (isInstantActivation || isMaturation);
      }
      case 'drained': {
        // `CollateralDrained` comes from `seize`, which takes `amount` from dust first and then from `activating`,
        // or from `debit`, which takes both whole and so fits the same split.
        const takenDust = before.dust < event.amount ? before.dust : event.amount;
        const takenActivating = event.amount - takenDust;
        return after.dust === before.dust - takenDust && after.activating === before.activating - takenActivating;
      }
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
    return { position: log.args.position, blockNumber: Number(log.blockNumber), log };
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

  /** Add a position with the activation that made it due; a position already added keeps its record. */
  add(key: PositionKey, activation: Activation): void {
    const id = `${key.controller}:${key.marketId}:${key.borrower}`;
    if (!this.#candidatesById.has(id)) {
      this.#candidatesById.set(id, { key, newestEvent: activation.log });
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
        this.#candidatesById.set(id, { key: candidate.key, newestEvent: newest });
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

function isSameEvent(at: LogRef, ref: LifecycleEventRef): boolean {
  return Number(at.blockNumber) === ref.blockNumber && at.logIndex === ref.logIndex && at.blockHash === ref.blockHash;
}

function isSameEventRef(left: LifecycleEventRef, right: LifecycleEventRef): boolean {
  return (
    left.blockNumber === right.blockNumber && left.logIndex === right.logIndex && left.blockHash === right.blockHash
  );
}
