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
  const url = input instanceof Request ? input.url : input.toString();
  // A lagging endpoint answers a log read without the logs and without an error.
  const lacksLogs = url.includes('lagging') && body.method === 'eth_getLogs';
  const result = lacksLogs ? [] : await node.transport(body.method, params);
  return Response.json({ jsonrpc: '2.0', id: body.id, result });
};

function print(...values: unknown[]): void {
  const message = values.map(String).join(' ');
  process.stdout.write(`${message}\n`);
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
}

console.log = print;
console.error = print;

if (scenario !== 'unconfigured') {
  const screening: ScreeningProvider = {
    screen: (request) => {
      assert.equal(request.chainId, chainId);
      assert.equal(request.anchors.length, 1);
      if (scenario === 'failed-signal') {
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

// Execute the same entry point as `node example/daemon.ts`, with this fixture's scripted RPC.
process.argv[1] = fileURLToPath(new URL('../../../example/daemon.ts', import.meta.url));
await import('../../../example/daemon.ts');
if (scenario === 'failed-signal') {
  assert.equal(process.exitCode, 1);
  assert.deepEqual(node.sent.calls, []);
  process.stdout.write('Signal failure returned without retrying.\n');
}
