// Phases B and C: which positions may be due, and which supplies still fund them. Every case is one
// decision of `docs/guardian-specification.md`, sections B and C.
import test from 'node:test';
import assert from 'node:assert/strict';
import { padHex } from 'viem';

import type { GuardianSetup } from '../../src/core/guardian.ts';
import type { Work } from '../../src/core/outcomes.ts';
import { GuardianStop } from '../../src/core/stop.ts';
import type { StopReason } from '../../src/core/stop.ts';
import { blockAt, BORROWER, CONTROLLER, MARKET } from './fake-node.ts';
import type { LogsCap } from './fake-node.ts';
import type { Lot, Script } from './fake-node.ts';
import { CORE_DEPLOYED, guardianOver } from './setup.ts';

const HEAD = 200_000;

const REPORT = HEAD - 2;

const DAY = 24 * 60 * 60;

/**
 * A log span small enough that a backward search from the report block crosses several spans. The
 * spans start at the core's deployment, `CORE_DEPLOYED`, so the newest runs from `191_000` to the
 * report block, the eleventh holds `100_000` and the twelfth holds `90_000`.
 */
const SPAN = 10_000;

/** A lot that started from zero at `blockNumber` and whose timer has long elapsed. */
function activation(blockNumber: number, amount: bigint, supplied: bigint): Lot {
  return {
    kind: 'activating',
    blockNumber,
    logIndex: 4,
    amount,
    position: {
      dust: 0n,
      activating: amount,
      activatingStart: blockAt(blockNumber).timestamp,
      activatingDelay: DAY,
    },
    supplied,
  };
}

/** A dust supply of 3 at `90_000`, and the activation of 8 at `100_000` that absorbed it. */
function dustThenAbsorbing(): { dusted: Lot; absorbing: Lot } {
  return {
    dusted: {
      kind: 'dusted',
      blockNumber: 90_000,
      logIndex: 2,
      amount: 3n,
      position: { dust: 3n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
      supplied: 3n,
    },
    absorbing: {
      kind: 'activating',
      blockNumber: 100_000,
      logIndex: 4,
      amount: 8n,
      position: {
        dust: 0n,
        activating: 8n,
        activatingStart: blockAt(100_000).timestamp,
        activatingDelay: DAY,
      },
      supplied: 5n,
    },
  };
}

/**
 * A lot of 4 that started from zero at `80_000`, a dust supply of 3 at `90_000` while it activates,
 * and the activation of 5 at `100_000` that absorbed the dust and grew the lot to 9.
 */
function dustIntoGrowingLot(): { started: Lot; dusted: Lot; absorbing: Lot } {
  const lotStart = blockAt(80_000).timestamp;
  return {
    started: activation(80_000, 4n, 4n),
    dusted: {
      kind: 'dusted',
      blockNumber: 90_000,
      logIndex: 2,
      amount: 3n,
      position: { dust: 3n, activating: 4n, activatingStart: lotStart, activatingDelay: DAY },
      supplied: 3n,
    },
    absorbing: {
      kind: 'activating',
      blockNumber: 100_000,
      logIndex: 4,
      amount: 5n,
      position: { dust: 0n, activating: 9n, activatingStart: blockAt(100_000).timestamp, activatingDelay: DAY },
      supplied: 2n,
    },
  };
}

async function workOf(script: Script, parts: Partial<GuardianSetup> & { maxLogBlockRange?: number } = {}) {
  const { guardian, node } = guardianOver(script, parts);
  const planned = await guardian.buildScanPlan();
  assert.ok(planned.kind === 'plan', 'the script should produce a plan');
  return { work: await guardian.reconstructWork(await guardian.discoverCandidatePositions(planned)), node };
}

async function assertStops(script: Script, reason: StopReason): Promise<void> {
  const { guardian } = guardianOver(script);
  const planned = await guardian.buildScanPlan();
  assert.ok(planned.kind === 'plan', 'the script should produce a plan');
  await assert.rejects(
    async () => {
      const discovered = await guardian.discoverCandidatePositions(planned);
      await guardian.reconstructWork(discovered);
    },
    (error: unknown) => {
      assert.ok(error instanceof GuardianStop);
      assert.equal(error.reason, reason);
      return true;
    },
  );
}

/** Compare exact supply locations, independently of reconstruction order. */
function assertAnchors(work: Work, expected: readonly (readonly [number, number])[]): void {
  assert.deepEqual(
    work
      .all()
      .map((anchor) => `${anchor.blockHash}:${anchor.logIndex}`)
      .sort(),
    expected.map(([blockNumber, logIndex]) => `${blockAt(blockNumber).hash}:${logIndex}`).sort(),
  );
}

test('a supply into a market with no controller is not a candidate', async () => {
  const { work } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    controller: null,
    lots: [activation(100_000, 5n, 5n)],
  });
  assert.equal(work.positions, 0);
});

