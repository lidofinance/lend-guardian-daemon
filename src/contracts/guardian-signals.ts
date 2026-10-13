// GuardianSignals state, history and writes. This layer owns the ABI and contract address;
// Guardian decides which reports to send and when; its configured client signs and broadcasts them.

import { encodeEventTopics, encodeFunctionData, getAbiItem, decodeFunctionResult } from 'viem';
import { lower } from '../common/types.ts';
import type { Address, BlockRef, Bytes32, ContractDeployment, MarketId, Hex } from '../common/types.ts';
import type { SignalTarget } from '../core/types.ts';
import { GUARDIAN_SIGNALS_ABI } from '../../abi/GuardianSignals.abi.ts';
import type { ReceiptRef, RpcProvider, RpcClient, SendOptions } from '../chain/rpc.ts';
import type { ReportContext } from '../events.ts';
import { decodeLogs } from './decode-logs.ts';
import { GuardianStop } from '../core/stop.ts';

const HEARTBEAT_ABI = [getAbiItem({ abi: GUARDIAN_SIGNALS_ABI, name: 'Heartbeat' })] as const;

const GUARDIAN_ADDED_ABI = [getAbiItem({ abi: GUARDIAN_SIGNALS_ABI, name: 'GuardianAdded' })] as const;

/** Chain evidence recovered for phase A of the scan cycle. */
export interface PreviousHeartbeatEvidence {
  readonly previousHeartbeatBlock: BlockRef | null;
  readonly heartbeatTimestampAtStart: number;
}

interface HeartbeatLog {
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

  async getHeartbeat(at: Bytes32): Promise<number> {
    const request = {
      abi: GUARDIAN_SIGNALS_ABI,
      functionName: 'getHeartbeat',
      args: [this.#guardian],
    } as const;
    const data = await this.#rpc.call(this.#registry, encodeFunctionData(request), at);
    return decodeFunctionResult({ ...request, data });
  }

  /**
   * Recover the previous heartbeat evidence required by the scan plan. The optional block is only
   * a search hint: its canonical header is checked before it can narrow the event range.
   */
  async recoverPreviousHeartbeat(
    observationBlock: BlockRef,
    hintedPreviousHeartbeatBlock: BlockRef | null = null,
  ): Promise<PreviousHeartbeatEvidence> {
    const heartbeatTimestampAtStart = await this.getHeartbeat(observationBlock.hash);
    if (heartbeatTimestampAtStart === 0) {
      return { heartbeatTimestampAtStart, previousHeartbeatBlock: null };
    }

    const searchFrom = await this.#heartbeatSearchFrom(heartbeatTimestampAtStart, hintedPreviousHeartbeatBlock);
    const latestHeartbeat = await this.#latestHeartbeatEvent(searchFrom, observationBlock);
    if (latestHeartbeat?.timestamp !== heartbeatTimestampAtStart) {
      return { heartbeatTimestampAtStart, previousHeartbeatBlock: null };
    }

    const reportedBlock = await this.#rpc.getBlock(latestHeartbeat.blockNumber);
    return {
      heartbeatTimestampAtStart,
      previousHeartbeatBlock: reportedBlock.timestamp === heartbeatTimestampAtStart ? reportedBlock : null,
    };
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
    return this.#send(this.encodeReport({ method: 'suspect', marketId, accounts: borrowers }), options);
  }

  flag(marketId: MarketId, borrowers: readonly Address[], options: SendOptions): Promise<ReceiptRef> {
    return this.#send(this.encodeReport({ method: 'flag', marketId, accounts: borrowers }), options);
  }

  heartbeat(block: BlockRef, digest: Bytes32, options: SendOptions): Promise<ReceiptRef> {
    return this.#send(this.encodeReport({ method: 'heartbeat', reportBlock: block, coverageDigest: digest }), options);
  }

  /** The registry call a report is sent as; a delivered transaction must carry exactly this. */
  encodeReport(report: ReportContext): Hex {
    if (report.method === 'heartbeat') {
      return encodeFunctionData({
        abi: GUARDIAN_SIGNALS_ABI,
        functionName: 'heartbeat',
        args: [this.#guardian, report.reportBlock, report.coverageDigest],
      });
    }
    return encodeFunctionData({
      abi: GUARDIAN_SIGNALS_ABI,
      functionName: report.method,
      args: [report.marketId, this.#guardian, report.accounts],
    });
  }

  #send(data: Hex, options: SendOptions): Promise<ReceiptRef> {
    if (this.#writer === undefined) {
      throw new GuardianStop('submission-disabled');
    }
    return this.#writer.send({ chainId: this.#chainId, to: this.#registry, data, value: 0n }, options);
  }

  async #heartbeatSearchFrom(
    heartbeatTimestampAtStart: number,
    hintedPreviousHeartbeatBlock: BlockRef | null,
  ): Promise<number> {
    if (hintedPreviousHeartbeatBlock === null) {
      return this.#deploymentBlock;
    }

    const canonicalBlock = await this.#rpc.getBlock(hintedPreviousHeartbeatBlock.number);
    if (canonicalBlock.hash !== hintedPreviousHeartbeatBlock.hash) {
      return this.#deploymentBlock;
    }
    return canonicalBlock.timestamp <= heartbeatTimestampAtStart
      ? hintedPreviousHeartbeatBlock.number
      : this.#deploymentBlock;
  }

  async #latestHeartbeatEvent(fromBlock: number, until: BlockRef): Promise<HeartbeatLog | null> {
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
