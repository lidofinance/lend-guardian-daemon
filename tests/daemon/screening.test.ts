import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { padHex } from 'viem';
import { HttpScreening } from '../../daemon/screening.ts';
import type { ScreeningRequestFinishedEvent } from '../../daemon/screening.ts';
import type { ScreeningRequest, SupplyAnchor } from '../../src/core/index.ts';
import { blockAt } from '../core/fake-node.ts';
import type { Lot, Script } from '../core/fake-node.ts';
import { guardianOver } from '../core/setup.ts';

const SCREENING_URL = 'http://screening.invalid/screen';

const FIRST: SupplyAnchor = {
  core: '0x00000000000000000000000000000000000000bb',
  blockHash: padHex('0xb1', { size: 32 }),
  transactionHash: padHex('0xa1', { size: 32 }),
  logIndex: 4,
  marketId: padHex('0x01', { size: 32 }),
  borrower: '0x00000000000000000000000000000000000000ee',
};

/** A second supply in the same transaction, for another borrower. */
const SECOND: SupplyAnchor = { ...FIRST, logIndex: 5, borrower: '0x00000000000000000000000000000000000000ef' };

const FIRST_ID = `${padHex('0xb1', { size: 32 })}:${padHex('0xa1', { size: 32 })}:4`;

const SECOND_ID = `${padHex('0xb1', { size: 32 })}:${padHex('0xa1', { size: 32 })}:5`;

/** A supply in another transaction, for a third borrower. */
const THIRD: SupplyAnchor = {
  ...FIRST,
  transactionHash: padHex('0xa3', { size: 32 }),
  logIndex: 0,
  borrower: '0x00000000000000000000000000000000000000f0',
};

const THIRD_ID = `${padHex('0xb1', { size: 32 })}:${padHex('0xa3', { size: 32 })}:0`;

const REQUEST: ScreeningRequest = {
  chainId: 1,
  reportBlock: { number: 100, hash: padHex('0x64', { size: 32 }), timestamp: 1_700_000_000 },
  anchors: [FIRST, SECOND],
};

/** Answer every request with the status and body given, and keep what was posted. */
function serve(context: TestContext, status: number, body: unknown): { url: string; body: unknown }[] {
  const requests: { url: string; body: unknown }[] = [];
  context.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    assert.ok(typeof init.body === 'string');
    requests.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve(Response.json(body, { status }));
  });
  return requests;
}

/** A judged result for the anchor id. */
function judged(id: string): Record<string, unknown> {
  return { id, status: 'judged', requiresSuspect: false, requiresFlag: true };
}

/** The ids a posted request asks about. */
function askedIds(body: string): string[] {
  const posted: unknown = JSON.parse(body);
  assert.ok(typeof posted === 'object' && posted !== null && 'anchors' in posted && Array.isArray(posted.anchors));
  return posted.anchors.map((anchor: unknown) => {
    assert.ok(typeof anchor === 'object' && anchor !== null && 'id' in anchor && typeof anchor.id === 'string');
    return anchor.id;
  });
}

/** Answer each request from `answer`, given the ids it asks about, and keep the ids of every request. */
function serveEach(context: TestContext, answer: (ids: string[], request: number) => Response): string[][] {
  const requests: string[][] = [];
  context.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => {
    assert.ok(typeof init.body === 'string');
    const ids = askedIds(init.body);
    requests.push(ids);
    return Promise.resolve(answer(ids, requests.length));
  });
  return requests;
}

test('screening posts every anchor with its id and returns the results in request order', async (context) => {
  const results = [
    { id: FIRST_ID, status: 'judged', requiresSuspect: false, requiresFlag: true, evidenceReference: 'case-1' },
    { id: SECOND_ID, status: 'incomplete', evidenceReference: null },
  ];
  const requests = serve(context, 200, { results });
  assert.deepEqual(await new HttpScreening(SCREENING_URL).screen(REQUEST), results);
  assert.deepEqual(requests, [
    {
      url: SCREENING_URL,
      body: {
        chainId: 1,
        reportBlock: { number: 100, hash: padHex('0x64', { size: 32 }), timestamp: 1_700_000_000 },
        anchors: [
          { id: FIRST_ID, ...FIRST },
          { id: SECOND_ID, ...SECOND },
        ],
      },
    },
  ]);
});