test('a controller that reports to another registry is not ours to screen', async () => {
  const { work } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    controllerRegistry: '0x00000000000000000000000000000000000000ff',
    lots: [activation(100_000, 5n, 5n)],
  });
  assert.equal(work.positions, 0);
});

test('a supply the controller put into dust is not a candidate', async () => {
  const dusted: Lot = {
    kind: 'dusted',
    blockNumber: 100_000,
    logIndex: 4,
    amount: 5n,
    position: { dust: 5n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
    supplied: 5n,
  };
  const { work } = await workOf({ head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [dusted] });
  assert.equal(work.positions, 0);
});

test('a supply the controller activated at once is not a candidate', async () => {
  const activated: Lot = {
    kind: 'activated',
    blockNumber: 100_000,
    logIndex: 4,
    amount: 5n,
    position: { dust: 0n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
    supplied: 5n,
  };
  const { work } = await workOf({ head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [activated] });
  assert.equal(work.positions, 0);
});

test('a drain logged right before a supply stops the attempt', async () => {
  const drained: Lot = {
    kind: 'drained',
    blockNumber: 100_000,
    logIndex: 4,
    amount: 5n,
    position: { dust: 0n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
    supplied: 5n,
  };
  await assertStops({ head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [drained] }, 'supply-without-controller-event');
});

test('a classification that names another borrower than the supply stops the attempt', async () => {
  const foreign: Lot = {
    kind: 'dusted',
    blockNumber: 100_000,
    logIndex: 4,
    amount: 5n,
    position: { dust: 5n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
    supplied: 5n,
    borrower: '0x00000000000000000000000000000000000000ab',
  };
  await assertStops({ head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [foreign] }, 'supply-without-controller-event');
});

test('a lot whose timer has not elapsed at the report block is not yet due', async () => {
  const late: Lot = {
    kind: 'activating',
    blockNumber: REPORT - 1,
    logIndex: 4,
    amount: 5n,
    position: {
      dust: 0n,
      activating: 5n,
      activatingStart: blockAt(REPORT).timestamp,
      activatingDelay: DAY,
    },
    supplied: 5n,
  };
  const { work } = await workOf({ head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [late] });
  assert.equal(work.positions, 0);
});

test('a due lot yields one anchor, and the supply beside it ends the walk', async () => {
  const { work, node } = await workOf(
    { head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [activation(100_000, 5n, 5n)] },
    { maxLogBlockRange: SPAN },
  );
  assert.equal(work.positions, 1);
  assert.equal(work.anchors, 1);
  const [anchors] = [...work.entries().values()];
  const anchor = anchors?.[0];
  assert.ok(anchor !== undefined);
  assert.equal(anchor.borrower, BORROWER);
  assert.equal(anchor.marketId, MARKET);
  assert.equal(anchor.logIndex, 5, 'the anchor is the supply, one log after the activation');
  // Discovery's classification reads name no borrower.
  const lifecycleQueries = node.logQueries.filter((query) => query.address === CONTROLLER && query.topics.length > 1);
  assert.equal(lifecycleQueries.length, 11, 'the walk reads down to the span that holds the lot and no older one');
  for (const query of lifecycleQueries) {
    assert.equal(query.topics[1], padHex(BORROWER, { size: 32 }));
  }
});

test('an activation that absorbed dust keeps the supply that dust came from', async () => {
  const { dusted, absorbing } = dustThenAbsorbing();
  const { work } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    lots: [dusted, absorbing],
  });
  assert.equal(work.anchors, 2, 'the activation and the dust it absorbed are both funding');
});

test('a walk across spans reads back only as far as the dust it traces', async () => {
  const { dusted, absorbing } = dustThenAbsorbing();
  const { work, node } = await workOf(
    { head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [dusted, absorbing] },
    { maxLogBlockRange: SPAN },
  );
  assert.equal(work.anchors, 2, 'the activation and the dust it absorbed are both funding');
  const lifecycleQueries = node.logQueries.filter((query) => query.address === CONTROLLER && query.topics.length > 1);
  assert.equal(lifecycleQueries.length, 12, 'the walk reads down to the span that holds the dust and no older one');
});

test('lifecycle events a node returns newest first are still walked from the newest', async () => {
  const { dusted, absorbing } = dustThenAbsorbing();
  const { work } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    lots: [absorbing, dusted],
  });
  assert.equal(work.positions, 1);
  assert.equal(work.anchors, 2, 'the activation and the dust it absorbed are both funding');
});

