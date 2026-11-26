import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { encodeFunctionData, parseAbi } from 'viem';
import { updateBalance } from '../../monitoring/balance.ts';
import { isRecord } from '../../monitoring/events.ts';
import { expectSample, fixture, sample } from './helpers.ts';

const DAEMON = 'lido_lend_guardian_daemon_';

const BALANCE = `${DAEMON}delegate_balance_wei`;

const READ_AT = `${DAEMON}delegate_balance_timestamp_seconds`;

const REGISTRY = '0xF46eB3bf7783825B0ffb5f532C148A261Ec518a9';

const GUARDIAN = '0xA6b2dbCCE7895347A62b4409d29bA7ce29A74655';

/** The delegate as the registry names it; the label holds it in lowercase. */
const DELEGATE = '0x60988cdae866d631e349d89dafecf02680e91107';

const LABELS = { delegate: DELEGATE };

/** The call that `GuardianSignals` answers with the Guardian's delegate. */
const GET_DELEGATE = encodeFunctionData({
  abi: parseAbi(['function getDelegate(address guardian) view returns (address)']),
  functionName: 'getDelegate',
  args: [GUARDIAN],
});

/** One scripted answer of an endpoint: its HTTP status and its body as sent. */
interface Answer {
  readonly status: number;
  readonly body: string;
}

/** The answer of an endpoint for each method; a method without one is answered with HTTP 500. */
type Script = Readonly<Partial<Record<'eth_call' | 'eth_getBalance', Answer>>>;

interface Endpoint {
  readonly url: string;
  /** The JSON bodies of the requests received, in order. */
  readonly requests: unknown[];
}

function answer(body: unknown, status = 200): Answer {
  return { status, body: JSON.stringify(body) };
}

function result(value: unknown): Answer {
  return answer({ jsonrpc: '2.0', id: 1, result: value });
}

/** An ABI-encoded address, as `eth_call` returns it. */
function word(address: string): string {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

/** An endpoint that names `DELEGATE` and answers its balance with the given quantity. */
function healthy(balance: string): Script {
  return { eth_call: result(word(DELEGATE)), eth_getBalance: result(balance) };
}

/** An RPC endpoint on a free loopback port that answers each method by the script, closed after the test. */
async function serveEndpoint(context: TestContext, script: Script): Promise<Endpoint> {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const method = isRecord(body) ? body.method : undefined;
      const scripted = method === 'eth_call' || method === 'eth_getBalance' ? script[method] : undefined;
      const sent = scripted ?? answer({}, 500);
      response.writeHead(sent.status, { 'content-type': 'application/json' }).end(sent.body);
    });
  });
  const url = await listen(server);
  context.after(() => {
    server.close();
  });
  return { url, requests };
}

/** The server's URL on a free loopback port, with a path that stands for a provider key. */
async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  return `http://127.0.0.1:${String(address.port)}/secret-provider-key`;
}

/** One read from the endpoints, on the fixture's clock. */
async function read(urls: readonly string[], base = fixture()): Promise<ReturnType<typeof fixture>> {
  await updateBalance({
    source: { registry: REGISTRY, guardian: GUARDIAN, rpcUrls: urls },
    metrics: base.metrics,
    sink: (line) => base.lines.push(line),
    clock: () => base.clock.now,
  });
  return base;
}

test('the delegate the registry names for the Guardian has its balance in the gauge, with the time of the read', async (context) => {
  // 0xde0b6b3a7640000 is 10^18 wei, one ether.
  const endpoint = await serveEndpoint(context, healthy('0xde0b6b3a7640000'));
  const { metrics, lines } = await read([endpoint.url]);
  await expectSample(metrics, BALANCE, LABELS, 1e18);
  await expectSample(metrics, READ_AT, LABELS, 1000);
  assert.deepEqual(endpoint.requests, [
    { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: REGISTRY, data: GET_DELEGATE }, 'latest'] },
    { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [DELEGATE, 'latest'] },
  ]);
  assert.deepEqual(lines, []);
});

test('an empty balance is zero, not a failed read', async (context) => {
  const endpoint = await serveEndpoint(context, healthy('0x0'));
  const { metrics, lines } = await read([endpoint.url]);
  await expectSample(metrics, BALANCE, LABELS, 0);
  assert.deepEqual(lines, []);
});

test('the next endpoint answers when the first one fails, and nothing is printed', async (context) => {
  const failing = await serveEndpoint(context, {});
  const working = await serveEndpoint(context, healthy('0x2a'));
  const { metrics, lines } = await read([failing.url, working.url]);
  await expectSample(metrics, BALANCE, LABELS, 42);
  assert.equal(failing.requests.length, 1);
  assert.deepEqual(lines, []);
});

