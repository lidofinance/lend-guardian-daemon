import type { EIP1193Parameters, PublicRpcSchema } from 'viem';
import type { TransactionContext } from '../events.ts';
import type { Address, BlockRef, Bytes32, Hex, TxHash } from '../common/types.ts';

const BASIS_POINTS_SCALE = 10_000n;

/** One JSON-RPC call. Errors are thrown; a result of `null` is a result, not a failure. */
export type RpcRequest = <Request extends EIP1193Parameters<PublicRpcSchema>>(
  request: Request,
) => Promise<Extract<PublicRpcSchema[number], { Method: Request['method'] }>['ReturnType']>;

/** The successful inclusion that subsequent canonical/depth checks must still find. */
export interface ReceiptRef {
  readonly transactionHash: TxHash;
  readonly blockNumber: number;
  readonly blockHash: Bytes32;
}

/** Normalized mined log; contract interpretation belongs to the contract layer. */
export interface ChainLog {
  readonly address: Address;
  readonly data: Hex;
  readonly topics: [] | [Hex, ...Hex[]];
  readonly blockNumber: bigint;
  readonly blockHash: Bytes32;
  readonly transactionHash: TxHash;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly removed: boolean;
}

export interface TransactionReceipt extends ReceiptRef {
  readonly status: 'success' | 'reverted';
}

/** The transaction a receipt names, as the chain holds it; `input` is the call it carries. */
export interface ChainTransaction {
  readonly transactionHash: TxHash;
  readonly from: Address;
  readonly to: Address | null;
  readonly input: Hex;
}

export interface LogFilter {
  readonly address: Address;
  readonly topics?: readonly (Hex | readonly Hex[] | null)[];
  readonly fromBlock: number;
  readonly toBlock: number;
}

export interface BlockLogFilter {
  readonly address: Address;
  readonly blockHash: Bytes32;
}

/** Chain reads in SDK types, independent of the library implementing request. */
export interface RpcProvider {
  readonly request: RpcRequest;
  call(to: Address, data: Hex, at: Bytes32): Promise<Hex>;
  getChainId(): Promise<number>;
  getTransactionCount(address: Address, at: 'latest' | 'pending' | number): Promise<number>;
  getBlock(number?: number): Promise<BlockRef>;
  getReceipt(hash: TxHash): Promise<TransactionReceipt | null>;
  getTransaction(hash: TxHash): Promise<ChainTransaction | null>;
  getLogs(filter: LogFilter | BlockLogFilter): Promise<ChainLog[]>;
  logBatches(filter: LogFilter, direction: 'forward' | 'backward'): AsyncIterable<ChainLog[]>;
  /** Decode every fetched log before selecting the newest; stop before older ranges. */
  getLastLog<Result>(filter: LogFilter, decode: (log: ChainLog) => Result): Promise<Result | undefined>;
  isConfirmed(receipt: ReceiptRef, head: BlockRef, depth: number): Promise<boolean>;
}

/** An immutable call; a replacement must preserve the chain, recipient, value and calldata. */
export interface TransactionRequest {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly nonce?: number;
  readonly gas?: bigint;
}

export interface TransactionPolicy {
  readonly maxFeePerGas: bigint;
  /**
   * Total time budget for one send, including preparation, inclusion and confirmation. Guardian
   * requires an integer from `(txConfirmationBlocks + 1) * slotSeconds * 1000` to 2_147_483_647 and
   * applies the same budget to its shared report-confirmation wait and to nonce clearing.
   */
  readonly sendTimeoutMs: number;
  /** Minimum fee increase for both EIP-1559 fields on replacement, in basis points. */
  readonly replacementFeeBumpBps: number;
  /** Inclusion wait before preparing a replacement at the same nonce; it sets how soon a stuck transaction is repriced. */
  readonly replacementTimeoutMs: number;
  /** Preparation attempts, including the initial transaction and estimates above the fee cap. */
  readonly sendAttempts: number;
}

/** Fully specified EIP-1559 transaction, ready for a configured signer. */
export interface PreparedTransaction extends TransactionRequest {
  readonly nonce: number;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface TransactionAttempt {
  readonly attempt: number;
  readonly context?: TransactionContext | undefined;
}

/** Per-send data only; the client receives its event handler at construction. */
export interface SendOptions {
  readonly confirmations: number;
  readonly context?: TransactionContext;
}

/** A raw broadcast failed before returning a transaction hash; the cause retains the client error. */
export class BroadcastFailure extends Error {
  constructor(cause: unknown) {
    super('Transaction broadcast did not return a hash', { cause });
    this.name = 'BroadcastFailure';
  }
}

/**
 * Delivery is available when a signing account is configured. `send` errors propagate unchanged;
 * one-shot clients wrap only raw-broadcast failures because they do not establish whether the node accepted the transaction.
 */
export interface RpcClient extends RpcProvider {
  readonly signer: Address | undefined;
  readonly transactionPolicy: TransactionPolicy;
  prepareTransaction(transaction: TransactionRequest, options: TransactionAttempt): Promise<PreparedTransaction>;
  broadcastTransaction(transaction: PreparedTransaction, options: TransactionAttempt): Promise<TxHash>;
  send(transaction: TransactionRequest, options: SendOptions): Promise<ReceiptRef>;
}

/** Internal delivery evidence: a receipt confirmed at the requested depth records a revert. */
export class ReceiptReverted extends Error {
  readonly receipt: ReceiptRef;

  constructor(receipt: ReceiptRef) {
    super('Transaction receipt reverted');
    this.name = 'ReceiptReverted';
    this.receipt = {
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
    };
  }
}

/** The greater of the current estimate and a strictly increased replacement fee. */
export function replacementFee(previous: bigint, estimated: bigint, basisPoints: number): bigint {
  const requiredIncrease = (previous * BigInt(basisPoints)) / BASIS_POINTS_SCALE;
  const minimum = previous + requiredIncrease + 1n;
  return estimated > minimum ? estimated : minimum;
}
