import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { padHex } from 'viem';
import { forward, runCycle, toRecord } from '../../daemon/main.ts';
import type { CycleStart } from '../../daemon/main.ts';
import { HttpScreening } from '../../daemon/screening.ts';
import type { ScreeningBatchEvent } from '../../daemon/screening.ts';
import { GuardianStop } from '../../src/core/index.ts';
import type { BlockRef, CycleOutcome, SdkEvent } from '../../src/core/index.ts';
import { Work } from '../../src/core/outcomes.ts';
import { blockAt, CORE, GUARDIAN, REGISTRY } from '../core/fake-node.ts';
import type { Script } from '../core/fake-node.ts';
import { guardianOver } from '../core/setup.ts';

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

test('forward posts the record once and ignores a receiver that fails', async (context) => {
  const request = context.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('receiver down')));
  forward('http://receiver.invalid/events', '{"event":"cycle.started"}');
  // A rejection the daemon did not handle would fail this test once the fetch settles.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(request.mock.callCount(), 1);
  const [url, init] = request.mock.calls[0]?.arguments ?? [];
  assert.equal(url, 'http://receiver.invalid/events');
  assert.ok(init?.signal instanceof AbortSignal);
  const { signal: _timeout, ...options } = init;
  assert.deepEqual(options, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"event":"cycle.started"}',
  });
});

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
    /^Forwarded events: cycle\.discovered, cycle\.finished, cycle\.planned, cycle\.reconstructed, cycle\.screened, cycle\.started, rpc\.requestFinished, rpc\.requestStarted, screening-batch$/m,
  );
  assert.match(
    child.stdout,
    /^Printed events: cycle\.discovered, cycle\.finished, cycle\.planned, cycle\.reconstructed, cycle\.screened, cycle\.started, screening-batch$/m,
  );
  assert.match(child.stdout, /^\{"event":"screening-batch","anchors":1,"judged":1,"incomplete":0\}$/m);
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
    '{"event":"daemon.failed","error":{"name":"Error","message":"SCREENING_URL must be an HTTP or HTTPS URL"}}\n',
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
  [{ SCREENING_TIMEOUT_MS: '300000' }, 'SCREENING_TIMEOUT_MS must be an integer from 1 to 290000'],
  [{ HEALTH_PORT: '65536' }, 'HEALTH_PORT must be an integer from 1 to 65535'],
  [{ CYCLE_INTERVAL_MS: '600000' }, 'HEALTH_WINDOW_MS must be longer than CYCLE_INTERVAL_MS and SCREENING_TIMEOUT_MS'],
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

const REPORT_BLOCK: BlockRef = blockAt(199_998);

const PREVIOUS_HEARTBEAT_BLOCK: BlockRef = blockAt(150_000);

const ATTESTED: CycleOutcome = {
  kind: 'attested',
  previousHeartbeatBlock: REPORT_BLOCK,
  heartbeat: `0x${'aa'.repeat(32)}`,
  digest: `0x${'bb'.repeat(32)}`,
};

/** The work a stale or incomplete attempt hands on: its plan, with no position. */
const WORK = new Work(
  {
    kind: 'plan',
    previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK,
    heartbeatTimestampAtStart: PREVIOUS_HEARTBEAT_BLOCK.timestamp,
    reportsSince: null,
    discoveryRange: { from: PREVIOUS_HEARTBEAT_BLOCK, to: REPORT_BLOCK },
  },
  new Map(),
);

const STALE: CycleOutcome = { kind: 'stale', reason: 'report-block-reorged', work: WORK };

const INCOMPLETE: CycleOutcome = {
  kind: 'incomplete',
  previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK,
  incomplete: [],
  work: WORK,
};

const START: CycleStart = { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK };

