import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { EventReceiver } from '../../monitoring/receiver.ts';
import { monitoringEndpoints } from '../../monitoring/server.ts';
import { Metrics } from '../../monitoring/metrics.ts';
import type { MetricsSource } from '../../monitoring/metrics.ts';
import { Recorder } from '../../monitoring/logger.ts';
import type { LogRecord } from '../../monitoring/logger.ts';

const BLOCK = { number: 100, hash: `0x${'ab'.repeat(32)}`, timestamp: 1000 };

const HASH = `0x${'cd'.repeat(32)}`;

const CONTEXT = {
  operationId: 'report-1',
  cycleId: 'sdk-cycle-1',
  method: 'heartbeat',
  reportBlock: BLOCK,
  coverageDigest: HASH,
};

const PREFIX = 'lido_lend_guardian_daemon_';

async function served(
  run: (url: string, records: LogRecord[], advance: () => void) => Promise<void>,
  overrides?: { readonly metrics?: Metrics; readonly runtime?: MetricsSource },
): Promise<void> {
  const records: LogRecord[] = [];
  let now = 10000;
  const metrics = overrides?.metrics ?? new Metrics();
  const recorder = new Recorder({
    sink: (record) => {
      records.push(record);
      metrics.observe(record);
    },
  });
  const receiver = new EventReceiver({ recorder, metrics, clock: () => now });
  const runtime: { runtime?: MetricsSource } = {};
  if (overrides?.runtime !== undefined) {
    runtime.runtime = overrides.runtime;
  }
  const server = createServer(
    monitoringEndpoints({
      receiver,
      metrics,
      version: 'test',
      progressTimeoutSeconds: 1,
      clock: () => now,
      ...runtime,
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`, records, () => {
      now += 1001;
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }
        reject(error);
      }),
    );
  }
}

function post(url: string, event: unknown): Promise<Response> {
  return fetch(`${url}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

test('fractional cycle completion times preserve the latest duration after an older event', async () => {
  const metrics = new Metrics();
  const recorder = new Recorder({ sink: (record) => metrics.observe(record) });
  const receiver = new EventReceiver({ recorder, metrics });
  assert.equal(
    receiver.receive({
      event: 'cycle.failed',
      cycleId: 'newer',
      startedAt: 900,
      finishedAt: 1000.75,
      error: { name: 'Error', message: 'synthetic' },
    }),
    true,
  );
  assert.equal(
    receiver.receive({
      event: 'cycle.failed',
      cycleId: 'older',
      startedAt: 0,
      finishedAt: 1000.25,
      error: { name: 'Error', message: 'synthetic' },
    }),
    true,
  );
  const exposition = await metrics.render();
  assert.ok(exposition.includes(`${PREFIX}cycles_total{outcome="failed"} 2\n`));
  assert.ok(exposition.includes(`${PREFIX}last_cycle_timestamp_seconds{outcome="failed"} 1.00075\n`));
  assert.ok(exposition.includes(`${PREFIX}last_cycle_duration_seconds 0.10075\n`));
});

test('fractional attestation times prevent an older report block from replacing the latest block', async () => {
  const metrics = new Metrics();
  const recorder = new Recorder({ sink: (record) => metrics.observe(record) });
  const receiver = new EventReceiver({ recorder, metrics });
  assert.equal(
    receiver.receive({
      event: 'cycle.finished',
      cycleId: 'newer',
      startedAt: 900,
      finishedAt: 1000.75,
      outcome: {
        kind: 'attested',
        previousHeartbeatBlock: { ...BLOCK, number: 101, timestamp: 1001 },
        heartbeat: HASH,
        digest: HASH,
      },
    }),
    true,
  );
  assert.equal(
    receiver.receive({
      event: 'cycle.finished',
      cycleId: 'older',
      startedAt: 0,
      finishedAt: 1000.25,
      outcome: { kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH },
    }),
    true,
  );
  const exposition = await metrics.render();
  assert.ok(exposition.includes(`${PREFIX}cycles_total{outcome="complete"} 2\n`));
  assert.ok(exposition.includes(`${PREFIX}last_cycle_timestamp_seconds{outcome="complete"} 1.00075\n`));
  assert.ok(exposition.includes(`${PREFIX}report_block_number 101\n`));
  assert.ok(exposition.includes(`${PREFIX}report_block_timestamp_seconds 1001\n`));
});

test('HTTP SDK events retain source correlation and produce cycle, transaction and RPC metrics', async () => {
  await served(async (url, records) => {
    const events = [
      { event: 'cycle.started', cycleId: 'sdk-cycle-1', startedAt: 1000 },
      { event: 'transaction.signing', context: CONTEXT, attempt: 1, startedAt: 1000, finishedAt: 1020 },
      {
        event: 'transaction.broadcast',
        context: CONTEXT,
        attempt: 1,
        nonce: 0,
        transactionHash: HASH,
        startedAt: 1020,
        finishedAt: 1030,
      },
      {
        event: 'report.confirmed',
        context: CONTEXT,
        transactionHash: HASH,
        receiptStatus: 'success',
        receiptBlockHash: HASH,
      },
      {
        event: 'rpc.requestFinished',
        rpcIndex: 0,
        requestId: 1,
        method: 'eth_getLogs',
        startedAt: 1000,
        finishedAt: 1250,
        httpStatus: 200,
        requestBytes: 100,
        responseBytes: 200,
      },
      {
        event: 'cycle.finished',
        cycleId: 'sdk-cycle-1',
        startedAt: 1000,
        finishedAt: 3000,
        outcome: { kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH },
      },
    ];
    for (const event of events) {
      assert.equal((await post(url, event)).status, 204);
    }
    assert.ok(records.some((record) => record.cycleId === 'sdk-cycle-1'));
    assert.ok(records.some((record) => record.details.operationId === 'report-1'));
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes(`${PREFIX}cycles_total{outcome="complete"} 1`));
    assert.ok(metrics.includes(`${PREFIX}last_cycle_duration_seconds 2`));
    assert.ok(metrics.includes(`${PREFIX}report_block_number 100`));
    assert.ok(metrics.includes(`${PREFIX}transactions_total{event="action-confirmed",method="heartbeat"} 1`));
    assert.ok(metrics.includes(`${PREFIX}transaction_signing_duration_seconds_sum{method="heartbeat"} 0.02`));
    assert.ok(metrics.includes('provider="rpc-1"'));
    assert.ok(metrics.includes('rpc_request_total'));
  });
});

test('SDK transaction filling events reach RPC metrics without recording transaction parameters', async () => {
  await served(async (url, records) => {
    const started = {
      event: 'rpc.requestStarted',
      rpcIndex: 0,
      requestId: 26,
      method: 'eth_fillTransaction',
      params: [{ from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', data: '0x4c30694c' }],
      startedAt: 1000.25,
    };
    assert.equal((await post(url, started)).status, 204);
    assert.equal(
      (
        await post(url, {
          ...started,
          event: 'rpc.requestFinished',
          finishedAt: 1001.25,
          httpStatus: 200,
          requestBytes: 538,
          responseBytes: 1288,
        })
      ).status,
      204,
    );
    assert.deepEqual(
      records.map((record) => record.event),
      ['rpc.requestStarted', 'rpc.requestFinished'],
    );
    assert.ok(records.every((record) => record.details.params === undefined));
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes('method="eth_fillTransaction",result="success",rpc_error_code=""} 1'));
  });
});

test('receiver liveness is independent of SDK freshness; invalid events do not refresh readiness', async () => {
  await served(async (url, _records, advance) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/ready`)).status, 503);
    assert.equal((await post(url, { event: 'cycle.started', cycleId: 'first', startedAt: 1000 })).status, 204);
    assert.equal((await fetch(`${url}/ready`)).status, 200);
    advance();
    assert.equal((await post(url, { event: 'cycle.finished', cycleId: 'first' })).status, 400);
    assert.equal((await fetch(`${url}/ready`)).status, 503);
    assert.equal((await fetch(`${url}/health`)).status, 200);
  });
});

test('HTTP rejects malformed, unknown and oversized events without recording their contents', async () => {
  await served(async (url, records) => {
    for (const event of [
      null,
      [],
      {},
      { event: 'private-label' },
      { event: 'cycle.failed', cycleId: 'bad', startedAt: 2000, finishedAt: 1000, error: {} },
      { event: 'rpc.requestFinished', rpcIndex: -1 },
      { event: 'transaction.broadcast', context: { method: 'private-label' } },
    ]) {
      assert.equal((await post(url, event)).status, 400);
    }
    assert.equal(
      (
        await fetch(`${url}/events`, {
          method: 'POST',
          body: 'private-invalid-json',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
      400,
    );
    assert.equal((await fetch(`${url}/events`, { method: 'POST', body: '{}' })).status, 415);
    assert.equal(
      (
        await post(url, {
          event: 'cycle.started',
          cycleId: 'large',
          startedAt: 1000,
          extra: 'x'.repeat(8 * 1024 * 1024),
        })
      ).status,
      413,
    );
    assert.ok(!JSON.stringify(records).includes('private-invalid-json'));
    assert.equal((await fetch(`${url}/events`)).status, 405);
    assert.equal((await fetch(`${url}/missing`)).status, 404);
  });
});

test('late cycle events preserve their ids and cannot move last progress backwards', async () => {
  await served(async (url, records) => {
    const finished = {
      event: 'cycle.finished',
      startedAt: 1000,
      outcome: { kind: 'nothing-due', previousHeartbeatBlock: null, reason: 'no-work-and-idle-heartbeat-not-due' },
    };
    assert.equal((await post(url, { ...finished, cycleId: 'new', finishedAt: 5000 })).status, 204);
    assert.equal((await post(url, { ...finished, cycleId: 'old', finishedAt: 2000 })).status, 204);
    assert.equal((await post(url, { event: 'cycle.started', cycleId: 'old', startedAt: 1000 })).status, 204);
    assert.deepEqual(
      records.map((record) => record.cycleId),
      ['new', 'old', 'old'],
    );
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes(`${PREFIX}cycles_total{outcome="no-change"} 2`));
    assert.ok(metrics.includes(`${PREFIX}last_cycle_timestamp_seconds{outcome="no-change"} 5`));
  });
});

test('SDK errors are bounded and scrubbed; labels cannot contain arbitrary methods', async () => {
  await served(async (url, records) => {
    assert.equal(
      (
        await post(url, {
          event: 'cycle.failed',
          cycleId: 'failed',
          startedAt: 1000,
          finishedAt: 2000,
          error: { name: 'Error', message: `RPC https://user:password@rpc.example/key failed ${'x'.repeat(1000)}` },
        })
      ).status,
      204,
    );
    const output = JSON.stringify(records);
    assert.ok(!output.includes('password'));
    assert.ok(!output.includes('rpc.example'));
    assert.ok(output.length < 2000);
    assert.equal(
      (
        await post(url, {
          event: 'rpc.requestFinished',
          rpcIndex: 0,
          requestId: 1,
          method: 'secret-arbitrary-method',
          startedAt: 1,
          finishedAt: 2,
          httpStatus: 200,
          requestBytes: 10,
          responseBytes: 20,
        })
      ).status,
      400,
    );
  });
});

