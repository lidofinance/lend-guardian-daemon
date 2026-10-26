import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_NAMES } from '../../monitoring/events.ts';
import { MAX_BODY_BYTES } from '../../monitoring/server.ts';
import { cycleFinished, post, sample, serve } from './helpers.ts';
import type { Served } from './helpers.ts';

async function withServer(run: (served: Served) => Promise<void>): Promise<void> {
  const served = await serve();
  try {
    await run(served);
  } finally {
    served.server.close();
  }
}

test('every known event is accepted with 204 and counted by name', async () => {
  await withServer(async ({ url, metrics }) => {
    for (const name of EVENT_NAMES) {
      assert.equal((await post(url, { event: name })).status, 204, name);
    }
    const exposition = await metrics.render();
    for (const name of EVENT_NAMES) {
      assert.equal(sample(exposition, 'lido_lend_guardian_monitor_events_total', { event: name }), 1, name);
    }
  });
});

test('wrong method, content type, size and body are rejected without a record', async () => {
  await withServer(async ({ url, metrics, lines }) => {
    assert.equal((await fetch(`${url}/events`)).status, 405);
    assert.equal((await post(url, { event: 'cycle.started' }, 'text/plain')).status, 415);
    assert.equal((await post(url, `{"event":"cycle.started","pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`)).status, 413);
    assert.equal((await post(url, '{')).status, 400);
    assert.equal((await post(url, { event: 'no.such.event' })).status, 400);
    const exposition = await metrics.render();
    const rejected = 'lido_lend_guardian_monitor_rejected_events_total';
    assert.equal(sample(exposition, rejected, { reason: 'method' }), 1);
    assert.equal(sample(exposition, rejected, { reason: 'content-type' }), 1);
    assert.equal(sample(exposition, rejected, { reason: 'body-size' }), 1);
    assert.equal(sample(exposition, rejected, { reason: 'json' }), 1);
    assert.equal(sample(exposition, rejected, { reason: 'unknown-event' }), 1);
    assert.equal(lines.length, 0);
  });
});

test('health is up while serving; readiness follows the daemon and names the times', async () => {
  await withServer(async ({ url, clock }) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const before = await fetch(`${url}/ready`);
    assert.equal(before.status, 503);
    assert.deepEqual(await before.json(), {
      status: 'stale',
      version: 'test',
      lastEventAt: null,
      lastCycleEndAt: null,
    });
    clock.now = 2_000_000;
    await post(url, cycleFinished({ kind: 'nothing-due', previousHeartbeatBlock: null, reason: 'x' }));
    const after = await fetch(`${url}/ready`);
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), {
      status: 'ok',
      version: 'test',
      lastEventAt: new Date(2_000_000).toISOString(),
      lastCycleEndAt: new Date(2_000_000).toISOString(),
    });
  });
});

test('the exposition is served with the Prometheus content type and unknown paths are 404', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/metrics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type')?.startsWith('text/plain'), true);
    assert.match(await response.text(), /^lido_lend_guardian_monitor_ready 0$/m);
    assert.equal((await fetch(`${url}/nothing`)).status, 404);
  });
});