test('an activation that did not start from zero and has no older event stops the attempt', async () => {
  // `activating` is 8 but the activation added 3, so 5 came from an older supply the node did not
  // return.
  const maturing: Lot = {
    kind: 'activating',
    blockNumber: 100_000,
    logIndex: 4,
    amount: 3n,
    position: {
      dust: 0n,
      activating: 8n,
      activatingStart: blockAt(100_000).timestamp,
      activatingDelay: DAY,
    },
    supplied: 3n,
  };
  await assertStops({ head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [maturing] }, 'position-history-broken');
});

test('an event that is not an activation and has no older event stops the attempt', async () => {
  // The drain left 5 activating, and the event that put them there is missing.
  const drained: Lot = {
    kind: 'drained',
    blockNumber: 90_000,
    logIndex: 2,
    amount: 1n,
    position: {
      dust: 0n,
      activating: 5n,
      activatingStart: blockAt(80_000).timestamp,
      activatingDelay: DAY,
    },
  };
  const maturing: Lot = {
    kind: 'activating',
    blockNumber: 100_000,
    logIndex: 4,
    amount: 3n,
    position: {
      dust: 0n,
      activating: 8n,
      activatingStart: blockAt(100_000).timestamp,
      activatingDelay: DAY,
    },
    supplied: 3n,
  };
  await assertStops(
    { head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [drained, maturing] },
    'position-history-broken',
  );
});

test('an activation that grew its lot and absorbed dust walks on past the dust to where the lot began', async () => {
  const { started, dusted, absorbing } = dustIntoGrowingLot();
  const { work } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    lots: [started, dusted, absorbing],
  });
  assert.equal(work.positions, 1);
  assert.equal(work.anchors, 3, 'the activation, the dust it absorbed and the lot it grew all fund');
});

test('an activation that grew its lot and absorbed dust, with no event older than the dust, stops the attempt', async () => {
  // `activating` is 9 but the activation added 5, so 4 came from an older supply the node did not
  // return.
  const { dusted, absorbing } = dustIntoGrowingLot();
  await assertStops(
    { head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [dusted, absorbing] },
    'position-history-broken',
  );
});

test('an activation with more assets than its supply stops when the absorbed dust history is absent', async () => {
  // credit adds assets + previous dust, even when the previous activating balance was zero.
  await assertStops(
    { head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [activation(100_000, 5n, 4n)] },
    'position-history-broken',
  );
});

test('an activation smaller than its paired supply stops the attempt', async () => {
  await assertStops(
    { head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [activation(100_000, 5n, 6n)] },
    'position-history-broken',
  );
});

test('an activation whose supply and preceding dust do not add up stops the attempt', async () => {
  const { dusted, absorbing } = dustThenAbsorbing();
  await assertStops(
    { head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [dusted, { ...absorbing, supplied: 4n }] },
    'position-history-broken',
  );
});

