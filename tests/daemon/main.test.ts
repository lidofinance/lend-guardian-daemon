import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { padHex } from 'viem';
import { reportEvent, toRecord } from '../../daemon/main.ts';
import { HttpScreening } from '../../daemon/screening.ts';
import type { ScreeningRequestFinishedEvent } from '../../daemon/screening.ts';
import { runCycle } from '../../example/guardian.ts';
import type { CycleStart } from '../../example/guardian.ts';
import { isRecord } from '../../src/common/validation.ts';
import { GuardianStop } from '../../src/core/index.ts';
import type { SdkEvent } from '../../src/core/index.ts';
import { blockAt, CORE, GUARDIAN, REGISTRY } from '../core/fake-node.ts';
import type { Script } from '../core/fake-node.ts';
import { guardianOver } from '../core/setup.ts';

const CONFIGURATION = {
  RPC_URLS: 'http://rpc.invalid/v3/SECRET-KEY',
  GUARDIAN,
  LIDO_LEND: CORE,
  LIDO_LEND_DEPLOYMENT_BLOCK: '1000',
  GUARDIAN_SIGNALS: REGISTRY,
  GUARDIAN_SIGNALS_DEPLOYMENT_BLOCK: '900',
  SCREENING_URL: 'http://screening.invalid/screen',
  EVENTS_URL: 'http://receiver.invalid/events',
  SIGNER_KEY: 'must-not-be-read',
};

/** A signal cycle whose broadcast fails. */
type SignalScenario = 'failed-send';

/** The delegate's key; the scripted registry names its address as the Guardian's delegate. */
const SIGNAL = { MODE: 'signal', SIGNER_KEY: padHex('0x02', { size: 32 }) };

