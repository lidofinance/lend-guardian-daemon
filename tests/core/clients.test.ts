import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, createWalletClient, custom } from 'viem';
import { mainnet, hoodi } from 'viem/chains';
import * as clients from '../../src/chain/viem-client.ts';
import { signingAccount } from './client.ts';
import { GUARDIAN_KEY } from './fake-node.ts';

for (const chain of [mainnet, hoodi]) {
  test(`${chain.name} configured clients are accepted directly with local and RPC accounts`, () => {
    const transport = custom({ request: () => Promise.reject(new Error('No RPC expected')) });
    const local = signingAccount(GUARDIAN_KEY);
    for (const account of [local, local.address]) {
      const publicClient = createPublicClient({ chain, transport });
      const walletClient = createWalletClient({ chain, transport, account });
      const client = new clients.ViemRpcClient({
        publicClient,
        walletClient,
        maxLogBlockRange: 1000,
        transactionPolicy: {
          sendTimeoutMs: 10_000,
          replacementFeeBumpBps: 1_000,
          maxFeePerGas: 100n,
          replacementTimeoutMs: 1000,
          sendAttempts: 2,
        },
      });
      assert.equal(client.signer, local.address);
    }
  });
}

test('the clients module exposes the viem client and transport at runtime', () => {
  assert.deepEqual(Object.keys(clients).sort(), ['ViemRpcClient', 'createViemRpcTransport']);
});
