import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpRequestError, padHex, TransactionReceiptNotFoundError } from 'viem';
import { registryDelivery } from './delivery-fixture.ts';
import {
  answering,
  BORROWER,
  failure,
  harness,
  implemented,
  MARKET,
  ofKind,
  RECEIPT,
  TRANSACTION_HASH,
  value,
} from './delivery-fakes.ts';

const TARGET = { marketId: MARKET, borrower: BORROWER };
const missing = () => new TransactionReceiptNotFoundError({ hash: TRANSACTION_HASH });

test('slow confirmations do not trigger a replacement of an included transaction', async () => {
  const fake = harness({ policy: { replacementTimeoutMs: 1, sendAttempts: 5 } });
  await assert.rejects(registryDelivery(fake.options, fake.observe, 30).sendSuspects([TARGET], 3), {
    name: 'WaitForTransactionReceiptTimeoutError',
  });
  assert.equal(fake.wallet.prepareTransactionRequest.calls.length, 1);
  assert.equal(fake.node.sendRawTransaction.calls.length, 1);
  assert.equal(ofKind(fake.events, 'included').length, 1);
  assert.equal(ofKind(fake.events, 'replaced').length, 0);
});

for (const outcome of ['missing', 'relocated'] as const) {
  test(`a ${outcome} receipt after viem's cached depth result is rejected`, async () => {
    const changed =
      outcome === 'missing' ? failure(missing()) : value({ ...RECEIPT, blockHash: padHex('0x44'), blockNumber: 11n });
    const fake = harness({
      node: {
        getBlockNumber: answering(value(11n)),
        getTransactionReceipt: answering(value(RECEIPT), value(RECEIPT), changed),
      },
    });
    await assert.rejects(registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 2), {
      message: 'Transaction receipt is not canonical',
    });
    assert.equal(fake.node.sendRawTransaction.calls.length, 1);
  });
}

test('a head regression after viem resolves cannot establish the requested depth', async () => {
  const fake = harness({ node: { getBlockNumber: answering(value(11n), value(10n)) } });
  await assert.rejects(registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 2), {
    message: 'Transaction receipt has insufficient confirmations',
  });
  assert.equal(fake.node.sendRawTransaction.calls.length, 1);
});

test('a receipt RPC failure during viem polling propagates without a replacement', async () => {
  const error = new HttpRequestError({ status: 503, url: 'http://fixture.invalid' });
  const fake = harness({
    node: {
      getTransactionReceipt: answering(failure(missing()), failure(missing()), failure(error)),
    },
  });
  await assert.rejects(
    registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 1),
    (caught: unknown) => caught === error,
  );
  assert.equal(fake.wallet.prepareTransactionRequest.calls.length, 1);
  assert.equal(fake.node.sendRawTransaction.calls.length, 1);
});

test('a block polling outage is surfaced on timeout before any fee bump', async () => {
  const error = new HttpRequestError({ status: 503, url: 'http://fixture.invalid' });
  const fake = harness({
    node: {
      getBlockNumber: answering(failure(error)),
      getTransactionReceipt: answering(failure(missing())),
    },
  });
  await assert.rejects(
    registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 1),
    (caught: unknown) => caught === error,
  );
  assert.equal(fake.wallet.prepareTransactionRequest.calls.length, 1);
  assert.equal(fake.node.sendRawTransaction.calls.length, 1);
});

test('the original can become readable while viem is waiting for its replacement', async () => {
  let originalChecksAfterReplacement = 0;
  const fake = harness({
    node: {
      getTransactionReceipt: implemented(({ hash }) => {
        if (hash === TRANSACTION_HASH && fake.node.sendRawTransaction.calls.length === 2) {
          originalChecksAfterReplacement += 1;
          if (originalChecksAfterReplacement >= 2) {
            return Promise.resolve(RECEIPT);
          }
        }
        return Promise.reject(missing());
      }),
    },
    signer: { signTransaction: answering(value('0x0102'), value('0x0103')) },
  });
  const receipts = await registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 1);
  assert.equal(receipts[0]?.transactionHash, TRANSACTION_HASH);
  assert.equal(fake.node.sendRawTransaction.calls.length, 2);
  assert.equal(ofKind(fake.events, 'included').length, 1);
});

test('a receipt published at an unchanged head is recovered at timeout before replacement', async () => {
  const fake = harness({
    node: {
      getTransactionReceipt: answering(failure(missing()), failure(missing()), failure(missing()), value(RECEIPT)),
    },
  });
  const receipts = await registryDelivery(fake.options, fake.observe).sendSuspects([TARGET], 1);
  assert.equal(receipts[0]?.transactionHash, TRANSACTION_HASH);
  assert.equal(fake.wallet.prepareTransactionRequest.calls.length, 1);
  assert.equal(fake.node.sendRawTransaction.calls.length, 1);
});
