import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_NAMES, isRecord, isRoutine, levelOf, readEvent } from '../../monitoring/events.ts';

test('every event name the daemon emits is known, with the two events added after the first contract', () => {
  assert.ok(EVENT_NAMES.includes('nonce.checked'));
  assert.ok(EVENT_NAMES.includes('report.skipped'));
  assert.ok(EVENT_NAMES.includes('daemon.failed'));
  assert.equal(levelOf('cycle.failed'), 'error');
  assert.equal(levelOf('rpc.answersDiffer'), 'warn');
  assert.equal(levelOf('cycle.started'), 'info');
});

test('a body that is not JSON, not an object or an unknown event is rejected by reason', () => {
  assert.equal(readEvent('{'), 'json');
  assert.equal(readEvent('[1]'), 'shape');
  assert.equal(readEvent('"cycle.started"'), 'shape');
  assert.equal(readEvent('{"event":"cycle.exploded"}'), 'unknown-event');
  assert.equal(readEvent('{"cycleId":"c1"}'), 'unknown-event');
});

test('the payload keeps every field but the event name, RPC parameters and credential-named keys', () => {
  const event = readEvent(
    JSON.stringify({
      event: 'rpc.requestStarted',
      requestId: 7,
      method: 'eth_call',
      params: [{ to: '0x1' }],
      rpcIndex: 0,
      startedAt: 5,
      nested: { apiKey: 'k', authorization: 'a', kept: 1 },
    }),
  );
  assert.ok(typeof event !== 'string');
  assert.deepEqual(event.payload, {
    requestId: 7,
    method: 'eth_call',
    rpcIndex: 0,
    startedAt: 5,
    nested: { kept: 1 },
  });
});

test('URLs in any text are replaced and long messages are bounded', () => {
  const message = `node https://user:pw@rpc.example/v1/secret said ${'x'.repeat(600)}`;
  const event = readEvent(JSON.stringify({ event: 'cycle.failed', cycleId: 'c1', error: { name: 'Error', message } }));
  assert.ok(typeof event !== 'string');
  const error = event.payload.error;
  assert.ok(isRecord(error));
  const text = error.message;
  assert.ok(typeof text === 'string');
  assert.ok(text.startsWith('node [url] said xxx'));
  assert.equal(text.length, 500);
  assert.ok(text.endsWith('…'));
});

test('only RPC starts and successful RPC finishes are routine', () => {
  const started = readEvent('{"event":"rpc.requestStarted"}');
  const finished = readEvent('{"event":"rpc.requestFinished"}');
  const failed = readEvent('{"event":"rpc.requestFinished","error":{"name":"E","message":"m"}}');
  const cycle = readEvent('{"event":"cycle.started"}');
  assert.ok(typeof started !== 'string' && typeof finished !== 'string');
  assert.ok(typeof failed !== 'string' && typeof cycle !== 'string');
  assert.equal(isRoutine(started), true);
  assert.equal(isRoutine(finished), true);
  assert.equal(isRoutine(failed), false);
  assert.equal(isRoutine(cycle), false);
});
