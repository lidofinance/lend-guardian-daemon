import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseRpcProvider, BroadcastFailure, Guardian, GuardianStop } from '../../src/core/index.ts';
import type {
  Address,
  EventHandler,
  PreparedTransaction,
  RpcClient,
  SdkEvent,
  TransactionAttempt,
  TransactionRequest,
  TxHash,
} from '../../src/core/index.ts';
import { rpcRequest, SEND_TIMEOUT_MS } from './client.ts';

const SIGNER: Address = '0x00000000000000000000000000000000000000d1';
const GUARDIAN: Address = '0x000000000000000000000000000000000000009a';
const CORE: Address = '0x00000000000000000000000000000000000000c0';
const GUARDIAN_SIGNALS: Address = '0x00000000000000000000000000000000000000e9';
const BLOCK_HASH = `0x${'22'.repeat(32)}` as const;
const TRANSACTION_HASH: TxHash = `0x${'33'.repeat(32)}`;

interface NonceState {
  latest: number;
  pending: number;
}

interface PreparedRecord {
  readonly transaction: PreparedTransaction;
  readonly attempt: TransactionAttempt;
}

interface BroadcastRecord extends PreparedRecord {
  readonly state: NonceState;
  readonly broadcasts: readonly PreparedRecord[];
}

interface NonceOverrides {
  readonly latest?: number;
  readonly pending?: number;
  readonly chainId?: number;
  readonly maxFeePerGas?: bigint;
  readonly sendTimeoutMs?: number;
  readonly replacementFeeBumpBps?: number;
  readonly replacementTimeoutMs?: number;
  readonly sendAttempts?: number;
  readonly estimatedMaxFeePerGas?: bigint;
  readonly estimatedPriorityFeePerGas?: bigint;
  readonly mode?: 'observe' | 'signal';
  readonly observerThrows?: boolean;
  readonly broadcast?: (record: BroadcastRecord) => Promise<void>;
}

function nonceClient(
  state: NonceState,
  prepared: PreparedRecord[],
  broadcasts: PreparedRecord[],
  overrides: NonceOverrides,
): RpcClient {
  const provider = new BaseRpcProvider({
    request: rpcRequest(() => Promise.reject(new Error('unexpected JSON-RPC request'))),
    maxLogBlockRange: 1,
  });
  return Object.assign(provider, {
    signer: SIGNER,
    transactionPolicy: {
      maxFeePerGas: overrides.maxFeePerGas ?? 100n,
      sendTimeoutMs: overrides.sendTimeoutMs ?? SEND_TIMEOUT_MS,
      replacementFeeBumpBps: overrides.replacementFeeBumpBps ?? 1_250,
      replacementTimeoutMs: overrides.replacementTimeoutMs ?? 1,
      sendAttempts: overrides.sendAttempts ?? 3,
    },
    getChainId: () => Promise.resolve(overrides.chainId ?? 1),
    getTransactionCount: (_address: Address, at: 'latest' | 'pending' | number) =>
      Promise.resolve(at === 'pending' ? state.pending : state.latest),
    getBlock: (number?: number) => Promise.resolve({ number: number ?? 10, hash: BLOCK_HASH, timestamp: 1 }),
    prepareTransaction: (request: TransactionRequest, attempt: TransactionAttempt) => {
      const transaction: PreparedTransaction = {
        ...request,
        nonce: request.nonce ?? 0,
        gas: request.gas ?? 21_000n,
        maxFeePerGas: overrides.estimatedMaxFeePerGas ?? 16n,
        maxPriorityFeePerGas: overrides.estimatedPriorityFeePerGas ?? 8n,
      };
      prepared.push({ transaction, attempt });
      return Promise.resolve(transaction);
    },
    broadcastTransaction: async (transaction: PreparedTransaction, attempt: TransactionAttempt) => {
      broadcasts.push({ transaction, attempt });
      if (overrides.broadcast === undefined) {
        state.latest += 1;
      } else {
        await overrides.broadcast({ transaction, attempt, state, broadcasts });
      }
      return TRANSACTION_HASH;
    },
    send: () => Promise.reject(new Error('nonce recovery must use prepare and broadcast primitives')),
  });
}

function recoveryFixture(overrides: NonceOverrides = {}) {
  const state = { latest: overrides.latest ?? 7, pending: overrides.pending ?? 7 };
  const prepared: PreparedRecord[] = [];
  const broadcasts: PreparedRecord[] = [];
  const events: SdkEvent[] = [];
  const client = nonceClient(state, prepared, broadcasts, overrides);
  const onEvent: EventHandler =
    overrides.observerThrows === true
      ? () => {
          throw new Error('observer failed');
        }
      : (event) => events.push(event);
  const common = {
    deployment: {
      chainId: 1,
      slotSeconds: 12,
      lidoLend: { address: CORE, deploymentBlock: 0 },
      guardianSignals: { address: GUARDIAN_SIGNALS, deploymentBlock: 0 },
    },
    guardian: GUARDIAN,
    screening: { screen: () => Promise.resolve([]) },
    reportBlockLag: 2,
    readConcurrency: 8,
    interBatchConfirmationBlocks: 2,
    confirmationPollIntervalMs: 1,
    idleHeartbeatInterval: 3_600,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: 1,
    maxSignalBatchSize: 20,
    onEvent,
  };
  const guardian =
    overrides.mode === 'observe'
      ? new Guardian({ ...common, mode: 'observe', client })
      : new Guardian({ ...common, mode: 'signal', client, expectedDelegate: SIGNER });
  return { guardian, state, prepared, broadcasts, events };
}

