import { ViemRpcClient } from '../../src/chain/viem-client.ts';
import { BroadcastFailure, ReceiptReverted } from '../../src/chain/rpc.ts';
// Registry delivery: preparation failures propagate, replacements keep their call, and every
// broadcast and refusal retains its transaction context. Every test
// drives one write through fakes of the node, the preparer and the signer.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  custom,
  defineChain,
  encodeErrorResult,
  encodeFunctionData,
  HttpRequestError,
  InvalidParamsRpcError,
  keccak256,
  SocketClosedError,
  TimeoutError,
  TransactionReceiptNotFoundError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { REGISTRY_WRITES, registryDelivery } from './delivery-fixture.ts';
import type { TransactionRequestEIP1559 as PreparationArguments } from 'viem';
import type { Fake, Reply, Signed } from './delivery-fakes.ts';
import {
  answering,
  BLOCK_HASH,
  BORROWER,
  failure,
  GUARDIAN,
  harness,
  implemented,
  MARKET,
  ofKind,
  PREPARED,
  RAW_TRANSACTION,
  RECEIPT,
  REGISTRY,
  TRANSACTION_HASH,
  value,
} from './delivery-fakes.ts';

import type { Hex, SignalTarget, TxHash, SendOptions } from '../../src/core/index.ts';

const TARGET: SignalTarget = { marketId: MARKET, borrower: BORROWER };

const SUSPECT_CONTEXT = {
  operationId: 'suspect-fixture',
  method: 'suspect',
  marketId: MARKET,
  accounts: [BORROWER],
} as const;

const REPORT_BLOCK = { number: 42, hash: BLOCK_HASH, timestamp: 1_700_000_000 };

const DIGEST: Hex = `0x${'33'.repeat(32)}`;

const SUSPECT_DATA = encodeFunctionData({
  abi: REGISTRY_WRITES,
  functionName: 'suspect',
  args: [MARKET, GUARDIAN, [BORROWER]],
});

const SECOND_RAW: Hex = '0x0103';

const SECOND_HASH = keccak256(SECOND_RAW);

const RECEIPT_REVERTED = {
  ...RECEIPT,
  blockNumber: 10n,
  blockHash: BLOCK_HASH,
  transactionHash: TRANSACTION_HASH,
  status: 'reverted',
} as const;

const SECOND_RECEIPT = {
  ...RECEIPT,
  blockNumber: 12n,
  blockHash: BLOCK_HASH,
  transactionHash: SECOND_HASH,
  status: 'success',
} as const;

const preparation = (...replies: readonly Reply<typeof PREPARED>[]): Fake<[PreparationArguments], typeof PREPARED> =>
  answering(...replies);

const serverError = (): HttpRequestError => new HttpRequestError({ status: 503, url: 'https://rpc.invalid' });

const notFound = (): Error => new TransactionReceiptNotFoundError({ hash: TRANSACTION_HASH });

const knownRevert = (errorName: 'InvalidBlockHash' | 'Unauthorized'): ContractFunctionRevertedError =>
  new ContractFunctionRevertedError({
    abi: REGISTRY_WRITES,
    data: encodeErrorResult({ abi: REGISTRY_WRITES, errorName }),
    functionName: 'heartbeat',
  });

/** What a node answers over JSON-RPC when it refuses: the code and the data viem reads. */
class RpcFailure extends Error {
  readonly code: number;

  readonly data: Hex | undefined;

