// Phase A: which block a cycle attests, and how far back it looks for candidates. Every case here
// is one decision of `docs/guardian-specification.md`, section A.
import test from 'node:test';
import assert from 'node:assert/strict';
import { padHex, toEventSelector } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import type { GuardianSetup } from '../../src/core/guardian.ts';
import type { BlockRef } from '../../src/common/types.ts';
import { GuardianStop } from '../../src/core/stop.ts';
import type { StopReason } from '../../src/core/stop.ts';
import { blockAt, GUARDIAN, REGISTRY } from './fake-node.ts';
import type { Script } from './fake-node.ts';
import { CORE_DEPLOYED, guardianOver, REGISTRY_DEPLOYED } from './setup.ts';

/** `ceil(7 days / 12s)`: the window phase A measures back from its anchor by default. */
const LOOKBACK = 50_400;

const HEAD = 200_000;

const DELEGATE_KEY = padHex('0x02', { size: 32 });
const DELEGATE = privateKeyToAddress(DELEGATE_KEY);

const OTHER_KEY = padHex('0x03', { size: 32 });
const OTHER_DELEGATE = privateKeyToAddress(OTHER_KEY);

/** A Guardian that never heartbeated and joined long before the report block. */
const JOINED: Script = { head: HEAD, heartbeatTimestamp: 0, guardianAddedAt: 150_000 };

async function planOver(
  script: Script,
  parts: Partial<GuardianSetup> & { privateKey?: `0x${string}` } = {},
  previousHeartbeatBlock?: BlockRef | null,
) {
  const { guardian, node } = guardianOver(script, parts);
  const planned = await guardian.buildScanPlan(previousHeartbeatBlock);
  const registryLogQueries = node.logQueries.filter((query) => query.address === REGISTRY);
  const registryQueries = registryLogQueries.map((query) => [query.fromBlock, query.toBlock]);
  return { planned, registryQueries, registryLogQueries };
}

async function assertStops(
  script: Script,
  reason: StopReason,
  parts: Partial<GuardianSetup> & { privateKey?: `0x${string}` } = {},
) {
  const { guardian } = guardianOver(script, parts);
  await assert.rejects(guardian.buildScanPlan(), (error: unknown) => {
    assert.ok(error instanceof GuardianStop);
    assert.equal(error.reason, reason);
    return true;
  });
}

/** The report block an attested cycle can pass back as a search hint. */
function hintAt(covered: number): BlockRef {
  return blockAt(covered);
}

test('a node that serves another chain stops the attempt before anything is planned', async () => {
  await assertStops(
    { head: HEAD, chainId: 560_048, heartbeatTimestamp: 0, guardianAddedAt: 150_000 },
    'chain-id-mismatch',
  );
});

test('a Guardian that is not a member stops the attempt rather than planning one', async () => {
  await assertStops({ head: HEAD, isGuardian: false, heartbeatTimestamp: 0 }, 'guardian-not-member');
});

test('a Guardian that signs itself and expects no delegate plans while the registry names none', async () => {
  const { planned } = await planOver(JOINED);

  assert.equal(planned.kind, 'plan');
});

test('an expected delegate that signs plans while the registry names it', async () => {
  const { planned } = await planOver(
    { ...JOINED, delegate: DELEGATE },
    { privateKey: DELEGATE_KEY, expectedDelegate: DELEGATE },
  );

  assert.equal(planned.kind, 'plan');
});

test('a Guardian that signs itself stops while the registry names a delegate nobody expects', async () => {
  await assertStops({ ...JOINED, delegate: DELEGATE }, 'delegate-mismatch');
});

test('a registry that names another delegate than the expected one stops the attempt', async () => {
  await assertStops({ ...JOINED, delegate: OTHER_DELEGATE }, 'delegate-mismatch', {
    privateKey: DELEGATE_KEY,
    expectedDelegate: DELEGATE,
  });
});

test('a registry that names no delegate while one is expected stops the attempt', async () => {
  await assertStops(JOINED, 'delegate-mismatch', { expectedDelegate: DELEGATE });
});

test('a signer that is neither the Guardian nor its expected delegate stops the attempt', async () => {
  await assertStops({ ...JOINED, delegate: DELEGATE }, 'signer-not-authorized', {
    privateKey: DELEGATE_KEY,
  });
  await assertStops({ ...JOINED, delegate: DELEGATE }, 'signer-not-authorized', {
    privateKey: OTHER_KEY,
    expectedDelegate: DELEGATE,
  });
  // With no delegate expected, another valid signing key is still unauthorized.
  await assertStops(JOINED, 'signer-not-authorized', { privateKey: OTHER_KEY });
});

