import { rpcRequest } from './client.ts';
import { ViemRpcClient } from '../../src/chain/viem-client.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, createWalletClient, custom, HttpRequestError, padHex } from 'viem';
import { BaseRpcProvider } from '../../src/core/index.ts';
import type { ChainLog } from '../../src/core/index.ts';
import { mainnet } from 'viem/chains';
import { blockAt, CORE, fakeNode, GUARDIAN } from './fake-node.ts';

const FILTER = { address: CORE, fromBlock: 1, toBlock: 8 };
const rawLog = (index: number) => ({
  address: CORE,
  blockHash: padHex('0x01'),
  blockNumber: '0x8',
  transactionIndex: '0x0',
  transactionHash: padHex('0x02'),
  logIndex: `0x${index.toString(16)}`,
  topics: [],
  data: '0x',
  removed: false,
});

test('latest-log search sorts a batch, decodes every returned log and stops before older ranges', async () => {
  const requests: unknown[] = [];
  const decoded: number[] = [];
  const client = new BaseRpcProvider({
    maxLogBlockRange: 2,
    request: rpcRequest((method, params) => {
      assert.equal(method, 'eth_getLogs');
      requests.push(...params);
      return Promise.resolve([rawLog(5), rawLog(2)]);
    }),
  });
  const latest = await client.getLastLog(FILTER, (log) => {
    decoded.push(log.logIndex);
    return log.logIndex;
  });
  assert.equal(latest, 5);
  assert.deepEqual(decoded, [2, 5]);
  assert.deepEqual(requests, [{ address: CORE, fromBlock: '0x7', toBlock: '0x8' }]);
  const failure = new Error('invalid earlier log in the returned batch');
  await assert.rejects(
    client.getLastLog(FILTER, (log: ChainLog) => {
      if (log.logIndex === 2) {
        throw failure;
      }
      return log;
    }),
    (error: unknown) => error === failure,
  );
});

test('receipt confirmation requires the inclusion block to remain canonical', async () => {
  const transactionHash = padHex('0x99', { size: 32 });
  const receipt = {
    transactionHash,
    blockNumber: 100,
    blockHash: blockAt(100).hash,
    status: 'success' as const,
  };
  const node = fakeNode({ head: 200, receipts: [receipt] });
  node.reorgBlock(receipt.blockNumber);
  const provider = new BaseRpcProvider({ request: rpcRequest(node.transport), maxLogBlockRange: 10 });

  assert.equal(await provider.isConfirmed(receipt, blockAt(200), 1), false);
});

test('ordinary SDK reads retain the configured viem request retry policy', async () => {
  let requests = 0;
  const publicClient = createPublicClient({
    transport: custom(
      {
        request: ({ method }: { method: string }) => {
          assert.equal(method, 'eth_chainId');
          requests += 1;
          return requests === 1
            ? Promise.reject(new HttpRequestError({ status: 503, url: 'http://fixture.invalid' }))
            : Promise.resolve('0x1');
        },
      },
      { retryCount: 1, retryDelay: 1 },
    ),
  });
  const client = new ViemRpcClient({
    publicClient,
    walletClient: createWalletClient({
      account: GUARDIAN,
      chain: mainnet,
      transport: custom({
        request: () => Promise.reject(new Error('No wallet requests expected')),
      }),
    }),
    maxLogBlockRange: 2,
    transactionPolicy: {
      sendTimeoutMs: 10_000,
      replacementFeeBumpBps: 1_000,
      maxFeePerGas: 100n,
      replacementTimeoutMs: 1,
      sendAttempts: 1,
    },
  });
  assert.equal(await client.getChainId(), 1);
  assert.equal(requests, 2);
});

for (const [fromBlock, toBlock, size, expected] of [
  [
    10,
    100,
    30,
    [
      [10, 39],
      [40, 69],
      [70, 99],
      [100, 100],
    ],
  ],
  [10, 10, 30, [[10, 10]]],
  [10, 9, 30, []],
  [
    Number.MAX_SAFE_INTEGER - 2,
    Number.MAX_SAFE_INTEGER,
    2,
    [
      [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 1],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ],
  ],
] as const) {
  test(`range ${fromBlock}–${toBlock} keeps identical batches in both directions`, async () => {
    for (const direction of ['forward', 'backward'] as const) {
      const requested: number[][] = [];
      const client = new BaseRpcProvider({
        maxLogBlockRange: size,
        request: rpcRequest((method, params) => {
          assert.equal(method, 'eth_getLogs');
          const filter = params[0];
          assert.ok(typeof filter === 'object' && filter !== null);
          assert.ok('fromBlock' in filter && typeof filter.fromBlock === 'string');
          assert.ok('toBlock' in filter && typeof filter.toBlock === 'string');
          requested.push([Number(filter.fromBlock), Number(filter.toBlock)]);
          return Promise.resolve([]);
        }),
      });
      for await (const logs of client.logBatches({ address: CORE, fromBlock, toBlock }, direction)) {
        assert.deepEqual(logs, []);
      }
      assert.deepEqual(requested, direction === 'forward' ? expected : [...expected].reverse());
    }
  });
}

test('missing blocks and pending logs fail while an absent receipt remains null', async () => {
  const client = new BaseRpcProvider({ request: rpcRequest(() => Promise.resolve(null)), maxLogBlockRange: 1 });
  await assert.rejects(client.getBlock(), /RPC block is missing or pending/);
  assert.equal(await client.getReceipt(padHex('0x01')), null);
  const pending = new BaseRpcProvider({
    request: rpcRequest(() => Promise.resolve([{ ...rawLog(0), blockHash: null, blockNumber: null }])),
    maxLogBlockRange: 1,
  });
  await assert.rejects(pending.getLogs({ address: CORE, blockHash: padHex('0x01') }), /RPC log has no mined block/);
});

test('invalid receipt status is rejected instead of becoming a confirmed result', async () => {
  const client = new BaseRpcProvider({
    request: rpcRequest(() => Promise.resolve({ status: '0x2' })),
    maxLogBlockRange: 1,
  });
  await assert.rejects(client.getReceipt(padHex('0x01')), /RPC receipt has no valid status/);
});
