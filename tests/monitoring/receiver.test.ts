import assert from 'node:assert/strict';
import test from 'node:test';
import type { DaemonEvent } from '../../daemon/main.ts';
import type { SupplyAnchor } from '../../src/core/index.ts';
import {
  ADDRESS,
  BLOCK,
  cycleFinished,
  expectSample,
  fixture,
  HASH,
  NOTHING_DUE,
  observedCycle,
  parseEvent,
  parsePosted,
  sample,
} from './helpers.ts';

const DAEMON = 'lido_lend_guardian_daemon_';

const OUTCOME_LABELS = ['complete', 'observed', 'no-change', 'stale', 'incomplete', 'failed'];

const RPC_LABELS = { network: 'ethereum', layer: 'el', chain_id: '560048', provider: 'rpc-1' };

/** A finished RPC request of a quarter second, as the daemon posts it. */
const RPC_FINISHED = {
  event: 'rpc.requestFinished',
  requestId: 1,
  method: 'eth_getLogs',
  rpcIndex: 1,
  startedAt: 1_000,
  finishedAt: 1_250,
  httpStatus: 200,
  requestBytes: 200,
  responseBytes: 900,
} as const satisfies DaemonEvent;

test('cycle outcomes map to the previous daemon labels with source times and durations', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(
    parsePosted(cycleFinished({ kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH })),
  );
  receiver.receive(observedCycle());
  receiver.receive(parsePosted(cycleFinished(NOTHING_DUE)));
  receiver.receive(parsePosted(cycleFinished({ kind: 'stale', reason: 'report-block-reorged' })));
  receiver.receive(parsePosted(cycleFinished({ kind: 'incomplete', previousHeartbeatBlock: null, incomplete: [] })));
  receiver.receive(
    parsePosted({ event: 'cycle.failed', cycleId: 'c2', startedAt: 1_000, finishedAt: 4_000, error: new Error('m') }),
  );
  for (const outcome of OUTCOME_LABELS) {
    await expectSample(metrics, `${DAEMON}cycles_total`, { outcome }, 1);
  }
  await expectSample(metrics, `${DAEMON}last_cycle_timestamp_seconds`, { outcome: 'complete' }, 22);
  await expectSample(metrics, `${DAEMON}last_cycle_timestamp_seconds`, { outcome: 'failed' }, 4);
  await expectSample(metrics, `${DAEMON}last_cycle_duration_seconds`, {}, 3);
  await expectSample(metrics, `${DAEMON}cycle_duration_seconds_count`, { outcome: 'stale' }, 1);
  await expectSample(metrics, `${DAEMON}cycle_restarts_total`, { reason: 'report-block-reorged' }, 1);
});

test('a cycle end without both times counts, and records no time or duration', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(parseEvent({ event: 'cycle.finished', cycleId: 'c1', finishedAt: 22_000, outcome: NOTHING_DUE }));
  const exposition = await metrics.render();
  assert.equal(sample(exposition, `${DAEMON}cycles_total`, { outcome: 'no-change' }), 1);
  assert.equal(sample(exposition, `${DAEMON}cycle_duration_seconds_count`, { outcome: 'no-change' }), undefined);
  assert.equal(sample(exposition, `${DAEMON}last_cycle_timestamp_seconds`, { outcome: 'no-change' }), undefined);
});

test('the report block follows an attested cycle and an observed cycle through its reconstruction', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(
    parsePosted(cycleFinished({ kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH })),
  );
  await expectSample(metrics, `${DAEMON}report_block_number`, {}, 100);
  await expectSample(metrics, `${DAEMON}report_block_timestamp_seconds`, {}, 1_700_000_000);
  const later = { ...BLOCK, number: 150, timestamp: 1_700_000_600 };
  receiver.receive(
    parsePosted({ event: 'cycle.reconstructed', cycleId: 'c9', reportBlock: later, positions: 1, anchors: [] }),
  );
  receiver.receive(observedCycle('c9'));
  await expectSample(metrics, `${DAEMON}report_block_number`, {}, 150);
  receiver.receive(parsePosted(cycleFinished({ kind: 'stale', reason: 'report-block-aged-out' }, 'c10')));
  await expectSample(metrics, `${DAEMON}report_block_number`, {}, 150);
});