test('a Guardian that signs itself plans while the registry names the delegate it expects', async () => {
  const { planned } = await planOver({ ...JOINED, delegate: DELEGATE }, { expectedDelegate: DELEGATE });

  assert.equal(planned.kind, 'plan');
});

test('nothing is due while the chain is younger than the core plus the report lag', async () => {
  const { planned } = await planOver({
    head: CORE_DEPLOYED + 1,
    heartbeatTimestamp: 0,
    guardianAddedAt: CORE_DEPLOYED,
  });
  assert.equal(planned.kind, 'nothing-due');
  assert.equal(planned.reason, 'report-block-before-core-deployment');
});

test('nothing is due when the report block is not past what the registry already stores', async () => {
  const reportBlock = blockAt(HEAD - 2);
  const { planned } = await planOver({
    head: HEAD,
    heartbeatTimestamp: reportBlock.timestamp,
    heartbeats: [{ blockNumber: reportBlock.number, timestamp: reportBlock.timestamp }],
  });
  assert.equal(planned.kind, 'nothing-due');
  assert.equal(planned.reason, 'report-block-not-past-stored-heartbeat');
});

test('a Guardian that never heartbeated measures its window back from joining', async () => {
  const { planned } = await planOver({ head: HEAD, heartbeatTimestamp: 0, guardianAddedAt: 150_000 });
  assert.ok(planned.kind === 'plan');
  assert.equal(planned.discoveryRange.to.number, HEAD - 2);
  assert.equal(planned.previousHeartbeatBlock, null);
  assert.equal(planned.heartbeatTimestampAtStart, 0);
  assert.equal(planned.discoveryRange.from.number, 150_000 - LOOKBACK);
});

test('custom lookbacks are rejected instead of changing the canonical discovery range', () => {
  // S3 retains the fixed seven-day scope; both narrower and wider windows change the work set.
  for (const activationLookbackSeconds of [7_210, 8 * 24 * 60 * 60]) {
    assert.throws(
      () => guardianOver(JOINED, Object.assign({ maxLogBlockRange: 1000 }, { activationLookbackSeconds })),
      {
        name: 'TypeError',
        message: 'The activation lookback is fixed at seven days',
      },
    );
  }
});

test('the discovery range never reaches behind the core', async () => {
  const { planned } = await planOver({ head: 2_000, heartbeatTimestamp: 0, guardianAddedAt: 1_500 });
  assert.ok(planned.kind === 'plan');
  assert.equal(planned.discoveryRange.from.number, CORE_DEPLOYED);
});

test('a membership event after the report block leaves this cycle nothing to attest', async () => {
  const { planned } = await planOver({ head: HEAD, heartbeatTimestamp: 0, guardianAddedAt: HEAD - 1 });
  assert.equal(planned.kind, 'nothing-due');
  assert.equal(planned.reason, 'membership-after-report-block');
});

test('a Guardian with no membership event at all cannot be planned for', async () => {
  await assertStops({ head: HEAD, heartbeatTimestamp: 0 }, 'guardian-added-event-missing');
});

test('a membership event that does not decode stops the attempt rather than reading as absent', async () => {
  await assertStops({ ...JOINED, undecodable: ['guardianAdded'] }, 'log-undecodable');
});

test('a heartbeat event that does not decode stops the attempt rather than naming no coverage', async () => {
  const covered = blockAt(180_000);

  await assertStops(
    {
      head: HEAD,
      heartbeatTimestamp: covered.timestamp,
      heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
      undecodable: ['heartbeat'],
    },
    'log-undecodable',
  );
});

// Event layouts of IGuardianSignals: the Guardian is the first indexed field of both events.
const HEARTBEAT_TOPIC = toEventSelector('Heartbeat(address,uint256,uint256,bytes)');
const GUARDIAN_ADDED_TOPIC = toEventSelector('GuardianAdded(address)');

test('the heartbeat history query binds the indexed Guardian address', async () => {
  const covered = blockAt(180_000);
  const { registryLogQueries } = await planOver({
    head: HEAD,
    heartbeatTimestamp: covered.timestamp,
    heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
  });
  const heartbeatQueries = registryLogQueries.filter((query) => query.topics[0] === HEARTBEAT_TOPIC);
  assert.ok(heartbeatQueries.length > 0);
  for (const query of heartbeatQueries) {
    assert.equal(query.topics[1], padHex(GUARDIAN, { size: 32 }));
  }
});

