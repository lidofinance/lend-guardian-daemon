import { rpcRequest } from './client.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { numberToHex, padHex } from 'viem';
import { SUPPLY_COLLATERAL_TOPICS } from '../../abi/Core.abi.ts';
import { BaseRpcProvider } from '../../src/chain/base-rpc-provider.ts';
import { Work } from '../../src/core/outcomes.ts';
import type { Lot } from './fake-node.ts';
import { blockAt, BORROWER, CONTROLLER, CORE, MARKET } from './fake-node.ts';
import { guardianOver } from './setup.ts';

const HEAD = 200_000;

function position(activating: bigint, dust = 0n) {
  return { activating, dust, activatingStart: blockAt(90_000).timestamp, activatingDelay: 12 };
}

test('a long partially drained lot retains its original activating contributor', async () => {
  const drains = Array.from(
    { length: 6_000 },
    (_unused, index): Lot => ({
      kind: 'drained',
      blockNumber: 100_001 + index,
      logIndex: 4,
      amount: 1n,
      position: { ...position(BigInt(6_000 - index)), activatingStart: blockAt(100_000).timestamp },
    }),
  );
  const { guardian } = guardianOver({
    head: HEAD,
    guardianAddedAt: 100_000,
    lots: [
      {
        kind: 'activating',
        blockNumber: 100_000,
        logIndex: 4,
        amount: 6_001n,
        supplied: 6_001n,
        position: { ...position(6_001n), activatingStart: blockAt(100_000).timestamp },
      },
      ...drains,
    ],
  });
  const plan = await guardian.buildScanPlan();
  assert.ok(plan.kind === 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
  assert.deepEqual(work.all(), [
    {
      core: CORE,
      blockHash: blockAt(100_000).hash,
      transactionHash: padHex(numberToHex(100_000_004), { size: 32 }),
      logIndex: 5,
      marketId: MARKET,
      borrower: BORROWER,
    },
  ]);
});

test('a long dust walk crosses prior coverage and retains dust absorbed into the new lot', async () => {
  const drains = Array.from(
    { length: 4_000 },
    (_unused, index): Lot => ({
      kind: 'drained',
      blockNumber: 90_002 + index,
      logIndex: 4,
      amount: 1n,
      position: position(2n, BigInt(4_000 - index)),
    }),
  );
  const covered = blockAt(93_000);
  const { guardian } = guardianOver({
    head: HEAD,
    heartbeatTimestamp: covered.timestamp,
    heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
    lots: [
      {
        kind: 'activating',
        blockNumber: 90_000,
        logIndex: 4,
        amount: 2n,
        supplied: 2n,
        position: position(2n),
      },
      {
        kind: 'dusted',
        blockNumber: 90_001,
        logIndex: 4,
        amount: 4_001n,
        supplied: 4_001n,
        position: position(2n, 4_001n),
      },
      ...drains,
      {
        kind: 'activated',
        blockNumber: 95_000,
        logIndex: 4,
        amount: 2n,
        position: { activating: 0n, dust: 1n, activatingStart: 0, activatingDelay: 0 },
      },
      {
        kind: 'activating',
        blockNumber: 100_000,
        logIndex: 4,
        amount: 6n,
        supplied: 5n,
        position: { ...position(6n), activatingStart: blockAt(100_000).timestamp },
      },
    ],
  });
  const plan = await guardian.buildScanPlan();
  assert.ok(plan.kind === 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
  assert.deepEqual(
    work.all().map((anchor) => anchor.transactionHash),
    [padHex(numberToHex(100_000_004), { size: 32 }), padHex(numberToHex(90_001_004), { size: 32 })],
  );
});

test('thousands of targets preserve positional decisions and complete report coverage', async () => {
  const { guardian } = guardianOver(
    { head: HEAD, guardianAddedAt: 150_000 },
    {
      screening: {
        screen: (request) =>
          Promise.resolve(
            request.anchors.map((anchor) => ({
              status: 'judged',
              requiresSuspect: anchor.logIndex % 2 === 0,
              requiresFlag: anchor.logIndex % 2 === 1,
            })),
          ),
      },
    },
  );
  const plan = await guardian.buildScanPlan();
  assert.ok(plan.kind === 'plan');
  const entries = Array.from({ length: 5_000 }, (_unused, index) => {
    const marketId = padHex(numberToHex(index + 1), { size: 32 });
    const key = { controller: CONTROLLER, marketId, borrower: BORROWER };
    const anchor = {
      core: CORE,
      marketId,
      borrower: BORROWER,
      blockHash: blockAt(100_000).hash,
      transactionHash: blockAt(100_000).hash,
      logIndex: index,
    };
    return [key, [anchor]] as const;
  });
  const work = new Work(plan, new Map(entries), new Map());
  const screened = await guardian.screenWork(work);
  assert.deepEqual(
    screened.results.map((entry) => entry.anchor),
    work.all(),
  );
  const targets = entries.map(([key]) => ({ marketId: key.marketId, borrower: key.borrower }));
  assert.deepEqual(
    screened.suspects,
    targets.filter((_target, index) => index % 2 === 0),
  );
  assert.deepEqual(
    screened.flags,
    targets.filter((_target, index) => index % 2 === 1),
  );
});

test('log reads use the configured static ranges in the requested order', async () => {
  const requested: { fromBlock: number; toBlock: number }[] = [];
  const rpc = new BaseRpcProvider({
    request: rpcRequest((method, params) => {
      assert.equal(method, 'eth_getLogs');
      const filter = params[0];
      assert.ok(typeof filter === 'object' && filter !== null);
      assert.ok('fromBlock' in filter && typeof filter.fromBlock === 'string');
      assert.ok('toBlock' in filter && typeof filter.toBlock === 'string');
      requested.push({
        fromBlock: Number(BigInt(filter.fromBlock)),
        toBlock: Number(BigInt(filter.toBlock)),
      });
      return Promise.resolve([]);
    }),
    maxLogBlockRange: 4,
  });

  const filter = {
    address: CORE,
    topics: SUPPLY_COLLATERAL_TOPICS,
    fromBlock: 1,
    toBlock: 16,
  };
  await rpc.getLogs(filter);
  assert.deepEqual(requested, [
    { fromBlock: 1, toBlock: 4 },
    { fromBlock: 5, toBlock: 8 },
    { fromBlock: 9, toBlock: 12 },
    { fromBlock: 13, toBlock: 16 },
  ]);

  requested.length = 0;
  for await (const logs of rpc.logBatches(filter, 'backward')) {
    assert.deepEqual(logs, []);
  }
  assert.deepEqual(requested, [
    { fromBlock: 13, toBlock: 16 },
    { fromBlock: 9, toBlock: 12 },
    { fromBlock: 5, toBlock: 8 },
    { fromBlock: 1, toBlock: 4 },
  ]);
});

test('a block the node refuses alone propagates its error once the range is halved down to it', async () => {
  const attempts: { fromBlock: number; toBlock: number }[] = [];
  const rpc = new BaseRpcProvider({
    request: rpcRequest((method, params) => {
      assert.equal(method, 'eth_getLogs');
      const filter = params[0];
      assert.ok(typeof filter === 'object' && filter !== null);
      assert.ok('fromBlock' in filter && typeof filter.fromBlock === 'string');
      assert.ok('toBlock' in filter && typeof filter.toBlock === 'string');
      attempts.push({
        fromBlock: Number(BigInt(filter.fromBlock)),
        toBlock: Number(BigInt(filter.toBlock)),
      });
      return Promise.reject(new Error('block range exceeds the limit'));
    }),
    maxLogBlockRange: 2,
  });
  await assert.rejects(
    rpc.getLogs({
      address: CORE,
      topics: SUPPLY_COLLATERAL_TOPICS,
      fromBlock: 1,
      toBlock: 2,
    }),
    /block range exceeds the limit/,
  );
  assert.deepEqual(attempts, [
    { fromBlock: 1, toBlock: 2 },
    { fromBlock: 1, toBlock: 1 },
  ]);
});
