import { rpcRequest } from './client.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, padHex, parseAbi } from 'viem';
import { GUARDIAN_SIGNALS_ABI } from '../../abi/GuardianSignals.abi.ts';
import { BaseRpcProvider } from '../../src/chain/base-rpc-provider.ts';
import { GuardianSignals } from '../../src/contracts/guardian-signals.ts';
import type { RpcClient, TransactionRequest, SendOptions, SdkEvent } from '../../src/core/index.ts';
import { blockAt, fakeNode, GUARDIAN, REGISTRY } from './fake-node.ts';
import { guardianOver } from './setup.ts';
import { REGISTRY_ERRORS } from './delivery-fixture.ts';

const SOLIDITY_ERRORS = parseAbi(['error Error(string message)', 'error Panic(uint256 code)']);
const SOLIDITY_REVERTS = [
  {
    name: 'Error',
    data: encodeErrorResult({ abi: SOLIDITY_ERRORS, errorName: 'Error', args: ['refused'] }),
  },
  {
    name: 'Panic',
    data: encodeErrorResult({ abi: SOLIDITY_ERRORS, errorName: 'Panic', args: [0x11n] }),
  },
] as const;
const CONTRACT_REVERTS = (
  [
    'InvalidBlockHash',
    'HeartbeatTimestampRegressed',
    'Unauthorized',
    'BlockInTheFuture',
    'TimestampInTheFuture',
  ] as const
).map((name) => ({
  name,
  data: encodeErrorResult({ abi: REGISTRY_ERRORS, errorName: name }),
}));
const UNDECODABLE_REVERTS = [null, '0x', '0xdeadbeef', '0x08c379a0'] as const;
const REPORT_BLOCK = blockAt(199_998);
const DIGEST = padHex('0x01', { size: 32 });

function writingClient(
  reader: BaseRpcProvider,
  send: (transaction: TransactionRequest, options: SendOptions) => ReturnType<RpcClient['send']>,
): RpcClient {
  return Object.assign(reader, {
    signer: GUARDIAN,
    transactionPolicy: {
      maxFeePerGas: 100n,
      sendTimeoutMs: 10_000,
      replacementFeeBumpBps: 1_000,
      replacementTimeoutMs: 1_000,
      sendAttempts: 2,
    },
    prepareTransaction: () => Promise.reject(new Error('The registry fixture implements send directly')),
    broadcastTransaction: () => Promise.reject(new Error('The registry fixture implements send directly')),
    send,
  });
}

function registryWithoutReads(error: Error): GuardianSignals {
  const reader = new BaseRpcProvider({
    request: rpcRequest(() => Promise.reject(new Error('Decoding must not contact RPC'))),
    maxLogBlockRange: 1,
  });
  const client = writingClient(reader, () => Promise.reject(error));
  return new GuardianSignals({
    client,
    chainId: 1,
    deployment: { address: REGISTRY, deploymentBlock: 0 },
    guardian: GUARDIAN,
  });
}

for (const { name, data } of [...CONTRACT_REVERTS, ...SOLIDITY_REVERTS]) {
  test(`registry submission propagates the original ${name} error`, async () => {
    const error = Object.assign(new Error('execution reverted'), { code: 3, data });
    await assert.rejects(
      registryWithoutReads(error).heartbeat(REPORT_BLOCK, DIGEST, { confirmations: 1 }),
      (caught: unknown) => caught === error,
    );
  });
}

for (const data of UNDECODABLE_REVERTS) {
  test(`missing or undecodable revert data ${String(data)} propagates unchanged`, async () => {
    const error = Object.assign(new Error('execution reverted'), { code: 3, data });
    await assert.rejects(
      registryWithoutReads(error).heartbeat(REPORT_BLOCK, DIGEST, { confirmations: 1 }),
      (caught: unknown) => caught === error,
    );
  });
}

test('an infrastructure error with revert-shaped data remains the original error', async () => {
  const error = Object.assign(new Error('RPC unavailable'), {
    data: encodeErrorResult({ abi: REGISTRY_ERRORS, errorName: 'InvalidBlockHash' }),
  });
  await assert.rejects(
    registryWithoutReads(error).heartbeat(REPORT_BLOCK, DIGEST, { confirmations: 1 }),
    (caught: unknown) => caught === error,
  );
});

