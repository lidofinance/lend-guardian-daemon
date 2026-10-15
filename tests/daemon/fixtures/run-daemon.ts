// Run the daemon's entry point in an isolated process with a scripted RPC, screening service and
// event receiver, and synthetic inputs only. The run ends with the first cycle's result, or, after
// a failed signal cycle, when the next cycle starts.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { padHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { blockAt, fakeNode } from '../../core/fake-node.ts';

const scenario = process.argv[2];
const node = fakeNode({
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

/** The anchor ids the screening service was asked about. */
const screenedIds: string[] = [];

/** The event names the receiver was sent. */
const forwardedEvents = new Set<string>();

/** Forwarded bodies that name the RPC endpoint, which the daemon must have replaced. */
let bodiesWithEndpoint = 0;

/** The event names the log printed. */
const printed = new Set<string>();

let startedCycles = 0;

/** Whether a call of `Guardian.cycle()` runs; outside one, only the clearing of pending nonces reads them. */
let isInCycle = false;

/** The nonce reads outside a cycle since the last one ended. */
let nonceReadsOutside = 0;

/** The nonce reads before each cycle started. */
const nonceReadsBeforeCycles: number[] = [];

type HealthHandler = (request: unknown, response: { writeHead(status: number): { end(): void } }) => void;

let health: HealthHandler | undefined;

// The liveness server is kept, not bound, so a run needs no free port.
mock.module('node:http', {
  namedExports: {
    createServer: (handler: HealthHandler) => {
      health = handler;
      return { listen: () => ({ unref: () => undefined }) };
    },
  },
});

// The daemon waits minutes between attempts; the scripted runs do not.
mock.module('node:timers/promises', {
  namedExports: { setTimeout: () => new Promise((resolve) => setImmediate(resolve)) },
});

function finish(): void {
  let healthStatus = 0;
  health?.(undefined, {
    writeHead: (status) => {
      healthStatus = status;
      return { end: () => undefined };
    },
  });
  process.stdout.write(`Screened anchors: ${screenedIds.join(', ')}\n`);
  process.stdout.write(`Forwarded events: ${[...forwardedEvents].sort().join(', ')}\n`);
  process.stdout.write(`Forwarded bodies naming an endpoint: ${bodiesWithEndpoint}\n`);
  process.stdout.write(`Printed events: ${[...printed].sort().join(', ')}\n`);
  process.stdout.write(`Nonce reads before each cycle: ${nonceReadsBeforeCycles.join(', ')}\n`);
  process.stdout.write(`Sent reports: ${node.sent.calls.join(', ')}\n`);
  process.stdout.write(`Health: ${healthStatus}\n`);
  process.exit(0);
}

/** Observe and an RPC error end with the first cycle; a signal failure ends when the next cycle starts. */
function isEnd(event: string): boolean {
  if (scenario === 'observe') {
    return event === 'cycle.finished';
  }
  if (scenario === 'rpc-error') {
    return event === 'cycle.failed';
  }
  return startedCycles === 2;
}

function screen(body: object): Response {
  assert.ok('anchors' in body && Array.isArray(body.anchors));
  const results = body.anchors.map((anchor: unknown) => {
    assert.ok(typeof anchor === 'object' && anchor !== null && 'id' in anchor);
    assert.ok(typeof anchor.id === 'string');
    screenedIds.push(anchor.id);
    return { id: anchor.id, status: 'judged', requiresSuspect: false, requiresFlag: true };
  });
  return Response.json({ results });
}

function receive(text: string, body: object): void {
  assert.ok('event' in body && typeof body.event === 'string');
  forwardedEvents.add(body.event);
  if (text.includes('rpc.invalid')) {
    bodiesWithEndpoint += 1;
  }
  if (body.event === 'cycle.started') {
    startedCycles += 1;
    isInCycle = true;
    nonceReadsBeforeCycles.push(nonceReadsOutside);
    nonceReadsOutside = 0;
  }
  const isCycleEnd = body.event === 'cycle.finished' || body.event === 'cycle.failed';
  if (isCycleEnd) {
    isInCycle = false;
  }
  if (isEnd(body.event)) {
    finish();
  }
}

function rpcError(id: unknown, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

async function answerRpc(body: object): Promise<Response> {
  assert.ok('id' in body && 'method' in body);
  assert.ok(typeof body.method === 'string');
  const params: unknown = 'params' in body ? body.params : [];
  assert.ok(Array.isArray(params));
  if (scenario === 'rpc-error' && body.method === 'eth_getLogs') {
    return rpcError(body.id, 'synthetic log outage');
  }
  if (scenario === 'failed-send' && body.method === 'eth_sendRawTransaction') {
    return rpcError(body.id, 'synthetic broadcast failure');
  }
  if (body.method === 'eth_getTransactionCount' && !isInCycle) {
    nonceReadsOutside += 1;
  }
  return Response.json({ jsonrpc: '2.0', id: body.id, result: await node.transport(body.method, params) });
}

// No HTTP request can leave this process: the RPC, the screening service and the receiver are scripted.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  assert.ok(typeof init?.body === 'string');
  const body: unknown = JSON.parse(init.body);
  assert.ok(typeof body === 'object' && body !== null);
  if (url === process.env.SCREENING_URL) {
    return screen(body);
  }
  if (url === process.env.EVENTS_URL) {
    receive(init.body, body);
    return new Response(null, { status: 204 });
  }
  return answerRpc(body);
};

console.log = (line: string) => {
  process.stdout.write(`${line}\n`);
  const record: unknown = JSON.parse(line);
  assert.ok(typeof record === 'object' && record !== null && 'event' in record);
  assert.ok(typeof record.event === 'string');
  printed.add(record.event);
};

// Execute the same entry point as `node daemon/main.ts`, with this fixture's scripted services.
process.argv[1] = fileURLToPath(new URL('../../../daemon/main.ts', import.meta.url));
await import('../../../daemon/main.ts');
