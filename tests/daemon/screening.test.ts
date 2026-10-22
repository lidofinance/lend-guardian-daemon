import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { padHex } from 'viem';
import { HttpScreening } from '../../daemon/screening.ts';
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
  test(`screening refuses ${name}`, async (context) => {
    serve(context, status, body);
    await assert.rejects(new HttpScreening(SCREENING_URL).screen(REQUEST), { message });
  });
}