const INCOMPLETE_FIRST = { id: FIRST_ID, status: 'incomplete' };

const INCOMPLETE_SECOND = { id: SECOND_ID, status: 'incomplete' };

for (const [name, status, body, message] of [
  [
    'an error status',
    503,
    { results: [INCOMPLETE_FIRST, INCOMPLETE_SECOND] },
    'Screening service answered with HTTP 503',
  ],
  ['a body without a results list', 200, { decisions: [] }, 'Screening response has no results list'],
  ['a result left out', 200, { results: [INCOMPLETE_FIRST] }, 'Screening response has 1 results for 2 anchors'],
  [
    'results in another order',
    200,
    { results: [INCOMPLETE_SECOND, INCOMPLETE_FIRST] },
    `Screening response does not answer anchor ${FIRST_ID} at its position`,
  ],
  [
    'a result without the anchor id',
    200,
    { results: [{ status: 'incomplete' }, INCOMPLETE_SECOND] },
    `Screening response does not answer anchor ${FIRST_ID} at its position`,
  ],
  [
    'a judged result without both decisions',
    200,
    { results: [{ id: FIRST_ID, status: 'judged', requiresSuspect: true }, INCOMPLETE_SECOND] },
    `Screening response has a malformed result for anchor ${FIRST_ID}`,
  ],
  [
    'an unknown status',
    200,
    { results: [{ id: FIRST_ID, status: 'clean' }, INCOMPLETE_SECOND] },
    `Screening response has a malformed result for anchor ${FIRST_ID}`,
  ],
  [
    'an evidence reference that is not text',
    200,
    { results: [INCOMPLETE_FIRST, { id: SECOND_ID, status: 'incomplete', evidenceReference: 7 }] },
    `Screening response has a malformed result for anchor ${SECOND_ID}`,
  ],
] as const) {
  test(`screening leaves the anchors of a request incomplete after ${name}, and reports why`, async (context) => {
    serve(context, status, body);
    context.mock.timers.enable({ apis: ['Date'], now: 1_000 });
    const events: ScreeningRequestFinishedEvent[] = [];
    const screening = new HttpScreening(SCREENING_URL, { onEvent: (event) => events.push(event) });

    const results = await screening.screen(REQUEST);

    assert.deepEqual(results, [{ status: 'incomplete' }, { status: 'incomplete' }]);
    const [event] = events;
    assert.ok(event !== undefined);
    assert.ok(event.error instanceof Error);
    assert.equal(event.error.message, message);
    const { error: _cause, ...counts } = event;
    assert.deepEqual(counts, {
      event: 'screening.requestFinished',
      anchors: 2,
      judged: 0,
      incomplete: 2,
      startedAt: 1_000,
      finishedAt: 1_000,
      httpStatus: status,
    });
  });
}

test('the body of an error status is cancelled, so its connection returns to the pool', async (context) => {
  let isCancelled = false;
  const body = new ReadableStream({
    cancel: () => {
      isCancelled = true;
    },
  });
  context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(body, { status: 503 })));

  const results = await new HttpScreening(SCREENING_URL).screen(REQUEST);

  assert.deepEqual(results, [{ status: 'incomplete' }, { status: 'incomplete' }]);
  assert.equal(isCancelled, true);
});

