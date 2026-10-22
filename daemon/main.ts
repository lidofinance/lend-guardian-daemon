// The deployable daemon: the example's Guardian and schedule with screening over HTTP, SDK events to
// the log and to an optional receiver, and a liveness endpoint. README.md in this directory describes
// its configuration, contracts and limits.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import * as env from '../example/env.ts';
import type { Setting } from '../example/env.ts';
import { createGuardian, GUARDIAN_SETTINGS, MAX_TIMER_MS, runCycles } from '../example/guardian.ts';
import type { ScheduleEvent } from '../example/guardian.ts';
import type { SdkEvent } from '../src/core/index.ts';
import {
  DEFAULT_SCREENING_BATCH_SIZE,
  DEFAULT_SCREENING_BUDGET_MS,
  DEFAULT_SCREENING_CONCURRENCY,
  HttpScreening,
  MAX_SCREENING_TIMEOUT_MS,
} from './screening.ts';
import type { ScreeningRequestFinishedEvent } from './screening.ts';

// End HTTP screening before the SDK's wait, so the last request settles before the SDK times out.
const SCREENING_SETTLE_MARGIN_MS = 10_000;

/**
 * Every numeric setting of the daemon; README.md describes them. The example's settings keep their
 * meaning and defaults, except the longer screening wait for the daemon's HTTP batches.
 */
const DAEMON_SETTINGS = {
  ...GUARDIAN_SETTINGS,
  SCREENING_TIMEOUT_MS: {
    default: DEFAULT_SCREENING_BUDGET_MS + SCREENING_SETTLE_MARGIN_MS,
    min: SCREENING_SETTLE_MARGIN_MS + 1,
    max: MAX_TIMER_MS,
  },
  SCREENING_BATCH_SIZE: { default: DEFAULT_SCREENING_BATCH_SIZE, min: 1 },
  SCREENING_CONCURRENCY: { default: DEFAULT_SCREENING_CONCURRENCY, min: 1 },
  SCREENING_REQUEST_TIMEOUT_MS: { default: MAX_SCREENING_TIMEOUT_MS, min: 1, max: MAX_SCREENING_TIMEOUT_MS },
  FORWARD_TIMEOUT_MS: { default: 5_000, min: 1, max: MAX_TIMER_MS },
  HEALTH_PORT: { default: 8_080, min: 1, max: 65_535 },
  HEALTH_WINDOW_MS: { default: 10 * 60_000, min: 1 },
} satisfies Record<string, Setting>;

const DEFAULT_RPC_USER_AGENT = 'guardian-daemon';

type DaemonEvent = SdkEvent | ScheduleEvent | ScreeningRequestFinishedEvent;

/** Any URL, which may carry an endpoint's credentials in its path or query. */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/** Schedule [scan attempts](../docs/guardian-specification.md#scan-cycle) with HTTP screening and liveness. */
async function main(): Promise<void> {
  const mode = env.mode('MODE');
  const settings = env.readSettings(DAEMON_SETTINGS);
  const eventsUrl = env.url('EVENTS_URL', { default: undefined });
  // A shorter window would mark a working daemon as stuck while it waits for a cycle or a request.
  const healthWindowMs = settings('HEALTH_WINDOW_MS');
  if (healthWindowMs <= Math.max(settings('CYCLE_INTERVAL_MS'), settings('SCREENING_REQUEST_TIMEOUT_MS'))) {
    throw new Error('HEALTH_WINDOW_MS must be longer than CYCLE_INTERVAL_MS and SCREENING_REQUEST_TIMEOUT_MS');
  }
  let lastEventAt = Date.now();
  const onEvent = (event: DaemonEvent): void => {
    lastEventAt = Date.now();
    reportEvent(event, eventsUrl, settings('FORWARD_TIMEOUT_MS'));
  };
  const screening = new HttpScreening(env.url('SCREENING_URL'), {
    batchSize: settings('SCREENING_BATCH_SIZE'),
    concurrency: settings('SCREENING_CONCURRENCY'),
    timeoutMs: settings('SCREENING_REQUEST_TIMEOUT_MS'),
    budgetMs: settings('SCREENING_TIMEOUT_MS') - SCREENING_SETTLE_MARGIN_MS,
    onEvent,
  });
  const userAgent = env.userAgent('RPC_USER_AGENT', { default: DEFAULT_RPC_USER_AGENT });
  const guardian = createGuardian({ mode, onEvent, screening, settings, userAgent });
  // Liveness for Docker or Kubernetes. The server does not keep the process alive, so an error that
  // ends the cycles also ends the process.
  createServer((_request, response) => {
    const isActive = Date.now() - lastEventAt < healthWindowMs;
    response.writeHead(isActive ? 200 : 503).end();
  })
    .listen(settings('HEALTH_PORT'))
    .unref();
  await runCycles({
    guardian,
    mode,
    cycleIntervalMs: settings('CYCLE_INTERVAL_MS'),
    maxRestarts: settings('MAX_RESTARTS_PER_CYCLE'),
    onEvent,
  });
}

/** Print and forward one event; routine RPC events go only to the optional receiver. */
export function reportEvent(event: DaemonEvent, eventsUrl: string | undefined, forwardTimeoutMs: number): void {
  const record = toRecord(event);
  const isRpcStarted = event.event === 'rpc.requestStarted';
  const isRpcSucceeded = event.event === 'rpc.requestFinished' && event.error === undefined;
  if (!isRpcStarted && !isRpcSucceeded) {
    console.log(record);
  }
  if (eventsUrl === undefined) {
    return;
  }
  // Delivery is best effort, with no queue or retries; README.md, Limitations, describes the loss.
  void fetch(eventsUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: record,
    signal: AbortSignal.timeout(forwardTimeoutMs),
  })
    // Only a read or cancelled body returns the connection to undici's pool.
    .then((response) => response.body?.cancel())
    .catch(() => {
      // The receiver answers for its own availability; delivery failures do not stop the cycle.
    });
}

/** JSON with decimal amounts, error names and messages, and URLs replaced to hide endpoint credentials. */
export function toRecord(event: object): string {
  return JSON.stringify(event, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'string') {
      return value.replace(URL_PATTERN, '[url]');
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    return value;
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    // A configuration or recovery error ends the process. An RPC error names its endpoint, so it is
    // printed through the same redaction as the events.
    console.error(toRecord({ event: 'daemon.failed', error }));
    process.exitCode = 1;
  }
}