const ANCHOR = {
  core: '0x00000000000000000000000000000000000000c0',
  blockHash: BLOCK.hash,
  transactionHash: HASH,
  logIndex: 1,
  marketId: HASH,
  borrower: '0x00000000000000000000000000000000000000b1',
};

const TARGET = { marketId: HASH, borrower: ANCHOR.borrower };

const SCREENED = {
  results: [
    { anchor: ANCHOR, result: { status: 'judged', requiresSuspect: false, requiresFlag: false } },
    { anchor: { ...ANCHOR, logIndex: 2 }, result: { status: 'judged', requiresSuspect: true, requiresFlag: false } },
    { anchor: { ...ANCHOR, logIndex: 3 }, result: { status: 'judged', requiresSuspect: false, requiresFlag: true } },
  ],
  skipped: [{ target: TARGET, anchors: [ANCHOR], flaggedBy: [ANCHOR.core] }],
  suspects: [TARGET],
  flags: [TARGET],
};

const CYCLE_WIRE_EVENTS = [
  { event: 'cycle.started', cycleId: 'sdk-cycle-1', startedAt: 1000 },
  {
    event: 'cycle.planned',
    cycleId: 'sdk-cycle-1',
    result: {
      kind: 'plan',
      previousHeartbeatBlock: null,
      heartbeatTimestampAtStart: 0,
      discoveryRange: { from: BLOCK, to: BLOCK },
    },
  },
  {
    event: 'cycle.discovered',
    cycleId: 'sdk-cycle-1',
    reportBlock: BLOCK,
    positions: [{ ...TARGET, controller: ANCHOR.core }],
  },
  { event: 'cycle.reconstructed', cycleId: 'sdk-cycle-1', reportBlock: BLOCK, positions: 1, anchors: [ANCHOR] },
  { event: 'cycle.screened', cycleId: 'sdk-cycle-1', reportBlock: BLOCK, ...SCREENED },
  {
    event: 'cycle.finished',
    cycleId: 'observed',
    startedAt: 1000,
    finishedAt: 3000,
    outcome: { kind: 'observed', previousHeartbeatBlock: null, screened: SCREENED },
  },
  {
    event: 'cycle.finished',
    cycleId: 'idle',
    startedAt: 4000,
    finishedAt: 5000,
    outcome: { kind: 'nothing-due', previousHeartbeatBlock: null, reason: 'no-work-and-idle-heartbeat-not-due' },
  },
  {
    event: 'cycle.finished',
    cycleId: 'stale',
    startedAt: 6000,
    finishedAt: 6500,
    outcome: { kind: 'stale', reason: 'report-block-reorged' },
  },
  {
    event: 'cycle.failed',
    cycleId: 'failed',
    startedAt: 7000,
    finishedAt: 7500,
    error: { name: 'GuardianStop', message: 'screening-result-incomplete' },
  },
  {
    event: 'cycle.finished',
    cycleId: 'attested',
    startedAt: 8000,
    finishedAt: 10000,
    outcome: { kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH },
  },
];

