// EIP-1559 delivery over configured viem clients. The transport owns RPC retries and failover.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Account, Chain, PublicClient, TransactionReceipt as ViemReceipt, Transport, WalletClient } from 'viem';
import { emitEvent } from '../events.ts';
import type { EventHandler, TransactionContext, TransactionStage } from '../events.ts';
import { frozenCopy } from '../common/immutable.ts';
import { rejectAfter } from '../common/timeout.ts';
import { BaseRpcProvider } from './base-rpc-provider.ts';
import { GuardianStop } from '../core/stop.ts';
import { BroadcastFailure, ReceiptReverted, replacementFee } from './rpc.ts';
import type {
  PreparedTransaction,
  ReceiptRef,
  RpcClient,
  SendOptions,
  TransactionAttempt,
  TransactionPolicy,
  TransactionRequest,
} from './rpc.ts';
import type { Address, Hex, TxHash } from '../common/types.ts';
import { requireDefined, requireInteger } from '../common/validation.ts';

export interface ViemRpcClientOptions {
  readonly publicClient: PublicClient;
  /** Omit for reads only; send requires a configured signing account. */
  readonly walletClient?: WalletClient<Transport, Chain, Account> | undefined;
  readonly maxLogBlockRange: number;
  readonly transactionPolicy: TransactionPolicy;
  readonly onEvent?: EventHandler;
}

class DeliveryLimit extends Error {
  readonly reason: 'send-attempts-exhausted' | 'confirmation-timeout' | 'signing-timeout';

  constructor(reason: DeliveryLimit['reason']) {
    super(`Transaction delivery stopped: ${reason}`);
    this.name = 'DeliveryLimit';
    this.reason = reason;
  }
}

/** Configured viem clients own library actions; this adapter owns bounded same-nonce delivery. */
export class ViemRpcClient extends BaseRpcProvider implements RpcClient {
  readonly #publicClient: PublicClient;
  readonly #walletClient: WalletClient<Transport, Chain, Account> | undefined;
  readonly transactionPolicy: TransactionPolicy;
  readonly #onEvent: EventHandler | undefined;
  #isSending = false;
  readonly signer: Address | undefined;

  constructor(options: ViemRpcClientOptions) {
    super({
      maxLogBlockRange: options.maxLogBlockRange,
      request: options.publicClient.request,
    });
    const policy = options.transactionPolicy;
    if (typeof policy.maxFeePerGas !== 'bigint' || policy.maxFeePerGas <= 0n) {
      throw new RangeError('maxFeePerGas must be a positive bigint');
    }
    requireInteger('replacementTimeoutMs', policy.replacementTimeoutMs, { min: 1 });
    requireInteger('sendTimeoutMs', policy.sendTimeoutMs, { min: 1, max: 2_147_483_647 });
    requireInteger('replacementFeeBumpBps', policy.replacementFeeBumpBps, { min: 1 });
    requireInteger('sendAttempts', policy.sendAttempts, { min: 1 });
    this.#publicClient = options.publicClient;
    this.#walletClient = options.walletClient;
    this.transactionPolicy = Object.freeze({ ...policy });
    this.#onEvent = options.onEvent;
    this.signer = options.walletClient?.account.address;
  }

  /** Prepare, sign, broadcast and await inclusion; only pending transactions can be replaced. */
  async send(transaction: TransactionRequest, options: SendOptions): Promise<ReceiptRef> {
    const walletClient = requireDefined('walletClient', this.#walletClient);
    if (this.#isSending) {
      throw new Error('another send is already in progress');
    }
    requireInteger('confirmations', options.confirmations, { min: 1 });
    const call = Object.freeze({ ...transaction });
    const { confirmations } = options;
    const context = frozenCopy(options.context);
    const deadline = Date.now() + this.transactionPolicy.sendTimeoutMs;
    const hashes: TxHash[] = [];
    let previous: PreparedTransaction | undefined;
    let receipt: ViemReceipt | null = null;
    let firstBroadcastAt: number | undefined;
    let attempts = 0;
    let stage: TransactionStage = 'preparation';
    this.#isSending = true;
    try {
      if ((await this.#publicClient.getChainId()) !== call.chainId) {
        throw new GuardianStop('chain-id-mismatch');
      }
      while (receipt === null) {
        if (Date.now() >= deadline) {
          throw new DeliveryLimit('confirmation-timeout');
        }
        stage = 'preparation';
        if (attempts >= this.transactionPolicy.sendAttempts) {
          throw new DeliveryLimit('send-attempts-exhausted');
        }
        attempts += 1;
        const prepared = await this.#prepare(call, previous, attempts, context);
        if (Date.now() >= deadline) {
          throw new DeliveryLimit('confirmation-timeout');
        }
        if (prepared.maxFeePerGas <= this.transactionPolicy.maxFeePerGas) {
          stage = 'signing';
          const signed = await this.#sign(walletClient, prepared, attempts, context, deadline);
          if (Date.now() >= deadline) {
            throw new DeliveryLimit('confirmation-timeout');
          }
          stage = 'broadcast';
          const hash = await this.#broadcast(signed, prepared.nonce, attempts, context);
          const replacedHash = hashes.at(-1);
          hashes.push(hash);
          previous = prepared;
          firstBroadcastAt ??= performance.now();
          if (replacedHash !== undefined) {
            emitEvent(this.#onEvent, {
              event: 'transaction.replaced',
              context,
              nonce: prepared.nonce,
              replacedHash,
              replacementHash: hash,
              replacementAttempt: hashes.length,
            });
          }
        }
        stage = 'confirmation';
        receipt = await this.#waitForInclusion(hashes, deadline);
      }
      if (!hashes.includes(receipt.transactionHash)) {
        throw new Error('Transaction receipt names a replaced transaction');
      }
      if (firstBroadcastAt !== undefined) {
        emitEvent(this.#onEvent, {
          event: 'transaction.included',
          context,
          transactionHash: receipt.transactionHash,
          receiptBlockHash: receipt.blockHash,
          receiptStatus: receipt.status,
          durationMs: performance.now() - firstBroadcastAt,
        });
      }
      return await this.#confirm(receipt, { confirmations, deadline });
    } catch (error) {
      if (error instanceof ReceiptReverted) {
        emitEvent(this.#onEvent, {
          event: 'transaction.failed',
          context,
          stage,
          reason: 'transaction-reverted',
          receiptStatus: 'reverted',
          receiptBlockHash: error.receipt.blockHash,
        });
      } else {
        const reason = error instanceof DeliveryLimit ? { reason: error.reason } : {};
        emitEvent(this.#onEvent, { event: 'transaction.failed', context, stage, ...reason, error });
      }
      throw error;
    } finally {
      this.#isSending = false;
    }
  }

