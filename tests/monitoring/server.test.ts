import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_NAMES } from '../../monitoring/events.ts';
import { MAX_BODY_BYTES } from '../../monitoring/server.ts';
import { CYCLE_TIMEOUT_MS, cycleFinished, NOTHING_DUE, post, sample, serve } from './helpers.ts';
import type { Served } from './helpers.ts';

async function withServer(run: (served: Served) => Promise<void>): Promise<void> {
  const served = await serve();
  try {
    await run(served);
  } finally {
    served.close();
  }
}

test('every known event is accepted with 204 and counted by name', async () => {
  await withServer(async ({ eventsUrl, metrics }) => {
    for (const name of EVENT_NAMES) {
      assert.equal((await post(eventsUrl, { event: name })).status, 204, name);
    }
    const exposition = await metrics.render();
    for (const name of EVENT_NAMES) {
      assert.equal(sample(exposition, 'lido_lend_guardian_monitor_events_total', { event: name }), 1, name);
    }
  });
});

for (const [reason, status, send] of [
  ['method', 405, (eventsUrl: string) => fetch(`${eventsUrl}/events`)],
  ['content-type', 415, (eventsUrl: string) => post(eventsUrl, { event: 'cycle.started' }, 'text/plain')],
  [
    'body-size',
    413,
    (eventsUrl: string) => post(eventsUrl, `{"event":"cycle.started","pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`),
  ],
  ['json', 400, (eventsUrl: string) => post(eventsUrl, '{')],
  ['shape', 400, (eventsUrl: string) => post(eventsUrl, '[1]')],
  ['unknown-event', 400, (eventsUrl: string) => post(eventsUrl, { event: 'no.such.event' })],
] as const) {
  test(`a post refused for its ${reason} answers ${String(status)} and is counted without a record`, async () => {
    await withServer(async ({ eventsUrl, metrics, lines }) => {
      const response = await send(eventsUrl);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: reason });
      const rejected = 'lido_lend_guardian_monitor_rejected_events_total';
      assert.equal(sample(await metrics.render(), rejected, { reason }), 1);
      assert.equal(lines.length, 0);
    });
  });
}

test('a post with another method is told the one allowed', async () => {
  await withServer(async ({ eventsUrl }) => {
    assert.equal((await fetch(`${eventsUrl}/events`, { method: 'PUT' })).headers.get('allow'), 'POST');
  });
});

test('health is up while serving; readiness follows the daemon and names the times', async () => {
  await withServer(async ({ url, eventsUrl, clock }) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const before = await fetch(`${url}/ready`);
    assert.equal(before.status, 503);
    assert.deepEqual(await before.json(), {
      status: 'stale',
      version: 'test',
      lastEventAt: null,
      lastProgressAt: null,
    });
    clock.now = 2_000_000;
    await post(eventsUrl, cycleFinished(NOTHING_DUE));
    const after = await fetch(`${url}/ready`);
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), {
      status: 'ok',
      version: 'test',
      lastEventAt: new Date(2_000_000).toISOString(),
      lastProgressAt: new Date(2_000_000).toISOString(),
    });
  });
});

test('the exposition is served with the Prometheus content type and unknown paths are 404', async () => {
  await withServer(async ({ url, eventsUrl }) => {
    const response = await fetch(`${url}/metrics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type')?.startsWith('text/plain'), true);
    assert.match(await response.text(), /^lido_lend_guardian_monitor_ready 0$/m);
    assert.equal((await fetch(`${url}/nothing`)).status, 404);
    assert.equal((await fetch(`${eventsUrl}/nothing`)).status, 404);
  });
});

test('events are taken only on the event port, and the other endpoints are served only on the other port', async () => {
  await withServer(async ({ url, eventsUrl, metrics }) => {
    assert.equal((await post(url, { event: 'cycle.started' })).status, 404);
    for (const path of ['/metrics', '/health', '/ready']) {
      assert.equal((await fetch(`${eventsUrl}${path}`)).status, 404, path);
    }
    const exposition = await metrics.render();
    assert.equal(sample(exposition, 'lido_lend_guardian_monitor_events_total', { event: 'cycle.started' }), undefined);
  });
});

test('the event server listens on the loopback interface only', async () => {
  await withServer(({ eventServer }) => {
    const address = eventServer.address();
    assert.ok(typeof address === 'object' && address !== null);
    assert.equal(address.address, '127.0.0.1');
    return Promise.resolve();
  });
});

test('a scrape reads the ready gauge at the clock, so a lapsed window reads 0 without a probe', async () => {
  await withServer(async ({ url, eventsUrl, clock }) => {
    await post(eventsUrl, cycleFinished(NOTHING_DUE));
    assert.match(await (await fetch(`${url}/metrics`)).text(), /^lido_lend_guardian_monitor_ready 1$/m);
    clock.now += CYCLE_TIMEOUT_MS + 1;
    assert.match(await (await fetch(`${url}/metrics`)).text(), /^lido_lend_guardian_monitor_ready 0$/m);
  });
});