const TRANSACTION_WIRE_EVENTS = [
  { event: 'report.started', context: CONTEXT },
  { event: 'transaction.preparation', context: CONTEXT, attempt: 1, startedAt: 1000, finishedAt: 1100 },
  { event: 'transaction.signing', context: CONTEXT, attempt: 1, startedAt: 1100, finishedAt: 1150 },
  {
    event: 'transaction.broadcast',
    context: CONTEXT,
    attempt: 1,
    nonce: 7,
    transactionHash: HASH,
    startedAt: 1150,
    finishedAt: 1160,
  },
  {
    event: 'transaction.included',
    context: CONTEXT,
    transactionHash: HASH,
    receiptBlockHash: BLOCK.hash,
    receiptStatus: 'success',
    durationMs: 2000,
  },
  {
    event: 'transaction.replaced',
    context: CONTEXT,
    nonce: 7,
    replacedHash: HASH,
    replacementHash: BLOCK.hash,
    replacementAttempt: 2,
  },
  {
    event: 'transaction.retry',
    context: CONTEXT,
    nonce: 7,
    attempt: 2,
    error: { name: 'Error', message: 'broadcast refused' },
  },
  {
    event: 'transaction.failed',
    context: CONTEXT,
    stage: 'confirmation',
    reason: 'transaction-reverted',
    receiptStatus: 'reverted',
    receiptBlockHash: BLOCK.hash,
  },
  {
    event: 'report.confirmed',
    context: CONTEXT,
    transactionHash: HASH,
    receiptStatus: 'success',
    receiptBlockHash: BLOCK.hash,
  },
  {
    event: 'nonce.cleared',
    context: { operationId: 'cancel-1', method: 'cancel' },
    nonce: 7,
    blockNumber: '100',
    blockHash: BLOCK.hash,
  },
];

