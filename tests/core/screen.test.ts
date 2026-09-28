// The screening phase: who is asked, who is not, and what the answers require.
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ScreeningRequest, ScreeningResult } from '../../src/core/screening-provider.ts';
import { coverageDigest } from '../../src/core/digest.ts';
import { GuardianStop } from '../../src/core/stop.ts';
import type { StopReason } from '../../src/core/stop.ts';
import type { Address } from '../../src/common/types.ts';
import { blockAt, BORROWER, CHAIN_ID, CORE, GUARDIAN, MARKET, REGISTRY } from './fake-node.ts';
import type { Lot, Script } from './fake-node.ts';
import { guardianOver } from './setup.ts';
import { Screened } from '../../src/core/outcomes.ts';

const HEAD = 200_000;

const DAY = 24 * 60 * 60;

const TARGET = { marketId: MARKET, borrower: BORROWER };

const CLEAN: ScreeningResult = { status: 'judged', requiresSuspect: false, requiresFlag: false };

const SUSPECT: ScreeningResult = { status: 'judged', requiresSuspect: true, requiresFlag: false };

const FLAG: ScreeningResult = { status: 'judged', requiresSuspect: false, requiresFlag: true };

const INCOMPLETE: ScreeningResult = { status: 'incomplete' };

function lot(blockNumber: number, amount: bigint): Lot {
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
    supplied: amount,
  };
}

const ONE_DUE: Script = { head: HEAD, guardianAddedAt: 1_000, lots: [lot(100_000, 5n)] };