test('the membership history query binds the indexed Guardian address', async () => {
  const { registryLogQueries } = await planOver(JOINED);
  const membershipQueries = registryLogQueries.filter((query) => query.topics[0] === GUARDIAN_ADDED_TOPIC);
  assert.ok(membershipQueries.length > 0);
  for (const query of membershipQueries) {
    assert.equal(query.topics[1], padHex(GUARDIAN, { size: 32 }));
  }
});

test('a stored heartbeat is matched to the block it reported, not the block it landed in', async () => {
  const covered = blockAt(180_000);
  const { planned } = await planOver({
    head: HEAD,
    heartbeatTimestamp: covered.timestamp,
    heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp, includedAt: 180_005 }],
  });
  assert.ok(planned.kind === 'plan');
  assert.deepEqual(planned.previousHeartbeatBlock, covered);
  assert.equal(planned.heartbeatTimestampAtStart, covered.timestamp);
  assert.equal(planned.discoveryRange.from.number, covered.number - LOOKBACK);
});

test('a heartbeat whose event timestamp is not the stored one names no coverage', async () => {
  const covered = blockAt(180_000);
  const { planned } = await planOver({
    head: HEAD,
    heartbeatTimestamp: covered.timestamp + 1,
    heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
    guardianAddedAt: 150_000,
  });
  assert.ok(planned.kind === 'plan');
  assert.equal(planned.previousHeartbeatBlock, null);
  assert.equal(planned.heartbeatTimestampAtStart, covered.timestamp + 1);
  assert.equal(planned.discoveryRange.from.number, 150_000 - LOOKBACK);
});

test('the latest heartbeat is found by block, whatever order the node returns the logs in', async () => {
  const older = blockAt(180_000);
  const newer = blockAt(185_000);
  const { planned } = await planOver({
    head: HEAD,
    heartbeatTimestamp: newer.timestamp,
    heartbeats: [
      { blockNumber: newer.number, timestamp: newer.timestamp },
      { blockNumber: older.number, timestamp: older.timestamp },
    ],
  });
  assert.ok(planned.kind === 'plan');
  assert.deepEqual(planned.previousHeartbeatBlock, newer);
});

test('of two heartbeats in one block, the later transaction is the latest', async () => {
  const older = blockAt(180_000);
  const newer = blockAt(184_000);
  const { planned } = await planOver({
    head: HEAD,
    heartbeatTimestamp: newer.timestamp,
    heartbeats: [
      {
        blockNumber: newer.number,
        timestamp: newer.timestamp,
        includedAt: 185_000,
        transactionIndex: 1,
      },
      {
        blockNumber: older.number,
        timestamp: older.timestamp,
        includedAt: 185_000,
        transactionIndex: 0,
      },
    ],
  });
  assert.ok(planned.kind === 'plan');
  assert.deepEqual(planned.previousHeartbeatBlock, newer);
});

test('a hint that still holds narrows the heartbeat search to the blocks after it', async () => {
  const covered = blockAt(180_000);
  const { planned, registryQueries } = await planOver(
    {
      head: HEAD,
      heartbeatTimestamp: covered.timestamp,
      heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
    },
    {},
    hintAt(covered.number),
  );
  assert.ok(planned.kind === 'plan');
  assert.deepEqual(planned.previousHeartbeatBlock, covered);
  assert.deepEqual(registryQueries, [[covered.number, HEAD]]);
});

test('a hint names no coverage when no heartbeat event stands behind it', async () => {
  const covered = blockAt(180_000);
  const { planned } = await planOver(
    { head: HEAD, heartbeatTimestamp: covered.timestamp, guardianAddedAt: 150_000 },
    {},
    hintAt(covered.number),
  );
  assert.ok(planned.kind === 'plan');
  assert.equal(planned.previousHeartbeatBlock, null);
});