for (const [name, script, reason] of [
  ['an HTTP error status', { eth_call: answer({}, 503) }, 'HTTP 503'],
  [
    'a JSON-RPC error',
    { eth_call: answer({ jsonrpc: '2.0', id: 1, error: { code: -32_005, message: 'limit exceeded' } }) },
    'JSON-RPC error -32005',
  ],
  ['an answer without a result', { eth_call: answer({ jsonrpc: '2.0', id: 1 }) }, 'the answer holds no result'],
  ['a call result that is no address', { eth_call: result(`0x${'f'.repeat(64)}`) }, 'the answer holds no address'],
  [
    'a registry without a delegate for the Guardian',
    { eth_call: result(word(`0x${'0'.repeat(40)}`)) },
    'the registry names no delegate for GUARDIAN',
  ],
  [
    'a balance that is no quantity',
    { eth_call: result(word(DELEGATE)), eth_getBalance: result('12') },
    'the answer holds no result',
  ],
  ['a null balance', { eth_call: result(word(DELEGATE)), eth_getBalance: result(null) }, 'the answer holds no result'],
] as const) {
  test(`${name} from every endpoint leaves the gauge unset and prints the failure`, async (context) => {
    const endpoint = await serveEndpoint(context, script);
    const { metrics, lines } = await read([endpoint.url]);
    const exposition = await metrics.render();
    assert.equal(sample(exposition, BALANCE, LABELS), undefined);
    assert.equal(sample(exposition, READ_AT, LABELS), undefined);
    assert.deepEqual(
      lines.map((line): unknown => JSON.parse(line)),
      [
        {
          event: 'monitor.balanceFailed',
          level: 'warn',
          error: `rpc-0: ${reason}`,
          message: `monitor.balanceFailed: rpc-0: ${reason}`,
        },
      ],
    );
  });
}

test('a body that is not JSON is a failed read whose record names no URL', async (context) => {
  const endpoint = await serveEndpoint(context, { eth_call: { status: 200, body: '<html>' } });
  const { metrics, lines } = await read([endpoint.url]);
  assert.equal(sample(await metrics.render(), BALANCE, LABELS), undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /"event":"monitor.balanceFailed".*rpc-0: /);
  assert.doesNotMatch(lines[0] ?? '', /127\.0\.0\.1|secret-provider-key/);
});

test('a failed read keeps the last balance and its time, so the gauge shows its age', async (context) => {
  const working = await serveEndpoint(context, healthy('0x2a'));
  const failing = await serveEndpoint(context, {});
  const base = await read([working.url]);
  base.clock.now += 60_000;
  await read([failing.url, failing.url], base);
  await expectSample(base.metrics, BALANCE, LABELS, 42);
  await expectSample(base.metrics, READ_AT, LABELS, 1000);
  const error = 'rpc-0: HTTP 500; rpc-1: HTTP 500';
  assert.deepEqual(
    base.lines.map((line): unknown => JSON.parse(line)),
    [{ event: 'monitor.balanceFailed', level: 'warn', error, message: `monitor.balanceFailed: ${error}` }],
  );
});

test('a rotated delegate replaces the series of the previous one', async (context) => {
  const rotated = `0x${'ab'.repeat(20)}`;
  const before = await serveEndpoint(context, healthy('0x2a'));
  const after = await serveEndpoint(context, { eth_call: result(word(rotated)), eth_getBalance: result('0x7') });
  const base = await read([before.url]);
  base.clock.now += 60_000;
  await read([after.url], base);
  const exposition = await base.metrics.render();
  assert.equal(sample(exposition, BALANCE, LABELS), undefined);
  assert.equal(sample(exposition, READ_AT, LABELS), undefined);
  await expectSample(base.metrics, BALANCE, { delegate: rotated }, 7);
  await expectSample(base.metrics, READ_AT, { delegate: rotated }, 1060);
});

test('an endpoint that refuses the connection is a failed read whose record names no URL', async () => {
  const closed = createServer();
  const url = await listen(closed);
  closed.close();
  await once(closed, 'close');
  const { metrics, lines } = await read([url]);
  assert.equal(sample(await metrics.render(), BALANCE, LABELS), undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /"event":"monitor.balanceFailed".*"error":"rpc-0: fetch failed \(ECONNREFUSED\)"/);
  assert.doesNotMatch(lines[0] ?? '', /127\.0\.0\.1|secret-provider-key/);
});