  constructor(code: number, message: string, data?: Hex) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** A real viem wallet client whose node reverts every estimate with `data`, for the decoding. */
function viemEstimateGasFailure(
  data: Hex,
  failureMethod: 'eth_estimateGas' | 'eth_fillTransaction' = 'eth_estimateGas',
): {
  readonly methods: string[];
  readonly prepare: Fake<[PreparationArguments], typeof PREPARED>;
} {
  const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const chain = defineChain({
    id: 1,
    name: 'test',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://unused.invalid'] } },
  });
  const methods: string[] = [];
  const client = createWalletClient({
    account,
    chain,
    transport: custom(
      {
        request: ({ method }: { readonly method: string }) => {
          methods.push(method);
          if (method === 'eth_fillTransaction' && failureMethod === 'eth_estimateGas') {
            return Promise.reject(new RpcFailure(-32_601, 'method not found'));
          }

          return Promise.reject(new RpcFailure(3, 'execution reverted', data));
        },
      },
      { retryCount: 0 },
    ),
  });

  return {
    methods,
    prepare: implemented(async (request: PreparationArguments) => {
      await client.prepareTransactionRequest({
        ...request,
        nonce: 7,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        type: 'eip1559',
      });
      throw new Error('Fixture expected estimation to fail');
    }),
  };
}

test('a heartbeat is written with the block as the ABI states it and returns its hash', async () => {
  const { options, observe, wallet } = harness();

  const hash = await registryDelivery(options, observe).sendHeartbeat(REPORT_BLOCK, DIGEST, 1);

  assert.equal(hash, TRANSACTION_HASH);
  assert.equal(
    wallet.prepareTransactionRequest.calls[0]?.[0].data,
    encodeFunctionData({
      abi: REGISTRY_WRITES,
      functionName: 'heartbeat',
      args: [GUARDIAN, REPORT_BLOCK, DIGEST],
    }),
  );
});

test('a second write while one is unresolved is refused', async () => {
  const { options, observe } = harness();
  const submitter = registryDelivery(options, observe);

  const first = submitter.sendSuspects([TARGET], 1);
  await assert.rejects(submitter.sendFlags([TARGET], 1), {
    message: 'another send is already in progress',
  });
  await first;
});

test('an original transaction can land during fee-cap waiting without another block', { timeout: 1000 }, async () => {
  const prepare = preparation(value(PREPARED), value({ ...PREPARED, maxFeePerGas: 200n }));
  const { options, observe, node } = harness({
    policy: { replacementTimeoutMs: 2, sendAttempts: 2 },
    wallet: { prepareTransactionRequest: prepare },
    node: {
      getBlockNumber: answering(value(12n)),
      getTransactionReceipt: implemented((_request: { readonly hash: TxHash }) => {
        if (prepare.calls.length < 2) {
          return Promise.reject(notFound());
        }
        return Promise.resolve({ ...SECOND_RECEIPT, transactionHash: TRANSACTION_HASH });
      }),
    },
  });

  const receipts = await registryDelivery(options, observe).sendSuspects([TARGET], 1);

  assert.deepEqual(receipts, [{ transactionHash: TRANSACTION_HASH, blockHash: BLOCK_HASH, blockNumber: 12 }]);
  assert.equal(prepare.calls.length, 2);
  assert.equal(node.sendRawTransaction.calls.length, 1);
});

test('delivery measures preparation, signing and first inclusion separately from confirmation', async (context) => {
  const clock = { now: 0 };
  context.mock.method(performance, 'now', () => clock.now);
  const { options, observe, events, node } = harness({
    wallet: {
      prepareTransactionRequest: implemented((_request: PreparationArguments) => {
        clock.now += 25;
        return Promise.resolve(PREPARED);
      }),
    },
    signer: {
      signTransaction: implemented((_request: Signed) => {
        clock.now += 15;
        return Promise.resolve(RAW_TRANSACTION);
      }),
    },
    node: {
      getBlockNumber: answering(value(10n), value(10n), value(10n), value(11n), value(12n)),
      sendRawTransaction: implemented((_request: { readonly serializedTransaction: Hex }) => {
        clock.now += 5;
        return Promise.resolve(TRANSACTION_HASH);
      }),
      getTransactionReceipt: implemented((_request: { readonly hash: TxHash }) => {
        clock.now += 80;
        return Promise.resolve({
          ...SECOND_RECEIPT,
          transactionHash: TRANSACTION_HASH,
          blockNumber: 10n,
        });
      }),
    },
  });

  await registryDelivery(options, observe).sendSuspects([TARGET], 3);

  const [prepared] = ofKind(events, 'preparation');
  const [signed] = ofKind(events, 'signing');
  const [broadcast] = ofKind(events, 'broadcast');
  assert.ok(prepared !== undefined);
  assert.ok(signed !== undefined);
  assert.ok(broadcast !== undefined);
  assert.partialDeepStrictEqual(prepared, { event: 'transaction.preparation', context: SUSPECT_CONTEXT, attempt: 1 });
  assert.partialDeepStrictEqual(signed, { event: 'transaction.signing', context: SUSPECT_CONTEXT, attempt: 1 });
  assert.partialDeepStrictEqual(broadcast, {
    event: 'transaction.broadcast',
    context: SUSPECT_CONTEXT,
    nonce: 7,
    transactionHash: TRANSACTION_HASH,
    attempt: 1,
  });
  assert.equal(prepared.finishedAt - prepared.startedAt, 25);
  assert.equal(signed.finishedAt - signed.startedAt, 15);
  assert.equal(broadcast.finishedAt - broadcast.startedAt, 5);
  assert.deepEqual(ofKind(events, 'included'), [
    {
      event: 'transaction.included',
      context: SUSPECT_CONTEXT,
      transactionHash: TRANSACTION_HASH,
      receiptBlockHash: BLOCK_HASH,
      receiptStatus: 'success',
      durationMs: 80,
    },
  ]);
  assert.equal(node.getTransactionReceipt.calls.length, 3);
  assert.equal(node.sendRawTransaction.calls.length, 1);
});

test('a receipt that reverted is a revert nobody names, recorded at confirmation', async () => {
  const { options, observe, events } = harness({
    node: { getTransactionReceipt: answering(value(RECEIPT_REVERTED)) },
  });

  await assert.rejects(registryDelivery(options, observe).sendSuspects([TARGET], 1), (error: unknown) => {
    assert.ok(error instanceof ReceiptReverted);
    assert.deepEqual(error.receipt, {
      transactionHash: TRANSACTION_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: 10,
    });

    return true;
  });
  assert.deepEqual(ofKind(events, 'failed'), [
    {
      event: 'transaction.failed',
      context: SUSPECT_CONTEXT,
      stage: 'confirmation',
      reason: 'transaction-reverted',
      receiptStatus: 'reverted',
      receiptBlockHash: BLOCK_HASH,
    },
  ]);
});

for (const data of [
  '0xdeadbeef',
  encodeErrorResult({ abi: REGISTRY_WRITES, errorName: 'InvalidBlockHash' }),
] as const) {
  test(`a real viem estimate revert ${data} stops immediately without a second preparation`, async () => {
    const viemFailure = viemEstimateGasFailure(data);
    const { options, observe, events, node } = harness({
      wallet: { prepareTransactionRequest: viemFailure.prepare },
    });
    await assert.rejects(
      registryDelivery(options, observe).sendHeartbeat(REPORT_BLOCK, DIGEST, 1),
      (error: unknown) => error instanceof BaseError,
    );
    assert.equal(viemFailure.prepare.calls.length, 1);
    assert.equal(viemFailure.methods.filter((method) => method === 'eth_estimateGas').length, 1);
    assert.equal(node.sendRawTransaction.calls.length, 0);
    assert.equal(ofKind(events, 'retry').length, 0);
    assert.ok(ofKind(events, 'failed')[0]?.error instanceof BaseError);
  });
}

for (const error of [
  serverError(),
  new HttpRequestError({ status: 429, url: 'https://rpc.invalid' }),
  new BaseError('wrapped timeout', {
    cause: new TimeoutError({ body: {}, url: 'https://rpc.invalid' }),
  }),
  new SocketClosedError({ url: 'https://rpc.invalid' }),
]) {
  test(`a ${error.name} from preparation propagates once; the transport owns retry policy`, async () => {
    const { options, observe, events, node, wallet } = harness({
      wallet: { prepareTransactionRequest: preparation(failure(error)) },
    });
    await assert.rejects(
      registryDelivery(options, observe).sendFlags([TARGET], 1),
      (caught: unknown) => caught === error,
    );
    assert.equal(wallet.prepareTransactionRequest.calls.length, 1);
    assert.equal(node.sendRawTransaction.calls.length, 0);
    assert.equal(ofKind(events, 'retry').length, 0);
    assert.equal(ofKind(events, 'failed')[0]?.error, error);
  });
}

test('a known revert while preparing a replacement fails without a second broadcast', async () => {
  const refusal = knownRevert('Unauthorized');
  const { options, observe, node } = harness({
    node: {
      getTransactionReceipt: answering(failure(notFound())),
      getBlockNumber: answering(value(12n)),
    },
    wallet: {
      prepareTransactionRequest: preparation(value(PREPARED), failure(refusal)),
    },
    policy: { replacementTimeoutMs: 2 },
  });

  await assert.rejects(registryDelivery(options, observe).sendSuspects([TARGET], 1), (error: unknown) => {
    assert.equal(error, refusal);
    return true;
  });
  assert.equal(node.sendRawTransaction.calls.length, 1);
});

test('preparation failures do not consume a lifetime budget shared by subsequent sends', async () => {
  const temporary = serverError();
  const { options, observe, wallet } = harness({
    wallet: { prepareTransactionRequest: preparation(failure(temporary), value(PREPARED)) },
  });
  const sender = registryDelivery(options, observe);
  await assert.rejects(sender.sendSuspects([TARGET], 1), (error: unknown) => error === temporary);
  await sender.sendFlags([TARGET], 1);
  await sender.sendHeartbeat(REPORT_BLOCK, DIGEST, 1);
  assert.equal(wallet.prepareTransactionRequest.calls.length, 3);
});

test('an authorization failure viem nested is not retried', async () => {
  const authorization = new BaseError('wrapped', {
    cause: new HttpRequestError({ status: 401, url: 'https://rpc.invalid' }),
  });
  const { options, observe, wallet, node } = harness({
    wallet: { prepareTransactionRequest: preparation(failure(authorization)) },
  });

  await assert.rejects(
    registryDelivery(options, observe).sendSuspects([TARGET], 1),
    (error: unknown) => error === authorization,
  );
  assert.equal(wallet.prepareTransactionRequest.calls.length, 1);
  assert.equal(node.sendRawTransaction.calls.length, 0);
});

test('invalid parameters and a signing failure are not retried', async () => {
  const invalid = harness({
    wallet: {
      prepareTransactionRequest: preparation(failure(new InvalidParamsRpcError(new Error('invalid params')))),
    },
  });
  await assert.rejects(
    registryDelivery(invalid.options, invalid.observe).sendSuspects([TARGET], 1),
    (error: unknown) => error instanceof InvalidParamsRpcError,
  );
  assert.equal(invalid.wallet.prepareTransactionRequest.calls.length, 1);
  assert.equal(invalid.node.sendRawTransaction.calls.length, 0);

  const signing = harness({
    signer: { signTransaction: answering(failure(new Error('signer unavailable'))) },
  });
  await assert.rejects(registryDelivery(signing.options, signing.observe).sendSuspects([TARGET], 1), {
    message: 'signer unavailable',
  });
  assert.equal(signing.signer.signTransaction.calls.length, 1);
  assert.equal(signing.node.sendRawTransaction.calls.length, 0);
  assert.deepEqual(
    signing.events.map((event) => [event.event, 'stage' in event ? event.stage : undefined]),
    [
      ['transaction.preparation', undefined],
      ['transaction.failed', 'signing'],
    ],
  );
});

test('a known heartbeat revert in preparation propagates unchanged, unretried and unsent', async () => {
  const refused = knownRevert('InvalidBlockHash');
  const { options, observe, node, wallet } = harness({
    wallet: { prepareTransactionRequest: preparation(failure(refused)) },
  });

  await assert.rejects(registryDelivery(options, observe).sendHeartbeat(REPORT_BLOCK, DIGEST, 1), (error: unknown) => {
    assert.equal(error, refused);

    return true;
  });
  assert.equal(wallet.prepareTransactionRequest.calls.length, 1);
  assert.equal(node.sendRawTransaction.calls.length, 0);
  assert.equal(node.sendRawTransaction.calls.length, 0);
});

test('an infrastructure failure is recorded at the stage it hit before it propagates', async () => {
  const wallet = new Error('wallet unavailable');
  const { options, observe, events } = harness({
    wallet: { prepareTransactionRequest: preparation(failure(wallet)) },
  });

  await assert.rejects(registryDelivery(options, observe).sendSuspects([TARGET], 1), {
    message: 'wallet unavailable',
  });
  assert.deepEqual(events, [
    {
      event: 'transaction.failed',
      context: SUSPECT_CONTEXT,
      stage: 'preparation',
      error: wallet,
    },
  ]);
});

test('a replacement is recorded with the hash it supersedes, at a bumped fee', async () => {
  const { options, observe, events, signer } = harness({
    node: {
      getTransactionReceipt: answering(failure(notFound()), value(SECOND_RECEIPT)),
      getBlockNumber: answering(value(12n)),
    },
    signer: { signTransaction: answering(value(RAW_TRANSACTION), value(SECOND_RAW)) },
    policy: { replacementTimeoutMs: 2 },
  });

  const receipts = await registryDelivery(options, observe).sendSuspects([TARGET], 1);

  assert.ok(!('kind' in receipts));
  assert.equal(receipts[0]?.transactionHash, SECOND_HASH);
  assert.deepEqual(ofKind(events, 'replaced'), [
    {
      event: 'transaction.replaced',
      context: SUSPECT_CONTEXT,
      nonce: 7,
      replacedHash: TRANSACTION_HASH,
      replacementHash: SECOND_HASH,
      replacementAttempt: 2,
    },
  ]);
  assert.equal(signer.signTransaction.calls[1]?.[0].nonce, 7);
  assert.equal(signer.signTransaction.calls[1][0].to, REGISTRY);
  assert.equal(signer.signTransaction.calls[1][0].data, SUSPECT_DATA);
  assert.equal(signer.signTransaction.calls[1][0].value, 0n);
  assert.equal(signer.signTransaction.calls[1][0].maxFeePerGas, 3n);
  assert.equal(signer.signTransaction.calls[1][0].maxPriorityFeePerGas, 2n);
});

test('a fee over the cap waits the replacement interval per attempt and gives up when the attempts are spent', async () => {
  const { options, observe, events, node, wallet } = harness({
    wallet: { prepareTransactionRequest: preparation(value({ ...PREPARED, maxFeePerGas: 200n })) },
    node: { getBlockNumber: answering(value(10n), value(11n), value(12n), value(13n)) },
  });

  await assert.rejects(registryDelivery(options, observe).sendSuspects([TARGET], 1), {
    message: 'Transaction delivery stopped: send-attempts-exhausted',
  });
  assert.equal(node.sendRawTransaction.calls.length, 0);
  assert.equal(wallet.prepareTransactionRequest.calls.length, 2);
  assert.deepEqual(
    ofKind(events, 'failed').map((event) => event.reason),
    ['send-attempts-exhausted'],
  );
});

test('an eth_fillTransaction EVM refusal stops preparation without simulation or broadcast', async () => {
  const refused = viemEstimateGasFailure('0xdeadbeef', 'eth_fillTransaction');
  const { options, observe, node } = harness({
    wallet: { prepareTransactionRequest: refused.prepare },
  });
  await assert.rejects(
    registryDelivery(options, observe).sendSuspects([TARGET], 1),
    (error: unknown) => error instanceof BaseError,
  );
  assert.deepEqual(refused.methods, ['eth_fillTransaction']);
  assert.equal(node.sendRawTransaction.calls.length, 0);
});

test('an over-cap replacement consumes one preparation attempt and preserves the nonce on the next attempt', async () => {
  const head = { number: 10n };
  const fake = harness({
    policy: { sendAttempts: 3, replacementTimeoutMs: 1 },
    node: {
      getBlockNumber: implemented((_options: { readonly cacheTime: number }) => Promise.resolve(head.number++)),
      getTransactionReceipt: implemented(({ hash }) => {
        if (fake.node.sendRawTransaction.calls.length === 2 && hash === SECOND_HASH) {
          return Promise.resolve(SECOND_RECEIPT);
        }
        return Promise.reject(notFound());
      }),
    },
    wallet: {
      prepareTransactionRequest: preparation(
        value({ ...PREPARED, maxFeePerGas: 90n }),
        value({ ...PREPARED, maxFeePerGas: 200n }),
        value({ ...PREPARED, maxFeePerGas: 95n }),
      ),
    },
    signer: { signTransaction: answering(value(RAW_TRANSACTION), value(SECOND_RAW)) },
  });
  const receipts = await registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 1);
  assert.equal(receipts[0]?.transactionHash, SECOND_HASH);
  assert.equal(fake.wallet.prepareTransactionRequest.calls.length, 3);
  assert.equal(fake.node.sendRawTransaction.calls.length, 2);
  assert.deepEqual(
    fake.wallet.prepareTransactionRequest.calls.map(([request]) => request.nonce),
    [undefined, 7, 7],
  );
  assert.equal(fake.signer.signTransaction.calls[1]?.[0].maxFeePerGas, 100n);
});