test('a hint names no coverage when the latest heartbeat names a block without that timestamp', async () => {
  // Another sender heartbeated a later block with the same timestamp: the registry stores the same
  // value, but the block that event names does not carry it.
  const covered = blockAt(180_000);
  const { planned } = await planOver(
    {
      head: HEAD,
      heartbeatTimestamp: covered.timestamp,
      heartbeats: [
        { blockNumber: covered.number, timestamp: covered.timestamp },
        { blockNumber: 185_000, timestamp: covered.timestamp },
      ],
      guardianAddedAt: 150_000,
    },
    {},
    hintAt(covered.number),
  );
  assert.ok(planned.kind === 'plan');
  assert.equal(planned.previousHeartbeatBlock, null);
  assert.equal(planned.discoveryRange.from.number, 150_000 - LOOKBACK);
});

test('a hint later than the stored heartbeat does not narrow the search', async () => {
  // The cycle that left the hint attested a block whose heartbeat no longer stands, and the
  // registry stores an earlier one again.
  const covered = blockAt(170_000);
  const { planned, registryQueries } = await planOver(
    {
      head: HEAD,
      heartbeatTimestamp: covered.timestamp,
      heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
    },
    {},
    hintAt(180_000),
  );
  assert.ok(planned.kind === 'plan');
  assert.deepEqual(planned.previousHeartbeatBlock, covered);
  assert.deepEqual(registryQueries, [[REGISTRY_DEPLOYED, HEAD]]);
});

test('a failure to read the hinted block stops heartbeat recovery', async () => {
  const covered = blockAt(180_000);
  const unknownHint = blockAt(190_000);
  await assert.rejects(
    planOver(
      {
        head: HEAD,
        heartbeatTimestamp: covered.timestamp,
        heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
        missingBlocks: [unknownHint.number],
      },
      {},
      unknownHint,
    ),
    /RPC block is missing or pending/,
  );
});

test('a hint whose block is no longer canonical does not narrow the search', async () => {
  const covered = blockAt(180_000);
  const { planned, registryQueries } = await planOver(
    {
      head: HEAD,
      heartbeatTimestamp: covered.timestamp,
      heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
    },
    {},
    { ...covered, hash: blockAt(999_999).hash },
  );
  assert.ok(planned.kind === 'plan');
  assert.deepEqual(planned.previousHeartbeatBlock, covered);
  assert.deepEqual(registryQueries, [[REGISTRY_DEPLOYED, HEAD]]);
});

test('a hint that understates its block timestamp does not narrow the search past the heartbeat', async () => {
  const covered = blockAt(180_000);
  const hinted = blockAt(190_000);
  const { planned, registryQueries } = await planOver(
    {
      head: HEAD,
      heartbeatTimestamp: covered.timestamp,
      heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
      guardianAddedAt: 150_000,
    },
    {},
    { ...hinted, timestamp: 0 },
  );
  assert.ok(planned.kind === 'plan');
  assert.deepEqual(planned.previousHeartbeatBlock, covered);
  assert.deepEqual(registryQueries, [[REGISTRY_DEPLOYED, HEAD]]);
});

test('a canonical hint narrows the search by its header, whatever timestamp it carries', async () => {
  const covered = blockAt(180_000);
  const hinted = blockAt(170_000);
  const { planned, registryQueries } = await planOver(
    {
      head: HEAD,
      heartbeatTimestamp: covered.timestamp,
      heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
    },
    {},
    { ...hinted, timestamp: covered.timestamp + 1 },
  );
  assert.ok(planned.kind === 'plan');
  assert.deepEqual(planned.previousHeartbeatBlock, covered);
  assert.deepEqual(registryQueries, [[hinted.number, HEAD]]);
});

test('a reusable heartbeat makes own reports count from after the block that included it', async () => {
  const covered = blockAt(180_000);
  const { planned } = await planOver({
    head: HEAD,
    heartbeatTimestamp: covered.timestamp,
    heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp, includedAt: 180_005 }],
  });
  assert.ok(planned.kind === 'plan');
  assert.equal(planned.reportsSince, blockAt(180_005).timestamp);
});

test('a Guardian without a heartbeat counts own reports from after the block it joined in', async () => {
  const { planned } = await planOver(JOINED);
  assert.ok(planned.kind === 'plan');
  assert.equal(planned.reportsSince, blockAt(150_000).timestamp);
});

test('a stored heartbeat without a reusable block leaves own reports uncounted', async () => {
  const covered = blockAt(180_000);
  const { planned } = await planOver({
    head: HEAD,
    heartbeatTimestamp: covered.timestamp + 1,
    heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
    guardianAddedAt: 150_000,
  });
  assert.ok(planned.kind === 'plan');
  assert.equal(planned.reportsSince, null);
});
