// Shared JSON-RPC reads. No client is constructed here; request uses the caller's transport.
import { hexToBigInt, hexToNumber, numberToHex } from 'viem';
import type { RpcLog, PublicRpcSchema } from 'viem';
import { lower } from '../common/types.ts';
import type { Address, BlockRef, Bytes32, Hex, TxHash } from '../common/types.ts';
import { requireInteger } from '../common/validation.ts';
import type {
  ChainTransaction,
  BlockLogFilter,
  ChainLog,
  LogFilter,
  ReceiptRef,
  RpcProvider,
  TransactionReceipt,
  RpcRequest,
} from './rpc.ts';
import { byLogPosition } from './log-order.ts';

type RpcLogFilter = Extract<PublicRpcSchema[number], { Method: 'eth_getLogs' }>['Parameters'][0];

export interface BaseRpcProviderOptions {
  readonly request: RpcRequest;
  readonly maxLogBlockRange: number;
}

/** Reusable reads for observe mode and for clients that add their own signing implementation. */
export class BaseRpcProvider implements RpcProvider {
  readonly request: RpcRequest;
  readonly #maxLogBlockRange: number;

  constructor(options: BaseRpcProviderOptions) {
    requireInteger('maxLogBlockRange', options.maxLogBlockRange, { min: 1 });
    this.request = options.request;
    this.#maxLogBlockRange = options.maxLogBlockRange;
  }

  call(to: Address, data: Hex, at: Bytes32): Promise<Hex> {
    return this.request({ method: 'eth_call', params: [{ to, data }, { blockHash: at }] });
  }

  async getChainId(): Promise<number> {
    return hexToNumber(await this.request({ method: 'eth_chainId' }));
  }

  async getTransactionCount(address: Address, at: 'latest' | 'pending' | number): Promise<number> {
    const block = typeof at === 'number' ? numberToHex(at) : at;
    return hexToNumber(await this.request({ method: 'eth_getTransactionCount', params: [address, block] }));
  }

  async getBlock(number?: number): Promise<BlockRef> {
    const tag = number === undefined ? 'latest' : numberToHex(number);
    const block = await this.request({ method: 'eth_getBlockByNumber', params: [tag, false] });
    if (block?.hash == null) {
      throw new TypeError('RPC block is missing or pending');
    }
    if (block.number === null) {
      throw new TypeError('RPC block has no number');
    }
    return {
      number: hexToNumber(block.number),
      hash: block.hash,
      timestamp: hexToNumber(block.timestamp),
    };
  }

  /** JSON-RPC null means pending/absent. A rejected request remains a failure. */
  async getReceipt(hash: TxHash): Promise<TransactionReceipt | null> {
    const receipt = await this.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt === null) {
      return null;
    }
    if (!['0x0', '0x1'].includes(receipt.status)) {
      throw new TypeError('RPC receipt has no valid status');
    }
    return {
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: hexToNumber(receipt.blockNumber),
      status: receipt.status === '0x1' ? 'success' : 'reverted',
    };
  }

  /** JSON-RPC null means unknown. A pending transaction is returned with the call it carries. */
  async getTransaction(hash: TxHash): Promise<ChainTransaction | null> {
    const transaction = await this.request({ method: 'eth_getTransactionByHash', params: [hash] });
    if (transaction === null) {
      return null;
    }
    return {
      transactionHash: transaction.hash,
      from: lower(transaction.from),
      to: transaction.to === null ? null : lower(transaction.to),
      input: transaction.input,
    };
  }

  async getLogs(filter: LogFilter | BlockLogFilter): Promise<ChainLog[]> {
    if ('blockHash' in filter) {
      return this.#logs(filter);
    }
    const found: ChainLog[] = [];
    for await (const logs of this.logBatches(filter, 'forward')) {
      found.push(...logs);
    }
    return found.sort(byLogPosition);
  }

  /** Static inclusive ranges; the consumer can stop a backward walk as soon as it has evidence. */
  async *logBatches(filter: LogFilter, direction: 'forward' | 'backward'): AsyncGenerator<ChainLog[]> {
    const ranges = this.#blockRanges(filter.fromBlock, filter.toBlock, direction);
    for (const [from, to] of ranges) {
      yield await this.#logs({
        address: filter.address,
        ...(filter.topics === undefined
          ? {}
          : {
              topics: filter.topics.map((topic) => (typeof topic === 'string' || topic === null ? topic : [...topic])),
            }),
        fromBlock: numberToHex(from),
        toBlock: numberToHex(to),
      });
    }
  }

  /** The caller's decoder also validates non-selected logs in the newest nonempty range. */
  async getLastLog<Result>(filter: LogFilter, decode: (log: ChainLog) => Result): Promise<Result | undefined> {
    for await (const logs of this.logBatches(filter, 'backward')) {
      if (logs.length > 0) {
        return logs.sort(byLogPosition).map(decode).at(-1);
      }
    }
    return undefined;
  }

  /** Successful, unchanged inclusion in a canonical block at the requested depth. */
  async isConfirmed(receipt: ReceiptRef, head: BlockRef, depth: number): Promise<boolean> {
    const landed = await this.getReceipt(receipt.transactionHash);
    if (landed?.status !== 'success') {
      return false;
    }
    const sameTransaction = landed.transactionHash === receipt.transactionHash;
    const sameBlock = landed.blockHash === receipt.blockHash;
    const sameNumber = landed.blockNumber === receipt.blockNumber;
    const sameInclusion = sameBlock && sameNumber;
    if (!sameTransaction || !sameInclusion) {
      return false;
    }
    const canonical = await this.getBlock(receipt.blockNumber);
    return canonical.hash === receipt.blockHash && head.number - receipt.blockNumber + 1 >= depth;
  }

  async #logs(filter: RpcLogFilter): Promise<ChainLog[]> {
    const logs = await this.request({ method: 'eth_getLogs', params: [filter] });
    return logs.map((log) => this.#log(log));
  }

  #log(log: RpcLog): ChainLog {
    if (log.blockNumber === null || log.blockHash === null) {
      throw new TypeError('RPC log has no mined block');
    }
    if (log.transactionHash === null || log.transactionIndex === null) {
      throw new TypeError('RPC log has no mined transaction');
    }
    if (log.logIndex === null) {
      throw new TypeError('RPC log has no log index');
    }
    return {
      address: log.address,
      data: log.data,
      topics: [...log.topics],
      blockNumber: hexToBigInt(log.blockNumber),
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      transactionIndex: hexToNumber(log.transactionIndex),
      logIndex: hexToNumber(log.logIndex),
      removed: log.removed,
    };
  }

  /** Inclusive static ranges, with identical batch boundaries in either traversal direction. */
  *#blockRanges(from: number, to: number, direction: 'forward' | 'backward' = 'forward'): Generator<[number, number]> {
    const size = this.#maxLogBlockRange;
    const last = Math.floor((to - from) / size);
    let index = direction === 'forward' ? 0 : last;
    const step = direction === 'forward' ? 1 : -1;
    while (index >= 0 && index <= last) {
      const start = from + index * size;
      yield [start, start + Math.min(size - 1, to - start)];
      // Stop before incrementing the last index, preserving maximum-safe block boundaries.
      if (index === (direction === 'forward' ? last : 0)) {
        return;
      }
      index += step;
    }
  }
}