test('a plan whose report block the node no longer holds stops the attempt', async () => {
  const { guardian } = guardianOver({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    lots: [activation(100_000, 5n, 5n)],
  });
  const planned = await guardian.buildScanPlan();
  assert.ok(planned.kind === 'plan');
  const broken = {
    ...planned,
    discoveryRange: {
      ...planned.discoveryRange,
      to: { ...planned.discoveryRange.to, hash: blockAt(1).hash },
    },
  };
  await assert.rejects(
    async () => {
      const discovered = await guardian.discoverCandidatePositions(broken);
      await guardian.reconstructWork(discovered);
    },
    (error: unknown) => {
      assert.ok(error instanceof GuardianStop);
      assert.equal(error.reason, 'node-behind-the-plan');
      return true;
    },
  );
});

test('a controller log served under another block than its supply log stops the attempt', async () => {
  const reorged: Lot = { ...activation(100_000, 5n, 5n), controllerBlockHash: blockAt(1).hash };
  await assertStops({ head: HEAD, guardianAddedAt: CORE_DEPLOYED, lots: [reorged] }, 'supply-without-controller-event');
});

test('a supply log that does not decode stops the attempt rather than dropping the supply', async () => {
  await assertStops(
    {
      head: HEAD,
      guardianAddedAt: CORE_DEPLOYED,
      lots: [activation(100_000, 5n, 5n)],
      undecodable: ['supply'],
    },
    'log-undecodable',
  );
});

test('a lifecycle log that does not decode stops the attempt rather than dropping the event', async () => {
  await assertStops(
    {
      head: HEAD,
      guardianAddedAt: CORE_DEPLOYED,
      lots: [activation(100_000, 5n, 5n)],
      undecodable: ['lifecycle'],
    },
    'log-undecodable',
  );
});

test('a paired supply that does not decode at the activation block stops the attempt rather than reading as unpaired', async () => {
  // Discovery reads the supplies fine, and only phase C's one-block lookup of the paired supply breaks.
  await assertStops(
    {
      head: HEAD,
      guardianAddedAt: CORE_DEPLOYED,
      lots: [activation(100_000, 5n, 5n)],
      undecodable: ['pairedSupply'],
    },
    'log-undecodable',
  );
});

test('a log range the node refuses is read again in halves until the node serves every part', async () => {
  const caps: LogsCap[] = [
    { over: SPAN - 1, code: -32005, message: 'query returned more than 10000 results' },
    {
      over: SPAN - 1,
      code: -32602,
      message: 'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
    },
    { over: SPAN - 1, message: 'the range exceeds the limit' },
  ];
  for (const logsCapped of caps) {
    const { work, node } = await workOf(
      {
        head: HEAD,
        guardianAddedAt: CORE_DEPLOYED,
        lots: [activation(100_000, 5n, 5n)],
        logsCapped,
      },
      { maxLogBlockRange: SPAN },
    );
    assertAnchors(work, [[100_000, 5]]);
    const served = node.logQueries.filter((query) => query.address === CONTROLLER);
    assert.ok(served.length > 0);
    assert.ok(served.every((query) => query.toBlock - query.fromBlock + 1 < SPAN));
  }
});

test('a node that refuses a single-block query stops the cycle', async () => {
  await assert.rejects(
    workOf(
      {
        head: HEAD,
        guardianAddedAt: CORE_DEPLOYED,
        lots: [activation(100_000, 5n, 5n)],
        logsCapped: { over: 0, code: -32005, message: 'query returned more than 10000 results' },
      },
      { maxLogBlockRange: SPAN },
    ),
    (error: unknown) =>
      hasCause(
        error,
        (candidate) =>
          candidate instanceof Error &&
          candidate.message === 'query returned more than 10000 results' &&
          'code' in candidate &&
          candidate.code === -32005,
      ),
  );
});

test("the controller's lifecycle events are read once for the window however many supplies it holds", async () => {
  const { work, node } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    lots: [activation(100_000, 5n, 5n), { ...activation(100_000, 7n, 7n), logIndex: 8 }, activation(150_000, 9n, 9n)],
  });
  assert.equal(work.positions, 1, 'every supply is on behalf of one borrower');
  const windowQueries = node.logQueries.filter((query) => query.address === CONTROLLER && query.topics.length === 1);
  assert.equal(windowQueries.length, 1, 'one query for the window, not one per supply or block');
});