test('the original transaction may confirm after its replacement was broadcast', async () => {
  const fake = harness({
    policy: { replacementTimeoutMs: 1 },
    node: {
      getBlockNumber: answering(value(12n)),
      getTransactionReceipt: implemented(({ hash }) => {
        if (fake.node.sendRawTransaction.calls.length === 2 && hash === TRANSACTION_HASH) {
          return Promise.resolve({ ...SECOND_RECEIPT, transactionHash: TRANSACTION_HASH });
        }
        return Promise.reject(notFound());
      }),
    },
    signer: { signTransaction: answering(value(RAW_TRANSACTION), value(SECOND_RAW)) },
  });
  const receipts = await registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 1);
  assert.equal(receipts[0]?.transactionHash, TRANSACTION_HASH);
  assert.equal(fake.node.sendRawTransaction.calls.length, 2);
});

test('a delivery deadline bounds block polling at the configured interval and releases the send lock', async () => {
  const fake = harness({
    node: { getTransactionReceipt: answering(failure(notFound())) },
    pollingInterval: 1000,
    policy: { replacementTimeoutMs: 1000, sendTimeoutMs: 100 },
  });
  const client = new ViemRpcClient(fake.options);
  const transaction = { chainId: 1, to: REGISTRY, data: SUSPECT_DATA, value: 0n };
  const options: SendOptions = {
    confirmations: 1,
    context: { operationId: 'deadline-test', method: 'suspect', marketId: MARKET, accounts: [BORROWER] },
  };
  await assert.rejects(client.send(transaction, options), {
    name: 'DeliveryLimit',
    reason: 'confirmation-timeout',
  });
  // One head observation by viem and a fresh probe at timeout; no intervening timer poll.
  assert.equal(fake.node.getBlockNumber.calls.length, 2);
  assert.equal(fake.node.sendRawTransaction.calls.length, 1);
  await assert.rejects(client.send(transaction, options), {
    name: 'DeliveryLimit',
    reason: 'confirmation-timeout',
  });
  assert.equal(fake.node.getBlockNumber.calls.length, 4);
  assert.equal(fake.node.sendRawTransaction.calls.length, 2);
});