test('a failed cycle forgets the report block of its reconstruction', async () => {
  const { receiver, metrics } = fixture();
  const block = { ...BLOCK, number: 150 };
  receiver.receive(
    parsePosted({ event: 'cycle.reconstructed', cycleId: 'c9', reportBlock: block, positions: 1, anchors: [] }),
  );
  receiver.receive(parsePosted({ event: 'cycle.failed', cycleId: 'c9', startedAt: 1, finishedAt: 2, error: 'e' }));
  receiver.receive(observedCycle('c9'));
  // The gauge keeps its initial 0: the observed cycle found no block to report.
  assert.equal(sample(await metrics.render(), `${DAEMON}report_block_number`), 0);
});

for (const outcome of [{ kind: 'unheard-of' }, 'text']) {
  test(`a malformed outcome, ${JSON.stringify(outcome)}, counts the event but changes no cycle metric`, async () => {
    const { receiver, metrics } = fixture();
    receiver.receive(parseEvent({ event: 'cycle.finished', cycleId: 'c1', outcome }));
    const exposition = await metrics.render();
    for (const label of OUTCOME_LABELS) {
      assert.equal(sample(exposition, `${DAEMON}cycles_total`, { outcome: label }), 0);
    }
    assert.equal(sample(exposition, 'lido_lend_guardian_monitor_events_total', { event: 'cycle.finished' }), 1);
  });
}

test('transaction steps and report outcomes count by stage and contract method', async () => {
  const { receiver, metrics } = fixture();
  const context = { operationId: 'o1', method: 'heartbeat', reportBlock: BLOCK, coverageDigest: HASH } as const;
  const posted: DaemonEvent[] = [
    {
      event: 'transaction.broadcast',
      context,
      nonce: 1,
      transactionHash: HASH,
      attempt: 1,
      startedAt: 1,
      finishedAt: 2,
    },
    {
      event: 'transaction.included',
      context,
      transactionHash: HASH,
      receiptBlockHash: HASH,
      receiptStatus: 'success',
      durationMs: 24_000,
    },
    { event: 'report.confirmed', context, transactionHash: HASH, receiptStatus: 'success', receiptBlockHash: HASH },
    {
      event: 'report.skipped',
      cycleId: 'c1',
      method: 'suspect',
      target: { marketId: HASH, borrower: ADDRESS },
      recordedAt: 1,
    },
    {
      event: 'nonce.cleared',
      context: { operationId: 'o2', method: 'cancel' },
      nonce: 3,
      blockNumber: 10n,
      blockHash: HASH,
    },
    { event: 'transaction.failed', stage: 'broadcast', reason: 'fee-cap' },
  ];
  for (const event of posted) {
    receiver.receive(parsePosted(event));
  }
  await expectSample(metrics, `${DAEMON}transactions_total`, { event: 'broadcast', method: 'heartbeat' }, 1);
  await expectSample(metrics, `${DAEMON}transactions_total`, { event: 'included', method: 'heartbeat' }, 1);
  await expectSample(metrics, `${DAEMON}transactions_total`, { event: 'confirmed', method: 'heartbeat' }, 1);
  await expectSample(metrics, `${DAEMON}transactions_total`, { event: 'skipped', method: 'suspect' }, 1);
  await expectSample(metrics, `${DAEMON}transactions_total`, { event: 'nonce-cleared', method: 'cancel' }, 1);
  await expectSample(metrics, `${DAEMON}transactions_total`, { event: 'failed', method: 'unknown' }, 1);
  await expectSample(metrics, `${DAEMON}transaction_inclusion_duration_seconds_sum`, { method: 'heartbeat' }, 24);
});

