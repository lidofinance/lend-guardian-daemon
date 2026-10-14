import { rpcRequest } from './client.ts';
import { BaseRpcProvider } from '../../src/core/index.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, parseAbi } from 'viem';
import { Guardian } from '../../src/core/guardian.ts';
import type { Script } from './fake-node.ts';
import { CHAIN_ID, CORE, GUARDIAN, REGISTRY, fakeNode } from './fake-node.ts';

const HEAD = 200_000;

const JOINED: Script = { head: HEAD, guardianAddedAt: 150_000 };

const DELEGATE_CALL = encodeFunctionData({
  abi: parseAbi(['function getDelegate(address) view returns (address)']),
  functionName: 'getDelegate',
  args: [GUARDIAN],
});

/** Observe has no signer, expected delegate or submitter, and must never read a delegate. */
function observerOver(script: Script) {
  const node = fakeNode(script);
  const reads: string[] = [];
  const guardian = new Guardian({
    mode: 'observe',
    deployment: {
      chainId: CHAIN_ID,
      slotSeconds: 12,
      lidoLend: { address: CORE, deploymentBlock: 1_000 },
      guardianSignals: { address: REGISTRY, deploymentBlock: 900 },
    },
    guardian: GUARDIAN,
    screening: { screen: () => Promise.resolve([]) },
    maxSignalBatchSize: 20,
    idleHeartbeatInterval: 12 * 60 * 60,
    screeningTimeoutMs: 10_000,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: 12,
    client: new BaseRpcProvider({
      maxLogBlockRange: 1_000_000,
      request: rpcRequest((method, params) => {
        const encoded = JSON.stringify(params);
        if (method === 'eth_call') {
          reads.push(encoded);
          assert.ok(!encoded.includes(DELEGATE_CALL), 'observe must not read the delegate');
        }
        return node.transport(method, params);
      }),
    }),
  });
  return { guardian, node, reads };
}

test('observe plans repeatedly without a signer, submitter or delegate read', async () => {
  const { guardian, node, reads } = observerOver({
    ...JOINED,
    delegate: '0x00000000000000000000000000000000000000d2',
  });
  assert.equal((await guardian.buildScanPlan()).kind, 'plan');
  node.advanceTo(HEAD + 1);
  assert.equal((await guardian.buildScanPlan()).kind, 'plan');
  assert.ok(reads.length > 0);
  assert.ok(reads.every((read) => !read.includes(DELEGATE_CALL)));
});

test('observe still rejects a node on another chain', async () => {
  const { guardian } = observerOver({ ...JOINED, chainId: CHAIN_ID + 1 });
  await assert.rejects(guardian.buildScanPlan(), { reason: 'chain-id-mismatch' });
});

test('observe still requires Guardian membership', async () => {
  const { guardian } = observerOver({ ...JOINED, isGuardian: false });
  await assert.rejects(guardian.buildScanPlan(), { reason: 'guardian-not-member' });
});

test('observe cannot submit even when the caller asks it to', async () => {
  const { guardian } = observerOver(JOINED);
  const plan = await guardian.buildScanPlan();
  assert.ok(plan.kind === 'plan');
  const screened = await guardian.screenWork(
    await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan)),
  );
  await assert.rejects(guardian.signalAndHeartbeat(screened), { reason: 'submission-disabled' });
});