  /** Estimate a transaction without broadcasting; the caller may supply a specific nonce. */
  async prepareTransaction(transaction: TransactionRequest, options: TransactionAttempt): Promise<PreparedTransaction> {
    const walletClient = requireDefined('walletClient', this.#walletClient);
    const startedAt = performance.timeOrigin + performance.now();
    const prepared = await walletClient.prepareTransactionRequest({ ...transaction, type: 'eip1559' });
    emitEvent(this.#onEvent, {
      event: 'transaction.preparation',
      ...options,
      startedAt,
      finishedAt: performance.timeOrigin + performance.now(),
    });
    return Object.freeze({
      chainId: transaction.chainId,
      to: transaction.to,
      value: transaction.value,
      data: transaction.data,
      nonce: prepared.nonce,
      gas: prepared.gas,
      maxFeePerGas: prepared.maxFeePerGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
    });
  }

  /** Sign and broadcast exactly once, without a replacement or confirmation loop. */
  async broadcastTransaction(transaction: PreparedTransaction, options: TransactionAttempt): Promise<TxHash> {
    const walletClient = requireDefined('walletClient', this.#walletClient);
    if (this.#isSending) {
      throw new Error('another send is already in progress');
    }
    const call = Object.freeze({ ...transaction });
    const { attempt, context } = frozenCopy(options);
    const deadline = Date.now() + this.transactionPolicy.sendTimeoutMs;
    this.#isSending = true;
    try {
      if ((await this.getChainId()) !== call.chainId) {
        throw new GuardianStop('chain-id-mismatch');
      }
      if (call.maxFeePerGas > this.transactionPolicy.maxFeePerGas) {
        throw new RangeError('Transaction fee exceeds maxFeePerGas');
      }
      const signed = await this.#sign(walletClient, call, attempt, context, deadline);
      try {
        return await this.#broadcast(signed, call.nonce, attempt, context);
      } catch (error) {
        throw new BroadcastFailure(error);
      }
    } finally {
      this.#isSending = false;
    }
  }

  /** Preserve the call and nonce while raising both fees enough to replace the previous broadcast. */
  async #prepare(
    call: TransactionRequest,
    previous: PreparedTransaction | undefined,
    attempt: number,
    context: TransactionContext | undefined,
  ): Promise<PreparedTransaction> {
    const estimated = await this.prepareTransaction(
      { ...call, ...(previous === undefined ? {} : { nonce: previous.nonce }) },
      { attempt, context },
    );
    if (previous === undefined) {
      return estimated;
    }
    const bump = this.transactionPolicy.replacementFeeBumpBps;
    return {
      ...estimated,
      maxFeePerGas: replacementFee(previous.maxFeePerGas, estimated.maxFeePerGas, bump),
      maxPriorityFeePerGas: replacementFee(previous.maxPriorityFeePerGas, estimated.maxPriorityFeePerGas, bump),
    };
  }