test('anchors are posted in batches of batchSize, and the results keep request order', async (context) => {
  const requests = serveEach(context, (ids) => Response.json({ results: ids.map(judged) }));
  context.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const events: ScreeningRequestFinishedEvent[] = [];
  const screening = new HttpScreening(SCREENING_URL, { batchSize: 1, onEvent: (event) => events.push(event) });

  const results = await screening.screen(REQUEST);

  assert.deepEqual(requests, [[FIRST_ID], [SECOND_ID]]);
  assert.deepEqual(results, [judged(FIRST_ID), judged(SECOND_ID)]);
  const finished = {
    event: 'screening.requestFinished',
    anchors: 1,
    judged: 1,
    incomplete: 0,
    startedAt: 1_000,
    finishedAt: 1_000,
    httpStatus: 200,
  };
  assert.deepEqual(events, [finished, finished]);
});

test('a request that fails leaves only its own anchors incomplete', async (context) => {
  const requests = serveEach(context, (ids, request) =>
    request === 1 ? Response.json({ results: ids.map(judged) }) : Response.json({}, { status: 503 }),
  );
  const events: ScreeningRequestFinishedEvent[] = [];
  const screening = new HttpScreening(SCREENING_URL, { batchSize: 1, onEvent: (event) => events.push(event) });

  const results = await screening.screen(REQUEST);

  assert.equal(requests.length, 2);
  assert.deepEqual(results, [judged(FIRST_ID), { status: 'incomplete' }]);
  assert.deepEqual(
    events.map((event) => event.incomplete),
    [0, 1],
  );
});

test('an observer that throws changes neither the judged answers nor the incomplete ones', async (context) => {
  serveEach(context, (ids, request) =>
    request === 1 ? Response.json({ results: ids.map(judged) }) : Response.json({}, { status: 503 }),
  );
  const screening = new HttpScreening(SCREENING_URL, {
    batchSize: 1,
    onEvent: () => {
      throw new Error('observer failure');
    },
  });

  const results = await screening.screen(REQUEST);

  assert.deepEqual(results, [judged(FIRST_ID), { status: 'incomplete' }]);
});

test('an observer whose promise rejects changes neither the answers nor leaves the rejection unhandled', async (context) => {
  serveEach(context, (ids, request) =>
    request === 1 ? Response.json({ results: ids.map(judged) }) : Response.json({}, { status: 503 }),
  );
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const screening = new HttpScreening(SCREENING_URL, {
    batchSize: 1,
    onEvent: () => Promise.reject(new Error('observer failure')),
  });

  process.on('unhandledRejection', recordUnhandled);
  try {
    const results = await screening.screen(REQUEST);
    // Node reports an unhandled rejection once the microtasks after it have run.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    assert.deepEqual(results, [judged(FIRST_ID), { status: 'incomplete' }]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
});

test('a request that outlasts timeoutMs leaves its anchors incomplete, reported with the timeout', async (context) => {
  context.mock.method(
    globalThis,
    'fetch',
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
      }),
  );
  const events: ScreeningRequestFinishedEvent[] = [];
  const screening = new HttpScreening(SCREENING_URL, { timeoutMs: 10, onEvent: (event) => events.push(event) });

  const results = await screening.screen(REQUEST);

  assert.deepEqual(results, [{ status: 'incomplete' }, { status: 'incomplete' }]);
  assert.ok(events[0]?.error instanceof Error);
  assert.equal(events[0].error.name, 'TimeoutError');
  // No answer arrived, so the event has no status.
  assert.equal('httpStatus' in events[0], false);
});

test('every request carries the user agent it is given', async (context) => {
  const request = context.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json({ results: [judged(FIRST_ID), judged(SECOND_ID)] })),
  );
  await new HttpScreening(SCREENING_URL, { userAgent: 'lend-guardian-daemon/test', timeoutMs: 5_000 }).screen(REQUEST);
  assert.deepEqual(request.mock.calls[0]?.arguments[1]?.headers, {
    'content-type': 'application/json',
    'user-agent': 'lend-guardian-daemon/test',
    'x-request-timeout-ms': '5000',
  });
});

