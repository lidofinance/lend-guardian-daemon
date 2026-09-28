import type { NodeRequest } from './client.ts';
// Configured viem clients with scripted actions; viem itself implements receipt waiting.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createPublicClient, createWalletClient, custom, keccak256, TransactionReceiptNotFoundError } from 'viem';
import { waitForTransactionReceipt, watchBlockNumber } from 'viem/actions';
import { mainnet } from 'viem/chains';
import type {
  Account,
  Chain,
  GetBlockNumberParameters,
  TransactionRequestEIP1559,
  SignTransactionParameters,
  TransactionReceipt,
  WaitForTransactionReceiptParameters,
  WatchBlockNumberParameters,
} from 'viem';
import type { ViemRpcClientOptions, TransactionPolicy } from '../../src/chain/viem-client.ts';
import type {
  Address,
  Bytes32,
  EventHandler,
  Hex,
  MarketId,
  SdkEvent,
  TransactionContext,
  TransactionDeliveryEvent,
  TxHash,
} from '../../src/core/index.ts';

export const REGISTRY: Address = '0x00000000000000000000000000000000000000e9';

export const GUARDIAN: Address = '0x000000000000000000000000000000000000009A';

/** The delegate: the address the harness signs as, and the one a cancellation pays itself from. */
export const DELEGATE: Address = '0x00000000000000000000000000000000000000d1';

export const BORROWER: Address = '0x00000000000000000000000000000000000000B1';

export const MARKET: MarketId = `0x${'11'.repeat(32)}`;

export const BLOCK_HASH: Bytes32 = `0x${'22'.repeat(32)}`;

export const RAW_TRANSACTION: Hex = '0x0102';

export const TRANSACTION_HASH: TxHash = keccak256(RAW_TRANSACTION);

export const PREPARED = {
  nonce: 7,
  gas: 50_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  chain: mainnet,
  chainId: 1,
  account: { address: DELEGATE, type: 'json-rpc' },
  from: DELEGATE,
  type: 'eip1559' as const,
};

export const RECEIPT: TransactionReceipt = {
  contractAddress: null,
  cumulativeGasUsed: 50_000n,
  effectiveGasPrice: 2n,
  from: DELEGATE,
  to: REGISTRY,
  gasUsed: 50_000n,
  logs: [],
  logsBloom: '0x',
  transactionIndex: 0,
  type: 'eip1559',
  blockNumber: 10n,
  blockHash: BLOCK_HASH,
  transactionHash: TRANSACTION_HASH,
  status: 'success',
};

export type Reply<Result> =
  | { readonly kind: 'value'; readonly value: Result }
  | { readonly kind: 'error'; readonly error: Error };

export function value<Result>(result: Result): Reply<Result> {
  return { kind: 'value', value: result };
}

export function failure<Result = never>(error: Error): Reply<Result> {
  return { kind: 'error', error };
}

/** A function under test control: callable as the interface names it, with every call kept. */
export interface Fake<Args extends readonly unknown[], Result> {
  (...args: Args): Promise<Result>;
  readonly calls: Args[];
}

/** A fake over an implementation, recording each call. */
export function implemented<Args extends readonly unknown[], Result>(
  implementation: (...args: Args) => Promise<Result>,
): Fake<Args, Result> {
  const calls: Args[] = [];
  const fake = (...args: Args): Promise<Result> => {
    calls.push(args);

    return implementation(...args);
  };

  return Object.assign(fake, { calls });
}

/** A fake answering the replies in order; the last one is repeated for every call after it. */
export function answering<Args extends readonly unknown[], Result>(
  ...replies: readonly Reply<Result>[]
): Fake<Args, Result> {
  const queue = [...replies];

  return implemented((..._args: Args) => {
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) {
      return Promise.reject(new Error('the fake has no reply left'));
    }

    return reply.kind === 'value' ? Promise.resolve(reply.value) : Promise.reject(reply.error);
  });
}

export type Signed = SignTransactionParameters<Chain, Account>;

interface NodeFakes {
  readonly getChainId: Fake<[], number>;
  readonly getBlockNumber: Fake<[{ readonly cacheTime: number }], bigint>;
  readonly getBlock: Fake<[{ readonly blockNumber: bigint }], { readonly hash: Bytes32 | null }>;
  readonly getTransactionReceipt: Fake<[{ readonly hash: TxHash }], TransactionReceipt>;
  readonly sendRawTransaction: Fake<[{ readonly serializedTransaction: Hex }], TxHash>;
}

interface WalletFakes {
  readonly prepareTransactionRequest: Fake<[TransactionRequestEIP1559], typeof PREPARED>;
}