test('screened anchors count by result and the required actions and withheld targets separately', async () => {
  const { receiver, metrics } = fixture();
  const anchor: SupplyAnchor = {
    core: ADDRESS,
    blockHash: HASH,
    transactionHash: HASH,
    logIndex: 1,
    marketId: HASH,
    borrower: ADDRESS,
  };
  const judged = (requiresSuspect: boolean, requiresFlag: boolean) => ({
    anchor,
    result: { status: 'judged', requiresSuspect, requiresFlag } as const,
  });
  receiver.receive(
    parsePosted({
      event: 'cycle.screened',
      cycleId: 'c1',
      reportBlock: BLOCK,
      results: [
        judged(false, false),
        judged(true, false),
        judged(true, true),
        { anchor, result: { status: 'incomplete' } },
      ],
      skipped: [{ target: { marketId: HASH, borrower: ADDRESS }, anchors: [anchor], flaggedBy: [ADDRESS] }],
      suspects: [],
      flags: [],
    }),
  );
  await expectSample(metrics, `${DAEMON}anchors_screened_total`, { result: 'none' }, 1);
  await expectSample(metrics, `${DAEMON}anchors_screened_total`, { result: 'suspect' }, 1);
  await expectSample(metrics, `${DAEMON}anchors_screened_total`, { result: 'flag' }, 1);
  await expectSample(metrics, `${DAEMON}anchors_screened_total`, { result: 'incomplete' }, 1);
  await expectSample(metrics, `${DAEMON}risk_decisions_total`, { action: 'suspect' }, 1);
  await expectSample(metrics, `${DAEMON}risk_decisions_total`, { action: 'flag' }, 1);
  await expectSample(metrics, `${DAEMON}screening_skipped_targets_total`, {}, 1);
});

test('RPC requests feed the policy metrics with bounded labels and the configured chain', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(parsePosted(RPC_FINISHED));
  const limited = Object.assign(new Error('rate limited'), { code: -32005 });
  receiver.receive(parsePosted({ ...RPC_FINISHED, method: 'eth_madeUp', httpStatus: 429, error: limited }));
  receiver.receive(
    parsePosted({ ...RPC_FINISHED, rpcIndex: 99, method: 'eth_call', httpStatus: 0, error: new Error('timeout') }),
  );
  const labels = RPC_LABELS;
  await expectSample(
    metrics,
    'http_rpc_requests_total',
    { ...labels, batched: 'false', response_code: '2xx', result: 'success' },
    1,
  );
  await expectSample(
    metrics,
    'http_rpc_requests_total',
    { ...labels, batched: 'false', response_code: '4xx', result: 'fail' },
    1,
  );
  await expectSample(
    metrics,
    'rpc_request_total',
    { ...labels, method: 'eth_getLogs', result: 'success', rpc_error_code: '' },
    1,
  );
  await expectSample(
    metrics,
    'rpc_request_total',
    { ...labels, method: 'other', result: 'fail', rpc_error_code: '-32005' },
    1,
  );
  await expectSample(metrics, 'http_rpc_response_seconds_sum', { ...labels, result: 'success' }, 0.25);
  await expectSample(metrics, 'http_rpc_response_seconds_sum', { ...labels, result: 'fail' }, 0.25);
  await expectSample(metrics, 'http_rpc_response_payload_bytes_count', { ...labels, result: 'success' }, 1);
  await expectSample(metrics, 'http_rpc_response_payload_bytes_count', { ...labels, result: 'fail' }, 1);
  await expectSample(metrics, 'http_rpc_request_payload_bytes_count', labels, 2);
  const other = { ...labels, provider: 'rpc-other' };
  await expectSample(
    metrics,
    'http_rpc_requests_total',
    { ...other, batched: 'false', response_code: '0xx', result: 'fail' },
    1,
  );
});

test('every RPC request is one JSON-RPC call in the batch size', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(parsePosted(RPC_FINISHED));
  receiver.receive(parsePosted({ ...RPC_FINISHED, requestId: 2 }));
  await expectSample(metrics, 'http_rpc_batch_size_count', RPC_LABELS, 2);
  await expectSample(metrics, 'http_rpc_batch_size_sum', RPC_LABELS, 2);
  await expectSample(metrics, 'http_rpc_batch_size_bucket', { ...RPC_LABELS, le: '1' }, 2);
});

