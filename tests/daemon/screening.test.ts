import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { padHex } from 'viem';
import { HttpScreening } from '../../daemon/screening.ts';
import type { ScreeningBatchEvent } from '../../daemon/screening.ts';
import type { ScreeningRequest, SupplyAnchor } from '../../src/core/index.ts';

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
    const events: ScreeningBatchEvent[] = [];
    const screening = new HttpScreening(SCREENING_URL, { onEvent: (event) => events.push(event) });

    const results = await screening.screen(REQUEST);

    assert.deepEqual(results, [{ status: 'incomplete' }, { status: 'incomplete' }]);
    const [event] = events;
    assert.ok(event !== undefined);
    assert.ok(event.error instanceof Error);
    assert.equal(event.error.message, message);
    const { error: _cause, ...counts } = event;
    assert.deepEqual(counts, { event: 'screening-batch', anchors: 2, judged: 0, incomplete: 2 });
  });
}

test('anchors are posted in batches of batchSize, and the results keep request order', async (context) => {
  const requests = serveEach(context, (ids) => Response.json({ results: ids.map(judged) }));
  const events: ScreeningBatchEvent[] = [];
  const screening = new HttpScreening(SCREENING_URL, { batchSize: 1, onEvent: (event) => events.push(event) });

  const results = await screening.screen(REQUEST);

  assert.deepEqual(requests, [[FIRST_ID], [SECOND_ID]]);
  assert.deepEqual(results, [judged(FIRST_ID), judged(SECOND_ID)]);
  assert.deepEqual(events, [
    { event: 'screening-batch', anchors: 1, judged: 1, incomplete: 0 },
    { event: 'screening-batch', anchors: 1, judged: 1, incomplete: 0 },
  ]);
});

test('a request that fails leaves only its own anchors incomplete', async (context) => {
  const requests = serveEach(context, (ids, request) =>
    request === 1 ? Response.json({ results: ids.map(judged) }) : Response.json({}, { status: 503 }),
  );
  const events: ScreeningBatchEvent[] = [];
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
  const events: ScreeningBatchEvent[] = [];
  const screening = new HttpScreening(SCREENING_URL, { timeoutMs: 10, onEvent: (event) => events.push(event) });

  const results = await screening.screen(REQUEST);

  assert.deepEqual(results, [{ status: 'incomplete' }, { status: 'incomplete' }]);
  assert.ok(events[0]?.error instanceof Error);
  assert.equal(events[0].error.name, 'TimeoutError');
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
  const events: ScreeningBatchEvent[] = [];
  const screening = new HttpScreening(SCREENING_URL, { budgetMs: 0, onEvent: (event) => events.push(event) });

  const results = await screening.screen(REQUEST);

  assert.deepEqual(requests, []);
  assert.deepEqual(results, [{ status: 'incomplete' }, { status: 'incomplete' }]);
  assert.deepEqual(events, []);
});