/** An activation that absorbed dust: two anchors, the dust's supply and the activating one. */
const TWO_ANCHORS: Script = {
  head: HEAD,
  guardianAddedAt: 1_000,
  lots: [
    {
      kind: 'dusted',
      blockNumber: 90_000,
      logIndex: 2,
      amount: 3n,
      position: { dust: 3n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
      supplied: 3n,
    },
    {
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
  ],
};

/** A Guardian whose provider records every request and answers each with `answers`. */
async function screenOver(script: Script, answers: readonly ScreeningResult[]) {
  const requests: ScreeningRequest[] = [];
  const screening = {
    screen: (request: ScreeningRequest) => {
      requests.push(request);
      return Promise.resolve(answers);
    },
  };
  const { guardian } = guardianOver(script, { screening });
  const planned = await guardian.buildScanPlan();
  assert.ok(planned.kind === 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(planned));
  return { guardian, work, requests };
}

async function assertStops(script: Script, answers: readonly ScreeningResult[], reason: StopReason) {
  const { guardian, work } = await screenOver(script, answers);
  await assert.rejects(guardian.screenWork(work), (error: unknown) => {
    assert.ok(error instanceof GuardianStop);
    assert.equal(error.reason, reason);
    return true;
  });
}

test('the provider is asked once, with the chain and the report block the anchors were read at', async () => {
  const { guardian, work, requests } = await screenOver(TWO_ANCHORS, [CLEAN, CLEAN]);
  await guardian.screenWork(work);
  assert.deepEqual(requests, [{ chainId: CHAIN_ID, reportBlock: blockAt(HEAD - 2), anchors: work.all() }]);
});

const REQUEST_MUTATIONS: Readonly<Record<string, (request: ScreeningRequest) => void>> = {
  'clears the anchors': (request) => {
    Object.assign(request.anchors, { length: 0 });
  },
  'reorders the anchors': (request) => {
    const [first, second] = request.anchors;
    assert.ok(first !== undefined);
    assert.ok(second !== undefined);
    Object.assign(request.anchors, { 0: second, 1: first });
  },
  'changes an anchor identity': (request) => {
    const first = request.anchors[0];
    assert.ok(first !== undefined);
    Object.assign(first, { transactionHash: blockAt(123).hash });
  },
  'moves the report block': (request) => {
    Object.assign(request.reportBlock, blockAt(HEAD - 1));
  },
  'replaces the requested anchors': (request) => {
    Object.assign(request, { anchors: [] });
  },
};

for (const [mutation, mutate] of Object.entries(REQUEST_MUTATIONS)) {
  test(`a provider that ${mutation} stops before any report or heartbeat`, async () => {
    const { guardian, sent } = guardianOver(TWO_ANCHORS, {
      screening: {
        screen: (request) => {
          mutate(request);
          return Promise.resolve(request.anchors.map(() => CLEAN));
        },
      },
    });
    const plan = await guardian.buildScanPlan();
    assert.ok(plan.kind === 'plan');
    const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
    const original = structuredClone({ anchors: work.all(), reportBlock: work.reportBlock });

    await assert.rejects(async () => {
      const screened = await guardian.screenWork(work);
      await guardian.signalAndHeartbeat(screened);
    }, TypeError);

    assert.deepEqual(sent.calls, []);
    assert.deepEqual({ anchors: work.all(), reportBlock: work.reportBlock }, original);
    assert.deepEqual(plan.discoveryRange.to, original.reportBlock);
  });
}

test('an empty answer to a nonempty request stops before any report or heartbeat', async () => {
  const { guardian, sent } = guardianOver(ONE_DUE, {
    screening: { screen: () => Promise.resolve([]) },
  });
  const plan = await guardian.buildScanPlan();
  assert.ok(plan.kind === 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));

  await assert.rejects(
    async () => {
      const screened = await guardian.screenWork(work);
      await guardian.signalAndHeartbeat(screened);
    },
    { reason: 'screening-result-missing' },
  );
  assert.deepEqual(sent.calls, []);
});

test('retained provider inputs cannot change result order, work or the heartbeat commitment', async () => {
  const requests: ScreeningRequest[] = [];
  const answers = [
    { ...CLEAN, evidenceReference: 'dust-case' },
    { ...CLEAN, evidenceReference: 'activating-case' },
  ];

  const { guardian, sent } = guardianOver(TWO_ANCHORS, {
    screening: {
      screen: (request) => {
        requests.push(request);
        return Promise.resolve(answers);
      },
    },
  });
  const plan = await guardian.buildScanPlan();
  assert.ok(plan.kind === 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
  const original = structuredClone({ anchors: work.all(), reportBlock: work.reportBlock });
  const expectedDigest = coverageDigest(original.anchors, {
    chainId: CHAIN_ID,
    core: CORE,
    registry: REGISTRY,
    guardian: GUARDIAN,
    previousBlockHash: null,
    reportBlockHash: original.reportBlock.hash,
  });
  const screened = await guardian.screenWork(work);
  const request = requests[0];
  assert.ok(request !== undefined);
  assert.notEqual(request.reportBlock, work.reportBlock);
  for (const [index, anchor] of request.anchors.entries()) {
    assert.notEqual(anchor, work.all()[index]);
  }
  for (const mutate of Object.values(REQUEST_MUTATIONS)) {
    assert.throws(() => mutate(request), TypeError);
  }
  assert.equal(Object.isFrozen(work.reportBlock), true);
  assert.ok(work.all().every((anchor) => Object.isFrozen(anchor)));
  assert.deepEqual(screened.results, [
    { anchor: original.anchors[0], result: answers[0] },
    { anchor: original.anchors[1], result: answers[1] },
  ]);
  assert.deepEqual({ anchors: work.all(), reportBlock: work.reportBlock }, original);

  const outcome = await guardian.signalAndHeartbeat(screened);
  assert.ok(outcome.kind === 'attested');
  assert.equal(outcome.digest, expectedDigest);
  assert.deepEqual(outcome.previousHeartbeatBlock, original.reportBlock);
  assert.deepEqual(sent.suspects, []);
  assert.deepEqual(sent.flags, []);
  assert.deepEqual(sent.heartbeats, [{ block: original.reportBlock.hash, digest: expectedDigest }]);
});

test('a clean result requires no report, and the anchor keeps its result for the record', async () => {
  const cleared: ScreeningResult = { ...CLEAN, evidenceReference: 'case-17' };
  const { guardian, work } = await screenOver(ONE_DUE, [cleared]);
  const screened = await guardian.screenWork(work);
  assert.deepEqual(screened.results, [{ anchor: work.all()[0], result: cleared }]);
  assert.deepEqual(screened.skipped, []);
  assert.deepEqual(screened.suspects, []);
  assert.deepEqual(screened.flags, []);
});

test('later provider edits cannot change recorded decisions or their required reports', async () => {
  const result = { ...FLAG, evidenceReference: 'case-original' };
  const answers = [result];
  const { guardian, work } = await screenOver(ONE_DUE, answers);
  const screened = await guardian.screenWork(work);
  assert.equal(Object.isFrozen(result), false);
  Object.assign(result, { requiresFlag: false, evidenceReference: 'changed' });
  answers.length = 0;
  assert.deepEqual(screened.results, [
    { anchor: work.all()[0], result: { ...FLAG, evidenceReference: 'case-original' } },
  ]);
  assert.deepEqual(screened.flags, [TARGET]);
  assert.deepEqual(screened.suspects, []);
  const recorded = screened.results[0];
  assert.ok(recorded !== undefined);
  assert.throws(() => Object.assign(recorded.result, { requiresFlag: false }), TypeError);
});

test('a provider decision getter is read once before validation and report selection', async () => {
  const reads: string[] = [];
  const result = {
    status: 'judged',
    requiresSuspect: false,
    get requiresFlag() {
      reads.push('flag');
      return reads.length === 1;
    },
  } as const;
  const { guardian, work } = await screenOver(ONE_DUE, [result]);
  const screened = await guardian.screenWork(work);
  assert.deepEqual(reads, ['flag']);
  assert.deepEqual(screened.results, [{ anchor: work.all()[0], result: FLAG }]);
  assert.deepEqual(screened.flags, [TARGET]);
});

test('a suspect result names its target once, by market and borrower', async () => {
  const { guardian, work } = await screenOver(ONE_DUE, [SUSPECT]);
  const screened = await guardian.screenWork(work);
  assert.deepEqual(screened.suspects, [TARGET]);
  assert.deepEqual(screened.flags, []);
});

test('a target whose anchors require different reports is both suspected and flagged', async () => {
  const { guardian, work } = await screenOver(TWO_ANCHORS, [SUSPECT, FLAG]);
  assert.equal(work.anchors, 2);
  const screened = await guardian.screenWork(work);
  assert.deepEqual(screened.suspects, [TARGET]);
  assert.deepEqual(screened.flags, [TARGET]);
});

test('one anchor that requires both reports is both suspected and flagged', async () => {
  const both: ScreeningResult = { status: 'judged', requiresSuspect: true, requiresFlag: true };
  const { guardian, work } = await screenOver(ONE_DUE, [both]);
  const screened = await guardian.screenWork(work);
  assert.deepEqual(screened.suspects, [TARGET]);
  assert.deepEqual(screened.flags, [TARGET]);
});

test('a target this Guardian already flagged is never sent to a provider again', async () => {
  // viem decodes 0x…c1 with a checksum, so the record shows whether the flaggers were lowered.
  const other = '0x00000000000000000000000000000000000000c1';
  const flaggedBy: Address[] = [other, GUARDIAN];
  const { guardian, work, requests } = await screenOver({ ...ONE_DUE, flaggedBy }, [FLAG]);
  const screened = await guardian.screenWork(work);
  assert.deepEqual(requests, [], 'the provider was not called at all');
  assert.deepEqual(screened.results, []);
  assert.deepEqual(screened.skipped, [{ target: TARGET, anchors: work.all(), flaggedBy }]);
  assert.deepEqual(screened.flags, []);
});

test('another Guardian flag does not excuse this one from screening', async () => {
  const other = '0x0000000000000000000000000000000000000001';
  const { guardian, work, requests } = await screenOver({ ...ONE_DUE, flaggedBy: [other] }, [CLEAN]);
  const screened = await guardian.screenWork(work);
  assert.equal(requests.length, 1);
  assert.equal(screened.results.length, 1);
  assert.deepEqual(screened.skipped, []);
});

test('an incomplete result stops the attempt instead of passing as clean', async () => {
  await assertStops(ONE_DUE, [INCOMPLETE], 'screening-result-incomplete');
});

for (const evidenceReference of ['', 7, { case: 'invalid' }]) {
  test(`malformed evidence ${JSON.stringify(evidenceReference)} stops screening`, async () => {
    const result = { ...CLEAN };
    // A provider written without TypeScript can return a value outside its declared contract.
    Object.assign(result, { evidenceReference });
    const { guardian } = guardianOver(ONE_DUE, {
      screening: { screen: () => Promise.resolve([result]) },
    });
    const plan = await guardian.buildScanPlan();
    assert.ok(plan.kind === 'plan');
    const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
    await assert.rejects(guardian.screenWork(work), { reason: 'screening-result-malformed' });
  });
}

test('evidence may be absent but a supplied reference must be a nonempty string', async () => {
  const { work } = await screenOver(ONE_DUE, []);
  const targets = { pending: [{ target: TARGET, anchors: work.all() }], skipped: [] };
  const screen = (answer: unknown) => Screened.fromAnswers(work, targets, [answer]);
  for (const answer of [
    CLEAN,
    ...[undefined, 'case-17', null].map((evidenceReference) => ({ ...CLEAN, evidenceReference })),
  ]) {
    assert.deepEqual(screen(answer).results, [{ anchor: work.all()[0], result: answer }]);
  }
  for (const evidenceReference of ['case-17', null]) {
    assert.throws(() => screen({ ...INCOMPLETE, evidenceReference }), { reason: 'screening-result-incomplete' });
  }
  for (const evidenceReference of ['', 7]) {
    assert.throws(() => screen({ ...INCOMPLETE, evidenceReference }), { reason: 'screening-result-malformed' });
  }
});

for (const evidenceReference of [undefined, null]) {
  test(`${String(evidenceReference)} evidence does not block a complete screening result or heartbeat`, async () => {
    const result: ScreeningResult = { ...CLEAN, evidenceReference };

    const { guardian, sent } = guardianOver(ONE_DUE, {
      screening: { screen: () => Promise.resolve([result]) },
    });
    const plan = await guardian.buildScanPlan();
    assert.ok(plan.kind === 'plan');
    const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
    const screened = await guardian.screenWork(work);
    assert.deepEqual(screened.results, [{ anchor: work.all()[0], result }]);
    assert.deepEqual(screened.suspects, []);
    assert.deepEqual(screened.flags, []);

    const outcome = await guardian.signalAndHeartbeat(screened);
    assert.ok(outcome.kind === 'attested');
    assert.deepEqual(sent.heartbeats, [{ block: work.reportBlock.hash, digest: outcome.digest }]);
  });
}

test('null evidence on an incomplete result still blocks the heartbeat as incomplete', async () => {
  await assertStops(ONE_DUE, [{ ...INCOMPLETE, evidenceReference: null }], 'screening-result-incomplete');
});

test('an incomplete result stops the attempt even beside a flag on the same target', async () => {
  await assertStops(TWO_ANCHORS, [FLAG, INCOMPLETE], 'screening-result-incomplete');
});

test('a provider that answers for fewer anchors than asked stops the attempt', async () => {
  await assertStops(TWO_ANCHORS, [FLAG], 'screening-result-missing');
});

test('a provider that answers for more anchors than asked stops the attempt', async () => {
  await assertStops(ONE_DUE, [CLEAN, CLEAN], 'screening-result-missing');
});

test('an answer of a shape nobody defined is not acted on: a status unknown, a report left out', async () => {
  const { work } = await screenOver(ONE_DUE, []);
  const targets = { pending: [{ target: TARGET, anchors: work.all() }], skipped: [] };
  const screen = (answer: unknown) => Screened.fromAnswers(work, targets, [answer]);
  assert.deepEqual(screen(SUSPECT).suspects, [TARGET]);
  assert.throws(() => screen(INCOMPLETE), { reason: 'screening-result-incomplete' });
  for (const answer of [
    { status: 'judgd', requiresSuspect: true, requiresFlag: false },
    { status: 'judged', requiresSuspect: true },
    { status: 'judged', requiresSuspect: 'yes', requiresFlag: false },
    null,
  ]) {
    assert.throws(() => screen(answer), { reason: 'screening-result-malformed' });
  }
});

test('screening reads each decision field once and ignores unrelated provider fields', async () => {
  const reads: string[] = [];
  const answer = {
    get status() {
      reads.push('status');
      return 'judged' as const;
    },
    get requiresSuspect() {
      reads.push('suspect');
      return true;
    },
    get requiresFlag() {
      reads.push('flag');
      return true;
    },
    get evidenceReference() {
      reads.push('evidence');
      return 'case-17';
    },
    get internal() {
      throw new Error('not part of the screening contract');
    },
    callback: () => undefined,
  };
  const { guardian, work } = await screenOver(ONE_DUE, [answer]);
  const screened = await guardian.screenWork(work);
  assert.deepEqual([...reads].sort(), ['evidence', 'flag', 'status', 'suspect']);
  assert.deepEqual(screened.results, [
    {
      anchor: work.all()[0],
      result: { status: 'judged', requiresSuspect: true, requiresFlag: true, evidenceReference: 'case-17' },
    },
  ]);
  assert.deepEqual(screened.suspects, [TARGET]);
  assert.deepEqual(screened.flags, [TARGET]);
  assert.equal(Object.isFrozen(answer), false);
});

test('a sparse answer array does not count as complete coverage', async () => {
  const answers: ScreeningResult[] = [];
  answers.length = 1;
  await assertStops(ONE_DUE, answers, 'screening-result-missing');
});
