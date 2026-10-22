import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import {
  BaseError,
  createPublicClient,
  HttpRequestError,
  ResponseBodyTooLargeError,
  RpcRequestError,
  TimeoutError,
} from 'viem';
import { createViemRpcTransport } from '../../src/chain/viem-transport.ts';
import type { ViemRpcTransportOptions } from '../../src/chain/viem-transport.ts';
import { isRecord } from '../../src/common/validation.ts';
import type { RpcRequestFinishedEvent, SdkEvent } from '../../src/core/index.ts';

const URLS = ['https://first.invalid', 'https://second.invalid'] as const;
const CHAIN_ID_REQUEST = { method: 'eth_chainId' } as const;

function jsonRequest(init: RequestInit | undefined): Readonly<Record<string, unknown>> {
  const body = init?.body;
  assert.ok(typeof body === 'string');
  const decoded: unknown = JSON.parse(body);
  assert.ok(isRecord(decoded));
  return decoded;
}

function answer(init: RequestInit | undefined, result: unknown = '0x1'): Response {
  return Response.json({ jsonrpc: '2.0', id: jsonRequest(init).id, result });
}

function finished(events: readonly SdkEvent[]): RpcRequestFinishedEvent[] {
  return events.filter((event): event is RpcRequestFinishedEvent => event.event === 'rpc.requestFinished');
}

function nestedError(error: unknown, predicate: (candidate: unknown) => boolean): Error | undefined {
  const found = error instanceof BaseError ? error.walk(predicate) : error;
  return found instanceof Error && predicate(found) ? found : undefined;
}

