import { rpcRequest } from './client.ts';
// Signing uses synthetic keys and a scripted transport; no endpoint or secret is read from the host.
import assert from 'node:assert/strict';
import test from 'node:test';
import { padHex } from 'viem';
import { BaseRpcProvider } from '../../src/chain/base-rpc-provider.ts';
import { signingClient, signingAccount } from './client.ts';
import { guardianOver } from './setup.ts';
import { blockAt, fakeNode, GUARDIAN_KEY, REGISTRY } from './fake-node.ts';

const HEAD = 200_000;
const HASH = padHex('0x12', { size: 32 });
const RECEIPT = {
  transactionHash: HASH,
  blockNumber: HEAD - 11,
  blockHash: blockAt(HEAD - 11).hash,
};

for (const privateKey of ['0x', '0x00', `0x${'0'.repeat(64)}`, `0x${'f'.repeat(64)}`, null, undefined]) {
  test(`rejects malformed key ${String(privateKey).length} without disclosing its value or contacting RPC`, () => {
    const options = Object.assign({ privateKey: GUARDIAN_KEY }, { privateKey });
    assert.throws(() => signingAccount(options.privateKey), {
      name: 'TypeError',
      message: 'privateKey must be a valid 32-byte secp256k1 key',
    });
  });
}

test('an observe client has no signer and cannot broadcast', async () => {
  const node = fakeNode({ head: HEAD, guardianAddedAt: 1000 });
  const client = new BaseRpcProvider({ request: rpcRequest(node.transport), maxLogBlockRange: 1000 });
  const { guardian } = guardianOver({ head: HEAD, guardianAddedAt: 1000 }, { mode: 'observe', client });
  assert.equal('signer' in client, false);
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const screened = await guardian.screenWork(
    await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan)),
  );
  await assert.rejects(guardian.signalAndHeartbeat(screened), { reason: 'submission-disabled' });
  assert.deepEqual(node.sent.calls, []);
});

test('checks the signing chain again before sending a transaction', async () => {
  const node = fakeNode({ head: HEAD, chainId: 2 });
  const client = signingClient([{ node: node.transport }]);
  await assert.rejects(client.send({ chainId: 1, to: REGISTRY, data: '0x', value: 0n }, { confirmations: 1 }), {
    reason: 'chain-id-mismatch',
  });
  assert.deepEqual(node.sent.calls, []);
});

test('confirmation depth includes the inclusion block and rejects a shallow canonical receipt', async () => {
  const node = fakeNode({ head: HEAD, receipts: [{ ...RECEIPT, status: 'success' }] });
  const rpc = new BaseRpcProvider({ request: rpcRequest(node.transport), maxLogBlockRange: 10 });
  assert.equal(await rpc.isConfirmed(RECEIPT, blockAt(HEAD), 12), true);
  assert.equal(await rpc.isConfirmed(RECEIPT, blockAt(HEAD - 1), 12), false);
  assert.equal(await rpc.isConfirmed(RECEIPT, blockAt(HEAD - 11), 1), true);
});

for (const failure of ['reverted', 'replaced'] as const) {
  test(`an initially ${failure} transaction fails its inclusion wait`, async () => {
    const node = fakeNode({ head: HEAD, guardianAddedAt: 1000 });
    const client = signingClient([
      {
        node: async (method, params) => {
          const response = await node.transport(method, params);
          if (method === 'eth_sendRawTransaction') {
            const hash = node.sent.transactions[0]?.hash;
            assert.ok(hash !== undefined);
            node.setReceipt(hash, {
              ...RECEIPT,
              transactionHash: failure === 'replaced' ? HASH : hash,
              status: failure === 'reverted' ? 'reverted' : 'success',
            });
          }
          return response;
        },
      },
    ]);
    const { guardian } = guardianOver({ head: HEAD, guardianAddedAt: 1000 }, { client });
    const plan = await guardian.buildScanPlan();
    assert.equal(plan.kind, 'plan');
    const screened = await guardian.screenWork(
      await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan)),
    );
    await assert.rejects(guardian.signalAndHeartbeat(screened), (error: unknown) => {
      const cause = error;
      assert.ok(cause instanceof Error);
      assert.match(cause.message, new RegExp(failure));
      return true;
    });
  });
}

test('a receipt RPC failure propagates rather than becoming missing confirmation', async () => {
  const rpc = new BaseRpcProvider({
    request: rpcRequest(() => Promise.reject(Object.assign(new Error('receipt lookup failed'), { code: -32602 }))),
    maxLogBlockRange: 10,
  });
  await assert.rejects(rpc.isConfirmed(RECEIPT, blockAt(HEAD), 12), /receipt lookup failed/);
});