test('a log response too large for the client is read again in halves', async () => {
  const { work } = await workOf(
    {
      head: HEAD,
      guardianAddedAt: CORE_DEPLOYED,
      lots: [activation(100_000, 5n, 5n)],
      logsTooLargeOver: SPAN - 1,
    },
    { maxLogBlockRange: SPAN },
  );
  assertAnchors(work, [[100_000, 5]]);
});

for (const deadlineOffset of [-1, 0, 1]) {
  test(`a position due ${deadlineOffset} seconds from previous coverage keeps exactly the uncovered contributors`, async () => {
    const coverage = blockAt(95_000);
    const { started, dusted, absorbing } = dustIntoGrowingLot();
    const activatingDelay = coverage.timestamp + deadlineOffset - started.position.activatingStart;
    const { work } = await workOf({
      head: HEAD,
      heartbeatTimestamp: coverage.timestamp,
      heartbeats: [{ blockNumber: coverage.number, timestamp: coverage.timestamp }],
      lots: [
        { ...started, position: { ...started.position, activatingDelay } },
        { ...dusted, position: { ...dusted.position, activatingDelay } },
        absorbing,
      ],
    });
    // Dust entered activating only at 100_000, so the earlier heartbeat never covered it.
    const expected: [number, number][] = [
      [90_000, 3],
      [100_000, 5],
    ];
    if (deadlineOffset > 0) {
      expected.push([80_000, 5]);
    }
    assertAnchors(work, expected);
  });
}

test('a dust search crossing coverage uses the latest position at that block', async () => {
  const coverage = blockAt(95_000);
  const { started, dusted, absorbing } = dustIntoGrowingLot();
  const matured: Lot = {
    kind: 'activated',
    blockNumber: coverage.number,
    logIndex: 6,
    amount: 4n,
    position: { dust: 3n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
  };
  const { work } = await workOf({
    head: HEAD,
    heartbeatTimestamp: coverage.timestamp,
    heartbeats: [{ blockNumber: coverage.number, timestamp: coverage.timestamp }],
    lots: [started, dusted, matured, { ...absorbing, position: { ...absorbing.position, activating: 5n } }],
  });
  assertAnchors(work, [
    [90_000, 3],
    [100_000, 5],
  ]);
});

test('a partial drain at the coverage block preserves coverage of the older contributor', async () => {
  const coverage = blockAt(95_000);
  const old = activation(80_000, 5n, 5n);
  const drained: Lot = {
    kind: 'drained',
    blockNumber: coverage.number,
    logIndex: 2,
    amount: 2n,
    position: { ...old.position, activating: 3n },
  };
  const fresh = activation(100_000, 3n, 3n);
  const { work } = await workOf({
    head: HEAD,
    heartbeatTimestamp: coverage.timestamp,
    heartbeats: [{ blockNumber: coverage.number, timestamp: coverage.timestamp }],
    lots: [old, drained, { ...fresh, position: { ...fresh.position, activating: 6n } }],
  });
  assertAnchors(work, [[100_000, 5]]);
});

test('discovery skips an already-due position with no fresh activation after coverage', async () => {
  const coverage = blockAt(95_000);
  const { work } = await workOf({
    head: HEAD,
    heartbeatTimestamp: coverage.timestamp,
    heartbeats: [{ blockNumber: coverage.number, timestamp: coverage.timestamp }],
    lots: [activation(80_000, 5n, 5n)],
  });
  assertAnchors(work, []);
});

test('an older activation that first becomes due after coverage remains discovery work', async () => {
  const coverage = blockAt(95_000);
  const old = activation(90_000, 5n, 5n);
  const { work } = await workOf({
    head: HEAD,
    heartbeatTimestamp: coverage.timestamp,
    heartbeats: [{ blockNumber: coverage.number, timestamp: coverage.timestamp }],
    lots: [old],
  });
  assertAnchors(work, [[90_000, 5]]);
});

test('reconstruction follows an absorbed dust supply beyond the discovery lookback', async () => {
  const dusted: Lot = {
    kind: 'dusted',
    blockNumber: 50_000,
    logIndex: 2,
    amount: 3n,
    supplied: 3n,
    position: { dust: 3n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
  };
  const { work } = await workOf(
    {
      head: HEAD,
      guardianAddedAt: 160_000,
      lots: [dusted, activation(170_000, 8n, 5n)],
    },
    { maxLogBlockRange: SPAN },
  );
  assertAnchors(work, [
    [50_000, 3],
    [170_000, 5],
  ]);
});

test('partially seized dust retains its original supply anchor when the remainder is absorbed', async () => {
  const { dusted, absorbing } = dustThenAbsorbing();
  const drained: Lot = {
    kind: 'drained',
    blockNumber: 95_000,
    logIndex: 2,
    amount: 2n,
    position: { dust: 1n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
  };
  const { work } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    lots: [dusted, drained, { ...absorbing, amount: 6n, position: { ...absorbing.position, activating: 6n } }],
  });
  assertAnchors(work, [
    [90_000, 3],
    [100_000, 5],
  ]);
});

test('partial activating seizure preserves every possible contributor', async () => {
  const first = activation(80_000, 5n, 5n);
  const second = activation(90_000, 5n, 5n);
  const secondPosition = { ...second.position, activating: 10n };
  const drained: Lot = {
    kind: 'drained',
    blockNumber: 100_000,
    logIndex: 2,
    amount: 7n,
    position: { ...secondPosition, activating: 3n },
  };
  const { work } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    lots: [first, { ...second, position: secondPosition }, drained],
  });
  assertAnchors(work, [
    [80_000, 5],
    [90_000, 5],
  ]);
});

