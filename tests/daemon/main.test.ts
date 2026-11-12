import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { getAddress, padHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { EventReporter, readBuildInfo, toRecord } from '../../daemon/main.ts';
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
import { readInstalledVersions } from '../lock-files.ts';
import { Secrets } from '../../example/secrets.ts';

/** A record with no secret to mask. */
const NO_SECRETS = new Secrets(new Map());

const CONFIGURATION = {
  RPC_URLS: 'http://rpc.invalid/v3/SECRET-KEY-0123456789abcdef',
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

function runDaemon(
  scenario: 'observe' | 'rpc-error' | 'busy-port' | SignalScenario,
  settings: Record<string, string> = {},
) {
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
    /^Forwarded events: cycle\.discovered, cycle\.finished, cycle\.planned, cycle\.reconstructed, cycle\.screened, cycle\.started, daemon\.forwardsCounted, daemon\.started, rpc\.requestFinished, rpc\.requestStarted, screening\.requestFinished$/m,
  );
  assert.match(
    child.stdout,
    /^Printed events: cycle\.discovered, cycle\.finished, cycle\.planned, cycle\.reconstructed, cycle\.screened, cycle\.started, daemon\.forwardsCounted, daemon\.started, screening\.requestFinished$/m,
  );
  assert.match(
    child.stdout,
    /^\{"event":"screening\.requestFinished","anchors":1,"judged":1,"incomplete":0,"startedAt":\d+,"finishedAt":\d+,"httpStatus":200\}$/m,
  );
  assert.match(child.stdout, /^Health: 200$/m);
});

test('an RPC error reaches the log and the receiver without the endpoint URL', () => {
  const child = runDaemon('rpc-error');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^\{"event":"cycle\.failed".*synthetic log outage/m);
  assert.match(child.stdout, /URL: \*\*\*/);
  // The node's JSON-RPC error code stays in the record, for the receiver's `rpc_error_code`.
  assert.match(
    child.stdout,
    /^\{"event":"rpc\.requestFinished".*"error":\{"name":"RpcRequestError",.*"code":-32000\}\}$/m,
  );
  assert.doesNotMatch(`${child.stdout}${child.stderr}`, /SECRET-KEY/);
  assert.match(child.stdout, /^Forwarded bodies naming an endpoint: 0$/m);
});

test('a configured URL is masked in records whatever its spelling', () => {
  const spellings = [
    'HTTPS://rpc.invalid/v3/SECRET-KEY-0123456789abcdef',
    'https:/rpc.invalid/v3/SECRET-KEY-0123456789abcdef',
    'https:\\\\rpc.invalid\\v3\\SECRET-KEY-0123456789abcdef',
    "https://rpc.invalid/v3/a'b/SECRET-KEY-0123456789abcdef",
    "https://rpc.invalid/rpc?label='x'&apiKey=SECRET-KEY-0123456789abcdef",
  ];
  for (const url of spellings) {
    const child = runDaemon('rpc-error', { RPC_URLS: url });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /URL: \*\*\*/, url);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /SECRET-KEY/, url);
    assert.match(child.stdout, /^Forwarded bodies naming an endpoint: 0$/m, url);
  }
});

test('every signal cycle clears the pending nonces before it starts, the one after a failed send included', () => {
  const child = runDaemon('failed-send');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^\{"event":"cycle\.failed".*synthetic broadcast failure/m);
  // Clearing reads the latest and the pending nonce, before the first cycle and before the next one.
  assert.match(child.stdout, /^Nonce reads before each cycle: 2, 2$/m);
  assert.match(child.stdout, /^Sent reports: $/m);
  // The failed cycle ends with the totals of the posts the receiver has answered so far.
  assert.match(child.stdout, /^\{"event":"daemon\.forwardsCounted","posts":\{"204":[1-9]\d*\},"durationMs":\d+\}$/m);
});

test('the daemon starts with a record of its build, deployment and settings that names no key and no URL', () => {
  const child = runDaemon('failed-send');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split('\n').find((text) => text.startsWith('{"event":"daemon.started"'));
  assert.ok(line !== undefined, child.stdout);
  const record: unknown = JSON.parse(line);
  assert.ok(isRecord(record) && isRecord(record.settings));
  const { settings, ...rest } = record;
  assert.deepEqual(rest, {
    event: 'daemon.started',
    build: { version: 'unknown', branch: 'unknown', commit: 'unknown' },
    configFile: null,
    mode: 'signal',
    chainId: 1,
    guardian: getAddress(GUARDIAN),
    lidoLend: { address: getAddress(CORE), deploymentBlock: 1000 },
    guardianSignals: { address: getAddress(REGISTRY), deploymentBlock: 900 },
    signer: privateKeyToAddress(SIGNAL.SIGNER_KEY),
    rpcUrlCount: 1,
    rpcLogQuorum: null,
    rpcUserAgent: 'lend-guardian-daemon/unknown',
    hasEventsUrl: true,
  });
  assert.equal(settings.CYCLE_INTERVAL_MS, 360_000);
  assert.equal(settings.SCREENING_TIMEOUT_MS, 1_210_000);
  assert.equal(settings.HEALTH_PORT, 8080);
  assert.doesNotMatch(line, /SECRET-KEY|rpc\.invalid|screening\.invalid|receiver\.invalid/);
  assert.ok(!line.includes(SIGNAL.SIGNER_KEY.slice(2)));
});