test('each request names its wait: timeoutMs, or the rest of the budget when that ends first', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const request = context.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json({ results: [judged(FIRST_ID), judged(SECOND_ID)] })),
  );
  await new HttpScreening(SCREENING_URL, { timeoutMs: 5_000, budgetMs: 60_000 }).screen(REQUEST);
  await new HttpScreening(SCREENING_URL, { timeoutMs: 5_000, budgetMs: 3_000 }).screen(REQUEST);
  assert.deepEqual(
    request.mock.calls.map((call) => call.arguments[1]?.headers),
    [
      { 'content-type': 'application/json', 'x-request-timeout-ms': '5000' },
      { 'content-type': 'application/json', 'x-request-timeout-ms': '3000' },
    ],
  );
});

test('a judged answer is kept for the next screening, which asks only about the other anchors', async (context) => {
  const requests = serveEach(context, (ids, request) =>
    Response.json({
      results: ids.map((id) => (request === 1 && id === SECOND_ID ? { id, status: 'incomplete' } : judged(id))),
    }),
  );
  const screening = new HttpScreening(SCREENING_URL);

  const first = await screening.screen(REQUEST);
  const second = await screening.screen(REQUEST);

  assert.deepEqual(first, [judged(FIRST_ID), { id: SECOND_ID, status: 'incomplete' }]);
  assert.deepEqual(second, [judged(FIRST_ID), judged(SECOND_ID)]);
  assert.deepEqual(requests, [[FIRST_ID, SECOND_ID], [SECOND_ID]]);
});

test('a screening with every anchor judged already posts nothing', async (context) => {
  const requests = serveEach(context, (ids) => Response.json({ results: ids.map(judged) }));
  const screening = new HttpScreening(SCREENING_URL);

  await screening.screen(REQUEST);
  const again = await screening.screen(REQUEST);

  assert.deepEqual(again, [judged(FIRST_ID), judged(SECOND_ID)]);
  assert.deepEqual(requests, [[FIRST_ID, SECOND_ID]]);
});

test('the answer for an anchor the request no longer holds is dropped, and the anchor is asked about when it returns', async (context) => {
  const requests = serveEach(context, (ids) => Response.json({ results: ids.map(judged) }));
  const screening = new HttpScreening(SCREENING_URL);

  await screening.screen(REQUEST);
  await screening.screen({ ...REQUEST, anchors: [FIRST] });
  await screening.screen(REQUEST);

  assert.deepEqual(requests, [[FIRST_ID, SECOND_ID], [SECOND_ID]]);
});

test('the budget running out leaves the remaining anchors incomplete without a request', async (context) => {
  const requests = serveEach(context, (ids) => Response.json({ results: ids.map(judged) }));
  const events: ScreeningRequestFinishedEvent[] = [];
  const screening = new HttpScreening(SCREENING_URL, { budgetMs: 0, onEvent: (event) => events.push(event) });

  const results = await screening.screen(REQUEST);

  assert.deepEqual(requests, []);
  assert.deepEqual(results, [{ status: 'incomplete' }, { status: 'incomplete' }]);
  assert.deepEqual(events, []);
});

/** Let the event loop turn until `condition` holds, or stop after a hundred turns. */
async function waitUntil(condition: () => boolean): Promise<void> {
  let turns = 0;
  while (!condition() && turns < 100) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    turns += 1;
  }
}

