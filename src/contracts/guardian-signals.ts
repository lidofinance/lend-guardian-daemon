// GuardianSignals state, history and writes. This layer owns the ABI and contract address;
// Guardian decides which reports to send and when; its configured client signs and broadcasts them.

import { encodeEventTopics, encodeFunctionData, getAbiItem, decodeFunctionResult } from 'viem';
import { lower } from '../common/types.ts';
import type { Address, BlockRef, Bytes32, ContractDeployment, MarketId, Hex } from '../common/types.ts';
import type { SignalTarget } from '../core/types.ts';
import { GUARDIAN_SIGNALS_ABI } from '../../abi/GuardianSignals.abi.ts';
import type { ReceiptRef, RpcProvider, RpcClient, SendOptions } from '../chain/rpc.ts';
import { decodeLogs } from './decode-logs.ts';
import { GuardianStop } from '../core/stop.ts';

const HEARTBEAT_ABI = [getAbiItem({ abi: GUARDIAN_SIGNALS_ABI, name: 'Heartbeat' })] as const;

const GUARDIAN_ADDED_ABI = [getAbiItem({ abi: GUARDIAN_SIGNALS_ABI, name: 'GuardianAdded' })] as const;

/** The latest heartbeat's committed block and registry timestamp. */
export interface HeartbeatLog {
  readonly blockNumber: number;
  readonly timestamp: number;
}

interface GuardianSignalsConfig {
  readonly chainId: number;
  readonly deployment: ContractDeployment;
  readonly guardian: Address;
}

type GuardianSignalsOptions = GuardianSignalsConfig &
  (
    | { readonly mode: 'observe'; readonly client: RpcProvider }
    | { readonly mode?: 'signal'; readonly client: RpcClient }
  );

/** GuardianSignals calls and events for one registry and Guardian identity. */
export class GuardianSignals {
  readonly #rpc: RpcProvider;

  readonly #writer: RpcClient | undefined;

  readonly #chainId: number;

  readonly #registry: Address;

  readonly #guardian: Address;

  readonly #deploymentBlock: number;

  constructor(options: GuardianSignalsOptions) {
    this.#rpc = options.client;
    this.#writer = options.mode === 'observe' ? undefined : options.client;
    this.#chainId = options.chainId;
    this.#registry = options.deployment.address;
    this.#guardian = options.guardian;
    this.#deploymentBlock = options.deployment.deploymentBlock;
  }

  async isGuardian(at: Bytes32): Promise<boolean> {
    const request = {
      abi: GUARDIAN_SIGNALS_ABI,
      functionName: 'isGuardian',
      args: [this.#guardian],
    } as const;
    const data = await this.#rpc.call(this.#registry, encodeFunctionData(request), at);
    return decodeFunctionResult({ ...request, data });
  }

  async delegate(at: Bytes32): Promise<Address> {
    const request = {
      abi: GUARDIAN_SIGNALS_ABI,
      functionName: 'getDelegate',
      args: [this.#guardian],
    } as const;
    const data = await this.#rpc.call(this.#registry, encodeFunctionData(request), at);
    return decodeFunctionResult({ ...request, data });
  }

  async storedHeartbeat(at: Bytes32): Promise<number> {
    const request = {
      abi: GUARDIAN_SIGNALS_ABI,
      functionName: 'getHeartbeat',
      args: [this.#guardian],
    } as const;
    const data = await this.#rpc.call(this.#registry, encodeFunctionData(request), at);
    return decodeFunctionResult({ ...request, data });
  }

  async flaggedBy(target: SignalTarget, at: Bytes32): Promise<Address[]> {
    const request = {
      abi: GUARDIAN_SIGNALS_ABI,
      functionName: 'getFlaggedBy',
      args: [target.marketId, target.borrower],
    } as const;
    const data = await this.#rpc.call(this.#registry, encodeFunctionData(request), at);
    const flaggers = decodeFunctionResult({ ...request, data });
    return flaggers.map(lower);
  }

  suspect(marketId: MarketId, borrowers: readonly Address[], options: SendOptions): Promise<ReceiptRef> {
    const data = encodeFunctionData({
      abi: GUARDIAN_SIGNALS_ABI,
      functionName: 'suspect',
      args: [marketId, this.#guardian, borrowers],
    });
    return this.#send(data, options);
  }

  flag(marketId: MarketId, borrowers: readonly Address[], options: SendOptions): Promise<ReceiptRef> {
    const data = encodeFunctionData({
      abi: GUARDIAN_SIGNALS_ABI,
      functionName: 'flag',
      args: [marketId, this.#guardian, borrowers],
    });
    return this.#send(data, options);
  }

  heartbeat(block: BlockRef, digest: Bytes32, options: SendOptions): Promise<ReceiptRef> {
    const data = encodeFunctionData({
      abi: GUARDIAN_SIGNALS_ABI,
      functionName: 'heartbeat',
      args: [this.#guardian, block, digest],
    });
    return this.#send(data, options);
  }

  #send(data: Hex, options: SendOptions): Promise<ReceiptRef> {
    if (this.#writer === undefined) {
      throw new GuardianStop('submission-disabled');
    }
    return this.#writer.send({ chainId: this.#chainId, to: this.#registry, data, value: 0n }, options);
  }

  async latestHeartbeat(fromBlock: number, until: BlockRef): Promise<HeartbeatLog | null> {
    const topics = encodeEventTopics({
      abi: HEARTBEAT_ABI,
      eventName: 'Heartbeat',
      args: { guardian: this.#guardian },
    });
    const latest = await this.#rpc.getLastLog(
      {
        address: this.#registry,
        topics,
        fromBlock,
        toBlock: until.number,
      },
      (log) => decodeLogs(HEARTBEAT_ABI, [log])[0],
    );
    if (latest === undefined) {
      return null;
    }
    return {
      blockNumber: Number(latest.args.blockNumber),
      timestamp: Number(latest.args.timestamp),
    };
  }

  async latestGuardianAdded(until: BlockRef): Promise<number | null> {
    const topics = encodeEventTopics({
      abi: GUARDIAN_ADDED_ABI,
      eventName: 'GuardianAdded',
      args: { guardian: this.#guardian },
    });
    const latest = await this.#rpc.getLastLog(
      {
        address: this.#registry,
        topics,
        fromBlock: this.#deploymentBlock,
        toBlock: until.number,
      },
      (log) => decodeLogs(GUARDIAN_ADDED_ABI, [log])[0],
    );
    return latest === undefined ? null : Number(latest.blockNumber);
  }
}