interface HarnessOverrides {
  readonly node?: Partial<NodeFakes>;
  readonly wallet?: Partial<WalletFakes>;
  readonly signer?: { readonly signTransaction: Fake<[Signed], Hex> };
  readonly policy?: Partial<TransactionPolicy>;
  readonly request?: NodeRequest;
  readonly pollingInterval?: number;
}

interface Harness {
  readonly options: ViemRpcClientOptions;
  readonly observe: EventHandler;
  readonly events: ObservedTransactionEvent[];
  readonly node: NodeFakes;
  readonly wallet: WalletFakes;
  readonly signer: { readonly signTransaction: Fake<[Signed], Hex> };
}

export function harness(overrides: HarnessOverrides = {}): Harness {
  const events: ObservedTransactionEvent[] = [];
  const node: NodeFakes = {
    getChainId: answering(value(1)),
    getBlockNumber: answering(value(10n)),
    getBlock: answering(value({ hash: BLOCK_HASH })),
    getTransactionReceipt: answering(value(RECEIPT)),
    sendRawTransaction: answering(value(TRANSACTION_HASH)),
    ...overrides.node,
  };
  const wallet: WalletFakes = {
    prepareTransactionRequest: answering(value(PREPARED)),
    ...overrides.wallet,
  };
  const signer = {
    signTransaction: answering<[Signed], Hex>(value(RAW_TRANSACTION)),
    ...overrides.signer,
  };
  const transport = custom(
    {
      request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
        if (overrides.request !== undefined) {
          return overrides.request(method, params ?? []);
        }
        assert.equal(method, 'eth_getBlockByNumber', 'Isolated delivery must not read a plan');
        const number = params?.[0];
        assert.ok(typeof number === 'string');
        const block = await node.getBlock({ blockNumber: BigInt(number) });
        return { ...block, number, timestamp: '0x0' };
      },
    },
    { retryCount: 0 },
  );
  const publicClient = createPublicClient({
    chain: mainnet,
    transport,
    pollingInterval: overrides.pollingInterval ?? 1,
  });
  const walletClient = createWalletClient({ account: DELEGATE, chain: mainnet, transport });
  mock.method(publicClient, 'getChainId', node.getChainId);
  mock.method(publicClient, 'getBlockNumber', (args: GetBlockNumberParameters = {}) =>
    node.getBlockNumber({ cacheTime: args.cacheTime ?? 0 }),
  );
  mock.method(publicClient, 'getTransactionReceipt', async ({ hash }: { hash: TxHash }) => {
    const receipt = await node.getTransactionReceipt({ hash });
    if (receipt.transactionHash !== hash) {
      throw new TransactionReceiptNotFoundError({ hash });
    }
    return receipt;
  });
  mock.method(publicClient, 'sendRawTransaction', async (args: { serializedTransaction: Hex }) => {
    await node.sendRawTransaction(args);
    return keccak256(args.serializedTransaction);
  });
  mock.method(publicClient, 'waitForTransactionReceipt', (args: WaitForTransactionReceiptParameters) =>
    waitForTransactionReceipt(publicClient, args),
  );
  mock.method(publicClient, 'watchBlockNumber', (args: WatchBlockNumberParameters) =>
    watchBlockNumber(publicClient, args),
  );
  mock.method(walletClient, 'prepareTransactionRequest', wallet.prepareTransactionRequest);
  mock.method(walletClient, 'signTransaction', signer.signTransaction);
  const observe: EventHandler = (event) => {
    if (!isTransactionEvent(event)) {
      throw new Error(`Unexpected event ${event.event}`);
    }
    events.push(event);
  };
  return {
    options: {
      publicClient,
      walletClient,
      onEvent: observe,
      maxLogBlockRange: 1,
      transactionPolicy: {
        sendTimeoutMs: 10_000,
        replacementFeeBumpBps: 1_000,
        maxFeePerGas: 100n,
        replacementTimeoutMs: 10,
        sendAttempts: 2,
        ...overrides.policy,
      },
    },
    observe,
    events,
    node,
    wallet,
    signer,
  };
}

type ObservedTransactionEvent = TransactionDeliveryEvent & { readonly context?: TransactionContext | undefined };

type TransactionKind = ObservedTransactionEvent['event'] extends `transaction.${infer Kind}` ? Kind : never;

type EventOfKind<Kind extends TransactionKind> = ObservedTransactionEvent & {
  readonly event: `transaction.${Kind}`;
};

function isTransactionEvent(event: SdkEvent): event is ObservedTransactionEvent {
  return event.event.startsWith('transaction.');
}

export function ofKind<Kind extends TransactionKind>(
  events: readonly ObservedTransactionEvent[],
  kind: Kind,
): EventOfKind<Kind>[] {
  const name: `transaction.${Kind}` = `transaction.${kind}`;
  return events.filter((event): event is EventOfKind<Kind> => event.event === name);
}