for (const { name, data } of SOLIDITY_REVERTS) {
  test(`Guardian preserves ${name} in the failure event and rejected submission`, async () => {
    const events: SdkEvent[] = [];
    const calls: string[] = [];
    const error = Object.assign(new Error('execution reverted'), { code: 3, data });
    const script = { head: 200_000, guardianAddedAt: 1_000 };
    const node = fakeNode(script);
    const onEvent = (event: SdkEvent): void => {
      events.push(event);
    };
    const client = writingClient(
      new BaseRpcProvider({ request: rpcRequest(node.transport), maxLogBlockRange: 1000 }),
      (_transaction: TransactionRequest, options: SendOptions) => {
        calls.push('send');
        onEvent({ event: 'transaction.failed', context: options.context, stage: 'preparation', error });
        return Promise.reject(error);
      },
    );
    const { guardian } = guardianOver(script, {
      client,
      onEvent,
    });
    const plan = await guardian.buildScanPlan();
    assert.equal(plan.kind, 'plan');
    const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
    await assert.rejects(
      guardian.signalAndHeartbeat(await guardian.screenWork(work)),
      (caught: unknown) => caught === error,
    );
    assert.deepEqual(calls, ['send']);
    const failures = events.filter((event) => event.event === 'transaction.failed');
    assert.equal(failures.length, 1);
    const event = failures[0];
    assert.ok(event?.event === 'transaction.failed');
    assert.equal(event.context?.method, 'heartbeat');
    assert.partialDeepStrictEqual(event, {
      event: 'transaction.failed',
      stage: 'preparation',
      error,
      context: { method: 'heartbeat', reportBlock: plan.discoveryRange.to },
    });
    assert.equal(event.event, 'transaction.failed');
    assert.equal(event.error, error);
  });
}

for (const wrapped of [false, true]) {
  test(`an unresolved broadcast stays unresolved even with a known revert (wrapped=${String(wrapped)})`, async () => {
    const data = encodeErrorResult({ abi: REGISTRY_ERRORS, errorName: 'InvalidBlockHash' });
    const refusal = Object.assign(new Error('execution reverted'), { code: 3, data });
    const unresolved = new Error('broadcast response lost', { cause: refusal });
    const error = wrapped ? new Error('client failed', { cause: unresolved }) : unresolved;
    assert.equal(unresolved.cause, refusal);
    await assert.rejects(
      registryWithoutReads(error).heartbeat(REPORT_BLOCK, DIGEST, { confirmations: 1 }),
      (caught: unknown) => caught === error,
    );
  });
}

test('registry preserves viem errors and wrapped RPC refusals without interpretation', async () => {
  const data = encodeErrorResult({ abi: REGISTRY_ERRORS, errorName: 'InvalidBlockHash' });
  const contract = new ContractFunctionRevertedError({
    abi: [...GUARDIAN_SIGNALS_ABI, ...REGISTRY_ERRORS],
    functionName: 'heartbeat',
    data,
  });
  const rpc = Object.assign(new Error('execution reverted'), { code: 3, data: { data } });
  const wrapped = new BaseError('preparation failed', { cause: rpc });
  for (const error of [contract, wrapped]) {
    await assert.rejects(
      registryWithoutReads(error).heartbeat(REPORT_BLOCK, DIGEST, { confirmations: 1 }),
      (caught: unknown) => caught === error,
    );
  }
});

test('an observe registry rejects writes before touching its read-only client', async () => {
  const client = new BaseRpcProvider({
    request: () => {
      throw new Error('Read-only write must not contact RPC');
    },
    maxLogBlockRange: 1,
  });
  const registry = new GuardianSignals({
    mode: 'observe',
    client,
    chainId: 1,
    deployment: { address: REGISTRY, deploymentBlock: 0 },
    guardian: GUARDIAN,
  });
  await assert.rejects(async () => registry.heartbeat(REPORT_BLOCK, DIGEST, { confirmations: 1 }), {
    reason: 'submission-disabled',
  });
});
