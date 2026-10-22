import { rpcRequest } from '../core/client.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { padHex } from 'viem';
import { cycle } from '../../example/daemon.ts';
import type { CycleStart } from '../../example/daemon.ts';
import { UnconfiguredScreening } from '../../example/screening-adapter.ts';
import { BaseRpcProvider } from '../../src/core/index.ts';
import { blockAt, CONTROLLER, CORE, fakeNode, GUARDIAN, REGISTRY } from '../core/fake-node.ts';
import type { Script } from '../core/fake-node.ts';
import { guardianOver } from '../core/setup.ts';

const DUE: Script = {
  head: 200_000,
  guardianAddedAt: 1_000,
  lots: [
    {
      kind: 'activating',
      blockNumber: 199_000,
      logIndex: 4,
      amount: 5n,
      supplied: 5n,
      position: {
        dust: 0n,
        activating: 5n,
        activatingStart: blockAt(199_000).timestamp,
        activatingDelay: 60,
      },
    },
  ],
};

const START: CycleStart = { previousHeartbeatBlock: null };

test('the example never submits or advances coverage when screening is unconfigured', async () => {
  const { guardian, sent } = guardianOver(DUE, { screening: new UnconfiguredScreening() });
  assert.equal((await cycle(guardian, START)).previousHeartbeatBlock, null);
  assert.deepEqual(sent.calls, []);
});

test('an incomplete cycle hands its work to the next one, which walks no position again', async () => {
  const { guardian, node } = guardianOver(DUE, { screening: new UnconfiguredScreening() });
  // A walk reads the controller's history of one borrower, named in a topic.
  const walks = () => node.logQueries.filter((query) => query.address === CONTROLLER && query.topics.length > 1);

  const next = await cycle(guardian, START);
  const walked = walks().length;
  assert.ok(walked > 0);
  await cycle(guardian, next);

  assert.equal(walks().length, walked);
});

test('observe runs screening through a read-only client and never signals', async (context) => {
  const node = fakeNode(DUE);
  const { guardian } = guardianOver(DUE, {
    mode: 'observe',
    client: new BaseRpcProvider({ request: rpcRequest(node.transport), maxLogBlockRange: 10_000 }),
    screening: {
      screen: (request) => {
        assert.equal(request.anchors.length, 1);
        return Promise.resolve([{ status: 'judged', requiresSuspect: true, requiresFlag: true }]);
      },
    },
  });
  const signalAndHeartbeat = context.mock.method(guardian, 'signalAndHeartbeat', () => {
    assert.fail('observe must not signal or heartbeat');
  });
  assert.equal((await cycle(guardian, START)).previousHeartbeatBlock, null);
  assert.equal(signalAndHeartbeat.mock.callCount(), 0);
  assert.deepEqual(node.sent.calls, []);
});

test('signal submits the configured provider decisions before the heartbeat', async () => {
  const { guardian, sent } = guardianOver(DUE, {
    screening: {
      screen: () => Promise.resolve([{ status: 'judged', requiresSuspect: true, requiresFlag: true }]),
    },
  });
  const { previousHeartbeatBlock } = await cycle(guardian, START);
  assert.ok(previousHeartbeatBlock !== null);
  assert.deepEqual(sent.calls, ['suspects', 'flags', 'heartbeat']);
});

test('a provider exception escapes the cycle without sending reports or heartbeat', async () => {
  const failure = new Error('screening service unavailable');
  const { guardian, sent } = guardianOver(DUE, {
    screening: { screen: () => Promise.reject(failure) },
  });
  await assert.rejects(cycle(guardian, START), (error) => error === failure);
  assert.deepEqual(sent.calls, []);
});

