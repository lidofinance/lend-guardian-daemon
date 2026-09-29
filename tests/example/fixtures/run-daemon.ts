// Run the shipped entry point in an isolated process with a scripted RPC and synthetic inputs only.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { padHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import type { ScreeningProvider } from '../../../src/core/index.ts';
import { blockAt, fakeNode } from '../../core/fake-node.ts';

const scenario = process.argv[2];
const chainId = Number(process.argv[3]);
const node = fakeNode({
  chainId,
  head: 200_000,
  guardianAddedAt: 1_000,
  delegate: privateKeyToAddress(padHex('0x02', { size: 32 })),
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
});

/** What the example has shown so far; the scripted RPC and screening fail by it. */
const seen = { startedCycles: 0, failedCycles: 0, nonceReadsAfterLastFailure: 0 };

/** The attempt whose start ends the run: the one after the last scripted failure. */
const lastAttempt = scenario === 'failed-send-then-screening' ? 3 : 2;

function failsBroadcast(): boolean {
  if (scenario === 'failed-send-then-screening') {
    return seen.startedCycles === 1;
  }
  return scenario === 'failed-send' || scenario === 'failed-clearing';
}

function rpcFailure(method: string): string | undefined {
  if (method === 'eth_sendRawTransaction' && failsBroadcast()) {
    return 'synthetic broadcast failure';
  }
  // Between a failed attempt and the next one only the clearing of pending nonces reads them.
  const isBetweenAttempts = seen.failedCycles === seen.startedCycles;
  if (method !== 'eth_getTransactionCount' || !isBetweenAttempts) {
    return undefined;
  }
  seen.nonceReadsAfterLastFailure += 1;
  return scenario === 'failed-clearing' ? 'synthetic nonce outage' : undefined;
}

// No HTTP request can leave this process, even if the example unexpectedly changes its endpoint.
globalThis.fetch = async (input, init) => {
  assert.equal(typeof init?.body, 'string');
  assert.ok(typeof init?.body === 'string');
  const body: unknown = JSON.parse(init.body);
  assert.ok(typeof body === 'object' && body !== null);
  assert.ok('id' in body && 'method' in body);
  assert.ok(typeof body.method === 'string');
  const params: unknown = 'params' in body ? body.params : [];
  assert.ok(Array.isArray(params));
  const failure = rpcFailure(body.method);
  if (failure !== undefined) {
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: failure } });
  }
  const url = input instanceof Request ? input.url : input.toString();
  // A lagging endpoint answers a log read without the logs and without an error.
  const lacksLogs = url.includes('lagging') && body.method === 'eth_getLogs';
  const result = lacksLogs ? [] : await node.transport(body.method, params);
  return Response.json({ jsonrpc: '2.0', id: body.id, result });
};

function print(...values: unknown[]): void {
  const message = values.map(String).join(' ');
  process.stdout.write(`${message}\n`);
  const [shown] = values;
  const isCycleStart =
    typeof shown === 'object' && shown !== null && 'event' in shown && shown.event === 'cycle.started';
  if (isCycleStart) {
    seen.startedCycles += 1;
  }
  if (seen.startedCycles === lastAttempt) {
    assert.deepEqual(node.sent.calls, []);
    process.stdout.write(
      `Attempt ${lastAttempt} started; nonces were read ${seen.nonceReadsAfterLastFailure} times before it.\n`,
    );
    process.exit(0);
  }
  const observed = message.startsWith('observed:');
  const incomplete = message.includes('screening-result-incomplete');
  if (scenario === 'observe' && observed) {
    assert.deepEqual(node.sent.calls, []);
    process.exit(0);
  }
  if (scenario === 'unconfigured' && incomplete) {
    assert.deepEqual(node.sent.calls, []);
    process.exit(0);
  }
  if (scenario === 'lagging-endpoint' && message.startsWith('cycle failed:')) {
    assert.deepEqual(node.sent.calls, []);
    process.exit(0);
  }
  if (message.startsWith('cycle failed:')) {
    seen.failedCycles += 1;
    seen.nonceReadsAfterLastFailure = 0;
  }
}

console.log = print;
console.error = print;

if (scenario !== 'unconfigured') {
  const screening: ScreeningProvider = {
    screen: (request) => {
      assert.equal(request.chainId, chainId);
      assert.equal(request.anchors.length, 1);
      const failsScreening = scenario === 'failed-signal' || seen.startedCycles === 2;
      if (failsScreening) {
        return Promise.reject(new Error('synthetic provider outage'));
      }
      return Promise.resolve([{ status: 'judged', requiresSuspect: false, requiresFlag: true }]);
    },
  };
  // Substitute the provider module, without an injection API in the executable example.
  mock.module('../../../example/screening-adapter.ts', {
    namedExports: { screening },
  });
}

// The example waits minutes between attempts; the scripted runs do not.
mock.module('node:timers/promises', {
  namedExports: { setTimeout: () => new Promise((resolve) => setImmediate(resolve)) },
});

// Execute the same entry point as `node example/daemon.ts`, with this fixture's scripted RPC.
process.argv[1] = fileURLToPath(new URL('../../../example/daemon.ts', import.meta.url));
await import('../../../example/daemon.ts');