test('up to concurrency requests are open at once, and the next batch is posted as soon as one of them ends', async (context) => {
  const open: { readonly ids: string[]; readonly answer: () => void }[] = [];
  context.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => {
    assert.ok(typeof init.body === 'string');
    const ids = askedIds(init.body);
    return new Promise<Response>((resolve) => {
      open.push({
        ids,
        answer: () => {
          resolve(Response.json({ results: ids.map(judged) }));
        },
      });
    });
  });
  const screening = new HttpScreening(SCREENING_URL, { batchSize: 1, concurrency: 2 });

  const screened = screening.screen({ ...REQUEST, anchors: [FIRST, SECOND, THIRD] });
  await waitUntil(() => open.length > 2);
  assert.deepEqual(
    open.map((request) => request.ids),
    [[FIRST_ID], [SECOND_ID]],
  );
  open[1]?.answer();
  await waitUntil(() => open.length > 2);
  assert.deepEqual(
    open.map((request) => request.ids),
    [[FIRST_ID], [SECOND_ID], [THIRD_ID]],
  );
  open[0]?.answer();
  open[2]?.answer();

  assert.deepEqual(await screened, [judged(FIRST_ID), judged(SECOND_ID), judged(THIRD_ID)]);
});

test('the budget ends every request open at once', async (context) => {
  context.mock.method(
    globalThis,
    'fetch',
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
      }),
  );
  const events: ScreeningRequestFinishedEvent[] = [];
  const screening = new HttpScreening(SCREENING_URL, {
    batchSize: 1,
    concurrency: 2,
    budgetMs: 20,
    onEvent: (event) => events.push(event),
  });

  const results = await screening.screen(REQUEST);

  assert.deepEqual(results, [{ status: 'incomplete' }, { status: 'incomplete' }]);
  assert.deepEqual(
    events.map((event) => (event.error instanceof Error ? event.error.name : 'no error')),
    ['TimeoutError', 'TimeoutError'],
  );
});

/** A lot of `activating` after a supply of `amount` at `blockNumber`, due a minute later. */
function lotAt(blockNumber: number, amount: bigint, activating: bigint): Lot {
  return {
    kind: 'activating',
    blockNumber,
    logIndex: 4,
    amount,
    supplied: amount,
    position: { dust: 0n, activating, activatingStart: blockAt(blockNumber).timestamp, activatingDelay: 60 },
  };
}

/** One supply due at the report block of a node at block 200,000. */
const ONE_DUE: Script = { head: 200_000, guardianAddedAt: 1_000, lots: [lotAt(199_000, 5n, 5n)] };

/** Two supplies of one borrower due at that report block: a lot and its top-up. */
const TWO_DUE: Script = {
  head: 200_000,
  guardianAddedAt: 1_000,
  lots: [lotAt(199_000, 5n, 5n), lotAt(199_500, 3n, 8n)],
};

test('screening reads an empty evidence reference as none', async (context) => {
  serve(context, 200, {
    results: [
      { ...judged(FIRST_ID), evidenceReference: '' },
      { ...INCOMPLETE_SECOND, evidenceReference: '' },
    ],
  });

  assert.deepEqual(await new HttpScreening(SCREENING_URL).screen(REQUEST), [
    { ...judged(FIRST_ID), evidenceReference: null },
    { ...INCOMPLETE_SECOND, evidenceReference: null },
  ]);
});

test('a judged answer with an empty evidence reference is reported', async (context) => {
  const requests = serveEach(context, (ids) =>
    Response.json({ results: ids.map((id) => ({ ...judged(id), evidenceReference: '' })) }),
  );
  const { guardian, sent } = guardianOver(ONE_DUE, { screening: new HttpScreening(SCREENING_URL) });

  assert.equal((await guardian.cycle()).kind, 'attested');

  assert.equal(requests.length, 1);
  assert.deepEqual(sent.calls, ['flags', 'heartbeat']);
});

test('an incomplete answer with an empty evidence reference leaves the flag another anchor requires', async (context) => {
  serveEach(context, (ids) =>
    Response.json({
      results: ids.map((id, index) => (index === 0 ? judged(id) : { id, status: 'incomplete', evidenceReference: '' })),
    }),
  );
  const { guardian, sent } = guardianOver(TWO_DUE, { screening: new HttpScreening(SCREENING_URL) });

  assert.equal((await guardian.cycle()).kind, 'incomplete');

  assert.deepEqual(sent.calls, ['flags']);
});