const RPC_WIRE_EVENTS = [
  { event: 'rpc.requestStarted', rpcIndex: 0, requestId: 1, method: 'eth_getLogs', startedAt: 1000.25 },
  {
    event: 'rpc.requestFinished',
    rpcIndex: 0,
    requestId: 1,
    method: 'eth_getLogs',
    startedAt: 1000.25,
    finishedAt: 1250.75,
    httpStatus: 200,
    requestBytes: 100,
    responseBytes: 200,
  },
  {
    event: 'rpc.requestFinished',
    rpcIndex: 0,
    requestId: 2,
    method: 'eth_call',
    startedAt: 2000,
    finishedAt: 2500,
    httpStatus: 200,
    requestBytes: 120,
    responseBytes: 80,
    error: { name: 'RpcRequestError', message: 'refused' },
  },
  { event: 'rpc.answersDiffer', method: 'eth_getLogs', acceptedRpcIndexes: [0], otherRpcIndexes: [1] },
];

test('all SDK and runner event types cross HTTP and produce exact remote metric values', async () => {
  await served(async (url, records) => {
    const events = [
      ...CYCLE_WIRE_EVENTS,
      ...TRANSACTION_WIRE_EVENTS,
      ...RPC_WIRE_EVENTS,
      { event: 'cycle-not-started', error: { name: 'Error', message: 'nonce recovery failed' } },
      { event: 'restart-budget-exhausted', restarts: 5, reason: 'report-block-reorged' },
      { event: 'nonce.checked', context: { ...CONTEXT, method: 'cancel' }, latest: 7, pending: 7 },
      {
        event: 'report.skipped',
        cycleId: 'sdk-cycle-1',
        method: 'suspect',
        target: { marketId: HASH, borrower: `0x${'ef'.repeat(20)}` },
        recordedAt: 1000,
      },
      { event: 'daemon.failed', error: { name: 'Error', message: 'invalid configuration' } },
    ];
    for (const event of events) {
      assert.equal((await post(url, event)).status, 204, event.event);
    }
    assert.deepEqual(
      records
        .filter((record) => record.event !== 'risk-decision' && record.event !== 'screening-result')
        .map((record) => record.event),
      events.map((event) => event.event),
    );
    const exposition = await (await fetch(`${url}/metrics`)).text();
    assert.doesNotMatch(exposition, /chain_id=/);
    for (const name of new Set(events.map((event) => event.event))) {
      let count = 1;
      if (name === 'cycle.finished') {
        count = 4;
      }
      if (name === 'rpc.requestFinished') {
        count = 2;
      }
      assert.ok(exposition.includes(`lido_lend_guardian_monitor_events_total{event="${name}"} ${count}\n`), name);
    }
    const expected = [
      `${PREFIX}cycles_total{outcome="complete"} 1`,
      `${PREFIX}cycles_total{outcome="observed"} 1`,
      `${PREFIX}cycles_total{outcome="no-change"} 1`,
      `${PREFIX}cycles_total{outcome="stale"} 1`,
      `${PREFIX}cycles_total{outcome="failed"} 1`,
      `${PREFIX}last_cycle_timestamp_seconds{outcome="complete"} 10`,
      `${PREFIX}last_cycle_timestamp_seconds{outcome="observed"} 3`,
      `${PREFIX}last_cycle_timestamp_seconds{outcome="no-change"} 5`,
      `${PREFIX}last_cycle_timestamp_seconds{outcome="stale"} 6.5`,
      `${PREFIX}last_cycle_timestamp_seconds{outcome="failed"} 7.5`,
      `${PREFIX}last_cycle_duration_seconds 2`,
      `${PREFIX}report_block_number 100`,
      `${PREFIX}report_block_timestamp_seconds 1000`,
      `${PREFIX}anchors_screened_total 3`,
      `${PREFIX}risk_decisions_total{action="suspect"} 1`,
      `${PREFIX}risk_decisions_total{action="flag"} 1`,
      `${PREFIX}log_records_total{level="info"} 25`,
      `${PREFIX}transactions_total{event="skipped",method="suspect"} 1`,
      `${PREFIX}log_records_total{level="warn"} 2`,
      `${PREFIX}log_records_total{level="error"} 5`,
      `${PREFIX}transaction_preparation_duration_seconds_sum{method="heartbeat"} 0.1`,
      `${PREFIX}transaction_preparation_duration_seconds_count{method="heartbeat"} 1`,
      `${PREFIX}transaction_preparation_duration_seconds_bucket{le="0.05",method="heartbeat"} 0`,
      `${PREFIX}transaction_preparation_duration_seconds_bucket{le="0.1",method="heartbeat"} 1`,
      `${PREFIX}transaction_signing_duration_seconds_sum{method="heartbeat"} 0.05`,
      `${PREFIX}transaction_signing_duration_seconds_count{method="heartbeat"} 1`,
      `${PREFIX}transaction_signing_duration_seconds_bucket{le="0.01",method="heartbeat"} 0`,
      `${PREFIX}transaction_signing_duration_seconds_bucket{le="0.05",method="heartbeat"} 1`,
      `${PREFIX}transaction_inclusion_duration_seconds_sum{method="heartbeat"} 2`,
      `${PREFIX}transaction_inclusion_duration_seconds_count{method="heartbeat"} 1`,
      `${PREFIX}transaction_inclusion_duration_seconds_bucket{le="1",method="heartbeat"} 0`,
      `${PREFIX}transaction_inclusion_duration_seconds_bucket{le="3",method="heartbeat"} 1`,
      'lido_lend_guardian_monitor_last_event_timestamp_seconds 10',
      'http_rpc_requests_total{network="ethereum",layer="el",provider="rpc-1",batched="false",response_code="2xx",result="success"} 2',
      'rpc_request_total{network="ethereum",layer="el",provider="rpc-1",method="eth_getLogs",result="success",rpc_error_code=""} 1',
      'rpc_request_total{network="ethereum",layer="el",provider="rpc-1",method="eth_call",result="fail",rpc_error_code=""} 1',
      'http_rpc_batch_size_sum{network="ethereum",layer="el",provider="rpc-1"} 2',
      'http_rpc_batch_size_count{network="ethereum",layer="el",provider="rpc-1"} 2',
      'http_rpc_batch_size_bucket{le="1",network="ethereum",layer="el",provider="rpc-1"} 2',
      'http_rpc_response_seconds_sum{network="ethereum",layer="el",provider="rpc-1"} 0.7505',
      'http_rpc_response_seconds_count{network="ethereum",layer="el",provider="rpc-1"} 2',
      'http_rpc_response_seconds_bucket{le="0.25",network="ethereum",layer="el",provider="rpc-1"} 0',
      'http_rpc_response_seconds_bucket{le="0.5",network="ethereum",layer="el",provider="rpc-1"} 2',
      'http_rpc_request_payload_bytes_sum{network="ethereum",layer="el",provider="rpc-1"} 220',
      'http_rpc_request_payload_bytes_count{network="ethereum",layer="el",provider="rpc-1"} 2',
      'http_rpc_request_payload_bytes_bucket{le="128",network="ethereum",layer="el",provider="rpc-1"} 2',
      'http_rpc_response_payload_bytes_sum{network="ethereum",layer="el",provider="rpc-1"} 280',
      'http_rpc_response_payload_bytes_count{network="ethereum",layer="el",provider="rpc-1"} 2',
      'http_rpc_response_payload_bytes_bucket{le="128",network="ethereum",layer="el",provider="rpc-1"} 1',
      'http_rpc_response_payload_bytes_bucket{le="256",network="ethereum",layer="el",provider="rpc-1"} 2',
    ];
    for (const sample of expected) {
      assert.ok(exposition.includes(`${sample}\n`), sample);
    }
    for (const event of [
      'preparation',
      'signing',
      'broadcast',
      'included',
      'replaced',
      'retry',
      'failed',
      'action-confirmed',
    ]) {
      assert.ok(exposition.includes(`${PREFIX}transactions_total{event="${event}",method="heartbeat"} 1\n`), event);
    }
    assert.ok(exposition.includes(`${PREFIX}transactions_total{event="action-confirmed",method="cancel"} 1\n`));
    assert.equal(records.length, 32);
    assert.ok(!exposition.includes('lido_lend_guardian_monitor_failures_total{'));
    assert.ok(!exposition.includes(`${PREFIX}transaction_confirmation_duration_seconds_count`));
    assert.ok(!exposition.includes(`${PREFIX}provider_requests_total{`));
    assert.ok(!exposition.includes(`${PREFIX}provider_failures_total{`));
  });
});

