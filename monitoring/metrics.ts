import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { BuildInfo } from './build-info.ts';
import { isObject } from './events.ts';
import type { EventPayload, EventName } from './events.ts';
import type { LogRecord } from './logger.ts';

export const CONTENT_TYPE = Registry.PROMETHEUS_CONTENT_TYPE;

const PREFIX = 'lido_lend_guardian_daemon_';

const MONITOR = 'lido_lend_guardian_monitor_';

type MetricName =
  | `${typeof PREFIX}${string}`
  | `${typeof MONITOR}${string}`
  | `http_rpc_${string}`
  | 'rpc_request_total';

const RPC_LABELS = ['network', 'layer', 'provider'] as const;

const TRANSACTION_EVENTS: ReadonlyMap<string, string> = new Map([
  ['transaction.preparation', 'preparation'],
  ['transaction.signing', 'signing'],
  ['transaction.broadcast', 'broadcast'],
  ['transaction.included', 'included'],
  ['transaction.replaced', 'replaced'],
  ['transaction.retry', 'retry'],
  ['transaction.failed', 'failed'],
  ['report.confirmed', 'action-confirmed'],
  ['report.skipped', 'skipped'],
  ['nonce.cleared', 'action-confirmed'],
]);

interface HttpStatusLabels {
  readonly response_code: string;
  readonly result: 'success' | 'fail';
}

const HTTP_STATUS_LABELS: ReadonlyMap<number, HttpStatusLabels> = new Map([
  [0, { response_code: '0xx', result: 'fail' }],
  [1, { response_code: '1xx', result: 'fail' }],
  [2, { response_code: '2xx', result: 'success' }],
  [3, { response_code: '3xx', result: 'fail' }],
  [4, { response_code: '4xx', result: 'fail' }],
  [5, { response_code: '5xx', result: 'fail' }],
]);

export interface MetricsSource {
  metrics(): Promise<string>;
}

/** Runtime metrics belong to the monitoring process. */
export function runtimeMetrics(): MetricsSource {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return registry;
}

export class Metrics {
  readonly #registry = new Registry();

  readonly #environment: string;

  #latestCycleAt = 0;

  readonly #cycleTimes = new Map<string, number>();