test('RPC_USER_AGENT follows the application name in the RPC User-Agent instead of replacing it', () => {
  const child = runDaemon('failed-send', { RPC_USER_AGENT: 'operator-17' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(
    child.stdout,
    /^\{"event":"daemon\.started".*"rpcUserAgent":"lend-guardian-daemon\/unknown operator-17"/m,
  );
});

test('a health port the daemon cannot listen on ends it through the same record as any other failure', () => {
  const child = runDaemon('busy-port');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  // The fixture's module mocks add Node's warnings to standard error; the daemon's own lines are JSON.
  assert.deepEqual(
    child.stderr.split('\n').filter((line) => line.startsWith('{')),
    [
      '{"event":"daemon.failed","error":{"name":"Error","message":"listen EADDRINUSE: address already in use :::8080"}}',
    ],
  );
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

test('a record carries amounts as decimal strings, errors as their name and message, and each secret masked', () => {
  const secrets = Secrets.read(['RPC_URLS'], { RPC_URLS: 'https://rpc.example/v3/secret-key-0123456789' });
  const error = new Error(
    'HTTP request failed.\n\nURL: https://rpc.example/v3/secret-key-0123456789\nRequest body: {}',
  );
  assert.equal(
    toRecord({ event: 'nonce.cleared', blockNumber: 12n, note: 'see http://docs.example/limits now', error }, secrets),
    JSON.stringify({
      event: 'nonce.cleared',
      blockNumber: '12',
      note: 'see http://docs.example/limits now',
      error: { name: 'Error', message: 'HTTP request failed.\n\nURL: ***\nRequest body: {}' },
    }),
  );
});

test('a record keeps the reason of a Guardian stop as its message', () => {
  assert.equal(
    toRecord({ event: 'cycle.failed', error: new GuardianStop('screening-result-malformed') }, NO_SECRETS),
    '{"event":"cycle.failed","error":{"name":"GuardianStop","message":"screening-result-malformed"}}',
  );
});

test('a record keeps the numeric code of an error, such as a JSON-RPC error code, and drops any other', () => {
  const limited = Object.assign(new Error('limit exceeded'), { code: -32005 });
  const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
  assert.equal(
    toRecord({ event: 'rpc.requestFinished', limited, refused }, NO_SECRETS),
    '{"event":"rpc.requestFinished","limited":{"name":"Error","message":"limit exceeded","code":-32005},"refused":{"name":"Error","message":"connect refused"}}',
  );
});

/** Let every settled fetch run its handlers. */
function settle(): Promise<unknown> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('reporting logs and posts the record once with the user agent and ignores a receiver that fails', async (context) => {
  const request = context.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('receiver down')));
  const log = context.mock.method(console, 'log', () => undefined);
  const reporter = new EventReporter({
    eventsUrl: 'http://receiver.invalid/events',
    timeoutMs: 5_000,
    userAgent: 'lend-guardian-daemon/test',
    secrets: NO_SECRETS,
  });
  const event = {
    event: 'screening.requestFinished',
    anchors: 2,
    judged: 1,
    incomplete: 1,
    startedAt: 1_000,
    finishedAt: 1_500,
    httpStatus: 200,
  } as const;
  reporter.report(event);
  // A rejection the daemon did not handle would fail this test once the fetch settles.
  await settle();
  const record =
    '{"event":"screening.requestFinished","anchors":2,"judged":1,"incomplete":1,"startedAt":1000,"finishedAt":1500,"httpStatus":200}';
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
    headers: { 'content-type': 'application/json', 'user-agent': 'lend-guardian-daemon/test' },
    body: record,
  });
});

test('after each cycle end the reporter posts the totals of the posts answered so far, a failed one as 0', async (context) => {
  const answers = [Promise.reject(new Error('receiver down')), Promise.resolve(new Response(null, { status: 204 }))];
  const request = context.mock.method(
    globalThis,
    'fetch',
    () => answers.shift() ?? Promise.resolve(new Response(null, { status: 503 })),
  );
  context.mock.method(console, 'log', () => undefined);
  const reporter = new EventReporter({
    eventsUrl: 'http://receiver.invalid/events',
    timeoutMs: 5_000,
    userAgent: 'test',
    secrets: NO_SECRETS,
  });
  reporter.report({ event: 'cycle.started', cycleId: 'one', startedAt: 1 });
  await settle();
  reporter.report({
    event: 'cycle.planned',
    cycleId: 'one',
    result: { kind: 'nothing-due', previousHeartbeatBlock: null, reason: 'no-work-and-idle-heartbeat-not-due' },
  });
  await settle();
  reporter.report({ event: 'schedule.cycleNotStarted', error: new Error('nonce') });
  await settle();
  const posted = request.mock.calls.map((call) => {
    const body = call.arguments[1]?.body;
    assert.ok(typeof body === 'string');
    const record: unknown = JSON.parse(body);
    assert.ok(isRecord(record));
    return record;
  });
  assert.deepEqual(
    posted.map((record) => record.event),
    ['cycle.started', 'cycle.planned', 'schedule.cycleNotStarted', 'daemon.forwardsCounted'],
  );
  const totals = posted[3];
  assert.ok(totals !== undefined);
  assert.deepEqual(totals.posts, { 0: 1, 204: 1 });
  assert.equal(typeof totals.durationMs, 'number');
});

for (const end of [
  {
    event: 'cycle.finished',
    cycleId: 'one',
    startedAt: 1,
    finishedAt: 2,
    outcome: { kind: 'stale', reason: 'report-block-reorged' },
  },
  { event: 'cycle.failed', cycleId: 'one', startedAt: 1, finishedAt: 2, error: new Error('node down') },
] as const) {
  test(`a ${end.event} is followed by the post totals, printed and posted`, async (context) => {
    const request = context.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const log = context.mock.method(console, 'log', () => undefined);
    const reporter = new EventReporter({
      eventsUrl: 'http://receiver.invalid/events',
      timeoutMs: 5_000,
      userAgent: 'test',
      secrets: NO_SECRETS,
    });
    reporter.report({ event: 'cycle.started', cycleId: 'one', startedAt: 1 });
    await settle();
    reporter.report(end);
    await settle();
    const printed = log.mock.calls.map((call) => String(call.arguments[0]));
    // The totals count the posts answered so far: the cycle's start, not its end posted just before them.
    assert.match(printed.at(-1) ?? '', /^\{"event":"daemon\.forwardsCounted","posts":\{"204":1\},"durationMs":\d+\}$/);
    const posted = request.mock.calls.map((call) => call.arguments[1]?.body);
    assert.equal(posted.length, 3);
    assert.equal(posted[2], printed.at(-1));
  });
}

test('without a receiver the reporter only prints, and reports no totals', (context) => {
  const request = context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 204 })));
  const log = context.mock.method(console, 'log', () => undefined);
  const reporter = new EventReporter({
    eventsUrl: undefined,
    timeoutMs: 5_000,
    userAgent: 'test',
    secrets: NO_SECRETS,
  });
  reporter.report({ event: 'schedule.cycleNotStarted', error: new Error('nonce') });
  assert.equal(request.mock.callCount(), 0);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [['{"event":"schedule.cycleNotStarted","error":{"name":"Error","message":"nonce"}}']],
  );
});