function transportFixture(
  context: TestContext,
  fetchImplementation: typeof globalThis.fetch,
  overrides: Partial<ViemRpcTransportOptions> = {},
) {
  context.mock.method(globalThis, 'fetch', fetchImplementation);
  const events: SdkEvent[] = [];
  const transport = createViemRpcTransport({
    urls: URLS,
    timeoutMs: 100,
    retryCount: 2,
    retryDelayMs: 1,
    maxResponseBodySize: 2_048,
    userAgent: 'transport-test',
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { transport, request: transport({}).request, events };
}

test('requires at least one RPC endpoint', () => {
  assert.throws(
    () =>
      createViemRpcTransport({
        urls: [],
        timeoutMs: 100,
        retryCount: 0,
        retryDelayMs: 0,
        maxResponseBodySize: 2_048,
        userAgent: 'transport-test',
      }),
    /At least one RPC endpoint is required/,
  );
});

test('records method, endpoint, status, timing and exact transferred byte counts', async (context) => {
  let requestInit: RequestInit | undefined;
  const fixture = transportFixture(context, (_input, init) => {
    requestInit = init;
    return Promise.resolve(answer(init));
  });

  assert.equal(await fixture.request(CHAIN_ID_REQUEST), '0x1');
  const [started, completed] = fixture.events;
  assert.ok(started?.event === 'rpc.requestStarted');
  assert.ok(completed?.event === 'rpc.requestFinished');
  assert.equal(started.requestId, 1);
  assert.equal(completed.requestId, started.requestId);
  assert.ok(!('params' in started));
  assert.equal(completed.startedAt, started.startedAt);
  assert.ok(completed.finishedAt >= completed.startedAt);
  assert.equal(completed.rpcIndex, 0);
  assert.equal(completed.method, 'eth_chainId');
  assert.equal(completed.httpStatus, 200);
  assert.equal(completed.requestBytes, Buffer.byteLength(JSON.stringify(jsonRequest(requestInit))));
  assert.ok(completed.responseBytes > 0);
  assert.equal(new Headers(requestInit?.headers).get('user-agent'), 'transport-test');
});

test('records the original JSON-RPC parameters on both request events', async (context) => {
  const fixture = transportFixture(context, (_input, init) => Promise.resolve(answer(init)));
  const params = ['0x0000000000000000000000000000000000000001', 'latest'] as const;

  assert.equal(await fixture.request({ method: 'eth_getBalance', params }), '0x1');
  const [started, completed] = fixture.events;
  assert.ok(started?.event === 'rpc.requestStarted');
  assert.ok(completed?.event === 'rpc.requestFinished');
  assert.deepEqual(started.params, params);
  assert.deepEqual(completed.params, params);
});

test('moves URL credentials into Basic authorization without sending them in the target URL', async (context) => {
  let requestUrl: string | undefined;
  let requestHeaders: Headers | undefined;
  const fixture = transportFixture(
    context,
    (input, init) => {
      requestUrl = input instanceof Request ? input.url : input.toString();
      requestHeaders = new Headers(init?.headers);
      return Promise.resolve(answer(init));
    },
    { urls: ['https://guardian:p%40ss@rpc.example/path'], retryCount: 0 },
  );

  assert.equal(await fixture.request(CHAIN_ID_REQUEST), '0x1');
  assert.equal(requestUrl, 'https://rpc.example/path');
  assert.equal(requestHeaders?.get('authorization'), `Basic ${Buffer.from('guardian:p@ss').toString('base64')}`);
  assert.ok(!JSON.stringify(fixture.events).includes('p%40ss'));
});

for (const status of [401, 403, 429, 503]) {
  test(`viem falls back after HTTP ${status}`, async (context) => {
    let calls = 0;
    const fixture = transportFixture(context, (_input, init) => {
      calls += 1;
      return Promise.resolve(calls === 1 ? new Response('failure', { status }) : answer(init));
    });

    assert.equal(await fixture.request(CHAIN_ID_REQUEST), '0x1');
    assert.equal(calls, 2);
    assert.deepEqual(
      finished(fixture.events).map((event) => event.rpcIndex),
      [0, 1],
    );
  });
}

test('passes a Retry-After within the request timeout on to viem', async (context) => {
  let calls = 0;
  const fixture = transportFixture(
    context,
    (_input, init) => {
      calls += 1;
      const response =
        calls === 1 ? new Response('limited', { status: 429, headers: { 'retry-after': '1' } }) : answer(init);
      return Promise.resolve(response);
    },
    { urls: [URLS[0]], retryCount: 1, timeoutMs: 2_000 },
  );
  const startedAt = performance.now();

  assert.equal(await fixture.request(CHAIN_ID_REQUEST), '0x1');
  assert.ok(performance.now() - startedAt >= 900);
  const limited = finished(fixture.events)[0];
  assert.equal(limited?.retryAfterMs, 1_000);
  const error = nestedError(limited.error, (candidate) => candidate instanceof HttpRequestError);
  assert.ok(error instanceof HttpRequestError);
  assert.equal(error.headers?.get('retry-after'), '1');
});

test('shortens a Retry-After longer than the request timeout to it', async (context) => {
  let calls = 0;
  const fixture = transportFixture(
    context,
    (_input, init) => {
      calls += 1;
      const response =
        calls === 1 ? new Response('limited', { status: 429, headers: { 'retry-after': '3600' } }) : answer(init);
      return Promise.resolve(response);
    },
    { urls: [URLS[0]], retryCount: 1, timeoutMs: 1_000 },
  );
  const startedAt = performance.now();

  assert.equal(await fixture.request(CHAIN_ID_REQUEST), '0x1');
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 900 && elapsed < 5_000, `paused ${String(elapsed)} ms`);
  const limited = finished(fixture.events)[0];
  assert.equal(limited?.retryAfterMs, 1_000);
  const error = nestedError(limited.error, (candidate) => candidate instanceof HttpRequestError);
  assert.ok(error instanceof HttpRequestError);
  assert.equal(error.headers?.get('retry-after'), '1');
});

for (const [form, header] of [
  ['a Retry-After date', 'Wed, 21 Oct 2015 07:28:00 GMT'],
  ['a Retry-After bounded below one second', '3600'],
] as const) {
  test(`drops ${form}, so viem backs off as configured`, async (context) => {
    let calls = 0;
    const fixture = transportFixture(
      context,
      (_input, init) => {
        calls += 1;
        const limited = { status: 429, headers: { 'retry-after': header } };
        return Promise.resolve(calls === 1 ? new Response('limited', limited) : answer(init));
      },
      { urls: [URLS[0]], retryCount: 1, timeoutMs: 100 },
    );
    const startedAt = performance.now();

    assert.equal(await fixture.request(CHAIN_ID_REQUEST), '0x1');
    assert.ok(performance.now() - startedAt < 500);
    const limited = finished(fixture.events)[0];
    assert.equal(limited?.retryAfterMs, undefined);
    const error = nestedError(limited?.error, (candidate) => candidate instanceof HttpRequestError);
    assert.ok(error instanceof HttpRequestError);
    assert.equal(error.headers?.get('retry-after'), null);
  });
}

test('preserves JSON-RPC revert code and data from an HTTP error response', async (context) => {
  let calls = 0;
  const fixture = transportFixture(context, () => {
    calls += 1;
    return Promise.resolve(
      Response.json({ error: { code: 3, message: 'execution reverted', data: '0x1234' } }, { status: 400 }),
    );
  });

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    const refusal = nestedError(error, (candidate) => candidate instanceof RpcRequestError);
    return refusal instanceof RpcRequestError && refusal.code === 3 && refusal.data === '0x1234';
  });
  assert.equal(calls, 1);
  const observed = nestedError(finished(fixture.events)[0]?.error, (candidate) => candidate instanceof RpcRequestError);
  assert.ok(observed instanceof RpcRequestError);
  assert.equal(observed.code, 3);
});