  readonly #cycle = {
    count: this.#counter(`${PREFIX}cycles_total`, 'SDK cycle completions by outcome.', ['outcome']),
    timestamp: this.#gauge(`${PREFIX}last_cycle_timestamp_seconds`, 'Latest SDK cycle completion time by outcome.', [
      'outcome',
    ]),
    duration: this.#gauge(`${PREFIX}last_cycle_duration_seconds`, 'Duration of the latest SDK cycle.'),
  };

  readonly #report = {
    number: this.#gauge(`${PREFIX}report_block_number`, 'Latest attested report block number.'),
    timestamp: this.#gauge(`${PREFIX}report_block_timestamp_seconds`, 'Latest attested report block timestamp.'),
  };

  readonly #transaction = {
    count: this.#counter(`${PREFIX}transactions_total`, 'SDK transaction events by method.', ['event', 'method']),
    preparation: this.#histogram(
      `${PREFIX}transaction_preparation_duration_seconds`,
      'Preparation time per broadcast, including replacements.',
      ['method'],
      [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
    ),
    signing: this.#histogram(
      `${PREFIX}transaction_signing_duration_seconds`,
      'Signing time per broadcast, including replacements.',
      ['method'],
      [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
    ),
    inclusion: this.#histogram(
      `${PREFIX}transaction_inclusion_duration_seconds`,
      'First broadcast to inclusion time, not confirmation.',
      ['method'],
      [1, 3, 6, 12, 24, 60, 120, 300, 600],
    ),
  };

  readonly #transactionDurations: ReadonlyMap<string, Histogram<string>> = new Map([
    ['transaction.preparation', this.#transaction.preparation],
    ['transaction.signing', this.#transaction.signing],
    ['transaction.included', this.#transaction.inclusion],
  ]);

  readonly #screening = {
    anchors: this.#counter(`${PREFIX}anchors_screened_total`, 'Screened supply anchors.'),
    decisions: this.#counter(`${PREFIX}risk_decisions_total`, 'Required screening actions.', ['action']),
  };

  readonly #records = this.#counter(`${PREFIX}log_records_total`, 'Structured log records by level.', ['level']);

  readonly #rpc = {
    http: this.#counter('http_rpc_requests_total', 'RPC HTTP requests by status and result.', [
      ...RPC_LABELS,
      'batched',
      'response_code',
      'result',
    ]),
    calls: this.#counter('rpc_request_total', 'RPC calls by method and result.', [
      ...RPC_LABELS,
      'method',
      'result',
      'rpc_error_code',
    ]),
    batchSize: this.#histogram(
      'http_rpc_batch_size',
      'RPC calls per HTTP request.',
      RPC_LABELS,
      [1, 2, 5, 10, 20, 50, 100],
    ),
    responseTime: this.#histogram(
      'http_rpc_response_seconds',
      'RPC HTTP response time.',
      RPC_LABELS,
      [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    ),
    requestBytes: this.#histogram(
      'http_rpc_request_payload_bytes',
      'RPC HTTP request body size.',
      RPC_LABELS,
      [128, 256, 512, 1024, 2048, 4096, 8192, 16384],
    ),
    responseBytes: this.#histogram(
      'http_rpc_response_payload_bytes',
      'Successful RPC HTTP response body size.',
      RPC_LABELS,
      [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536],
    ),
  };

  readonly #monitor = {
    events: this.#counter(`${MONITOR}events_total`, 'Accepted SDK events by name.', ['event']),
    lastEvent: this.#gauge(`${MONITOR}last_event_timestamp_seconds`, 'Latest accepted SDK event ingestion time.', []),
    failures: this.#counter(`${MONITOR}failures_total`, 'Rejected HTTP events and record failures.', ['reason']),
  };

  constructor(options: { readonly environment?: string | undefined } = {}) {
    this.#environment = options.environment ?? 'unknown';
    for (const outcome of ['no-change', 'complete', 'observed', 'stale', 'failed']) {
      this.#cycle.count.inc({ outcome }, 0);
    }
    for (const action of ['suspect', 'flag']) {
      this.#screening.decisions.inc({ action }, 0);
    }
    for (const level of ['info', 'warn', 'error', 'fatal']) {
      this.#records.inc({ level }, 0);
    }
  }

  monitorStarted(build: BuildInfo): void {
    this.#gauge(`${MONITOR}build_info`, 'Monitoring image build.', ['name', 'env', 'version', 'branch', 'commit']).set(
      { name: 'lido-lend-guardian-monitoring', env: this.#environment, ...build },
      1,
    );
  }

  observe(record: LogRecord): void {
    this.#records.inc({ level: record.level });
    const transaction = TRANSACTION_EVENTS.get(record.event);
    if (transaction !== undefined) {
      const method = text(record.details.method);
      this.#transaction.count.inc({ event: transaction, method });
      this.#observeTransaction(record, method);
      return;
    }
    switch (record.event) {
      case 'cycle.finished':
      case 'cycle.failed':
        this.#observeCycle(record);
        return;
      case 'screening-result':
        this.#screening.anchors.inc();
        return;
      case 'risk-decision':
        this.#screening.anchors.inc();
        if (Array.isArray(record.details.actions)) {
          for (const action of record.details.actions) {
            this.#screening.decisions.inc({ action: text(action) });
          }
        }
    }
  }

  #observeTransaction(record: LogRecord, method: string): void {
    if (!['suspect', 'flag', 'heartbeat'].includes(method)) {
      return;
    }
    const { startedAt, finishedAt } = record.details;
    let durationMs = record.details.durationMs;
    if (record.event !== 'transaction.included') {
      if (typeof startedAt !== 'number' || typeof finishedAt !== 'number') {
        return;
      }
      durationMs = finishedAt - startedAt;
    }
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
      return;
    }
    if (durationMs < 0) {
      return;
    }
    const seconds = durationMs / 1000;
    this.#transactionDurations.get(record.event)?.observe({ method }, seconds);
  }

  #observeCycle(record: LogRecord): void {
    const { details } = record;
    // Source time retains fractional milliseconds that an ISO log timestamp cannot represent.
    let at: number;
    if (typeof details.finishedAt === 'number') {
      at = details.finishedAt / 1000;
    } else {
      at = Date.parse(record.timestamp) / 1000;
    }
    const outcome = text(details.outcome);
    this.#cycle.count.inc({ outcome });
    const previous = this.#cycleTimes.get(outcome) ?? -1;
    if (at >= previous) {
      this.#cycleTimes.set(outcome, at);
      this.#cycle.timestamp.set({ outcome }, at);
      const report = details.reportBlock;
      if (outcome === 'complete' && isObject(report)) {
        this.#report.number.set(Number(report.number));
        this.#report.timestamp.set(Number(report.timestamp));
      }
    }
    if (at < this.#latestCycleAt) {
      return;
    }
    this.#latestCycleAt = at;
    if (typeof details.durationMs === 'number') {
      this.#cycle.duration.set(details.durationMs / 1000);
    }
  }

  receivedEvent(event: EventName, timestamp: number): void {
    this.#monitor.events.inc({ event });
    this.#monitor.lastEvent.set(timestamp / 1000);
  }

  receiverFailed(reason: 'body' | 'schema' | 'record' | 'content-type'): void {
    this.#monitor.failures.inc({ reason });
  }

  observeRemoteRpc(payload: EventPayload): void {
    const index = Number(payload.rpcIndex);
    const labels = { network: 'ethereum', layer: 'el', provider: rpcProvider(index) };
    const http = httpStatusLabels(Number(payload.httpStatus));
    this.#rpc.http.inc({
      ...labels,
      batched: 'false',
      ...http,
    });
    let rpcResult = 'success';
    if (payload.error !== undefined) {
      rpcResult = 'fail';
    }
    this.#rpc.calls.inc({
      ...labels,
      method: text(payload.method),
      result: rpcResult,
      rpc_error_code: '',
    });
    this.#rpc.batchSize.observe(labels, 1);
    this.#rpc.responseTime.observe(labels, (Number(payload.finishedAt) - Number(payload.startedAt)) / 1000);
    this.#rpc.requestBytes.observe(labels, Number(payload.requestBytes));
    this.#rpc.responseBytes.observe(labels, Number(payload.responseBytes));
  }

  render(): Promise<string> {
    return this.#registry.metrics();
  }

  #counter(name: MetricName, help: string, labelNames: readonly string[] = []): Counter<string> {
    return new Counter({ name, help, labelNames: [...labelNames], registers: [this.#registry] });
  }

  #gauge(name: MetricName, help: string, labelNames: readonly string[] = []): Gauge<string> {
    const gauge = new Gauge<string>({
      name,
      help,
      labelNames: [...labelNames],
      registers: [this.#registry],
    });
    if (labelNames.length === 0) {
      gauge.remove({});
    }
    return gauge;
  }

  #histogram(
    name: MetricName,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ): Histogram<string> {
    return new Histogram({
      name,
      help,
      labelNames: [...labelNames],
      buckets: [...buckets],
      registers: [this.#registry],
    });
  }
}

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function rpcProvider(index: number): string {
  if (index < 64) {
    return `rpc-${index + 1}`;
  }
  return 'rpc-other';
}

function httpStatusLabels(status: number): HttpStatusLabels {
  if (status === 0) {
    return { response_code: '', result: 'fail' };
  }
  return HTTP_STATUS_LABELS.get(Math.floor(status / 100)) ?? { response_code: '', result: 'fail' };
}
