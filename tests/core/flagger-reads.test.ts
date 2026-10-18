import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { decodeFunctionData, encodeAbiParameters, isHex, numberToHex, padHex } from 'viem';
import { GUARDIAN_SIGNALS_ABI } from '../../abi/GuardianSignals.abi.ts';
import { Work } from '../../src/core/outcomes.ts';
import type { PositionKey } from '../../src/core/types.ts';
import type { SupplyAnchor } from '../../src/core/types.ts';
import type { NodeRequest } from './client.ts';
import type { ScreeningRequest } from '../../src/core/screening-provider.ts';
import type { SignalTarget } from '../../src/core/types.ts';
import type { Address } from '../../src/common/types.ts';
import { lower } from '../../src/common/types.ts';
import { blockAt, BORROWER, CONTROLLER, CORE, GUARDIAN, REGISTRY } from './fake-node.ts';
import { guardianOver } from './setup.ts';

const HEAD = 200_000;
const OTHER_GUARDIAN: Address = '0x0000000000000000000000000000000000000001';

/** Distinct targets exercise several flagger batches without relying on discovery fixtures. */
function buildWork(count: number): Work {
  const entries = Array.from({ length: count }, (_unused, index): [PositionKey, SupplyAnchor[]] => {
    const marketId = padHex(numberToHex(index + 1), { size: 32 });
    const target = { controller: CONTROLLER, marketId, borrower: BORROWER };
    const anchor = {
      core: CORE,
      marketId,
      borrower: BORROWER,
      blockHash: blockAt(100_000).hash,
      transactionHash: blockAt(index + 1).hash,
      logIndex: 2,
    };
    return [target, [anchor]];
  });
  return new Work(
    {
      kind: 'plan',
      previousHeartbeatBlock: null,
      heartbeatTimestampAtStart: 0,
      reportsSince: null,
      discoveryRange: { from: blockAt(99_600), to: blockAt(HEAD - 2) },
    },
    new Map(entries),
  );
}

interface PendingRead {
  readonly target: SignalTarget;
  readonly resolve: (answer: string) => void;
  readonly reject: (error: Error) => void;
}

function controlledNode() {
  const reads: PendingRead[] = [];
  const methods: string[] = [];
  const transport: NodeRequest = (method, params) => {
    methods.push(method);
    assert.equal(method, 'eth_call');
    const call = params[0];
    assert.ok(typeof call === 'object' && call !== null);
    assert.ok('to' in call);
    assert.equal(call.to, REGISTRY);
    assert.ok('data' in call && typeof call.data === 'string');
    assert.ok(isHex(call.data));
    const decoded = decodeFunctionData({ abi: GUARDIAN_SIGNALS_ABI, data: call.data });
    assert.ok(decoded.functionName === 'getFlaggedBy');
    assert.deepEqual(params[1], { blockHash: blockAt(HEAD - 2).hash });
    const [marketId, borrower] = decoded.args;
    return new Promise((resolve, reject) => {
      reads.push({ target: { marketId, borrower: lower(borrower) }, resolve, reject });
    });
  };
  return { reads, transport, methods };
}

function answer(flaggers: readonly Address[]): string {
  return encodeAbiParameters([{ type: 'address[]' }], [[...flaggers]]);
}