test('an RPC request without both times counts, without a response time', async () => {
  const { receiver, metrics } = fixture();
  const { startedAt: _startedAt, ...withoutStart } = RPC_FINISHED;
  receiver.receive(parseEvent(withoutStart));
  const exposition = await metrics.render();
  const success = { ...RPC_LABELS, result: 'success' };
  assert.equal(sample(exposition, 'rpc_request_total', { ...success, method: 'eth_getLogs', rpc_error_code: '' }), 1);
  assert.equal(sample(exposition, 'http_rpc_response_seconds_count', success), undefined);
});

test('runner records and answer disagreements have their own counters', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(
    parsePosted({ event: 'schedule.restartBudgetExhausted', restarts: 5, reason: 'report-block-reorged' }),
  );
  receiver.receive(parsePosted({ event: 'schedule.cycleNotStarted', error: new Error('m') }));
  receiver.receive(
    parsePosted({ event: 'rpc.answersDiffer', method: 'eth_getLogs', acceptedRpcIndexes: [0], otherRpcIndexes: [1] }),
  );
  await expectSample(metrics, `${DAEMON}restart_budget_exhausted_total`, {}, 1);
  await expectSample(metrics, `${DAEMON}cycles_not_started_total`, {}, 1);
  await expectSample(metrics, `${DAEMON}rpc_answers_differ_total`, {}, 1);
  await expectSample(metrics, `${DAEMON}log_records_total`, { level: 'error' }, 2);
  await expectSample(metrics, `${DAEMON}log_records_total`, { level: 'warn' }, 1);
});

test('screening requests count by response code class and result, with their duration', async () => {
  const { receiver, metrics } = fixture();
  const request = { event: 'screening.requestFinished', anchors: 2, startedAt: 10_000, finishedAt: 12_500 } as const;
  receiver.receive(parsePosted({ ...request, judged: 2, incomplete: 0, httpStatus: 200 }));
  receiver.receive(
    parsePosted({ ...request, judged: 0, incomplete: 2, httpStatus: 503, error: new Error('HTTP 503') }),
  );
  receiver.receive(parsePosted({ ...request, judged: 0, incomplete: 2, error: new Error('timeout') }));
  await expectSample(metrics, `${DAEMON}screening_requests_total`, { response_code: '2xx', result: 'success' }, 1);
  await expectSample(metrics, `${DAEMON}screening_requests_total`, { response_code: '5xx', result: 'fail' }, 1);
  await expectSample(metrics, `${DAEMON}screening_requests_total`, { response_code: '0xx', result: 'fail' }, 1);
  await expectSample(metrics, `${DAEMON}screening_request_duration_seconds_sum`, { result: 'success' }, 2.5);
  await expectSample(metrics, `${DAEMON}screening_request_duration_seconds_count`, { result: 'fail' }, 2);
  await expectSample(metrics, `${DAEMON}screening_request_anchors_total`, { result: 'judged' }, 2);
  await expectSample(metrics, `${DAEMON}screening_request_anchors_total`, { result: 'incomplete' }, 4);
});

test('a screening request without both times counts with its anchors, without a duration', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(
    parseEvent({ event: 'screening.requestFinished', anchors: 1, judged: 1, incomplete: 0, httpStatus: 200 }),
  );
  const exposition = await metrics.render();
  assert.equal(sample(exposition, `${DAEMON}screening_requests_total`, { response_code: '2xx', result: 'success' }), 1);
  assert.equal(sample(exposition, `${DAEMON}screening_request_anchors_total`, { result: 'judged' }), 1);
  assert.equal(
    sample(exposition, `${DAEMON}screening_request_duration_seconds_count`, { result: 'success' }),
    undefined,
  );
});

