// Shared JSON-RPC reads. No client is constructed here; request uses the caller's transport.
import { hexToBigInt, hexToNumber, numberToHex } from 'viem';
import type { RpcLog, PublicRpcSchema } from 'viem';
import type { Address, BlockRef, Bytes32, Hex, TxHash } from '../common/types.ts';
import { requireInteger } from '../common/validation.ts';
import type { ChainLog, LogFilter, ReceiptRef, RpcProvider, TransactionReceipt, RpcRequest } from './rpc.ts';
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

  async getLogs(filter: LogFilter): Promise<ChainLog[]> {
    const found: ChainLog[] = [];
    for await (const logs of this.logBatches(filter, 'forward')) {
      found.push(...logs);
    }
    return found.sort(byLogPosition);
  }

  /**
   * Static inclusive ranges; the consumer can stop a backward walk as soon as it has evidence. A range
   * whose read fails is read again in halves, down to one block, because a provider's log limit or the
   * transport's response limit refuses a range that holds too many logs; a block that fails alone
   * propagates its error.
   */
  async *logBatches(filter: LogFilter, direction: 'forward' | 'backward'): AsyncGenerator<ChainLog[]> {
    // Ranges still to read, the next one last, so the halves of a failed range keep the traversal order.
    const pending = [...this.#blockRanges(filter.fromBlock, filter.toBlock, direction)].reverse();
    while (true) {
      const range = pending.pop();
      if (range === undefined) {
        return;
      }
      const [from, to] = range;
      let logs: ChainLog[];
      try {
        logs = await this.#rangeLogs(filter, from, to);
      } catch (error) {
        if (from === to) {
          throw error;
        }
        pending.push(...halves(from, to, direction));
        continue;
      }
      yield logs;
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

  #rangeLogs(filter: LogFilter, from: number, to: number): Promise<ChainLog[]> {
    return this.#logs({
      address: filter.address,
      ...(filter.topics === undefined ? {} : { topics: [...filter.topics] }),
      fromBlock: numberToHex(from),
      toBlock: numberToHex(to),
    });
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

/** The halves of a failed range in the order to push them, so the half read first is popped first. */
function halves(from: number, to: number, direction: 'forward' | 'backward'): [number, number][] {
  const middle = from + Math.floor((to - from) / 2);
  const lower: [number, number] = [from, middle];
  const upper: [number, number] = [middle + 1, to];
  return direction === 'forward' ? [upper, lower] : [lower, upper];
}
