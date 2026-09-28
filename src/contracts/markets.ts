// Core and controller reads return typed market evidence; Guardian decides what the cycle covers.

import {
  encodeFunctionData,
  decodeFunctionResult,
  getAbiItem,
  isAddressEqual,
  pad,
  parseEventLogs,
  toEventSelector,
} from 'viem';
import type { ParseEventLogsReturnType } from 'viem';
import { MARKET_CONTROLLER_ABI } from '../../abi/MarketController.abi.ts';
import { CORE_ABI, SUPPLY_COLLATERAL_ABI, SUPPLY_COLLATERAL_TOPICS } from '../../abi/Core.abi.ts';
import { byLogPosition } from '../chain/log-order.ts';
import type { LogPosition } from '../chain/log-order.ts';
import type { RpcProvider, ChainLog } from '../chain/rpc.ts';
import { decodeLogs } from './decode-logs.ts';
import type { PositionKey } from '../core/types.ts';
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
export interface Position {
  readonly dust: bigint;
  readonly activating: bigint;
  /** The base deadline is `activatingStart + activatingDelay`; zero start means no timer. */
  readonly activatingStart: number;
  readonly activatingDelay: number;
}

type LifecycleKind = 'dusted' | 'activating' | 'activated' | 'drained';

/** One controller event for one borrower: every change to `dust`, `activating` and the timer. */
export interface Lifecycle {
  readonly kind: LifecycleKind;
  readonly amount: bigint;
  readonly position: Position;
  readonly at: LogRef;
}

/** One `SupplyCollateral`, reduced to what discovery and reconstruction compare. */
export interface SupplyLog {
  readonly marketId: MarketId;
  readonly borrower: Address;
  readonly assets: bigint;
  readonly blockHash: Bytes32;
  readonly transactionHash: TxHash;
  readonly logIndex: number;
}

/** A `CollateralActivating` that classified a supply: the timer it set, and where it was logged. */
export interface Activation {
  readonly position: Position;
  readonly blockNumber: number;
}

/** A log as the node returns it, before the core knows which event it is. */
type ReceiptLog = ChainLog;

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

const LIFECYCLE_KINDS: Record<LifecycleLog['eventName'], Lifecycle['kind']> = {
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
  readonly #controllers = new Map<MarketId, Address>();
  readonly #registries = new Map<Address, Address>();
  readonly #blockLogs = new Map<string, Promise<ReceiptLog[]>>();

  constructor(rpc: RpcProvider, deployment: ContractDeployment) {
    this.#rpc = rpc;
    this.#core = deployment.address;
    this.#deploymentBlock = deployment.deploymentBlock;
  }

  /** Read the discovery window or one historical block without applying cycle policy. */
  async supplies(range: { readonly fromBlock: number; readonly toBlock: number }): Promise<SupplyLog[]> {
    const raw = await this.#rpc.getLogs({
      address: this.#core,
      topics: SUPPLY_COLLATERAL_TOPICS,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    });
    return decodeLogs(SUPPLY_COLLATERAL_ABI, raw).map((log) => this.#supplyOf(log));
  }

  async controllerOf(marketId: MarketId, at: Bytes32): Promise<Address> {
    const cachedController = this.#controllers.get(marketId);
    if (cachedController !== undefined) {
      return cachedController;
    }

    const request = {
      abi: CORE_ABI,
      functionName: 'marketController',
      args: [marketId],
    } as const;
    const data = await this.#rpc.call(this.#core, encodeFunctionData(request), at);
    const controller = decodeFunctionResult({ ...request, data });

    this.#controllers.set(marketId, controller);
    return controller;
  }

  async registryOf(controller: Address, at: Bytes32): Promise<Address> {
    const cachedRegistry = this.#registries.get(controller);
    if (cachedRegistry !== undefined) {
      return cachedRegistry;
    }

    const request = {
      abi: MARKET_CONTROLLER_ABI,
      functionName: 'guardianSignals',
    } as const;
    const data = await this.#rpc.call(controller, encodeFunctionData(request), at);
    const registry = decodeFunctionResult({ ...request, data });

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

  /** The zero-boundary shortcut requires exactly one core supply paired with the activation. */
  async supplyAfter(position: PositionKey, activation: Lifecycle): Promise<SupplyLog> {
    const supplies = await this.supplies({
      fromBlock: Number(activation.at.blockNumber),
      toBlock: Number(activation.at.blockNumber),
    });
    const paired = supplies.filter((supply) => this.#isPairedWith(supply, activation, position));
    const supply = paired.length === 1 ? paired[0] : undefined;
    if (supply === undefined) {
      throw new GuardianStop('position-history-broken');
    }
    return supply;
  }

  /** The controller's lifecycle events for one borrower, newest first. */
  async *lifecycleBack(position: PositionKey, until: BlockRef): AsyncGenerator<Lifecycle> {
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

  /** The controller's logs of one block, read once however many of the block's supplies it classified. */
  #logsOf(controller: Address, blockHash: Bytes32): Promise<ReceiptLog[]> {
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
  #activationOf(log: ReceiptLog, borrower: Address): Activation | null {
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

  #isPairedWith(supply: SupplyLog, activation: Lifecycle, position: PositionKey): boolean {
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

  #lifecycleOf(log: LifecycleLog): Lifecycle {
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