/** A Guardian that answers each call with the next outcome, the last one repeated, and keeps the calls in order. */
function scripted(outcomes: readonly (CycleOutcome | Error)[], clearing?: Error) {
  const calls: string[] = [];
  const hints: (BlockRef | null | undefined)[] = [];
  const works: (Work | undefined)[] = [];
  const queue = [...outcomes];
  const guardian = {
    cycle: (previousHeartbeatBlock?: BlockRef | null, earlierWork?: Work): Promise<CycleOutcome> => {
      calls.push('cycle');
      hints.push(previousHeartbeatBlock);
      works.push(earlierWork);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      assert.ok(next !== undefined);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    clearPendingNonces: (): Promise<void> => {
      calls.push('clear');
      return clearing === undefined ? Promise.resolve() : Promise.reject(clearing);
    },
  };
  const reported: unknown[] = [];

  return { guardian, calls, hints, works, reported, onEvent: (event: unknown) => reported.push(event) };
}

test('a signal cycle clears the pending nonces first, and an attested call hands its report block on', async () => {
  const { guardian, calls, reported, onEvent } = scripted([ATTESTED]);

  const next = await runCycle({ guardian, mode: 'signal', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(calls, ['clear', 'cycle']);
  assert.deepEqual(next, { previousHeartbeatBlock: REPORT_BLOCK });
  assert.deepEqual(reported, []);
});

test('an observe cycle clears no nonces', async () => {
  const { guardian, calls, onEvent } = scripted([ATTESTED]);

  await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(calls, ['cycle']);
});

test('a stale call is replanned at once from the same hint, with the work it reconstructed', async () => {
  const { guardian, hints, works, reported, onEvent } = scripted([STALE, ATTESTED]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(hints, [PREVIOUS_HEARTBEAT_BLOCK, PREVIOUS_HEARTBEAT_BLOCK]);
  assert.deepEqual(works, [undefined, WORK]);
  assert.deepEqual(next, { previousHeartbeatBlock: REPORT_BLOCK });
  assert.deepEqual(reported, []);
});

test('a plan that stays stale ends the cycle after five replans, reported once, and keeps the hint and the work', async () => {
  const { guardian, calls, reported, onEvent } = scripted([STALE]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.equal(calls.length, 6);
  assert.deepEqual(reported, [{ event: 'restart-budget-exhausted', restarts: 5, reason: 'report-block-reorged' }]);
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
});

test('a restart budget of zero ends the cycle at the first stale plan', async () => {
  const { guardian, calls, reported, onEvent } = scripted([STALE]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 0, onEvent }, START);

  assert.equal(calls.length, 1);
  assert.deepEqual(reported, [{ event: 'restart-budget-exhausted', restarts: 0, reason: 'report-block-reorged' }]);
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
});

test('an incomplete call ends the cycle at once with its hint and work, for the next scheduled cycle', async () => {
  const { guardian, calls, reported, onEvent } = scripted([INCOMPLETE]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(calls, ['cycle']);
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
  assert.deepEqual(reported, []);
});

test('the work a cycle starts from reaches the SDK call, and a failed call hands it on with the hint', async () => {
  const { guardian, calls, works, reported, onEvent } = scripted([new GuardianStop('delegate-mismatch')]);

  const next = await runCycle({ guardian, mode: 'signal', maxRestarts: 5, onEvent }, { ...START, earlierWork: WORK });

  assert.deepEqual(calls, ['clear', 'cycle']);
  assert.deepEqual(works, [WORK]);
  assert.deepEqual(reported, [], 'the SDK reports the failed call as cycle.failed');
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
});

test('a failed call without earlier work ends the cycle with its hint alone', async () => {
  const { guardian, onEvent } = scripted([new GuardianStop('delegate-mismatch')]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, START);

  assert.deepEqual(next, START);
});

test('a failed nonce clearing reports a cycle that could not start, without calling the SDK cycle', async () => {
  const failure = new Error('cancel: RPC is on another chain');
  const { guardian, calls, reported, onEvent } = scripted([ATTESTED], failure);

  const next = await runCycle({ guardian, mode: 'signal', maxRestarts: 5, onEvent }, { ...START, earlierWork: WORK });

  assert.deepEqual(calls, ['clear']);
  assert.deepEqual(reported, [{ event: 'cycle-not-started', error: failure }]);
  assert.deepEqual(next, { previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK, earlierWork: WORK });
});

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
  const screeningEvents: ScreeningBatchEvent[] = [];
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