test('does not write when the signer has no pending nonce', async () => {
  const fixture = recoveryFixture();

  await fixture.guardian.clearPendingNonces();
  assert.equal(fixture.prepared.length, 0);
  assert.equal(fixture.broadcasts.length, 0);
});

test('clears one pending nonce with a zero-value self-transfer and confirms it', async () => {
  const fixture = recoveryFixture({ pending: 8 });

  await fixture.guardian.clearPendingNonces();
  assert.deepEqual(fixture.prepared[0]?.transaction, {
    chainId: 1,
    to: SIGNER,
    nonce: 7,
    value: 0n,
    data: '0x',
    gas: 21_000n,
    maxFeePerGas: 16n,
    maxPriorityFeePerGas: 8n,
  });
  assert.equal(fixture.broadcasts.length, 1);
  assert.deepEqual(
    fixture.events
      .filter((event) => event.event === 'nonce.cleared')
      .map((event) => [event.nonce, event.blockNumber, event.blockHash]),
    [[7, 10n, BLOCK_HASH]],
  );
});

test('clears several pending nonces in order', async () => {
  const fixture = recoveryFixture({ pending: 10 });

  await fixture.guardian.clearPendingNonces();
  assert.deepEqual(
    fixture.broadcasts.map((record) => record.transaction.nonce),
    [7, 8, 9],
  );
  assert.deepEqual(
    fixture.events.filter((event) => event.event === 'nonce.cleared').map((event) => event.nonce),
    [7, 8, 9],
  );
});

test('raises both fees and retains the nonce after an indeterminate broadcast', async () => {
  const refusal = new Error('provider-specific broadcast failure');
  const fixture = recoveryFixture({
    pending: 8,
    broadcast: ({ state, broadcasts }) => {
      if (broadcasts.length === 1) {
        return Promise.reject(new BroadcastFailure(refusal));
      }
      state.latest = 8;
      return Promise.resolve();
    },
  });

  await fixture.guardian.clearPendingNonces();
  assert.deepEqual(
    fixture.broadcasts.map(({ transaction }) => [
      transaction.nonce,
      transaction.maxFeePerGas,
      transaction.maxPriorityFeePerGas,
    ]),
    [
      [7, 16n, 8n],
      [7, 19n, 10n],
    ],
  );
  const retry = fixture.events.find((event) => event.event === 'transaction.retry');
  assert.equal(retry?.event, 'transaction.retry');
  assert.equal(retry.error, refusal);
});

test('stops before broadcast when a cancellation exceeds the fee cap', async () => {
  const fixture = recoveryFixture({ pending: 8, maxFeePerGas: 15n });

  await assert.rejects(fixture.guardian.clearPendingNonces(), /replacement fee exceeds maxFeePerGas/);
  assert.equal(fixture.broadcasts.length, 0);
  const failed = fixture.events.find((event) => event.event === 'transaction.failed');
  assert.equal(failed?.event, 'transaction.failed');
  assert.equal(failed.stage, 'nonce-clearing');
});

test('bounds repeated indeterminate broadcasts by sendAttempts', async () => {
  const fixture = recoveryFixture({
    pending: 8,
    sendAttempts: 2,
    broadcast: () => Promise.reject(new BroadcastFailure(new Error('arbitrary provider response'))),
  });

  await assert.rejects(fixture.guardian.clearPendingNonces(), /exhausted sendAttempts/);
  assert.equal(fixture.broadcasts.length, 2);
});

test('propagates failures outside the raw broadcast boundary without retrying', async () => {
  const failure = new Error('signing failed');
  const fixture = recoveryFixture({
    pending: 8,
    broadcast: () => Promise.reject(failure),
  });

  await assert.rejects(fixture.guardian.clearPendingNonces(), (error: unknown) => error === failure);
  assert.equal(fixture.broadcasts.length, 1);
  assert.equal(fixture.events.filter((event) => event.event === 'transaction.retry').length, 0);
});

test('stops on a chain mismatch before preparing a cancellation', async () => {
  const fixture = recoveryFixture({ pending: 8, chainId: 2 });

  await assert.rejects(fixture.guardian.clearPendingNonces(), (error: unknown) => {
    return error instanceof GuardianStop && error.reason === 'chain-id-mismatch';
  });
  assert.equal(fixture.prepared.length, 0);
});

test('observe mode cannot clear pending nonces', async () => {
  const fixture = recoveryFixture({ mode: 'observe' });

  await assert.rejects(fixture.guardian.clearPendingNonces(), (error: unknown) => {
    return error instanceof GuardianStop && error.reason === 'submission-disabled';
  });
});

test('observer failures cannot fail successful nonce recovery', async () => {
  const fixture = recoveryFixture({ pending: 8, observerThrows: true });

  await fixture.guardian.clearPendingNonces();
  assert.equal(fixture.broadcasts.length, 1);
});
