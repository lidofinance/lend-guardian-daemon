// A signing client for benchmarks. The chain server mines each registry call, and waiting for
// inclusion or confirmations moves its virtual head instead of wall-clock time. Reads, receipts and
// confirmation checks run through the SDK's own BaseRpcProvider over the measured node, so they are
// counted like any other request. Fees, signing and replacement are not modelled.

import { BaseRpcProvider } from '../src/chain/base-rpc-provider.ts';
import type {
  ChainTransaction,
  PreparedTransaction,
  ReceiptRef,
  RpcClient,
  SendOptions,
  TransactionPolicy,
  TransactionRequest,
} from '../src/chain/rpc.ts';
import type { Address, Hex, TxHash } from '../src/common/types.ts';
import type { RemoteChain } from './chain-client.ts';
import { typedRequest } from './synthetic-rpc.ts';
import type { MinedTransaction, NodeRequest, ProviderQueue } from './synthetic-rpc.ts';

/**
 * Delivery policy the SDK reads from its client. Only `sendTimeoutMs` matters here: Guardian uses it
 * as the wall-clock bound of each report kind's shared confirmation wait, and requires it to cover
 * the confirmation depth plus one slot. Ten minutes covers the deepest scenario, 32 blocks.
 */
const POLICY: TransactionPolicy = Object.freeze({
  maxFeePerGas: 100_000_000_000n,
  sendTimeoutMs: 600_000,
  replacementFeeBumpBps: 1_000,
  replacementTimeoutMs: 36_000,
  sendAttempts: 5,
});

/** A registry transaction the client delivered, with the head when it was broadcast. */
export interface Delivery extends MinedTransaction {
  /** Position among this client's deliveries, from zero. */
  readonly sequence: number;
  readonly headAtBroadcast: number;
  readonly to: Address;
  readonly input: Hex;
}

export interface SyntheticClientOptions {
  readonly node: NodeRequest;
  readonly chain: RemoteChain;
  readonly signer: Address;
  readonly maxLogBlockRange: number;
  /** Blocks from broadcast to inclusion. */
  readonly inclusionBlocks: number;
  /** Called after each inclusion and before confirmations accumulate; faults are injected here. */
  readonly onIncluded?: ((delivery: Delivery) => Promise<void>) | undefined;
  /**
   * The modelled provider's queue, when the scenario has one: a send counts as a request in flight, so
   * the provider's answers do not move the clock while the chain server mines and confirms it.
   */
  readonly providerQueue?: ProviderQueue | undefined;
}

export class SyntheticClient extends BaseRpcProvider implements RpcClient {
  readonly signer: Address;

  readonly transactionPolicy = POLICY;

  readonly #chain: RemoteChain;

  readonly #inclusionBlocks: number;

  readonly #onIncluded: ((delivery: Delivery) => Promise<void>) | undefined;

  readonly #providerQueue: ProviderQueue | undefined;

  readonly #deliveries: Delivery[] = [];

  constructor(options: SyntheticClientOptions) {
    super({ request: typedRequest(options.node), maxLogBlockRange: options.maxLogBlockRange });
    this.signer = options.signer;
    this.#chain = options.chain;
    this.#inclusionBlocks = options.inclusionBlocks;
    this.#onIncluded = options.onIncluded;
    this.#providerQueue = options.providerQueue;
  }

  /** Every delivery so far, in order. */
  deliveries(): readonly Delivery[] {
    return this.#deliveries;
  }

  prepareTransaction(): Promise<PreparedTransaction> {
    return Promise.reject(new Error('The synthetic client delivers through send only'));
  }

  broadcastTransaction(): Promise<TxHash> {
    return Promise.reject(new Error('The synthetic client delivers through send only'));
  }

  /** Mine the call, let the fault hook act, then advance the head to the requested depth. */
  async send(transaction: TransactionRequest, options: SendOptions): Promise<ReceiptRef> {
    this.#providerQueue?.startRequest();
    try {
      return await this.#mine(transaction, options);
    } finally {
      this.#providerQueue?.finishRequest();
    }
  }

  /**
   * The call behind a delivered hash, as Guardian's receipt binding reads it. The synthetic chain keeps
   * no raw transactions, so the client answers from its deliveries, and this read is not counted as a
   * request, unlike the receipt and block reads of the same check.
   */
  override getTransaction(hash: TxHash): Promise<ChainTransaction | null> {
    const delivery = this.#deliveries.find((candidate) => candidate.hash === hash);
    if (delivery === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      transactionHash: delivery.hash,
      from: this.signer,
      to: delivery.to,
      input: delivery.input,
    });
  }

  async #mine(transaction: TransactionRequest, options: SendOptions): Promise<ReceiptRef> {
    const headAtBroadcast = await this.#chain.head();
    const mined = await this.#chain.include(transaction.data, this.#inclusionBlocks);
    const delivery: Delivery = {
      ...mined,
      sequence: this.#deliveries.length,
      headAtBroadcast,
      to: transaction.to,
      input: transaction.data,
    };
    this.#deliveries.push(delivery);
    await this.#onIncluded?.(delivery);
    await this.#chain.advanceTo(mined.blockNumber + options.confirmations - 1);
    if (mined.status === 'reverted') {
      throw new Error(`Synthetic ${mined.method} transaction reverted`);
    }
    return { transactionHash: mined.hash, blockNumber: mined.blockNumber, blockHash: mined.blockHash };
  }
}