test("the daemon's post totals replace the previous ones, summed by response code class", async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(
    parsePosted({ event: 'daemon.forwardsCounted', posts: { 0: 2, 202: 1, 204: 40 }, durationMs: 1_500 }),
  );
  await expectSample(metrics, `${DAEMON}event_posts`, { response_code: '0xx' }, 2);
  await expectSample(metrics, `${DAEMON}event_posts`, { response_code: '2xx' }, 41);
  await expectSample(metrics, `${DAEMON}event_post_duration_seconds`, {}, 1.5);
  // A restarted daemon counts from zero; the totals follow it.
  receiver.receive(parsePosted({ event: 'daemon.forwardsCounted', posts: { 204: 3 }, durationMs: 100 }));
  const exposition = await metrics.render();
  assert.equal(sample(exposition, `${DAEMON}event_posts`, { response_code: '2xx' }), 3);
  assert.equal(sample(exposition, `${DAEMON}event_posts`, { response_code: '0xx' }), undefined);
  assert.equal(sample(exposition, `${DAEMON}event_post_duration_seconds`, {}), 0.1);
});

for (const malformed of [{ posts: { 204: 'many' }, durationMs: 100 }, { posts: { 204: 9 } }]) {
  test(`malformed post totals, ${JSON.stringify(malformed)}, change nothing`, async () => {
    const { receiver, metrics } = fixture();
    receiver.receive(parsePosted({ event: 'daemon.forwardsCounted', posts: { 204: 3 }, durationMs: 100 }));
    receiver.receive(parseEvent({ event: 'daemon.forwardsCounted', ...malformed }));
    await expectSample(metrics, `${DAEMON}event_posts`, { response_code: '2xx' }, 3);
  });
}

test('identity and build labels come from the configuration, not the stream', async () => {
  const { metrics } = fixture();
  await expectSample(
    metrics,
    `${DAEMON}info`,
    {
      mode: 'signal',
      guardian: '0xA6b2dbCCE7895347A62b4409d29bA7ce29A74655',
      chain_id: '560048',
    },
    1,
  );
  await expectSample(
    metrics,
    'lido_lend_guardian_monitor_build_info',
    { version: '1.2.3', branch: 'feat/x', commit: 'abc' },
    1,
  );
});

test('records carry a level, a sequence and the scrubbed details; routine RPC events are not printed', () => {
  const { receiver, lines, clock } = fixture();
  receiver.receive(
    parsePosted({
      event: 'rpc.requestStarted',
      requestId: 1,
      method: 'eth_call',
      params: [1],
      rpcIndex: 0,
      startedAt: 1,
    }),
  );
  receiver.receive(parsePosted(RPC_FINISHED));
  clock.now += 5;
  receiver.receive(
    parsePosted({
      event: 'cycle.failed',
      cycleId: 'c1',
      startedAt: 1,
      finishedAt: 2,
      error: new Error('see https://x.y/z'),
    }),
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    timestamp: new Date(1_000_005).toISOString(),
    sequence: 1,
    level: 'error',
    event: 'cycle.failed',
    cycleId: 'c1',
    details: { startedAt: 1, finishedAt: 2, error: { name: 'Error', message: 'see [url]' } },
  });
});

test('a stale reason the SDK does not send is one label value, so the stream cannot add series', async () => {
  const { receiver, metrics } = fixture();
  for (const reason of ['made-up-1', 'made-up-2']) {
    receiver.receive(parseEvent({ event: 'cycle.finished', cycleId: reason, outcome: { kind: 'stale', reason } }));
  }
  assert.equal(sample(await metrics.render(), `${DAEMON}cycle_restarts_total`, { reason: 'other' }), 2);
});

test('an RPC error code outside the JSON-RPC set is one label value, so the stream cannot add series', async () => {
  const { receiver, metrics } = fixture();
  for (const code of [3, -32_000, -32_768, -31_999, 7, 12_345]) {
    const error = Object.assign(new Error('m'), { code });
    receiver.receive(parsePosted({ ...RPC_FINISHED, rpcIndex: 0, method: 'eth_call', error }));
  }
  const exposition = await metrics.render();
  const labels = { ...RPC_LABELS, provider: 'rpc-0', method: 'eth_call', result: 'fail' };
  for (const [code, count] of [
    ['3', 1],
    ['-32000', 1],
    ['-32768', 1],
    ['other', 3],
  ] as const) {
    assert.equal(sample(exposition, 'rpc_request_total', { ...labels, rpc_error_code: code }), count, code);
  }
});
