// Core and controller reads return typed market evidence; Guardian decides what the cycle covers.

import {
  encodeEventTopics,
  encodeFunctionData,
  decodeFunctionResult,
  getAbiItem,
  isAddressEqual,
  pad,
  parseEventLogs,
  toEventSelector,
  zeroAddress,
} from 'viem';
import type { ParseEventLogsReturnType } from 'viem';
import { MARKET_CONTROLLER_ABI } from '../../abi/MarketController.abi.ts';
import { CORE_ABI, SUPPLY_COLLATERAL_ABI, SUPPLY_COLLATERAL_TOPICS } from '../../abi/Core.abi.ts';
import { byLogPosition } from '../chain/log-order.ts';
import type { LogPosition } from '../chain/log-order.ts';
import type { RpcProvider, ChainLog } from '../chain/rpc.ts';
import { decodeLogs } from './decode-logs.ts';
import type { ScanPlan } from '../core/outcomes.ts';
import type { PositionKey, SupplyAnchor } from '../core/types.ts';
import { GuardianStop } from '../core/stop.ts';
import { lower } from '../common/types.ts';
import type { Address, BlockRef, Bytes32, ContractDeployment, MarketId, TxHash } from '../common/types.ts';

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
 * Create one instance per phase call: binding caches belong to that call's report block,
 * and classification logs are cached by controller and historical block hash. No cache crosses calls.
 */
export class Markets {
  readonly #rpc: RpcProvider;
  readonly #core: Address;
  readonly #deploymentBlock: number;
  // Pending reads are cached, so supplies classified at once share one read per market and controller.
  readonly #controllers = new Map<MarketId, Promise<Address>>();
  readonly #registries = new Map<Address, Promise<Address>>();
  readonly #blockLogs = new Map<string, Promise<ChainLog[]>>();

  constructor(rpc: RpcProvider, deployment: ContractDeployment) {
    this.#rpc = rpc;
    this.#core = deployment.address;
    this.#deploymentBlock = deployment.deploymentBlock;
  }

  /** Discover every position that may require screening under Appendix B, `concurrency` supplies at a time. */
  async discoverCandidatePositions(
    plan: ScanPlan,
    targetRegistry: Address,
    concurrency: number,
  ): Promise<PositionKey[]> {
    const supplies = await this.supplies({
      fromBlock: plan.discoveryRange.from.number,
      toBlock: plan.discoveryRange.to.number,
    });
    const positions = await readInBatches(supplies, concurrency, (supply) =>
      this.#candidatePositionFromSupply(plan, supply, targetRegistry),
    );
    const candidatesByPosition = new Map<string, PositionKey>();
    for (const position of positions) {
      if (position !== null) {
        candidatesByPosition.set(`${position.marketId}:${position.borrower}`, position);
      }
    }
    return [...candidatesByPosition.values()];
  }

  /**
   * Reconstruct the uncovered contributors for every candidate position under Appendix C,
   * `concurrency` positions at a time.
   */
  async reconstructWork(
    plan: ScanPlan,
    positions: readonly PositionKey[],
    concurrency: number,
  ): Promise<ReadonlyMap<PositionKey, readonly SupplyAnchor[]>> {
    const walks = await readInBatches(positions, concurrency, async (position) => ({
      position,
      anchors: await this.#reconstructPosition(plan, position),
    }));
    const byPosition = new Map<PositionKey, readonly SupplyAnchor[]>();
    for (const { position, anchors } of walks) {
      if (anchors.length > 0) {
        byPosition.set(position, anchors);
      }
    }
    return byPosition;
  }

  /** Read the discovery window's supplies without applying cycle policy. */
  async supplies(range: { readonly fromBlock: number; readonly toBlock: number }): Promise<SupplyLog[]> {
    const raw = await this.#rpc.getLogs({
      address: this.#core,
      topics: SUPPLY_COLLATERAL_TOPICS,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    });
    return decodeLogs(SUPPLY_COLLATERAL_ABI, raw).map((log) => this.#supplyOf(log));
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
   * from controller logs at the supply's block hash, instead of Appendix B's transaction receipt.
   * This shares one controller/block read across supplies and avoids loading unrelated receipt logs;
   * transaction, adjacent log index and borrower still identify the same classification event.
   */
  async activationBefore(supply: SupplyLog, controller: Address): Promise<Activation | null> {
    const logs = await this.#logsOf(controller, supply.blockHash);
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

  async #candidatePositionFromSupply(
    plan: ScanPlan,
    supply: SupplyLog,
    targetRegistry: Address,
  ): Promise<PositionKey | null> {
    const controller = await this.controllerOf(supply.marketId, plan.discoveryRange.to.hash);
    if (controller === zeroAddress) {
      return null;
    }
    const reportsTo = await this.registryOf(controller, plan.discoveryRange.to.hash);
    if (!isAddressEqual(reportsTo, targetRegistry)) {
      return null;
    }

    const activation = await this.activationBefore(supply, controller);
    if (activation === null) {
      return null;
    }
    const deadline = activation.position.activatingStart + activation.position.activatingDelay;
    if (deadline > plan.discoveryRange.to.timestamp) {
      return null;
    }
    if (!this.#requiresCurrentCoverage(plan.previousHeartbeatBlock, activation.blockNumber, deadline)) {
      return null;
    }
    return { controller: lower(controller), marketId: supply.marketId, borrower: supply.borrower };
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

  /** The controller's logs of one block, read once however many of the block's supplies it classified. */
  #logsOf(controller: Address, blockHash: Bytes32): Promise<ChainLog[]> {
    const cacheKey = `${controller}:${blockHash}`;
    const cachedLogs = this.#blockLogs.get(cacheKey);
    if (cachedLogs !== undefined) {
      return cachedLogs;
    }

    const logs = this.#rpc.getLogs({ address: controller, blockHash });

    this.#blockLogs.set(cacheKey, logs);
    return logs;
  }

  /** The activation named by the classification immediately before a supply. */
  #activationOf(log: ChainLog, borrower: Address): Activation | null {
    const [classification] = parseEventLogs({
      abi: MARKET_CONTROLLER_ABI,
      eventName: ['CollateralDusted', 'CollateralActivating', 'CollateralActivated'],
      args: { borrower },
      logs: [log],
    });
    if (classification === undefined) {
      throw new GuardianStop('supply-without-controller-event');
    }
    if (classification.eventName !== 'CollateralActivating') {
      return null;
    }
    return { position: classification.args.position, blockNumber: Number(log.blockNumber) };
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
 * Read `items` `concurrency` at a time, in their order. Every read of a batch settles before the first
 * failure in item order ends the call, so no read outlives it.
 */
async function readInBatches<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  read: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let from = 0; from < items.length; from += concurrency) {
    const batch = await Promise.allSettled(items.slice(from, from + concurrency).map(read));
    for (const outcome of batch) {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
      results.push(outcome.value);
    }
  }
  return results;
}