test('flagger reads stay within eight concurrent calls and preserve every target in input order', async () => {
  const work = buildWork(20);
  const node = controlledNode();
  const requests: ScreeningRequest[] = [];
  const skippedMarkets = new Set([8, 9, 20]);
  const { guardian } = guardianOver(
    { head: HEAD },
    {
      endpoints: [{ node: node.transport }],
      screening: {
        screen: (request) => {
          requests.push(request);
          return Promise.resolve(
            request.anchors.map((anchor) => ({
              status: 'judged',
              requiresSuspect: Number(BigInt(anchor.marketId)) % 2 === 1,
              requiresFlag: Number(BigInt(anchor.marketId)) % 2 === 0,
            })),
          );
        },
      },
    },
  );
  const screening = guardian.screenWork(work);
  for (let from = 0; from < 20; from += 8) {
    await setImmediate();
    assert.equal(node.reads.length, Math.min(from + 8, 20));
    assert.equal(requests.length, 0);
    const batch = node.reads.slice(from).reverse();
    for (const read of batch.slice(0, -1)) {
      const isOwnFlag = skippedMarkets.has(Number(BigInt(read.target.marketId)));
      read.resolve(answer(isOwnFlag ? [OTHER_GUARDIAN, GUARDIAN] : [OTHER_GUARDIAN]));
    }
    await setImmediate();
    assert.equal(node.reads.length, Math.min(from + 8, 20), 'a slow read holds the next batch');
    const last = batch.at(-1);
    assert.ok(last !== undefined);
    const isOwnFlag = skippedMarkets.has(Number(BigInt(last.target.marketId)));
    last.resolve(answer(isOwnFlag ? [OTHER_GUARDIAN, GUARDIAN] : [OTHER_GUARDIAN]));
  }
  const screened = await screening;
  const pending = work.all().filter((anchor) => !skippedMarkets.has(Number(BigInt(anchor.marketId))));
  const targets = work.all().map(({ marketId, borrower }) => ({ marketId, borrower }));
  assert.deepEqual(
    node.reads.map((read) => read.target),
    targets,
  );
  assert.deepEqual(
    requests.map((request) => request.anchors),
    [pending],
  );
  assert.deepEqual(
    screened.results.map((entry) => entry.anchor),
    pending,
  );
  assert.deepEqual(
    screened.skipped.map((entry) => entry.target),
    [targets[7], targets[8], targets[19]],
  );
  assert.deepEqual(screened.suspects, [
    targets[0],
    targets[2],
    targets[4],
    targets[6],
    targets[10],
    targets[12],
    targets[14],
    targets[16],
    targets[18],
  ]);
  assert.deepEqual(screened.flags, [
    targets[1],
    targets[3],
    targets[5],
    targets[9],
    targets[11],
    targets[13],
    targets[15],
    targets[17],
  ]);
  assert.equal(screened.work(), work);
  assert.equal(screened.work().all().length, 20);
});

test('a failed flagger read stops before later batches, provider screening or submission', async () => {
  const work = buildWork(20);
  const node = controlledNode();
  const requests: ScreeningRequest[] = [];

  const { guardian } = guardianOver(
    { head: HEAD },
    {
      endpoints: [{ node: node.transport }],

      screening: {
        screen: (request) => {
          requests.push(request);
          return Promise.resolve([]);
        },
      },
    },
  );
  const stopped = assert.rejects(async () => {
    await guardian.signalAndHeartbeat(await guardian.screenWork(work));
  }, /flagger read failed/);
  await setImmediate();
  assert.equal(node.reads.length, 8);
  for (const read of node.reads.slice(0, 8)) {
    read.resolve(answer([]));
  }
  await setImmediate();
  assert.equal(node.reads.length, 16);
  const failed = node.reads[8];
  assert.ok(failed !== undefined);
  failed.reject(Object.assign(new Error('flagger read failed'), { code: -32602 }));
  for (const read of node.reads.slice(9)) {
    read.resolve(answer([]));
  }
  await stopped;
  await setImmediate();
  assert.equal(node.reads.length, 16);
  assert.deepEqual(requests, []);
  assert.deepEqual(
    node.methods,
    Array.from({ length: 16 }, () => 'eth_call'),
  );
});

test('empty work performs no flagger reads or provider calls', async () => {
  const node = controlledNode();
  const requests: ScreeningRequest[] = [];
  const { guardian } = guardianOver(
    { head: HEAD },
    {
      endpoints: [{ node: node.transport }],
      screening: {
        screen: (request) => {
          requests.push(request);
          return Promise.resolve([]);
        },
      },
    },
  );
  const screened = await guardian.screenWork(buildWork(0));
  assert.deepEqual(node.reads, []);
  assert.deepEqual(requests, []);
  assert.deepEqual(screened.results, []);
  assert.deepEqual(screened.skipped, []);
});

for (const limit of [1, 3]) {
  test(`configured concurrency limits flagger batches to ${limit} while retaining every source`, async () => {
    const node = controlledNode();
    const work = buildWork(7);
    const { guardian } = guardianOver(
      { head: HEAD },
      {
        flaggerReadConcurrency: limit,
        endpoints: [{ node: node.transport }],
      },
    );
    const screening = guardian.screenWork(work);
    for (let from = 0; from < 7; from += limit) {
      await setImmediate();
      assert.equal(node.reads.length, Math.min(from + limit, 7));
      for (const read of node.reads.slice(from)) {
        read.resolve(answer([]));
      }
    }
    const result = await screening;
    assert.deepEqual(
      result.results.map((entry) => entry.anchor),
      work.all(),
    );
  });
}