test('CLI rejects an unknown mode before reading configuration or reaching RPC', () => {
  const child = spawnSync(process.execPath, ['example/daemon.ts'], {
    cwd: new URL('../../', import.meta.url),
    env: { MODE: 'typo' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /MODE must be observe or signal/);
});

test('CLI rejects unsupported networks before reading RPC configuration', () => {
  const child = spawnSync(process.execPath, ['example/daemon.ts'], {
    cwd: new URL('../../', import.meta.url),
    env: { CHAIN_ID: '11155111' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /CHAIN_ID must be 1 \(mainnet\) or 560048 \(Hoodi\)/);
});

type Scenario = 'observe' | 'unconfigured' | 'lagging-endpoint' | SignalScenario;

/** Signal attempts that fail: in screening, in the broadcast, and in the recovery after it. */
type SignalScenario = 'failed-signal' | 'failed-send' | 'failed-send-then-screening' | 'failed-clearing';

const SIGNAL_SCENARIOS: readonly string[] = [
  'failed-signal',
  'failed-send',
  'failed-send-then-screening',
  'failed-clearing',
];

function runExample(scenario: Scenario, chainId?: string, rpc: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', 'tests/example/fixtures/run-daemon.ts', scenario, chainId ?? '1'],
    {
      cwd: new URL('../../', import.meta.url),
      // Deliberately do not inherit the host environment or any real credentials.
      env: {
        ...(SIGNAL_SCENARIOS.includes(scenario) ? { MODE: 'signal' } : {}),
        ...(chainId === undefined ? {} : { CHAIN_ID: chainId }),
        RPC_URLS: 'http://rpc.invalid',
        GUARDIAN,
        LIDO_LEND: CORE,
        GUARDIAN_SIGNALS: REGISTRY,
        LIDO_LEND_DEPLOYMENT_BLOCK: '1000',
        GUARDIAN_SIGNALS_DEPLOYMENT_BLOCK: '900',
        SIGNER_KEY: SIGNAL_SCENARIOS.includes(scenario) ? padHex('0x02', { size: 32 }) : 'must-not-be-read',
        ...rpc,
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

for (const chainId of [undefined, '1', '560048']) {
  test(`observe on ${chainId ?? 'default mainnet'} screens without reading signing material or sending`, () => {
    const child = runExample('observe', chainId);
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /observed: 1 screened, 0 targets already flagged, 0 suspects, 1 flags/);
    assert.match(child.stdout, /no transactions sent/);
  });
}

test('default observe leaves requested screening incomplete and stops before submission', () => {
  const child = runExample('unconfigured');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /reconstructed 1 supply anchors/);
  assert.match(child.stdout, /^incomplete: 1 anchors without a complete answer; no heartbeat$/m);
  assert.doesNotMatch(child.stdout, /attested block|observed:/);
});

test('a signal failure before sending is followed by another attempt without reading nonces', () => {
  const child = runExample('failed-signal');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /cycle failed: Error: synthetic provider outage/);
  assert.match(child.stdout, /Attempt 2 started; nonces were read 0 times before it/);
});

test('a signal failure after sending clears the pending nonces before another attempt', () => {
  const child = runExample('failed-send');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /synthetic broadcast failure/);
  assert.match(child.stdout, /Attempt 2 started; nonces were read 2 times before it/);
});

test('a failure before sending reads no nonces although an earlier attempt reached sending', () => {
  const child = runExample('failed-send-then-screening');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Attempt 3 started; nonces were read 0 times before it/);
});

test('the example ends when the pending nonces cannot be cleared', () => {
  const child = runExample('failed-clearing');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /synthetic nonce outage/);
  assert.doesNotMatch(child.stdout, /Attempt 2 started/);
});

test('observe with a log quorum screens when the endpoints return the same logs', () => {
  const rpc = { RPC_URLS: 'http://first.invalid,http://second.invalid', RPC_LOG_QUORUM: '2' };
  const child = runExample('observe', undefined, rpc);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /observed: 1 screened, 0 targets already flagged, 0 suspects, 1 flags/);
});

test('a log quorum fails the cycle when an endpoint lacks the logs of the other', () => {
  const rpc = { RPC_URLS: 'http://first.invalid,http://lagging.invalid', RPC_LOG_QUORUM: '2' };
  const child = runExample('lagging-endpoint', undefined, rpc);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /did not confirm eth_getLogs: answers-differ/);
  assert.doesNotMatch(child.stdout, /observed:/);
});

test('without a log quorum an endpoint that lacks logs is not noticed', () => {
  const rpc = { RPC_URLS: 'http://first.invalid,http://lagging.invalid' };
  const child = runExample('observe', undefined, rpc);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /observed: 1 screened/);
});

for (const [name, rpc, message] of [
  ['that is not a number', { RPC_LOG_QUORUM: 'two' }, /RPC_LOG_QUORUM is not a positive integer/],
  ['that is empty', { RPC_LOG_QUORUM: '' }, /RPC_LOG_QUORUM is not a positive integer/],
  ['of one', { RPC_LOG_QUORUM: '1' }, /logQuorum must be between 2 and 1/],
  ['above the number of endpoints', { RPC_LOG_QUORUM: '2' }, /logQuorum must be between 2 and 1/],
] as const) {
  test(`the example refuses a log quorum ${name} before reaching RPC`, () => {
    const child = runExample('observe', undefined, rpc);
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stderr, message);
  });
}