/** The version of each package a lock file installs, by its path under `node_modules`. */
test('the daemon image installs the dependency versions the tests run against', async () => {
  const tested = await readInstalledVersions('package-lock.json');
  const image = await readInstalledVersions('daemon/package-lock.json');
  assert.ok(image.has('node_modules/viem'), 'the image installs viem');
  for (const [path, version] of image) {
    assert.equal(version, tested.get(path), `${path} in daemon/package-lock.json`);
  }
});

const UNKNOWN_BUILD = { version: 'unknown', branch: 'unknown', commit: 'unknown' };

/** A `build-info.json` holding the text, in a directory removed after the test. */
function writeBuildInfo(context: TestContext, text: string): URL {
  const directory = mkdtempSync(join(tmpdir(), 'daemon-build-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'build-info.json');
  writeFileSync(file, text);
  return pathToFileURL(file);
}

test('build info is read from the image file', (context) => {
  const text = JSON.stringify({ version: 'dev', branch: 'feat/develop-build', commit: 'c0ffee' });
  assert.deepEqual(readBuildInfo(writeBuildInfo(context, text)), {
    version: 'dev',
    branch: 'feat/develop-build',
    commit: 'c0ffee',
  });
});

test('a build field that is empty, absent or not text reads as unknown', (context) => {
  assert.deepEqual(readBuildInfo(writeBuildInfo(context, JSON.stringify({ version: '', commit: 7 }))), UNKNOWN_BUILD);
});

test('without the build file, as in a run from a checkout, every field is unknown', (context) => {
  assert.deepEqual(readBuildInfo(new URL('missing.json', writeBuildInfo(context, '{}'))), UNKNOWN_BUILD);
});

for (const text of ['"dev"', '[1]']) {
  test(`a build file holding ${text}, not a JSON object, stops the start`, (context) => {
    assert.throws(() => readBuildInfo(writeBuildInfo(context, text)), {
      message: 'build-info.json must hold a JSON object',
    });
  });
}

test('a build file that is not JSON stops the start', (context) => {
  assert.throws(() => readBuildInfo(writeBuildInfo(context, '{')), SyntaxError);
});