test('screening events expose decisions and preserve work and skipped evidence', async () => {
  await served(async (url, records) => {
    const results = [
      {
        anchor: ANCHOR,
        result: { status: 'judged', requiresSuspect: true, requiresFlag: false, evidenceReference: 'case:'.repeat(80) },
      },
      { anchor: { ...ANCHOR, logIndex: 2 }, result: { status: 'judged', requiresSuspect: false, requiresFlag: true } },
      { anchor: { ...ANCHOR, logIndex: 3 }, result: { status: 'judged', requiresSuspect: false, requiresFlag: false } },
    ];
    const skipped = [{ target: TARGET, anchors: [ANCHOR], flaggedBy: [ANCHOR.core] }];
    assert.equal(
      (
        await post(url, {
          event: 'cycle.reconstructed',
          cycleId: 'screened',
          reportBlock: BLOCK,
          positions: 1,
          anchors: [ANCHOR],
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await post(url, {
          event: 'cycle.screened',
          cycleId: 'screened',
          reportBlock: BLOCK,
          results,
          skipped,
          suspects: [TARGET],
          flags: [TARGET],
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await post(url, {
          event: 'cycle.finished',
          cycleId: 'screened',
          startedAt: 1,
          finishedAt: 2,
          outcome: {
            kind: 'observed',
            previousHeartbeatBlock: null,
            screened: { results, skipped, suspects: [TARGET], flags: [TARGET] },
          },
        })
      ).status,
      204,
    );
    assert.ok(records.some((record) => JSON.stringify(record.details.skipped) === JSON.stringify(skipped)));
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes(`${PREFIX}anchors_screened_total 3`));
    assert.ok(metrics.includes(`${PREFIX}risk_decisions_total{action="suspect"} 1`));
    assert.ok(metrics.includes(`${PREFIX}risk_decisions_total{action="flag"} 1`));
    assert.ok(metrics.includes(`${PREFIX}cycles_total{outcome="observed"} 1`));
  });
});

test('fractional SDK RPC and inclusion timings are accepted without inventing confirmation latency', async () => {
  await served(async (url) => {
    assert.equal(
      (
        await post(url, {
          event: 'rpc.requestFinished',
          rpcIndex: 1,
          requestId: 2,
          method: 'eth_call',
          startedAt: 1000.25,
          finishedAt: 1250.75,
          httpStatus: 200,
          requestBytes: 100,
          responseBytes: 0,
          error: { name: 'RpcRequestError', message: 'refused' },
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await post(url, {
          event: 'transaction.included',
          context: CONTEXT,
          transactionHash: HASH,
          receiptBlockHash: HASH,
          receiptStatus: 'success',
          durationMs: 1500.5,
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await post(url, {
          event: 'report.confirmed',
          context: CONTEXT,
          transactionHash: HASH,
          receiptBlockHash: HASH,
          receiptStatus: 'success',
        })
      ).status,
      204,
    );
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes('http_rpc_response_seconds_sum{network="ethereum",layer="el",provider="rpc-2"} 0.2505'));
    assert.ok(metrics.includes('method="eth_call",result="fail",rpc_error_code=""} 1'));
    assert.ok(metrics.includes(`${PREFIX}transaction_inclusion_duration_seconds_sum{method="heartbeat"} 1.5005`));
    assert.ok(!metrics.includes(`${PREFIX}transaction_confirmation_duration_seconds_count`));
  });
});

test('a stale invocation and runner failures remain explicit observations', async () => {
  await served(async (url, records) => {
    assert.equal(
      (
        await post(url, {
          event: 'cycle.finished',
          cycleId: 'stale',
          startedAt: 1,
          finishedAt: 2,
          outcome: { kind: 'stale', reason: 'report-block-reorged' },
        })
      ).status,
      204,
    );
    assert.equal(
      (await post(url, { event: 'restart-budget-exhausted', restarts: 5, reason: 'report-block-reorged' })).status,
      204,
    );
    assert.equal(
      (await post(url, { event: 'cycle-not-started', error: { name: 'Error', message: 'nonce recovery failed' } }))
        .status,
      204,
    );
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes(`${PREFIX}cycles_total{outcome="stale"} 1`));
    assert.ok(metrics.includes('lido_lend_guardian_monitor_events_total{event="restart-budget-exhausted"} 1'));
    assert.deepEqual(
      records.map((record) => record.event),
      ['cycle.finished', 'restart-budget-exhausted', 'cycle-not-started'],
    );
    assert.equal(records[1]?.level, 'error');
  });
});

test('a delayed success still updates successful progress after a newer failed cycle', async () => {
  await served(async (url) => {
    assert.equal(
      (
        await post(url, {
          event: 'cycle.failed',
          cycleId: 'failed',
          startedAt: 1000,
          finishedAt: 5000,
          error: { name: 'Error', message: 'failed' },
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await post(url, {
          event: 'cycle.finished',
          cycleId: 'completed',
          startedAt: 1000,
          finishedAt: 3000,
          outcome: { kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH },
        })
      ).status,
      204,
    );
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes(`${PREFIX}last_cycle_timestamp_seconds{outcome="complete"} 3`));
    assert.ok(metrics.includes(`${PREFIX}last_cycle_timestamp_seconds{outcome="failed"} 5`));
    assert.ok(metrics.includes(`${PREFIX}last_cycle_duration_seconds 4`));
  });
});

test('a synchronous record failure returns 500, is counted and does not refresh readiness', async () => {
  const metrics = new Metrics();
  const recorder = new Recorder({
    sink: () => {
      throw new Error('private-sink-detail');
    },
  });
  const receiver = new EventReceiver({ recorder, metrics });
  const server = createServer(monitoringEndpoints({ receiver, metrics, version: 'test', progressTimeoutSeconds: 1 }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  try {
    const url = `http://127.0.0.1:${address.port}`;
    const response = await post(url, { event: 'cycle.started', cycleId: 'failed', startedAt: 1000 });
    assert.equal(response.status, 500);
    assert.equal(await response.text(), '');
    assert.equal((await fetch(`${url}/ready`)).status, 503);
    const exposition = await (await fetch(`${url}/metrics`)).text();
    assert.ok(exposition.includes('lido_lend_guardian_monitor_failures_total{reason="record"} 1'));
    assert.ok(!exposition.includes('private-sink-detail'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Prometheus event freshness is absent before events and invalid input cannot refresh it', async () => {
  await served(async (url, _records, advance) => {
    const name = 'lido_lend_guardian_monitor_last_event_timestamp_seconds';
    const before = await (await fetch(`${url}/metrics`)).text();
    assert.ok(!before.split('\n').some((line) => line.startsWith(`${name} `)));
    await post(url, { event: 'cycle.started', cycleId: 'fresh', startedAt: 1000 });
    advance();
    await post(url, { event: 'unknown' });
    assert.ok((await (await fetch(`${url}/metrics`)).text()).includes(`${name} 10`));
  });
});

test('large RPC indexes retain evidence but cannot create unbounded metric labels', async () => {
  await served(async (url, records) => {
    assert.equal(
      (
        await post(url, {
          event: 'rpc.requestFinished',
          rpcIndex: 1000000,
          requestId: 1,
          method: 'eth_call',
          startedAt: 1,
          finishedAt: 2,
          httpStatus: 200,
          requestBytes: 10,
          responseBytes: 20,
        })
      ).status,
      204,
    );
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes('provider="rpc-other"'));
    assert.ok(!metrics.includes('rpc-1000001'));
    assert.equal(records[0]?.details.rpcIndex, 1000000);
  });
});

test('nonce cancellation cannot be presented as a confirmed Guardian report', async () => {
  await served(async (url) => {
    const context = { operationId: 'cancel-1', method: 'cancel' };
    assert.equal(
      (
        await post(url, {
          event: 'report.confirmed',
          context,
          transactionHash: HASH,
          receiptStatus: 'success',
          receiptBlockHash: HASH,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post(url, { event: 'nonce.cleared', context, nonce: 1, blockNumber: '100', blockHash: HASH })).status,
      204,
    );
  });
});

test('a delayed attestation exposes its report block after a newer failed cycle', async () => {
  await served(async (url) => {
    assert.equal(
      (
        await post(url, {
          event: 'cycle.failed',
          cycleId: 'newer-failure',
          startedAt: 1000,
          finishedAt: 5000,
          error: { name: 'Error', message: 'synthetic failure' },
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await post(url, {
          event: 'cycle.finished',
          cycleId: 'earlier-success',
          startedAt: 1000,
          finishedAt: 3000,
          outcome: { kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH },
        })
      ).status,
      204,
    );
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes(`${PREFIX}report_block_number 100\n`));
    assert.ok(metrics.includes(`${PREFIX}report_block_timestamp_seconds 1000\n`));
    assert.ok(metrics.includes(`${PREFIX}last_cycle_timestamp_seconds{outcome="complete"} 3\n`));
    assert.ok(metrics.includes(`${PREFIX}last_cycle_timestamp_seconds{outcome="failed"} 5\n`));
    assert.ok(metrics.includes(`${PREFIX}last_cycle_duration_seconds 4\n`));
  });
});

test('the latest attested report block survives older attestations and later cycles without coverage', async () => {
  await served(async (url) => {
    const events = [
      {
        event: 'cycle.finished',
        cycleId: 'latest-attestation',
        startedAt: 1000,
        finishedAt: 3000,
        outcome: { kind: 'attested', previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH },
      },
      {
        event: 'cycle.finished',
        cycleId: 'older-attestation',
        startedAt: 1000,
        finishedAt: 2000,
        outcome: {
          kind: 'attested',
          previousHeartbeatBlock: { number: 50, hash: HASH, timestamp: 500 },
          heartbeat: HASH,
          digest: HASH,
        },
      },
      {
        event: 'cycle.finished',
        cycleId: 'nothing-due',
        startedAt: 1000,
        finishedAt: 4000,
        outcome: { kind: 'nothing-due', previousHeartbeatBlock: null, reason: 'no-work-and-idle-heartbeat-not-due' },
      },
      {
        event: 'cycle.failed',
        cycleId: 'failed',
        startedAt: 1000,
        finishedAt: 5000,
        error: { name: 'Error', message: 'synthetic failure' },
      },
    ];
    for (const event of events) {
      assert.equal((await post(url, event)).status, 204);
    }
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.ok(metrics.includes(`${PREFIX}report_block_number 100\n`));
    assert.ok(metrics.includes(`${PREFIX}report_block_timestamp_seconds 1000\n`));
    assert.ok(metrics.includes(`${PREFIX}cycles_total{outcome="complete"} 2\n`));
    assert.ok(metrics.includes(`${PREFIX}cycles_total{outcome="no-change"} 1\n`));
    assert.ok(metrics.includes(`${PREFIX}cycles_total{outcome="failed"} 1\n`));
    assert.ok(metrics.includes(`${PREFIX}last_cycle_duration_seconds 4\n`));
  });
});

test('application metrics remain available when runtime collection fails', async () => {
  await served(
    async (url) => {
      await post(url, { event: 'cycle.started', cycleId: 'active', startedAt: 1000 });
      const response = await fetch(`${url}/metrics`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
      const text = await response.text();
      assert.ok(text.includes('lido_lend_guardian_monitor_events_total{event="cycle.started"} 1\n'));
      assert.ok(!text.includes('private-collection-detail'));
    },
    { runtime: { metrics: () => Promise.reject(new Error('private-collection-detail')) } },
  );
});

test('an application metric collection failure returns an empty HTTP 500 response', async () => {
  class FailingMetrics extends Metrics {
    override render(): Promise<string> {
      return Promise.reject(new Error('private-collection-detail'));
    }
  }
  await served(
    async (url) => {
      const response = await fetch(`${url}/metrics`);
      assert.equal(response.status, 500);
      assert.equal(await response.text(), '');
      assert.equal((await fetch(`${url}/health`)).status, 200);
    },
    { metrics: new FailingMetrics() },
  );
});
