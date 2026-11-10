import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseLevel, EVENT_NAMES, formatRecord, isRecord, isRoutine, readEvent } from '../../monitoring/events.ts';
import { parseEvent } from './helpers.ts';

test("the daemon's own records are known beside the SDK events", () => {
  for (const name of [
    'nonce.checked',
    'report.skipped',
    'schedule.cycleNotStarted',
    'schedule.restartBudgetExhausted',
    'screening.requestFinished',
    'daemon.started',
    'daemon.forwardsCounted',
  ]) {
    assert.ok(
      EVENT_NAMES.some((known) => known === name),
      name,
    );
  }
});

for (const name of ['daemon.failed', 'cycle-not-started', 'cycle.exploded']) {
  test(`an event the daemon never posts, ${name}, is refused as unknown`, () => {
    assert.deepEqual(readEvent(JSON.stringify({ event: name })), { kind: 'rejected', reason: 'unknown-event' });
  });
}

test('each record has the level of its event', () => {
  assert.equal(chooseLevel(parseEvent({ event: 'cycle.failed' })), 'error');
  assert.equal(chooseLevel(parseEvent({ event: 'schedule.cycleNotStarted' })), 'error');
  assert.equal(chooseLevel(parseEvent({ event: 'rpc.answersDiffer' })), 'warn');
  assert.equal(chooseLevel(parseEvent({ event: 'cycle.started' })), 'info');
  assert.equal(chooseLevel(parseEvent({ event: 'screening.requestFinished', anchors: 1 })), 'info');
});

test('a screening request without a usable answer is a warning', () => {
  const event = parseEvent({ event: 'screening.requestFinished', error: { name: 'TimeoutError' } });
  assert.equal(chooseLevel(event), 'warn');
});

test('a body that is not JSON is refused', () => {
  assert.deepEqual(readEvent('{'), { kind: 'rejected', reason: 'json' });
});

for (const body of ['[1]', '"cycle.started"', 'null']) {
  test(`a body that is not an object, ${body}, is refused by its shape`, () => {
    assert.deepEqual(readEvent(body), { kind: 'rejected', reason: 'shape' });
  });
}

test('an object without an event name is refused as unknown', () => {
  assert.deepEqual(readEvent('{"cycleId":"c1"}'), { kind: 'rejected', reason: 'unknown-event' });
});

test('the cycle id is read apart from the payload, and an id that is not text is none', () => {
  assert.equal(parseEvent({ event: 'cycle.started', cycleId: 'c7' }).cycleId, 'c7');
  const event = parseEvent({ event: 'cycle.started', cycleId: 7, startedAt: 1 });
  assert.equal(event.cycleId, undefined);
  assert.deepEqual(event.payload, { startedAt: 1 });
});

test('the payload keeps every field but the event name, RPC parameters and credential-named keys', () => {
  const event = parseEvent({
    event: 'rpc.requestStarted',
    requestId: 7,
    method: 'eth_call',
    params: [{ to: '0x1' }],
    rpcIndex: 0,
    startedAt: 5,
    nested: { apiKey: 'k', authorization: 'a', password: 'p', privateKey: 'q', credentials: 'c', kept: 1 },
  });
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
  const event = parseEvent({ event: 'cycle.failed', cycleId: 'c1', error: { name: 'Error', message } });
  const error = event.payload.error;
  assert.ok(isRecord(error));
  const text = error.message;
  assert.ok(typeof text === 'string');
  assert.ok(text.startsWith('node [url] said xxx'));
  assert.equal(text.length, 500);
  assert.ok(text.endsWith('…'));
});

test('only RPC starts and successful RPC finishes are routine', () => {
  assert.equal(isRoutine(parseEvent({ event: 'rpc.requestStarted' })), true);
  assert.equal(isRoutine(parseEvent({ event: 'rpc.requestFinished' })), true);
  assert.equal(isRoutine(parseEvent({ event: 'rpc.requestFinished', error: { name: 'E', message: 'm' } })), false);
  assert.equal(isRoutine(parseEvent({ event: 'cycle.started' })), false);
});

test("the receiver's own lines go through the same scrub as the event records", () => {
  const line = formatRecord({
    event: 'monitor.failed',
    level: 'error',
    error: 'cannot reach https://user:pw@host.example/path',
    config: { port: 9464, dbPassword: 'p', signerPrivateKey: 'k' },
  });
  assert.equal(line, '{"event":"monitor.failed","level":"error","error":"cannot reach [url]","config":{"port":9464}}');
});