test('an ambiguous broadcast failure preserves its cause and cannot become a registry refusal', async () => {
  const refused = knownRevert('InvalidBlockHash');
  const { options, observe, node } = harness({
    node: { sendRawTransaction: answering(failure(refused)) },
  });
  await assert.rejects(registryDelivery(options, observe).sendHeartbeat(REPORT_BLOCK, DIGEST, 1), (error: unknown) => {
    assert.equal(error, refused);
    return true;
  });
  assert.equal(node.sendRawTransaction.calls.length, 1);
});

test('one-shot broadcast classifies a raw RPC failure without inspecting its message', async () => {
  const refused = serverError();
  const { options, node } = harness({
    node: { sendRawTransaction: answering(failure(refused)) },
    request: (method) => {
      assert.equal(method, 'eth_chainId');
      return Promise.resolve('0x1');
    },
  });
  const client = new ViemRpcClient(options);
  const transaction = { ...PREPARED, to: REGISTRY, data: SUSPECT_DATA, value: 0n };

  await assert.rejects(client.broadcastTransaction(transaction, { attempt: 1 }), (error: unknown) => {
    assert.ok(error instanceof BroadcastFailure);
    assert.equal(error.cause, refused);
    return true;
  });
  assert.equal(node.sendRawTransaction.calls.length, 1);
});

