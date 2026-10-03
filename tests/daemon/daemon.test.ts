import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { padHex } from 'viem';
import { forward, runCycle, toRecord } from '../../daemon/main.ts';
import { GuardianStop } from '../../src/core/index.ts';
import type { BlockRef, CycleOutcome } from '../../src/core/index.ts';
import { Work } from '../../src/core/outcomes.ts';
import { blockAt, CORE, GUARDIAN, REGISTRY } from '../core/fake-node.ts';

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
    toRecord({ event: 'cycle.failed', error: new GuardianStop('screening-result-incomplete') }),
    '{"event":"cycle.failed","error":{"name":"GuardianStop","message":"screening-result-incomplete"}}',
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
    /^Forwarded events: cycle\.discovered, cycle\.finished, cycle\.planned, cycle\.reconstructed, cycle\.screened, cycle\.started, rpc\.requestFinished, rpc\.requestStarted$/m,
  );
  assert.match(
    child.stdout,
    /^Printed events: cycle\.discovered, cycle\.finished, cycle\.planned, cycle\.reconstructed, cycle\.screened, cycle\.started$/m,
  );
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

const STALE: CycleOutcome = { kind: 'stale', reason: 'report-block-reorged' };

/** A Guardian that answers each call with the next outcome, the last one repeated, and keeps the calls in order. */
function scripted(outcomes: readonly (CycleOutcome | Error)[], clearing?: Error) {
  const calls: string[] = [];
  const hints: (BlockRef | null | undefined)[] = [];
  const earlierWorks: (Work | undefined)[] = [];
  const queue = [...outcomes];
  const guardian = {
    cycle: (previousHeartbeatBlock?: BlockRef | null, earlierWork?: Work): Promise<CycleOutcome> => {
      calls.push('cycle');
      hints.push(previousHeartbeatBlock);
      earlierWorks.push(earlierWork);
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

  return { guardian, calls, hints, earlierWorks, reported, onEvent: (event: unknown) => reported.push(event) };
}

test('a signal cycle clears the pending nonces first, and an attested call hands its report block on', async () => {
  const { guardian, calls, reported, onEvent } = scripted([ATTESTED]);

  const next = await runCycle({ guardian, mode: 'signal', maxRestarts: 5, onEvent }, PREVIOUS_HEARTBEAT_BLOCK);

  assert.deepEqual(calls, ['clear', 'cycle']);
  assert.deepEqual(next, REPORT_BLOCK);
  assert.deepEqual(reported, []);
});

test('an observe cycle clears no nonces', async () => {
  const { guardian, calls, onEvent } = scripted([ATTESTED]);

  await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, PREVIOUS_HEARTBEAT_BLOCK);

  assert.deepEqual(calls, ['cycle']);
});

test('a stale call is replanned at once from the same hint', async () => {
  const { guardian, hints, reported, onEvent } = scripted([STALE, ATTESTED]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, PREVIOUS_HEARTBEAT_BLOCK);

  assert.deepEqual(hints, [PREVIOUS_HEARTBEAT_BLOCK, PREVIOUS_HEARTBEAT_BLOCK]);
  assert.deepEqual(next, REPORT_BLOCK);
  assert.deepEqual(reported, []);
});

test('a replan reuses the work of the stale attempt', async () => {
  const work = new Work(
    {
      kind: 'plan',
      previousHeartbeatBlock: PREVIOUS_HEARTBEAT_BLOCK,
      heartbeatTimestampAtStart: PREVIOUS_HEARTBEAT_BLOCK.timestamp,
      discoveryRange: { from: PREVIOUS_HEARTBEAT_BLOCK, to: REPORT_BLOCK },
    },
    new Map(),
  );
  const { guardian, earlierWorks, onEvent } = scripted([{ ...STALE, work }, ATTESTED]);

  await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, PREVIOUS_HEARTBEAT_BLOCK);

  assert.equal(earlierWorks.length, 2);
  assert.equal(earlierWorks[0], undefined);
  assert.equal(earlierWorks[1], work);
});

test('a plan that stays stale ends the cycle after five replans, reported once, and keeps the hint', async () => {
  const { guardian, calls, reported, onEvent } = scripted([STALE]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 5, onEvent }, PREVIOUS_HEARTBEAT_BLOCK);

  assert.equal(calls.length, 6);
  assert.deepEqual(reported, [{ event: 'restart-budget-exhausted', restarts: 5, reason: 'report-block-reorged' }]);
  assert.deepEqual(next, PREVIOUS_HEARTBEAT_BLOCK);
});

test('a restart budget of zero ends the cycle at the first stale plan', async () => {
  const { guardian, calls, reported, onEvent } = scripted([STALE]);

  const next = await runCycle({ guardian, mode: 'observe', maxRestarts: 0, onEvent }, PREVIOUS_HEARTBEAT_BLOCK);

  assert.equal(calls.length, 1);
  assert.deepEqual(reported, [{ event: 'restart-budget-exhausted', restarts: 0, reason: 'report-block-reorged' }]);
  assert.deepEqual(next, PREVIOUS_HEARTBEAT_BLOCK);
});

test('a failed call ends the cycle with its hint, and the daemon reports nothing of its own', async () => {
  const { guardian, calls, reported, onEvent } = scripted([new GuardianStop('delegate-mismatch')]);

  const next = await runCycle({ guardian, mode: 'signal', maxRestarts: 5, onEvent }, PREVIOUS_HEARTBEAT_BLOCK);

  assert.deepEqual(calls, ['clear', 'cycle']);
  assert.deepEqual(reported, [], 'the SDK reports the failed call as cycle.failed');
  assert.deepEqual(next, PREVIOUS_HEARTBEAT_BLOCK);
});

test('a failed nonce clearing reports a cycle that could not start, without calling the SDK cycle', async () => {
  const failure = new Error('cancel: RPC is on another chain');
  const { guardian, calls, reported, onEvent } = scripted([ATTESTED], failure);

  const next = await runCycle({ guardian, mode: 'signal', maxRestarts: 5, onEvent }, PREVIOUS_HEARTBEAT_BLOCK);

  assert.deepEqual(calls, ['clear']);
  assert.deepEqual(reported, [{ event: 'cycle-not-started', error: failure }]);
  assert.deepEqual(next, PREVIOUS_HEARTBEAT_BLOCK);
});
