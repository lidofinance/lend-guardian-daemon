import assert from 'node:assert/strict';
import test from 'node:test';
import { readEvent } from '../../monitoring/events.ts';
import type { ReceivedEvent } from '../../monitoring/events.ts';
import { ADDRESS, BLOCK, cycleFinished, expectSample, fixture, HASH, sample } from './helpers.ts';

const DAEMON = 'lido_lend_guardian_daemon_';

function event(value: Record<string, unknown>): ReceivedEvent {
  const parsed = readEvent(JSON.stringify(value));
  assert.ok(typeof parsed !== 'string', JSON.stringify(parsed));
  return parsed;
}

test('cycle outcomes map to the previous daemon labels with source times and durations', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(
    event(cycleFinished({ kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH })),
  );
  receiver.receive(event(cycleFinished({ kind: 'observed', previousHeartbeatBlock: null, screened: {} })));
  receiver.receive(
    event(
      cycleFinished({ kind: 'nothing-due', previousHeartbeatBlock: null, reason: 'membership-after-report-block' }),
    ),
  );
  receiver.receive(event(cycleFinished({ kind: 'stale', reason: 'report-block-reorged' })));
  receiver.receive(
    event({
      event: 'cycle.failed',
      cycleId: 'c2',
      startedAt: 1_000,
      finishedAt: 4_000,
      error: { name: 'E', message: 'm' },
    }),
  );
  for (const outcome of ['complete', 'observed', 'no-change', 'stale', 'failed']) {
    await expectSample(metrics, `${DAEMON}cycles_total`, { outcome }, 1);
  }
  await expectSample(metrics, `${DAEMON}last_cycle_timestamp_seconds`, { outcome: 'complete' }, 22);
  await expectSample(metrics, `${DAEMON}last_cycle_timestamp_seconds`, { outcome: 'failed' }, 4);
  await expectSample(metrics, `${DAEMON}last_cycle_duration_seconds`, {}, 3);
  await expectSample(metrics, `${DAEMON}cycle_duration_seconds_count`, { outcome: 'stale' }, 1);
  await expectSample(metrics, `${DAEMON}cycle_restarts_total`, { reason: 'report-block-reorged' }, 1);
});

test('the report block follows an attested cycle and an observed cycle through its reconstruction', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(
    event(cycleFinished({ kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH })),
  );
  await expectSample(metrics, `${DAEMON}report_block_number`, {}, 100);
  await expectSample(metrics, `${DAEMON}report_block_timestamp_seconds`, {}, 1_700_000_000);
  const later = { ...BLOCK, number: 150, timestamp: 1_700_000_600 };
  receiver.receive(
    event({ event: 'cycle.reconstructed', cycleId: 'c9', reportBlock: later, positions: 1, anchors: [] }),
  );
  receiver.receive(event(cycleFinished({ kind: 'observed', previousHeartbeatBlock: null, screened: {} }, 'c9')));
  await expectSample(metrics, `${DAEMON}report_block_number`, {}, 150);
  receiver.receive(event(cycleFinished({ kind: 'stale', reason: 'report-block-aged-out' }, 'c10')));
  await expectSample(metrics, `${DAEMON}report_block_number`, {}, 150);
});

test('a malformed outcome counts the event but changes no cycle metric', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(event({ event: 'cycle.finished', cycleId: 'c1', outcome: { kind: 'unheard-of' } }));
  receiver.receive(event({ event: 'cycle.finished', cycleId: 'c1', outcome: 'text' }));
  const exposition = await metrics.render();
  for (const outcome of ['complete', 'observed', 'no-change', 'stale', 'failed']) {
    assert.equal(sample(exposition, `${DAEMON}cycles_total`, { outcome }), 0);
  }
  assert.equal(sample(exposition, 'lido_lend_guardian_monitor_events_total', { event: 'cycle.finished' }), 2);
});

