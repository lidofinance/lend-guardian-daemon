import assert from 'node:assert/strict';
import test from 'node:test';
import { readEvent } from '../../monitoring/events.ts';
import type { ReceivedEvent } from '../../monitoring/events.ts';
import { CYCLE_TIMEOUT_MS, cycleFinished, EVENT_TIMEOUT_MS, expectSample, fixture } from './helpers.ts';

const READY = 'lido_lend_guardian_monitor_ready';

function event(value: Record<string, unknown>): ReceivedEvent {
  const parsed = readEvent(JSON.stringify(value));
  assert.ok(typeof parsed !== 'string');
  return parsed;
}

const RPC = { event: 'rpc.requestStarted', requestId: 1, method: 'eth_call', rpcIndex: 0, startedAt: 1 };

test('not ready before the first cycle end, even while events arrive', async () => {
  const { receiver, metrics } = fixture();
  assert.equal(receiver.freshness().ready, false);
  receiver.receive(event(RPC));
  assert.equal(receiver.freshness().ready, false);
  await expectSample(metrics, READY, {}, 0);
  receiver.receive(event(cycleFinished({ kind: 'nothing-due', previousHeartbeatBlock: null, reason: 'x' })));
  assert.equal(receiver.freshness().ready, true);
  await expectSample(metrics, READY, {}, 1);
});

test('a cycle that keeps making RPC requests but never ends goes stale after the cycle window', async () => {
  const { receiver, metrics, clock } = fixture();
  receiver.receive(event(cycleFinished({ kind: 'stale', reason: 'report-block-reorged' })));
  clock.now += CYCLE_TIMEOUT_MS;
  receiver.receive(event(RPC));
  assert.equal(receiver.freshness().ready, true);
  clock.now += 1;
  receiver.receive(event(RPC));
  assert.equal(receiver.freshness().ready, false);
  await expectSample(metrics, READY, {}, 0);
  receiver.receive(
    event({ event: 'cycle.failed', cycleId: 'c2', startedAt: 1, finishedAt: 2, error: { name: 'E', message: 'm' } }),
  );
  assert.equal(receiver.freshness().ready, true);
});

test('silence after a cycle end goes stale after the event window', () => {
  const { receiver, clock } = fixture();
  receiver.receive(event(cycleFinished({ kind: 'observed', previousHeartbeatBlock: null, screened: {} })));
  clock.now += EVENT_TIMEOUT_MS;
  const fresh = receiver.freshness();
  assert.equal(fresh.ready, true);
  assert.equal(fresh.lastEventAt, 1_000_000);
  assert.equal(fresh.lastCycleEndAt, 1_000_000);
  clock.now += 1;
  assert.equal(receiver.freshness().ready, false);
});