test('records JSON-RPC errors returned with HTTP 200', async (context) => {
  const fixture = transportFixture(
    context,
    () => Promise.resolve(Response.json({ error: { code: -32_602, message: 'invalid params' } })),
    { urls: [URLS[0]], retryCount: 0 },
  );

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST));
  const [completed] = finished(fixture.events);
  assert.equal(completed?.httpStatus, 200);
  const refusal = nestedError(completed.error, (candidate) => candidate instanceof RpcRequestError);
  assert.ok(refusal instanceof RpcRequestError);
  assert.equal(refusal.code, -32_602);
});

test('rejects malformed JSON returned with HTTP 200', async (context) => {
  const fixture = transportFixture(context, () => Promise.resolve(new Response('{', { status: 200 })), {
    urls: [URLS[0]],
    retryCount: 0,
  });

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    const requestError = nestedError(error, (candidate) => candidate instanceof HttpRequestError);
    return requestError instanceof HttpRequestError && requestError.cause instanceof SyntaxError;
  });
});

const REVERT = { code: 3, message: 'execution reverted', data: '0x1234' };

const MALFORMED_REPLIES = [
  {
    name: 'neither a result nor an error',
    reply: { jsonrpc: '2.0', id: 1 },
    message: 'The RPC endpoint returned neither a result nor a valid error.',
  },
  {
    name: 'a null error and no result',
    reply: { jsonrpc: '2.0', id: 1, error: null },
    message: 'The RPC endpoint returned neither a result nor a valid error.',
  },
  {
    name: 'a list instead of an object',
    reply: [{ jsonrpc: '2.0', id: 1, result: '0x1' }],
    message: 'The RPC endpoint returned neither a result nor a valid error.',
  },
  {
    name: 'a text instead of an object',
    reply: 'ok',
    message: 'The RPC endpoint returned neither a result nor a valid error.',
  },
  {
    name: 'an error whose code is not a number',
    reply: { jsonrpc: '2.0', id: 1, error: { code: '3', message: 'execution reverted' } },
    message: 'The RPC endpoint returned an invalid error.',
  },
  {
    name: 'an error that is not an object',
    reply: { jsonrpc: '2.0', id: 1, error: 'rate limited' },
    message: 'The RPC endpoint returned an invalid error.',
  },
  {
    name: 'a result beside an error',
    reply: { jsonrpc: '2.0', id: 1, result: '0x1', error: REVERT },
    message: 'The RPC endpoint returned both result and error.',
  },
];

for (const { name, reply, message } of MALFORMED_REPLIES) {
  test(`rejects an HTTP 200 reply with ${name}`, async (context) => {
    const fixture = transportFixture(context, () => Promise.resolve(Response.json(reply)), {
      urls: [URLS[0]],
      retryCount: 0,
    });

    await assert.rejects(fixture.request(CHAIN_ID_REQUEST));
    const failure = nestedError(
      finished(fixture.events)[0]?.error,
      (candidate) => candidate instanceof HttpRequestError,
    );
    assert.ok(failure instanceof HttpRequestError);
    assert.ok(failure.cause instanceof TypeError);
    assert.equal(failure.cause.message, message);
  });
}

test('returns the result of a reply whose error field is null', async (context) => {
  let calls = 0;
  const fixture = transportFixture(context, () => {
    calls += 1;
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: '0x1', error: null }));
  });

  assert.equal(await fixture.request(CHAIN_ID_REQUEST), '0x1');
  assert.equal(calls, 1);
});

test('an error reply whose result field is null keeps its code and data', async (context) => {
  let calls = 0;
  const fixture = transportFixture(context, () => {
    calls += 1;
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: null, error: REVERT }));
  });

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    const refusal = nestedError(error, (candidate) => candidate instanceof RpcRequestError);
    return refusal instanceof RpcRequestError && refusal.code === 3 && refusal.data === '0x1234';
  });
  assert.equal(calls, 1);
});