test('transaction steps and report outcomes count by stage and contract method', async () => {
  const { receiver, metrics } = fixture();
  const context = { operationId: 'o1', method: 'heartbeat', reportBlock: BLOCK, coverageDigest: HASH };
  receiver.receive(
    event({
      event: 'transaction.broadcast',
      context,
      nonce: 1,
      transactionHash: HASH,
      attempt: 1,
      startedAt: 1,
      finishedAt: 2,
    }),
  );
  receiver.receive(
    event({
      event: 'transaction.included',
      context,
      transactionHash: HASH,
      receiptBlockHash: HASH,
      receiptStatus: 'success',
      durationMs: 24_000,
    }),
  );
  receiver.receive(
    event({
      event: 'report.confirmed',
      context,
      transactionHash: HASH,
      receiptStatus: 'success',
      receiptBlockHash: HASH,
    }),
  );
  receiver.receive(
    event({
      event: 'report.skipped',
      cycleId: 'c1',
      method: 'suspect',
      target: { marketId: HASH, borrower: ADDRESS },
      recordedAt: 1,
    }),
  );
  receiver.receive(
    event({
      event: 'nonce.cleared',
      context: { operationId: 'o2', method: 'cancel' },
      nonce: 3,
      blockNumber: '10',
      blockHash: HASH,
    }),
  );
  receiver.receive(event({ event: 'transaction.failed', stage: 'broadcast', reason: 'fee-cap' }));
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
  const anchor = {
    core: ADDRESS,
    blockHash: HASH,
    transactionHash: HASH,
    logIndex: 1,
    marketId: HASH,
    borrower: ADDRESS,
  };
  const judged = (requiresSuspect: boolean, requiresFlag: boolean): object => ({
    status: 'judged',
    requiresSuspect,
    requiresFlag,
  });
  receiver.receive(
    event({
      event: 'cycle.screened',
      cycleId: 'c1',
      reportBlock: BLOCK,
      results: [
        { anchor, result: judged(false, false) },
        { anchor, result: judged(true, false) },
        { anchor, result: judged(true, true) },
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
  const base = {
    event: 'rpc.requestFinished',
    requestId: 1,
    rpcIndex: 1,
    startedAt: 1_000,
    finishedAt: 1_250,
    requestBytes: 200,
    responseBytes: 900,
  };
  receiver.receive(event({ ...base, method: 'eth_getLogs', httpStatus: 200 }));
  receiver.receive(
    event({
      ...base,
      method: 'eth_madeUp',
      httpStatus: 429,
      error: { name: 'HttpRequestError', message: 'rate limited', code: -32005 },
    }),
  );
  receiver.receive(
    event({ ...base, rpcIndex: 99, method: 'eth_call', httpStatus: 0, error: { name: 'TimeoutError', message: 't' } }),
  );
  const labels = { network: 'ethereum', layer: 'el', chain_id: '560048', provider: 'rpc-1' };
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
  await expectSample(metrics, 'http_rpc_response_seconds_sum', labels, 0.5);
  await expectSample(metrics, 'http_rpc_request_payload_bytes_count', labels, 2);
  const other = { ...labels, provider: 'rpc-other' };
  await expectSample(
    metrics,
    'http_rpc_requests_total',
    { ...other, batched: 'false', response_code: '0xx', result: 'fail' },
    1,
  );
});

test('runner records and answer disagreements have their own counters', async () => {
  const { receiver, metrics } = fixture();
  receiver.receive(event({ event: 'restart-budget-exhausted', restarts: 5, reason: 'report-block-reorged' }));
  receiver.receive(event({ event: 'cycle-not-started', error: { name: 'E', message: 'm' } }));
  receiver.receive(
    event({ event: 'rpc.answersDiffer', method: 'eth_getLogs', acceptedRpcIndexes: [0], otherRpcIndexes: [1] }),
  );
  await expectSample(metrics, `${DAEMON}restart_budget_exhausted_total`, {}, 1);
  await expectSample(metrics, `${DAEMON}cycles_not_started_total`, {}, 1);
  await expectSample(metrics, `${DAEMON}rpc_answers_differ_total`, {}, 1);
  await expectSample(metrics, `${DAEMON}log_records_total`, { level: 'error' }, 2);
  await expectSample(metrics, `${DAEMON}log_records_total`, { level: 'warn' }, 1);
});

test('identity and build labels come from the configuration, not the stream', async () => {
  const { metrics } = fixture();
  await expectSample(
    metrics,
    `${DAEMON}info`,
    {
      mode: 'signal',
      guardian: ADDRESS.replace(/^0x.*/, '0xA6b2dbCCE7895347A62b4409d29bA7ce29A74655'),
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
    event({ event: 'rpc.requestStarted', requestId: 1, method: 'eth_call', params: [1], rpcIndex: 0, startedAt: 1 }),
  );
  receiver.receive(
    event({
      event: 'rpc.requestFinished',
      requestId: 1,
      method: 'eth_call',
      rpcIndex: 0,
      startedAt: 1,
      finishedAt: 2,
      httpStatus: 200,
      requestBytes: 1,
      responseBytes: 1,
    }),
  );
  clock.now += 5;
  receiver.receive(
    event({
      event: 'cycle.failed',
      cycleId: 'c1',
      startedAt: 1,
      finishedAt: 2,
      error: { name: 'E', message: 'see https://x.y/z' },
    }),
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    timestamp: new Date(1_000_005).toISOString(),
    sequence: 1,
    level: 'error',
    event: 'cycle.failed',
    cycleId: 'c1',
    details: { startedAt: 1, finishedAt: 2, error: { name: 'E', message: 'see [url]' } },
  });
});
