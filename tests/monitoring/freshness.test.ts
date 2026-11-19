import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BLOCK,
  CYCLE_TIMEOUT_MS,
  cycleFinished,
  EVENT_TIMEOUT_MS,
  fixture,
  HASH,
  NOTHING_DUE,
  observedCycle,
  parsePosted,
  sample,
} from './helpers.ts';
import type { DaemonEvent } from '../../daemon/main.ts';

const RPC: DaemonEvent = { event: 'rpc.requestStarted', requestId: 1, method: 'eth_call', rpcIndex: 0, startedAt: 1 };

test('not ready before the first cycle that made progress, even while events arrive', () => {
  const { receiver } = fixture();
  assert.equal(receiver.freshness().ready, false);
  receiver.receive(parsePosted(RPC));
  assert.equal(receiver.freshness().ready, false);
  receiver.receive(parsePosted(cycleFinished(NOTHING_DUE)));
  assert.equal(receiver.freshness().ready, true);
});

test('a cycle that keeps making RPC requests but never ends goes stale after the cycle window', () => {
  const { receiver, clock } = fixture();
  receiver.receive(parsePosted(cycleFinished(NOTHING_DUE)));
  clock.now += CYCLE_TIMEOUT_MS;
  receiver.receive(parsePosted(RPC));
  assert.equal(receiver.freshness().ready, true);
  clock.now += 1;
  receiver.receive(parsePosted(RPC));
  assert.equal(receiver.freshness().ready, false);
});

for (const [kind, event] of [
  [
    'attested',
    parsePosted(cycleFinished({ kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH })),
  ],
  ['observed', observedCycle()],
  ['nothing-due', parsePosted(cycleFinished(NOTHING_DUE))],
] as const) {
  test(`a cycle that ends ${kind} made progress, so the daemon is ready`, () => {
    const { receiver, clock } = fixture();
    clock.now = 2_000_000;
    receiver.receive(event);
    assert.deepEqual(receiver.freshness(), { ready: true, lastEventAt: 2_000_000, lastProgressAt: 2_000_000 });
  });
}

test('stale, incomplete and failed cycles make no progress, so they leave the daemon not ready', () => {
  const { receiver } = fixture();
  receiver.receive(parsePosted(cycleFinished({ kind: 'stale', reason: 'report-block-reorged' })));
  receiver.receive(
    parsePosted(cycleFinished({ kind: 'incomplete', previousHeartbeatBlock: null, incomplete: [] }, 'c2')),
  );
  receiver.receive(
    parsePosted({ event: 'cycle.failed', cycleId: 'c3', startedAt: 1, finishedAt: 2, error: new Error('m') }),
  );
  assert.deepEqual(receiver.freshness(), { ready: false, lastEventAt: 1_000_000, lastProgressAt: null });
});

test('silence after a cycle that made progress goes stale after the event window', () => {
  const { receiver, clock } = fixture();
  receiver.receive(observedCycle());
  clock.now += EVENT_TIMEOUT_MS;
  assert.deepEqual(receiver.freshness(), { ready: true, lastEventAt: 1_000_000, lastProgressAt: 1_000_000 });
  clock.now += 1;
  assert.equal(receiver.freshness().ready, false);
});

test('reading the freshness leaves the ready gauge to the scrape', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(parsePosted(cycleFinished(NOTHING_DUE)));
  assert.equal(receiver.freshness().ready, true);
  assert.equal(sample(await metrics.render(), 'lido_lend_guardian_monitor_ready'), 0);
});