test('a malformed reply to a failed HTTP request keeps the status and retry headers', async (context) => {
  const reply = { jsonrpc: '2.0', id: 1, result: '0x1', error: REVERT };
  const fixture = transportFixture(
    context,
    () => Promise.resolve(Response.json(reply, { status: 429, headers: { 'retry-after': '1' } })),
    { urls: [URLS[0]], retryCount: 0, timeoutMs: 2_000 },
  );

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST));
  const limited = finished(fixture.events)[0];
  assert.equal(limited?.retryAfterMs, 1_000);
  const failure = nestedError(limited.error, (candidate) => candidate instanceof HttpRequestError);
  assert.ok(failure instanceof HttpRequestError);
  assert.equal(failure.status, 429);
  assert.equal(failure.headers?.get('retry-after'), '1');
});

test('an observer that edits request parameters cannot change a later attempt', async (context) => {
  const sentFilters: unknown[] = [];
  const fixture = transportFixture(
    context,
    (_input, init) => {
      sentFilters.push(jsonRequest(init).params);
      const isFirstAttempt = sentFilters.length === 1;
      return Promise.resolve(isFirstAttempt ? new Response('busy', { status: 503 }) : answer(init, []));
    },
    {
      onEvent: (event) => {
        if (event.event === 'rpc.requestStarted' && Array.isArray(event.params)) {
          event.params[0] = { fromBlock: '0x3', toBlock: '0x3' };
        }
      },
    },
  );
  const params = [{ fromBlock: '0x1', toBlock: '0x3' }] as const;

  assert.deepEqual(await fixture.request({ method: 'eth_getLogs', params }), []);
  assert.deepEqual(sentFilters, [[{ fromBlock: '0x1', toBlock: '0x3' }], [{ fromBlock: '0x1', toBlock: '0x3' }]]);
  assert.deepEqual(params, [{ fromBlock: '0x1', toBlock: '0x3' }]);
});

test('rejects a JSON result carried by an unsuccessful HTTP response', async (context) => {
  const fixture = transportFixture(
    context,
    (_input, init) => Promise.resolve(new Response(JSON.stringify({ result: jsonRequest(init).id }), { status: 503 })),
    { urls: [URLS[0]], retryCount: 0 },
  );

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    return nestedError(error, (candidate) => candidate instanceof HttpRequestError) instanceof HttpRequestError;
  });
});

test('records an unsuccessful HTTP response with no body', async (context) => {
  const fixture = transportFixture(context, () => Promise.resolve(new Response(null, { status: 503 })), {
    urls: [URLS[0]],
    retryCount: 0,
  });

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    return nestedError(error, (candidate) => candidate instanceof HttpRequestError) instanceof HttpRequestError;
  });
  assert.equal(finished(fixture.events)[0]?.responseBytes, 0);
});

test('viem bounds retry rounds across endpoints', async (context) => {
  let calls = 0;
  const fixture = transportFixture(context, () => {
    calls += 1;
    return Promise.resolve(new Response('busy', { status: 503 }));
  });

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST));
  assert.equal(calls, 6);
  assert.equal(finished(fixture.events).length, 6);
});

test('viem deduplicates concurrent equivalent requests', async (context) => {
  let calls = 0;
  const fixture = transportFixture(context, async (_input, init) => {
    calls += 1;
    await sleep(5);
    return answer(init);
  });

  await Promise.all([
    fixture.request(CHAIN_ID_REQUEST, { dedupe: true }),
    fixture.request(CHAIN_ID_REQUEST, { dedupe: true }),
  ]);
  assert.equal(calls, 1);
});

test('concurrent physical attempts retain separate measurements', async (context) => {
  const fixture = transportFixture(context, async (_input, init) => {
    await sleep(5);
    return answer(init, jsonRequest(init).method);
  });

  assert.deepEqual(
    await Promise.all([fixture.request({ method: 'eth_chainId' }), fixture.request({ method: 'eth_blockNumber' })]),
    ['eth_chainId', 'eth_blockNumber'],
  );
  assert.deepEqual(
    finished(fixture.events)
      .map((event) => event.method)
      .sort(),
    ['eth_blockNumber', 'eth_chainId'],
  );
  assert.deepEqual(
    finished(fixture.events)
      .map((event) => event.requestId)
      .sort(),
    [1, 2],
  );
});