test('a receipt RPC failure propagates unchanged and is not treated as an absent receipt', async () => {
  const unavailable = new HttpRequestError({ status: 401, url: 'https://rpc.invalid' });
  const { options, observe, node } = harness({
    node: { getTransactionReceipt: answering(failure(unavailable)) },
  });
  await assert.rejects(registryDelivery(options, observe).sendHeartbeat(REPORT_BLOCK, DIGEST, 1), (error: unknown) => {
    assert.equal(error, unavailable);
    return true;
  });
  assert.equal(node.getTransactionReceipt.calls.length, 1);
  assert.equal(node.sendRawTransaction.calls.length, 1);
});

test('a pending receipt can become readable without another block or replacement', { timeout: 1000 }, async () => {
  const { options, observe, node } = harness({
    node: {
      getBlockNumber: answering(value(10n)),
      getTransactionReceipt: answering(
        failure(notFound()),
        value({
          ...RECEIPT,
          transactionHash: TRANSACTION_HASH,
          blockHash: BLOCK_HASH,
          blockNumber: 10n,
          status: 'success',
        }),
      ),
    },
  });
  const receipt = await registryDelivery(options, observe).sendHeartbeat(REPORT_BLOCK, DIGEST, 1);
  assert.equal(receipt, TRANSACTION_HASH);
  assert.equal(node.getTransactionReceipt.calls.length, 3);
  assert.equal(node.sendRawTransaction.calls.length, 1);
});

