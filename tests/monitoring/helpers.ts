import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Metrics } from '../../monitoring/metrics.ts';
import { Receiver } from '../../monitoring/receiver.ts';
import { monitoringEndpoints } from '../../monitoring/server.ts';

export const IDENTITY = { guardian: '0xA6b2dbCCE7895347A62b4409d29bA7ce29A74655', mode: 'signal', chainId: '560048' };

export const BUILD = { version: '1.2.3', branch: 'feat/x', commit: 'abc' };

export const BLOCK = { number: 100, hash: `0x${'ab'.repeat(32)}`, timestamp: 1_700_000_000 };

export const HASH = `0x${'cd'.repeat(32)}`;

export const ADDRESS = `0x${'ef'.repeat(20)}`;

export const EVENT_TIMEOUT_MS = 900_000;

export const CYCLE_TIMEOUT_MS = 3_600_000;

export interface Fixture {
  readonly metrics: Metrics;
  readonly receiver: Receiver;
  readonly lines: string[];
  readonly clock: { now: number };
}

/** A receiver on a fake clock starting at one million milliseconds, with its printed records collected. */
export function fixture(): Fixture {
  const clock = { now: 1_000_000 };
  const lines: string[] = [];
  const metrics = new Metrics(IDENTITY, BUILD);
  const receiver = new Receiver({
    metrics,
    windows: { eventTimeoutMs: EVENT_TIMEOUT_MS, cycleTimeoutMs: CYCLE_TIMEOUT_MS },
    sink: (line) => lines.push(line),
    clock: () => clock.now,
  });
  return { metrics, receiver, lines, clock };
}

/** The value of one sample in the exposition, matched by name and the given labels in any order. */
export function sample(exposition: string, name: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of exposition.split('\n')) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (match?.[1] !== name) {
      continue;
    }
    const found = parseLabels(match[2] ?? '');
    const same = Object.entries(labels).every(([key, value]) => found.get(key) === value);
    if (same && found.size === Object.keys(labels).length) {
      return Number(match[3]);
    }
  }
  return undefined;
}

function parseLabels(text: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const pair of text.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
    labels.set(pair[1] ?? '', pair[2] ?? '');
  }
  return labels;
}

export async function expectSample(
  metrics: Metrics,
  name: string,
  labels: Record<string, string>,
  value: number,
): Promise<void> {
  assert.equal(sample(await metrics.render(), name, labels), value, `${name} ${JSON.stringify(labels)}`);
}

export interface Served extends Fixture {
  readonly url: string;
  readonly server: Server;
}

export async function serve(): Promise<Served> {
  const base = fixture();
  const server = createServer(monitoringEndpoints({ receiver: base.receiver, metrics: base.metrics, version: 'test' }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  return { ...base, server, url: `http://127.0.0.1:${String(address.port)}` };
}

export function post(url: string, body: unknown, contentType = 'application/json'): Promise<Response> {
  return fetch(`${url}/events`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function cycleFinished(outcome: Record<string, unknown>, cycleId = 'c1'): Record<string, unknown> {
  return { event: 'cycle.finished', cycleId, startedAt: 10_000, finishedAt: 22_000, outcome };
}