test('the fallback retains native watcher and endpoint metadata', (context) => {
  const fixture = transportFixture(context, (_input, init) => Promise.resolve(answer(init)));
  const client = createPublicClient({ transport: fixture.transport });
  const stop = client.watchBlockNumber({ onBlockNumber: () => undefined });

  stop();
  const fallbackTransports: unknown = client.transport.transports;
  assert.ok(Array.isArray(fallbackTransports));
  assert.equal(fallbackTransports.length, 2);
  assert.equal(fixture.transport.endpoints.length, 2);
});

test('viem keeps filter calls on the endpoint that created the filter', async (context) => {
  const seen: [string, unknown][] = [];
  const fixture = transportFixture(context, (input, init) => {
    const method = jsonRequest(init).method;
    const url = input instanceof Request ? input.url : input.toString();
    seen.push([url, method]);
    if (method === 'eth_newBlockFilter' && url.includes('first')) {
      return Promise.resolve(new Response('down', { status: 503 }));
    }
    return Promise.resolve(answer(init, method === 'eth_newBlockFilter' ? '0x42' : []));
  });
  const client = createPublicClient({ transport: fixture.transport });

  const filter = await client.createBlockFilter();
  await client.getFilterChanges({ filter });
  const last = seen.at(-1);
  assert.ok(last !== undefined);
  assert.ok(last[0].includes('second'));
});

test('the timeout aborts fetch before response headers arrive', async (context) => {
  let aborts = 0;
  const fixture = transportFixture(
    context,
    (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal !== undefined && signal !== null);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborts += 1;
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error('request aborted'));
          },
          { once: true },
        );
      });
    },
    { urls: [URLS[0]], timeoutMs: 10, retryCount: 0 },
  );

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    return nestedError(error, (candidate) => candidate instanceof TimeoutError) instanceof TimeoutError;
  });
  assert.equal(aborts, 1);
});

test('the timeout cancels a stalled body and remains retryable', async (context) => {
  let cancellations = 0;
  const fixture = transportFixture(
    context,
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancellations += 1;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    { urls: [URLS[0]], timeoutMs: 10 },
  );

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    return nestedError(error, (candidate) => candidate instanceof TimeoutError) instanceof TimeoutError;
  });
  await sleep(1);
  assert.equal(cancellations, 3);
  assert.equal(finished(fixture.events).length, 3);
});

test('rejects response bodies above the configured limit', async (context) => {
  const fixture = transportFixture(context, (_input, init) => Promise.resolve(answer(init, 'a'.repeat(200))), {
    maxResponseBodySize: 80,
    retryCount: 0,
  });

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    const tooLarge = nestedError(error, (candidate) => candidate instanceof ResponseBodyTooLargeError);
    return tooLarge instanceof ResponseBodyTooLargeError;
  });
});

test('rejects an oversized declared body before reading it', async (context) => {
  const fixture = transportFixture(
    context,
    () => Promise.resolve(new Response('small', { headers: { 'content-length': '200' } })),
    { urls: [URLS[0]], maxResponseBodySize: 80, retryCount: 0 },
  );

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    const tooLarge = nestedError(error, (candidate) => candidate instanceof ResponseBodyTooLargeError);
    return tooLarge instanceof ResponseBodyTooLargeError;
  });
  assert.equal(finished(fixture.events)[0]?.responseBytes, 0);
});

test('an oversized declared body is cancelled unread, so its connection is not left open', async (context) => {
  let cancellations = 0;
  const fixture = transportFixture(
    context,
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancellations += 1;
            },
          }),
          { headers: { 'content-length': '200' } },
        ),
      ),
    { urls: [URLS[0]], maxResponseBodySize: 80, retryCount: 0 },
  );

  await assert.rejects(fixture.request(CHAIN_ID_REQUEST), (error: unknown) => {
    const tooLarge = nestedError(error, (candidate) => candidate instanceof ResponseBodyTooLargeError);
    return tooLarge instanceof ResponseBodyTooLargeError;
  });
  await sleep(1);
  assert.equal(cancellations, 1);
});

test('observer failures cannot change a successful request', async (context) => {
  const fixture = transportFixture(context, (_input, init) => Promise.resolve(answer(init)), {
    onEvent: () => {
      throw new Error('observer failed');
    },
  });

  assert.equal(await fixture.request(CHAIN_ID_REQUEST), '0x1');
});

test('asynchronous observer failures cannot change a successful request', async (context) => {
  const fixture = transportFixture(context, (_input, init) => Promise.resolve(answer(init)), {
    onEvent: () => Promise.reject(new Error('observer failed asynchronously')),
  });

  assert.equal(await fixture.request(CHAIN_ID_REQUEST), '0x1');
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
});