function runDaemon(scenario: 'observe' | 'rpc-error' | SignalScenario, settings: Record<string, string> = {}) {
  const isSignal = scenario === 'failed-send';
  return spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', 'tests/daemon/fixtures/run-daemon.ts', scenario],
    {
      cwd: new URL('../../', import.meta.url),
      // Deliberately do not inherit the host environment or any real credentials.
      env: { ...CONFIGURATION, ...(isSignal ? SIGNAL : {}), ...settings },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

test('an observe cycle screens over HTTP, prints its events and forwards every event', () => {
  const child = runDaemon('observe');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^\{"event":"cycle\.finished".*"outcome":\{"kind":"observed"/m);
  // The supply log follows its controller's classification, which the script places at index 4.
  const anchorId = new RegExp(`^Screened anchors: ${blockAt(199_000).hash}:0x[0-9a-f]{64}:5$`, 'm');
  assert.match(child.stdout, anchorId);
  assert.match(
    child.stdout,
    /^Forwarded events: cycle\.discovered, cycle\.finished, cycle\.planned, cycle\.reconstructed, cycle\.screened, cycle\.started, rpc\.requestFinished, rpc\.requestStarted, screening\.requestFinished$/m,
  );
  assert.match(
    child.stdout,
    /^Printed events: cycle\.discovered, cycle\.finished, cycle\.planned, cycle\.reconstructed, cycle\.screened, cycle\.started, screening\.requestFinished$/m,
  );
  assert.match(child.stdout, /^\{"event":"screening\.requestFinished","anchors":1,"judged":1,"incomplete":0\}$/m);
  assert.match(child.stdout, /^Health: 200$/m);
});

test('an RPC error reaches the log and the receiver without the endpoint URL', () => {
  const child = runDaemon('rpc-error');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^\{"event":"cycle\.failed".*synthetic log outage/m);
  assert.match(child.stdout, /URL: \[url\]/);
  assert.doesNotMatch(`${child.stdout}${child.stderr}`, /SECRET-KEY/);
  assert.match(child.stdout, /^Forwarded bodies naming an endpoint: 0$/m);
});

test('every signal cycle clears the pending nonces before it starts, the one after a failed send included', () => {
  const child = runDaemon('failed-send');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^\{"event":"cycle\.failed".*synthetic broadcast failure/m);
  // Clearing reads the latest and the pending nonce, before the first cycle and before the next one.
  assert.match(child.stdout, /^Nonce reads before each cycle: 2, 2$/m);
  assert.match(child.stdout, /^Sent reports: $/m);
});

test('the daemon refuses to start without a screening service URL', () => {
  const { SCREENING_URL: _unset, ...withoutScreening } = CONFIGURATION;
  const child = spawnSync(process.execPath, ['daemon/main.ts'], {
    cwd: new URL('../../', import.meta.url),
    env: withoutScreening,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(
    child.stderr,
    '{"event":"daemon.failed","error":{"name":"Error","message":"SCREENING_URL is not set"}}\n',
  );
});

test('a setting from the environment replaces its default', () => {
  const child = runDaemon('observe', { REPORT_BLOCK_LAG: '3' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  // The scripted head is block 200,000; the default lag of two would report block 199,998.
  assert.match(child.stdout, /^\{"event":"cycle\.screened","cycleId":"[^"]+","reportBlock":\{"number":199997,/m);
});

for (const [settings, message] of [
  [{ MAX_LOG_BLOCK_RANGE: 'wide' }, 'MAX_LOG_BLOCK_RANGE must be an integer of at least 1'],
  [{ REPORT_BLOCK_LAG: '0' }, 'REPORT_BLOCK_LAG must be an integer of at least 1'],
  [{ RPC_RETRY_COUNT: '' }, 'RPC_RETRY_COUNT must be an integer of at least 0'],
  [{ MAX_FEE_PER_GAS_WEI: '1e11' }, 'MAX_FEE_PER_GAS_WEI must be an integer of at least 1'],
  [{ SCREENING_REQUEST_TIMEOUT_MS: '300000' }, 'SCREENING_REQUEST_TIMEOUT_MS must be an integer from 1 to 290000'],
  [{ SCREENING_TIMEOUT_MS: '10000' }, 'SCREENING_TIMEOUT_MS must be an integer from 10001 to 2147483647'],
  [{ HEALTH_PORT: '65536' }, 'HEALTH_PORT must be an integer from 1 to 65535'],
  [
    { CYCLE_INTERVAL_MS: '600000' },
    'HEALTH_WINDOW_MS must be longer than CYCLE_INTERVAL_MS and SCREENING_REQUEST_TIMEOUT_MS',
  ],
] as const) {
  test(`the daemon refuses ${Object.keys(settings).join(', ')} out of its range before any RPC request`, () => {
    const child = spawnSync(process.execPath, ['daemon/main.ts'], {
      cwd: new URL('../../', import.meta.url),
      env: { ...CONFIGURATION, ...settings },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stderr, `{"event":"daemon.failed","error":{"name":"Error","message":"${message}"}}\n`);
  });
}

for (const [name, value, message] of [
  ['EVENTS_URL', 'ftp://receiver.invalid/events', 'EVENTS_URL must be an HTTP or HTTPS URL'],
  ['RPC_USER_AGENT', 'guardian\ndaemon', 'RPC_USER_AGENT must be nonempty text that an HTTP header can carry'],
  ['RPC_USER_AGENT', '', 'RPC_USER_AGENT must be nonempty text that an HTTP header can carry'],
] as const) {
  test(`the daemon refuses ${name}=${JSON.stringify(value)} before any RPC request`, () => {
    const child = spawnSync(process.execPath, ['daemon/main.ts'], {
      cwd: new URL('../../', import.meta.url),
      env: { ...CONFIGURATION, [name]: value },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stderr, `{"event":"daemon.failed","error":{"name":"Error","message":"${message}"}}\n`);
  });
}

const HEAD = 200_000;

const DAY = 24 * 60 * 60;

/** One due position with two anchors: the supply of its dust and the supply that activated it. */
const TWO_ANCHORS: Script = {
  head: HEAD,
  guardianAddedAt: 1_000,
  lots: [
    {
      kind: 'dusted',
      blockNumber: 90_000,
      logIndex: 2,
      amount: 3n,
      position: { dust: 3n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
      supplied: 3n,
    },
    {
      kind: 'activating',
      blockNumber: 100_000,
      logIndex: 4,
      amount: 8n,
      position: { dust: 0n, activating: 8n, activatingStart: blockAt(100_000).timestamp, activatingDelay: DAY },
      supplied: 5n,
    },
  ],
};

/** The ids a posted screening request asks about. */
function askedIds(body: unknown): string[] {
  assert.ok(typeof body === 'string');
  const posted: unknown = JSON.parse(body);
  assert.ok(typeof posted === 'object' && posted !== null && 'anchors' in posted && Array.isArray(posted.anchors));
  return posted.anchors.map((anchor: unknown) => {
    assert.ok(typeof anchor === 'object' && anchor !== null && 'id' in anchor && typeof anchor.id === 'string');
    return anchor.id;
  });
}

/** A request the service never answers; the adapter's timeout aborts it. */
function neverAnswered(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    });
  });
}

/** The answer of an unreliable service to each request in turn, the last one repeated. */
const UNRELIABLE_SERVICE: readonly ((
  ids: readonly string[],
  signal: AbortSignal | null | undefined,
) => Promise<Response>)[] = [
  // The first anchor is a suspect; the service has not finished the other.
  (ids) =>
    Promise.resolve(
      Response.json({
        results: ids.map((id, index) =>
          index === 0
            ? { id, status: 'judged', requiresSuspect: true, requiresFlag: false }
            : { id, status: 'incomplete' },
        ),
      }),
    ),
  (_ids, signal) => neverAnswered(signal),
  () => Promise.resolve(Response.json({}, { status: 503 })),
  (ids) =>
    Promise.resolve(
      Response.json({
        results: ids.map((id) => ({ id, status: 'judged', requiresSuspect: false, requiresFlag: false })),
      }),
    ),
];

/** Serve the unreliable service and keep the ids of every request. */
function serveUnreliably(context: TestContext): string[][] {
  const requests: string[][] = [];
  context.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => {
    const ids = askedIds(init.body);
    requests.push(ids);
    const answer = UNRELIABLE_SERVICE[requests.length - 1] ?? UNRELIABLE_SERVICE.at(-1);
    assert.ok(answer !== undefined);
    return answer(ids, init.signal);
  });
  return requests;
}

test('scheduled cycles reach the heartbeat through a service that answers incomplete, hangs and fails, asking each anchor until judged', async (context) => {
  const requests = serveUnreliably(context);
  const screeningEvents: ScreeningRequestFinishedEvent[] = [];
  const screening = new HttpScreening('http://screening.invalid/screen', {
    timeoutMs: 10,
    onEvent: (event) => screeningEvents.push(event),
  });
  const outcomes: string[] = [];
  const onEvent = (event: SdkEvent): void => {
    if (event.event === 'cycle.finished') {
      outcomes.push(event.outcome.kind);
    }
  };
  const { guardian, node, sent } = guardianOver(TWO_ANCHORS, { screening, onEvent });
  const deps = { guardian, mode: 'signal' as const, maxRestarts: 5, onEvent: () => undefined };

  let start: CycleStart = { previousHeartbeatBlock: null };
  start = await runCycle(deps, start);
  // The suspect the first cycle sent is recorded, and the chain moved on past the confirmation depth.
  assert.deepEqual(sent.calls, ['suspects']);
  node.setSuspectedBy([{ guardian: GUARDIAN, reportedAt: blockAt(HEAD).timestamp }]);
  node.advanceTo(HEAD + 30);
  start = await runCycle(deps, start);
  start = await runCycle(deps, start);
  start = await runCycle(deps, start);

  assert.deepEqual(outcomes, ['incomplete', 'incomplete', 'incomplete', 'attested']);
  // The judged anchor is never asked about again; the other is asked until the service judges it.
  const [firstRequest] = requests;
  assert.ok(firstRequest !== undefined);
  assert.equal(firstRequest.length, 2);
  assert.deepEqual(requests.slice(1), [firstRequest.slice(1), firstRequest.slice(1), firstRequest.slice(1)]);
  assert.deepEqual(
    screeningEvents.map((event) => (event.error instanceof Error ? event.error.name : event.incomplete)),
    [1, 'TimeoutError', 'Error', 0],
  );
  // The suspect is kept, not sent again, and the heartbeat follows the last answer.
  assert.deepEqual(sent.calls, ['suspects', 'heartbeat']);
  assert.equal(start.earlierWork, undefined);
  assert.equal(start.previousHeartbeatBlock?.number, HEAD + 30 - 2);
});

test('a record carries amounts as decimal strings and errors as their name and message without URLs', () => {
  const error = new Error('HTTP request failed.\n\nURL: https://rpc.example/v3/secret-key?token=1\nRequest body: {}');
  assert.equal(
    toRecord({ event: 'nonce.cleared', blockNumber: 12n, note: 'see http://host.example/key now', error }),
    JSON.stringify({
      event: 'nonce.cleared',
      blockNumber: '12',
      note: 'see [url] now',
      error: { name: 'Error', message: 'HTTP request failed.\n\nURL: [url]\nRequest body: {}' },
    }),
  );
});

test('a record keeps the reason of a Guardian stop as its message', () => {
  assert.equal(
    toRecord({ event: 'cycle.failed', error: new GuardianStop('screening-result-malformed') }),
    '{"event":"cycle.failed","error":{"name":"GuardianStop","message":"screening-result-malformed"}}',
  );
});

test('reporting logs and posts the record once and ignores a receiver that fails', async (context) => {
  const request = context.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('receiver down')));
  const log = context.mock.method(console, 'log', () => undefined);
  reportEvent(
    { event: 'screening.requestFinished', anchors: 2, judged: 1, incomplete: 1 },
    'http://receiver.invalid/events',
    5_000,
  );
  // A rejection the daemon did not handle would fail this test once the fetch settles.
  await new Promise((resolve) => setImmediate(resolve));
  const record = '{"event":"screening.requestFinished","anchors":2,"judged":1,"incomplete":1}';
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [[record]],
  );
  assert.equal(request.mock.callCount(), 1);
  const [url, init] = request.mock.calls[0]?.arguments ?? [];
  assert.equal(url, 'http://receiver.invalid/events');
  assert.ok(init?.signal instanceof AbortSignal);
  const { signal: _timeout, ...options } = init;
  assert.deepEqual(options, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: record,
  });
});

/** The version of each package a lock file installs, by its path under `node_modules`. */
async function readInstalledVersions(lockPath: string): Promise<Map<string, unknown>> {
  const lock: unknown = JSON.parse(await readFile(new URL(`../../${lockPath}`, import.meta.url), 'utf8'));
  const packages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
  return new Map(
    Object.entries(packages)
      .filter(([path]) => path.startsWith('node_modules/'))
      .map(([path, entry]) => [path, isRecord(entry) ? entry.version : undefined]),
  );
}

test('the daemon image installs the dependency versions the tests run against', async () => {
  const tested = await readInstalledVersions('package-lock.json');
  const image = await readInstalledVersions('daemon/package-lock.json');
  assert.ok(image.has('node_modules/viem'), 'the image installs viem');
  for (const [path, version] of image) {
    assert.equal(version, tested.get(path), `${path} in daemon/package-lock.json`);
  }
});