  /** A signer that never answers, such as a remote key service, must not hold the send past its budget. */
  async #sign(
    walletClient: WalletClient<Transport, Chain, Account>,
    prepared: PreparedTransaction,
    attempt: number,
    context: TransactionContext | undefined,
    deadline: number,
  ): Promise<Hex> {
    const startedAt = performance.timeOrigin + performance.now();
    const remainingMs = Math.max(deadline - Date.now(), 0);
    const signed = await Promise.race([
      walletClient.signTransaction({ ...prepared, type: 'eip1559' }),
      rejectAfter(remainingMs, new DeliveryLimit('signing-timeout')),
    ]);
    emitEvent(this.#onEvent, {
      event: 'transaction.signing',
      context,
      attempt,
      startedAt,
      finishedAt: performance.timeOrigin + performance.now(),
    });
    return signed;
  }

  async #broadcast(
    signed: Hex,
    nonce: number,
    attempt: number,
    context: TransactionContext | undefined,
  ): Promise<TxHash> {
    const startedAt = performance.timeOrigin + performance.now();
    const hash = await this.#publicClient.sendRawTransaction({ serializedTransaction: signed });
    emitEvent(this.#onEvent, {
      event: 'transaction.broadcast',
      context,
      attempt,
      nonce,
      transactionHash: hash,
      startedAt,
      finishedAt: performance.timeOrigin + performance.now(),
    });
    return hash;
  }

  /** A null result permits another attempt; RPC failures remain errors rather than replacement signals. */
  async #waitForInclusion(hashes: readonly TxHash[], deadline: number): Promise<ViemReceipt | null> {
    // Surface receipt errors directly before entering viem's waiter, which suppresses its first read error.
    const receipt = await this.#receiptOf(hashes);
    if (receipt !== null) {
      return receipt;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new DeliveryLimit('confirmation-timeout');
    }
    const replacementTimeoutMs = this.transactionPolicy.replacementTimeoutMs;
    const isBoundedByDeadline = remainingMs <= replacementTimeoutMs;
    const timeout = Math.min(replacementTimeoutMs, remainingMs);
    const hash = hashes.at(-1);
    if (hash === undefined) {
      // No broadcast was allowed by the fee cap. Pace the next estimate.
      await sleep(timeout);
      return null;
    }
    try {
      return await this.#publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout,
        checkReplacement: false,
      });
    } catch (error) {
      if (!isNamedError(error, 'WaitForTransactionReceiptTimeoutError')) {
        throw error;
      }
      // viem can suppress head-poll errors. A failed fresh read must not cause a fee bump.
      await this.#publicClient.getBlockNumber({ cacheTime: 0 });
      const receiptAfterTimeout = await this.#receiptOf(hashes);
      if (receiptAfterTimeout !== null) {
        return receiptAfterTimeout;
      }
      if (isBoundedByDeadline) {
        throw new DeliveryLimit('confirmation-timeout');
      }
      return null;
    }
  }

  /** Any of our broadcasts can land, including the original after a replacement was submitted. */
  async #receiptOf(hashes: readonly TxHash[]): Promise<ViemReceipt | null> {
    for (const hash of hashes) {
      const receipt = await this.#publicClient.getTransactionReceipt({ hash }).catch((error: unknown) => {
        if (isNamedError(error, 'TransactionReceiptNotFoundError')) {
          return null;
        }
        throw error;
      });
      if (receipt !== null) {
        if (receipt.transactionHash !== hash) {
          throw new Error('Transaction receipt names a replaced transaction');
        }
        return receipt;
      }
    }
    return null;
  }

  /** Await depth without replacing an included transaction, then verify fresh canonical evidence. */
  async #confirm(
    receipt: ViemReceipt,
    { confirmations, deadline }: { readonly confirmations: number; readonly deadline: number },
  ): Promise<ReceiptRef> {
    const timeout = deadline - Date.now();
    if (timeout <= 0) {
      throw new DeliveryLimit('confirmation-timeout');
    }
    if (confirmations > 1) {
      await this.#publicClient.waitForTransactionReceipt({
        hash: receipt.transactionHash,
        confirmations,
        timeout,
        checkReplacement: false,
      });
    }
    // The waiter may retain an earlier receipt in memory, so check the current inclusion again.
    const landed = await this.#receiptOf([receipt.transactionHash]);
    const sameBlock = landed?.blockHash === receipt.blockHash;
    const sameNumber = landed?.blockNumber === receipt.blockNumber;
    if (!sameBlock || !sameNumber) {
      throw new Error('Transaction receipt is not canonical');
    }
    const head = await this.#publicClient.getBlockNumber({ cacheTime: 0 });
    if (head - receipt.blockNumber + 1n < BigInt(confirmations)) {
      throw new Error('Transaction receipt has insufficient confirmations');
    }
    const confirmed = {
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: Number(receipt.blockNumber),
    };
    const block = await this.getBlock(confirmed.blockNumber);
    if (block.hash !== receipt.blockHash) {
      throw new Error('Transaction receipt is not canonical');
    }
    if (landed.status === 'reverted') {
      throw new ReceiptReverted(confirmed);
    }
    return confirmed;
  }
}

export { createViemRpcTransport, LogsNotConfirmedError } from './viem-transport.ts';
export type { ViemRpcTransport, ViemRpcTransportOptions } from './viem-transport.ts';

export type { TransactionPolicy } from './rpc.ts';

/** Match public viem error identities across package instances. */
function isNamedError(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}
