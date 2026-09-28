import test from 'node:test';
import assert from 'node:assert/strict';
import { Discovered, Work, Screened } from '../../src/core/outcomes.ts';
import type { ScanPlan } from '../../src/core/outcomes.ts';
import { blockAt, BORROWER, CONTROLLER, CORE, MARKET } from './fake-node.ts';
import { guardianOver } from './setup.ts';

function inputs() {
  const plan: ScanPlan = {
    kind: 'plan',
    previousHeartbeatBlock: blockAt(150_000),
    heartbeatTimestampAtStart: blockAt(150_000).timestamp,
    discoveryRange: { from: blockAt(100_000), to: blockAt(200_000) },
  };
  const key = { controller: CONTROLLER, marketId: MARKET, borrower: BORROWER };
  const anchor = {
    core: CORE,
    blockHash: blockAt(100_000).hash,
    transactionHash: blockAt(100_001).hash,
    logIndex: 4,
    marketId: MARKET,
    borrower: BORROWER,
  };
  const anchors = [anchor];
  const entries = new Map([[key, anchors]]);
  return { plan, key, anchor, anchors, entries };
}

test('a returned plan and its block references cannot be changed', async () => {
  const covered = blockAt(150_000);
  const { guardian } = guardianOver({
    head: 200_000,
    heartbeatTimestamp: covered.timestamp,
    heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
  });
  const plan = await guardian.buildScanPlan();
  assert.ok(plan.kind === 'plan');
  assert.throws(() => Object.assign(plan, { heartbeatTimestampAtStart: 0 }), TypeError);
  for (const block of [plan.discoveryRange.from, plan.discoveryRange.to, plan.previousHeartbeatBlock]) {
    assert.ok(block !== null);
    assert.throws(() => Object.assign(block, { number: 0 }), TypeError);
  }
});

test('Discovered owns its plan and positions without freezing constructor inputs', () => {
  const source = inputs();
  const expectedPlan = structuredClone(source.plan);
  const expectedKey = structuredClone(source.key);
  const positions = [source.key];
  const discovered = new Discovered(source.plan, positions);

  Object.assign(source.plan.discoveryRange.to, { number: 1 });
  assert.ok(source.plan.previousHeartbeatBlock !== null);
  Object.assign(source.plan.previousHeartbeatBlock, { number: 2 });
  Object.assign(source.key, { borrower: CORE });
  positions.length = 0;

  assert.deepEqual(discovered.plan(), expectedPlan);
  assert.deepEqual(discovered.all(), [expectedKey]);
  discovered.all().splice(0);
  assert.deepEqual(discovered.all(), [expectedKey]);
  assert.throws(() => Object.assign(discovered.plan().discoveryRange.to, { number: 0 }), TypeError);
  const position = discovered.all()[0];
  assert.ok(position !== undefined);
  assert.throws(() => Object.assign(position, { borrower: CORE }), TypeError);
});

test('Work owns its blocks, keys, anchors and map without freezing constructor inputs', () => {
  const source = inputs();
  const expected = structuredClone(source);
  const work = new Work(source.plan, source.entries);
  assert.ok(source.plan.previousHeartbeatBlock !== null);
  Object.assign(source.plan.discoveryRange.to, { number: 1 });
  Object.assign(source.plan.previousHeartbeatBlock, { number: 2 });
  Object.assign(source.key, { borrower: CORE });
  Object.assign(source.anchor, { logIndex: 99 });
  source.anchors.length = 0;
  source.entries.clear();
  assert.deepEqual(work.reportBlock, expected.plan.discoveryRange.to);
  assert.deepEqual(work.previousHeartbeatBlock, expected.plan.previousHeartbeatBlock);
  assert.deepEqual(work.entries(), expected.entries);
  assert.deepEqual(work.all(), [expected.anchor]);
  assert.equal(work.positions, 1);
  assert.equal(work.anchors, 1);

  const visible = work.entries();
  assert.ok(visible instanceof Map);
  visible.clear();
  work.all().splice(0);
  assert.equal(work.entries().size, 1);
  assert.deepEqual(work.all(), [expected.anchor]);
  assert.throws(() => Object.assign(work, { anchors: 0 }), TypeError);
  assert.throws(() => Object.assign(work.reportBlock, { number: 0 }), TypeError);
  const entry = [...work.entries()][0];
  assert.ok(entry !== undefined);
  const [key, anchors] = entry;
  const anchor = anchors[0];
  assert.ok(anchor !== undefined);
  assert.throws(() => Object.assign(key, { borrower: CORE }), TypeError);
  assert.throws(() => Object.assign(anchors, { length: 0 }), TypeError);
  assert.throws(() => Object.assign(anchor, { logIndex: 0 }), TypeError);
});

test('Screened owns its decisions, skipped entries and report targets', () => {
  const source = inputs();
  const work = new Work(source.plan, source.entries);
  const result = { status: 'judged', requiresSuspect: true, requiresFlag: true } as const;
  const target = { marketId: MARKET, borrower: BORROWER };
  const results = [{ anchor: source.anchor, result }];
  const flaggedBy = [CORE];
  const skipped = [{ target, anchors: source.anchors, flaggedBy }];
  const suspects = [target];
  const flags = [target];
  const expected = structuredClone({ results, skipped, suspects, flags });
  const screened = new Screened(work, { results, skipped }, { suspects, flags });
  Object.assign(result, { requiresFlag: false });
  Object.assign(target, { borrower: CORE });
  Object.assign(source.anchor, { logIndex: 9 });
  results.length = 0;
  skipped.length = 0;
  suspects.length = 0;
  flags.length = 0;
  flaggedBy.length = 0;
  assert.deepEqual(screened.results, expected.results);
  assert.deepEqual(screened.skipped, expected.skipped);
  assert.deepEqual(screened.suspects, expected.suspects);
  assert.deepEqual(screened.flags, expected.flags);
  assert.equal(screened.work(), work);
  for (const array of [screened.results, screened.skipped, screened.suspects, screened.flags]) {
    assert.throws(() => Object.assign(array, { length: 0 }), TypeError);
  }
  const flag = screened.flags[0];
  const recorded = screened.results[0];
  const skippedTarget = screened.skipped[0];
  assert.ok(flag !== undefined);
  assert.ok(recorded !== undefined);
  assert.ok(skippedTarget !== undefined);
  assert.throws(() => Object.assign(screened, { flags: [] }), TypeError);
  assert.throws(() => Object.assign(flag, { borrower: CORE }), TypeError);
  assert.throws(() => Object.assign(recorded.result, { requiresFlag: false }), TypeError);
  assert.throws(() => Object.assign(skippedTarget.flaggedBy, { length: 0 }), TypeError);
});
