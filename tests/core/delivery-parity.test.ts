import { ViemRpcClient } from '../../src/chain/viem-client.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { numberToHex, padHex, TransactionReceiptNotFoundError, zeroAddress } from 'viem';
import { Guardian } from '../../src/core/index.ts';
import { Screened, Work } from '../../src/core/outcomes.ts';
import type { Signed } from './delivery-fakes.ts';
import type { TransactionRequestEIP1559 as PreparationArguments } from 'viem';
import type { Hex } from '../../src/core/index.ts';
import { SEND_TIMEOUT_MS } from './client.ts';
import { registryDelivery } from './delivery-fixture.ts';
import {
  answering,
  BORROWER,
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

const TARGET = { marketId: MARKET, borrower: BORROWER };

for (const status of ['success', 'reverted'] as const) {
  test(`an orphaned ${status} receipt cannot establish a confirmed transaction outcome`, async () => {
    const fake = harness({
      node: {
        getTransactionReceipt: answering(value({ ...RECEIPT, status })),
        getBlock: answering(value({ hash: padHex('0x44') })),
      },
    });
    await assert.rejects(registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 1), {
      message: 'Transaction receipt is not canonical',
    });
    assert.deepEqual(fake.node.getBlock.calls, [[{ blockNumber: 10n }]]);
    assert.equal(fake.node.sendRawTransaction.calls.length, 1);
    assert.equal(fake.events.filter((event) => event.event === 'transaction.failed').length, 1);
    assert.equal(ofKind(fake.events, 'failed').at(-1)?.stage, 'confirmation');
    assert.equal(ofKind(fake.events, 'failed').at(-1)?.reason, undefined);
  });
}

test('an orphaned first report stops Guardian before its second batch or heartbeat', async () => {
  const fake = harness({
    policy: { sendTimeoutMs: SEND_TIMEOUT_MS },
    node: { getBlockNumber: answering(value(11n)) },
    request: (method, params) => {
      if (method === 'eth_call') {
        return Promise.resolve(padHex('0x0'));
      }
      assert.equal(method, 'eth_getBlockByNumber');
      const number = params[0] === 'latest' ? 11 : Number(params[0]);
      return Promise.resolve({
        number: numberToHex(number),
        hash: padHex(numberToHex(number)),
        timestamp: numberToHex(number * 12),
      });
    },
  });
  const client = new ViemRpcClient(fake.options);
  const signer = fake.options.walletClient?.account.address;
  assert.ok(signer !== undefined);
  const guardian = new Guardian({
    deployment: {
      chainId: 1,
      slotSeconds: 12,
      lidoLend: { address: REGISTRY, deploymentBlock: 0 },
      guardianSignals: { address: REGISTRY, deploymentBlock: 0 },
    },
    guardian: signer,
    expectedDelegate: zeroAddress,
    client,
    screening: { screen: () => Promise.resolve([]) },
    maxSignalBatchSize: 1,
    idleHeartbeatInterval: 1,
    screeningTimeoutMs: 10_000,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: 2,
    onEvent: fake.observe,
  });
  const reportBlock = { number: 9, hash: padHex('0x09'), timestamp: 108 };
  const work = new Work(
    {
      kind: 'plan',
      previousHeartbeatBlock: null,
      heartbeatTimestampAtStart: 0,
      reportsSince: null,
      discoveryRange: { from: reportBlock, to: reportBlock },
    },
    new Map(),
  );
  const screened = new Screened(
    work,
    { results: [], skipped: [] },
    {
      suspects: [TARGET, { ...TARGET, borrower: padHex('0x02', { size: 20 }) }],
      flags: [],
    },
  );
  await assert.rejects(guardian.signalAndHeartbeat(screened), {
    message: 'Transaction receipt is not canonical',
  });
  assert.equal(fake.node.sendRawTransaction.calls.length, 1);
  assert.deepEqual(
    fake.events.map((event) => [event.event, event.context?.method]),
    [
      ['transaction.preparation', 'suspect'],
      ['transaction.signing', 'suspect'],
      ['transaction.broadcast', 'suspect'],
      ['transaction.included', 'suspect'],
      ['transaction.failed', 'suspect'],
    ],
  );
});

for (const delayed of ['preparation', 'signing'] as const) {
  test(`${delayed} time is excluded from the replacement window`, async () => {
    const broadcasts: number[] = [];
    const fake = harness({
      policy: { replacementTimeoutMs: 50 },
      node: {
        getTransactionReceipt: implemented((_query: { hash: Hex }) => {
          if (broadcasts.length < 2) {
            return Promise.reject(new TransactionReceiptNotFoundError({ hash: TRANSACTION_HASH }));
          }
          return Promise.resolve(RECEIPT);
        }),
        sendRawTransaction: implemented((_request: { serializedTransaction: Hex }) => {
          broadcasts.push(performance.now());
          return Promise.resolve(TRANSACTION_HASH);
        }),
      },
      wallet: {
        prepareTransactionRequest: implemented(async (_request: PreparationArguments) => {
          if (delayed === 'preparation' && broadcasts.length === 0) {
            await sleep(100);
          }
          return PREPARED;
        }),
      },
      signer: {
        signTransaction: implemented(async (_request: Signed) => {
          if (delayed === 'signing' && broadcasts.length === 0) {
            await sleep(100);
          }
          return RAW_TRANSACTION;
        }),
      },
    });
    await registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 1);
    assert.equal(broadcasts.length, 2);
    const [first, second] = broadcasts;
    assert.ok(first !== undefined && second !== undefined);
    // Allow timer rounding, but preparation/signing must not consume the pending interval.
    assert.ok(second - first >= 45);
    assert.equal(fake.wallet.prepareTransactionRequest.calls.length, 2);
    assert.equal(fake.signer.signTransaction.calls[1]?.[0].nonce, 7);
    assert.equal(fake.signer.signTransaction.calls[1][0].maxFeePerGas, 3n);
  });
}

test('a signature completed at the deadline is never broadcast', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const fake = harness({
    signer: {
      signTransaction: implemented((_request: Signed) => {
        context.mock.timers.setTime(11000);
        return Promise.resolve(RAW_TRANSACTION);
      }),
    },
  });
  await assert.rejects(registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 1), {
    name: 'DeliveryLimit',
    reason: 'confirmation-timeout',
  });
  assert.equal(fake.node.sendRawTransaction.calls.length, 0);
  assert.equal(ofKind(fake.events, 'failed').length, 1);
  assert.partialDeepStrictEqual(ofKind(fake.events, 'failed')[0], {
    event: 'transaction.failed',
    stage: 'signing',
    reason: 'confirmation-timeout',
  });
});