test('a later timer extension can make a discovered position not yet due at the report block', async () => {
  const first = activation(100_000, 5n, 5n);
  const later = activation(REPORT - 1, 3n, 3n);
  const { work } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    lots: [first, { ...later, position: { ...later.position, activating: 8n } }],
  });
  assertAnchors(work, []);
});

for (const kind of ['activated', 'drained'] as const) {
  test(`clearing activating through ${kind} removes the discovered position from work`, async () => {
    const cleared: Lot = {
      kind,
      blockNumber: 110_000,
      logIndex: 2,
      amount: 5n,
      position: { dust: 0n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
    };
    const { work } = await workOf({
      head: HEAD,
      guardianAddedAt: CORE_DEPLOYED,
      lots: [activation(100_000, 5n, 5n), cleared],
    });
    assertAnchors(work, []);
  });
}

for (const kind of ['activated', 'drained'] as const) {
  test(`a lot ${kind} since its supply is no candidate, so its history is not walked`, async () => {
    const cleared: Lot = {
      kind,
      blockNumber: 110_000,
      logIndex: 2,
      amount: 5n,
      position: { dust: 0n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
    };
    const { guardian, node } = guardianOver({
      head: HEAD,
      guardianAddedAt: CORE_DEPLOYED,
      lots: [activation(100_000, 5n, 5n), cleared],
    });
    const planned = await guardian.buildScanPlan();
    assert.ok(planned.kind === 'plan', 'the script should produce a plan');
    const discovered = await guardian.discoverCandidatePositions(planned);
    assert.deepEqual(discovered.all(), []);
    const work = await guardian.reconstructWork(discovered);
    assert.equal(work.positions, 0);
    const walks = node.logQueries.filter((query) => query.address === CONTROLLER && query.topics.length > 1);
    assert.equal(walks.length, 0, 'no history walk for a position discovery discarded');
  });
}

test('multiple supplies in one block yield distinct anchors regardless of returned log order', async () => {
  const first = activation(100_000, 5n, 5n);
  const second: Lot = { ...first, logIndex: 8, position: { ...first.position, activating: 10n } };
  const { work } = await workOf({
    head: HEAD,
    guardianAddedAt: CORE_DEPLOYED,
    lots: [second, first],
  });
  assert.equal(work.positions, 1);
  assertAnchors(work, [
    [100_000, 5],
    [100_000, 9],
  ]);
});

function hasCause(error: unknown, predicate: (candidate: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === 'object') {
    if (seen.has(current)) {
      break;
    }
    if (predicate(current)) {
      return true;
    }
    seen.add(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
