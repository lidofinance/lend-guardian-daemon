import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { toRecord } from '../../daemon/main.ts';
import type { DaemonEvent } from '../../daemon/main.ts';
import { Secrets } from '../../example/secrets.ts';
import { readEvent } from '../../monitoring/events.ts';
import type { ReceivedEvent } from '../../monitoring/events.ts';
import { Metrics } from '../../monitoring/metrics.ts';
import { Receiver } from '../../monitoring/receiver.ts';
import { startEventServer, startMonitoringServer } from '../../monitoring/server.ts';
import type { Address, BlockRef, Bytes32, CycleOutcome, Observed } from '../../src/core/index.ts';

export const IDENTITY = { guardian: '0xA6b2dbCCE7895347A62b4409d29bA7ce29A74655', mode: 'signal', chainId: '560048' };

export const BUILD = { version: '1.2.3', branch: 'feat/x', commit: 'abc' };

export const BLOCK: BlockRef = { number: 100, hash: `0x${'ab'.repeat(32)}`, timestamp: 1_700_000_000 };

export const HASH: Bytes32 = `0x${'cd'.repeat(32)}`;

export const ADDRESS: Address = `0x${'ef'.repeat(20)}`;

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
  /** `/metrics`, `/health` and `/ready`. */
  readonly url: string;
  /** `POST /events`. */
  readonly eventsUrl: string;
  readonly eventServer: Server;
  readonly close: () => void;
}

/** The two servers of the receiver on free ports of the loopback interface. */
export async function serve(): Promise<Served> {
  const base = fixture();
  const options = { receiver: base.receiver, metrics: base.metrics, version: 'test' };
  const eventServer = await startEventServer(0, options);
  const server = await startMonitoringServer(0, '127.0.0.1', options);
  const close = (): void => {
    eventServer.close();
    server.close();
  };
  return { ...base, eventServer, close, url: localUrl(server), eventsUrl: localUrl(eventServer) };
}

function localUrl(server: Server): string {
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  return `http://127.0.0.1:${String(address.port)}`;
}

export function post(url: string, body: unknown, contentType = 'application/json'): Promise<Response> {
  return fetch(`${url}/events`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The event the receiver reads from a body, for a body no daemon type describes; the test fails on a refusal. */
export function parseEvent(value: Readonly<Record<string, unknown>>): ReceivedEvent {
  const parsed = readEvent(JSON.stringify(value));
  assert.ok(parsed.kind === 'event', JSON.stringify(parsed));
  return parsed.event;
}

/**
 * The event the receiver reads from what the daemon posts: typed by the daemon's union and serialized by
 * its `toRecord`, so a renamed field the receiver reads fails the typecheck.
 */
export function parsePosted(event: DaemonEvent): ReceivedEvent {
  const parsed = readEvent(toRecord(event, new Secrets(new Map())));
  assert.ok(parsed.kind === 'event', JSON.stringify(parsed));
  return parsed.event;
}

/** A cycle of twelve seconds that finished at 22 seconds of Unix time. */
export function cycleFinished(outcome: Exclude<CycleOutcome, Observed>, cycleId = 'c1'): DaemonEvent {
  return { event: 'cycle.finished', cycleId, startedAt: 10_000, finishedAt: 22_000, outcome };
}

/** An observed cycle; its `screened`, which the receiver does not read, holds empty lists. */
export function observedCycle(cycleId = 'c1'): ReceivedEvent {
  const screened = { results: [], skipped: [], suspects: [], flags: [] };
  const outcome = { kind: 'observed', previousHeartbeatBlock: null, screened };
  return parseEvent({ event: 'cycle.finished', cycleId, startedAt: 10_000, finishedAt: 22_000, outcome });
}

/** A nothing-due cycle, the shortest outcome that made progress. */
export const NOTHING_DUE: Exclude<CycleOutcome, Observed> = {
  kind: 'nothing-due',
  previousHeartbeatBlock: null,
  reason: 'no-work-and-idle-heartbeat-not-due',
};
