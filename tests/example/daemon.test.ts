import { rpcRequest } from '../core/client.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { padHex } from 'viem';
import { cycle } from '../../example/daemon.ts';
import { UnconfiguredScreening } from '../../example/screening-adapter.ts';
import { BaseRpcProvider } from '../../src/core/index.ts';
import { blockAt, CORE, fakeNode, GUARDIAN, REGISTRY } from '../core/fake-node.ts';
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

test('the example never submits or advances coverage when screening is unconfigured', async () => {
  const { guardian, sent } = guardianOver(DUE, { screening: new UnconfiguredScreening() });
  await assert.rejects(cycle(guardian, undefined), {
    reason: 'screening-result-incomplete',
  });
  assert.deepEqual(sent.calls, []);
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
  assert.equal(await cycle(guardian, undefined), undefined);
  assert.equal(signalAndHeartbeat.mock.callCount(), 0);
  assert.deepEqual(node.sent.calls, []);
});

test('signal submits the configured provider decisions before the heartbeat', async () => {
  const { guardian, sent } = guardianOver(DUE, {
    screening: {
      screen: () => Promise.resolve([{ status: 'judged', requiresSuspect: true, requiresFlag: true }]),
    },
  });
  const cursor = await cycle(guardian, undefined);
  assert.ok(cursor !== undefined);
  assert.deepEqual(sent.calls, ['suspects', 'flags', 'heartbeat']);
});

test('a provider exception escapes the cycle without sending reports or heartbeat', async () => {
  const failure = new Error('screening service unavailable');
  const { guardian, sent } = guardianOver(DUE, {
    screening: { screen: () => Promise.reject(failure) },
  });
  await assert.rejects(cycle(guardian, undefined), (error) => error === failure);
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

function runExample(scenario: 'observe' | 'unconfigured' | 'failed-signal', chainId?: string) {
  return spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', 'tests/example/fixtures/run-daemon.ts', scenario, chainId ?? '1'],
    {
      cwd: new URL('../../', import.meta.url),
      // Deliberately do not inherit the host environment or any real credentials.
      env: {
        ...(scenario === 'failed-signal' ? { MODE: 'signal' } : {}),
        ...(chainId === undefined ? {} : { CHAIN_ID: chainId }),
        RPC_URLS: 'http://rpc.invalid',
        GUARDIAN,
        LIDO_LEND: CORE,
        GUARDIAN_SIGNALS: REGISTRY,
        LIDO_LEND_DEPLOYMENT_BLOCK: '1000',
        GUARDIAN_SIGNALS_DEPLOYMENT_BLOCK: '900',
        SIGNER_KEY: scenario === 'failed-signal' ? padHex('0x02', { size: 32 }) : 'must-not-be-read',
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
  assert.match(child.stdout, /screening-result-incomplete/);
  assert.doesNotMatch(child.stdout, /attested block|observed:/);
});

test('a signal failure stops the scheduler instead of starting another attempt', () => {
  const child = runExample('failed-signal');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stdout, /synthetic provider outage/);
  assert.match(child.stdout, /reconcile pending transactions before restarting/);
  assert.match(child.stdout, /Signal failure returned without retrying/);
});
