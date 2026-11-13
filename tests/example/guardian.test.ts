import assert from 'node:assert/strict';
import test from 'node:test';
import { runCycle } from '../../example/guardian.ts';
import type { CycleStart } from '../../example/guardian.ts';
import { GuardianStop } from '../../src/core/index.ts';
import type { BlockRef, CycleOutcome } from '../../src/core/index.ts';
import { Work } from '../../src/core/outcomes.ts';
import { blockAt } from '../core/fake-node.ts';

const REPORT_BLOCK: BlockRef = blockAt(199_998);

const PREVIOUS_HEARTBEAT_BLOCK: BlockRef = blockAt(150_000);

const ATTESTED: CycleOutcome = {
  kind: 'attested',
  previousHeartbeatBlock: REPORT_BLOCK,
  heartbeat: `0x${'aa'.repeat(32)}`,
  digest: `0x${'bb'.repeat(32)}`,
};

/** The work a stale or incomplete attempt hands on: its plan, with no position. */
const WORK = new Work(
  {
    kind: 'plan',
    previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK,
    heartbeatTimestampAtStart: PREVIOUS_HEARTBEAT_BLOCK.timestamp,
    reportsSince: null,
    discoveryRange: { from: PREVIOUS_HEARTBEAT_BLOCK, to: REPORT_BLOCK },
  },
  new Map(),
  new Map(),
);

const STALE: CycleOutcome = { kind: 'stale', reason: 'report-block-reorged', work: WORK };

const INCOMPLETE: CycleOutcome = {
  kind: 'incomplete',
  previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK,
  incomplete: [],
  work: WORK,
};

const START: CycleStart = { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK };

/** A Guardian that answers each call with the next outcome, the last one repeated, and keeps the calls in order. */
function scripted(outcomes: readonly (CycleOutcome | Error)[], clearing?: Error) {
  const calls: string[] = [];
  const hints: (BlockRef | null | undefined)[] = [];
  const works: (Work | undefined)[] = [];
  const queue = [...outcomes];
  const guardian = {
    cycle: (previousHeartbeatBlock?: BlockRef | null, earlierWork?: Work): Promise<CycleOutcome> => {
      calls.push('cycle');
      hints.push(previousHeartbeatBlock);
      works.push(earlierWork);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      assert.ok(next !== undefined);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    clearPendingNonces: (): Promise<void> => {
      calls.push('clear');
      return clearing === undefined ? Promise.resolve() : Promise.reject(clearing);
    },
  };
  const reported: unknown[] = [];

  return { guardian, calls, hints, works, reported, onEvent: (event: unknown) => reported.push(event) };
}

test('a signal cycle clears the pending nonces first, and an attested call hands its report block on', async () => {
  const { guardian, calls, reported, onEvent } = scripted([ATTESTED]);

  const next = await runCycle({ guardian, mode: 'signal', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(calls, ['clear', 'cycle']);
  assert.deepEqual(next, { previousHeartbeatBlock: REPORT_BLOCK });
  assert.deepEqual(reported, []);
});

test('an observe cycle clears no nonces', async () => {
  const { guardian, calls, onEvent } = scripted([ATTESTED]);

  await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(calls, ['cycle']);
});

test('a stale call is replanned at once from the same hint, with the work it reconstructed', async () => {
  const { guardian, hints, works, reported, onEvent } = scripted([STALE, ATTESTED]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(hints, [PREVIOUS_HEARTBEAT_BLOCK, PREVIOUS_HEARTBEAT_BLOCK]);
  assert.deepEqual(works, [undefined, WORK]);
  assert.deepEqual(next, { previousHeartbeatBlock: REPORT_BLOCK });
  assert.deepEqual(reported, []);
});

test('a plan that stays stale ends the cycle after five replans, reported once, and keeps the hint and the work', async () => {
  const { guardian, calls, reported, onEvent } = scripted([STALE]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.equal(calls.length, 6);
  assert.deepEqual(reported, [
    { event: 'schedule.restartBudgetExhausted', restarts: 5, reason: 'report-block-reorged' },
  ]);
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
});

test('a restart budget of zero ends the cycle at the first stale plan', async () => {
  const { guardian, calls, reported, onEvent } = scripted([STALE]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 0, onEvent }, START);

  assert.equal(calls.length, 1);
  assert.deepEqual(reported, [
    { event: 'schedule.restartBudgetExhausted', restarts: 0, reason: 'report-block-reorged' },
  ]);
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
});

test('an incomplete call ends the cycle at once with its hint and work, for the next scheduled cycle', async () => {
  const { guardian, calls, reported, onEvent } = scripted([INCOMPLETE]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(calls, ['cycle']);
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
  assert.deepEqual(reported, []);
});

test('the work a cycle starts from reaches the SDK call, and a failed call hands it on with the hint', async () => {
  const { guardian, calls, works, reported, onEvent } = scripted([new GuardianStop('delegate-mismatch')]);

  const next = await runCycle({ guardian, mode: 'signal', maxRestarts: 5, onEvent }, { ...START, earlierWork: WORK });

  assert.deepEqual(calls, ['clear', 'cycle']);
  assert.deepEqual(works, [WORK]);
  assert.deepEqual(reported, [], 'the SDK reports the failed call as cycle.failed');
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
});

test('a failed call without earlier work ends the cycle with its hint alone', async () => {
  const { guardian, onEvent } = scripted([new GuardianStop('delegate-mismatch')]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(next, START);
});

test('a failed nonce clearing reports a cycle that could not start, without calling the SDK cycle', async () => {
  const failure = new Error('cancel: RPC is on another chain');
  const { guardian, calls, reported, onEvent } = scripted([ATTESTED], failure);

  const next = await runCycle({ guardian, mode: 'signal', maxRestarts: 5, onEvent }, { ...START, earlierWork: WORK });

  assert.deepEqual(calls, ['clear']);
  assert.deepEqual(reported, [{ event: 'schedule.cycleNotStarted', error: failure }]);
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
});