for (const field of ['sendTimeoutMs', 'replacementFeeBumpBps'] as const) {
  test(`transaction policy rejects invalid ${field} before contacting the node`, () => {
    const { options, node } = harness();
    for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () =>
          new ViemRpcClient({
            ...options,
            transactionPolicy: { ...options.transactionPolicy, [field]: value },
          }),
        RangeError,
      );
    }
    assert.equal(node.getChainId.calls.length, 0);
  });
}

test('replacement fees honor the configured percentage on both fee fields', async () => {
  const prepared = { ...PREPARED, maxFeePerGas: 40n, maxPriorityFeePerGas: 10n };
  const { options, observe, signer } = harness({
    node: {
      getTransactionReceipt: answering(failure(notFound()), value(SECOND_RECEIPT)),
      getBlockNumber: answering(value(12n)),
    },
    wallet: { prepareTransactionRequest: preparation(value(prepared)) },
    signer: { signTransaction: answering(value(RAW_TRANSACTION), value(SECOND_RAW)) },
    policy: { maxFeePerGas: 100n, replacementTimeoutMs: 2, replacementFeeBumpBps: 2000 },
  });
  await registryDelivery(options, observe).sendSuspects([TARGET], 1);
  const replacement = signer.signTransaction.calls[1]?.[0];
  assert.ok(replacement !== undefined);
  assert.equal(replacement.maxFeePerGas, 49n);
  assert.equal(replacement.maxPriorityFeePerGas, 13n);
  assert.equal(replacement.nonce, prepared.nonce);
});
