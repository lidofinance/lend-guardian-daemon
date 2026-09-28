// Portable SDK edge scenarios that complement the deployed-contract fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageDigest } from '../../src/core/digest.ts';
import { blockAt, CORE, GUARDIAN, REGISTRY } from '../core/fake-node.ts';
import type { Lot, Script } from '../core/fake-node.ts';
import { guardianOver } from '../core/setup.ts';

const HEAD = 200_000;
const REPORT_BLOCK = HEAD - 2;
const DAY = 24 * 60 * 60;

const ACTIVATION: Lot = {
  kind: 'activating',
  blockNumber: 100_000,
  logIndex: 4,
  amount: 100n,
  position: {
    dust: 0n,
    activating: 100n,
    activatingStart: blockAt(100_000).timestamp,
    activatingDelay: DAY,
  },
  supplied: 100n,
};

const PARTIAL_DRAIN: Lot = {
  kind: 'drained',
  blockNumber: 150_000,
  logIndex: 2,
  amount: 40n,
  position: {
    dust: 0n,
    activating: 60n,
    activatingStart: blockAt(100_000).timestamp,
    activatingDelay: DAY,
  },
};

const ONE_DUE: Script = { head: HEAD, guardianAddedAt: 1_000, lots: [ACTIVATION] };

test('keeps the original contributor after a partial activating-position drain', async () => {
  const { guardian } = guardianOver({
    head: HEAD,
    guardianAddedAt: 1_000,
    lots: [ACTIVATION, PARTIAL_DRAIN],
  });
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));

  assert.equal(work.anchors, 1);
  assert.partialDeepStrictEqual(work.all()[0], {
    blockHash: blockAt(ACTIVATION.blockNumber).hash,
    logIndex: ACTIVATION.logIndex + 1,
  });
});

test('returns stale when the selected report block is reorged in isolation', async () => {
  const { guardian, node } = guardianOver(ONE_DUE);
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const screened = await guardian.screenWork(
    await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan)),
  );
  node.reorgBlock(plan.discoveryRange.to.number);

  assert.deepEqual(await guardian.signalAndHeartbeat(screened), {
    kind: 'stale',
    reason: 'report-block-reorged',
  });
});

test('returns stale when the report block leaves the reserved blockhash window', async () => {
  const { guardian, node } = guardianOver(ONE_DUE);
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const screened = await guardian.screenWork(
    await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan)),
  );
  node.advanceTo(REPORT_BLOCK + 250);

  assert.deepEqual(await guardian.signalAndHeartbeat(screened), {
    kind: 'stale',
    reason: 'report-block-aged-out',
  });
});

test('commits an own-flag-skipped anchor in the heartbeat digest', async () => {
  const built = guardianOver(
    { ...ONE_DUE, flaggedBy: [GUARDIAN] },
    {
      screening: { screen: () => Promise.reject(new Error('own flag reached provider')) },
    },
  );
  const plan = await built.guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const discovered = await built.guardian.discoverCandidatePositions(plan);
  const work = await built.guardian.reconstructWork(discovered);
  const screened = await built.guardian.screenWork(work);
  assert.equal(screened.skipped.length, 1);

  const outcome = await built.guardian.signalAndHeartbeat(screened);
  assert.equal(outcome.kind, 'attested');
  assert.equal(
    built.sent.heartbeats[0]?.digest,
    coverageDigest(work.all(), {
      chainId: 1,
      core: CORE,
      registry: REGISTRY,
      guardian: GUARDIAN,
      previousBlockHash: null,
      reportBlockHash: plan.discoveryRange.to.hash,
    }),
  );
});
