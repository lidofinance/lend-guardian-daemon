// The Prometheus registry. Metric names and outcome labels are those of the previous Guardian daemon, so
// the `Guardian daemon` dashboard reads them unchanged; the receiver's own state is under
// `lido_lend_guardian_monitor_`. Label values come from closed sets, never from the stream.

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { DaemonIdentity } from './config.ts';
import type { Level, Rejection } from './events.ts';

const DAEMON = 'lido_lend_guardian_daemon_';

const MONITOR = 'lido_lend_guardian_monitor_';

export type CycleOutcome = 'complete' | 'observed' | 'no-change' | 'stale' | 'failed';

export const CYCLE_OUTCOMES: readonly CycleOutcome[] = ['complete', 'observed', 'no-change', 'stale', 'failed'];

/** The registry methods a report names, plus the nonce cancellation. */
export type ReportMethod = 'suspect' | 'flag' | 'heartbeat' | 'cancel' | 'unknown';

export type TransactionStage =
  | 'preparation'
  | 'signing'
  | 'broadcast'
  | 'included'
  | 'replaced'
  | 'retry'
  | 'failed'
  | 'confirmed'
  | 'skipped'
  | 'nonce-cleared';

export type AnchorResult = 'none' | 'suspect' | 'flag' | 'incomplete';

/** One `rpc.requestFinished`, reduced to the labels of the Lido RPC metrics policy. */
export interface RpcSample {
  readonly provider: string;
  readonly method: string;
  readonly responseCode: string;
  readonly isSuccess: boolean;
  readonly errorCode: string;
  readonly durationSeconds: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
}

export interface BuildInfo {
  readonly version: string;
  readonly branch: string;
  readonly commit: string;
}

export type RejectionReason = Rejection | 'method' | 'content-type' | 'body-size';

const SECONDS_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const CYCLE_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800];

const DELIVERY_BUCKETS = [1, 5, 12, 24, 36, 60, 120, 240, 336];

const BYTES_BUCKETS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

const RPC_LABELS = ['network', 'layer', 'chain_id', 'provider'] as const;

export class Metrics {
  readonly #registry = new Registry();

  readonly #chainId: string;

  readonly #info = this.#gauge(`${DAEMON}info`, 'Mode, Guardian and chain of the daemon as the pod configures it; 1.', [
    'mode',
    'guardian',
    'chain_id',
  ]);

  readonly #cycles = this.#counter(`${DAEMON}cycles_total`, 'Finished and failed cycles by outcome.', ['outcome']);

  readonly #lastCycle = this.#gauge(
    `${DAEMON}last_cycle_timestamp_seconds`,
    'Unix time of the last finished or failed cycle, by outcome.',
    ['outcome'],
  );

  readonly #lastDuration = this.#gauge(
    `${DAEMON}last_cycle_duration_seconds`,
    'Duration of the last finished or failed cycle.',
  );

  readonly #cycleDuration = this.#histogram(
    `${DAEMON}cycle_duration_seconds`,
    'Duration of finished and failed cycles by outcome.',
    ['outcome'],
    CYCLE_BUCKETS,
  );

  readonly #reportBlockNumber = this.#gauge(
    `${DAEMON}report_block_number`,
    'Report block number of the last complete or observed cycle.',
  );

  readonly #reportBlockTimestamp = this.#gauge(
    `${DAEMON}report_block_timestamp_seconds`,
    'Unix time of the report block of the last complete or observed cycle.',
  );

  readonly #restarts = this.#counter(
    `${DAEMON}cycle_restarts_total`,
    'Plans that went stale and were rebuilt, by reason.',
    ['reason'],
  );

  readonly #budgetExhausted = this.#counter(
    `${DAEMON}restart_budget_exhausted_total`,
    'Cycles that gave up rebuilding a stale plan.',
  );

  readonly #notStarted = this.#counter(
    `${DAEMON}cycles_not_started_total`,
    'Cycles that did not start because clearing pending nonces failed.',
  );

  readonly #transactions = this.#counter(
    `${DAEMON}transactions_total`,
    'Transaction delivery steps and report outcomes by stage and contract method.',
    ['event', 'method'],
  );

  readonly #inclusion = this.#histogram(
    `${DAEMON}transaction_inclusion_duration_seconds`,
    'Time from the first broadcast to the first observed inclusion, by contract method.',
    ['method'],
    DELIVERY_BUCKETS,
  );

  readonly #anchors = this.#counter(`${DAEMON}anchors_screened_total`, 'Screened supply anchors by result.', [
    'result',
  ]);

  readonly #decisions = this.#counter(
    `${DAEMON}risk_decisions_total`,
    'Suspect and flag actions required by screening.',
    ['action'],
  );

  readonly #skippedTargets = this.#counter(
    `${DAEMON}screening_skipped_targets_total`,
    'Targets withheld from screening because this Guardian had already flagged them.',
  );

  readonly #records = this.#counter(`${DAEMON}log_records_total`, 'Accepted events by level.', ['level']);

  readonly #answersDiffer = this.#counter(
    `${DAEMON}rpc_answers_differ_total`,
    'Log reads for which the RPC providers answered differently.',
  );

  readonly #httpRequests = this.#counter(
    'http_rpc_requests_total',
    'HTTP requests to RPC endpoints by batching, response code class and result.',
    [...RPC_LABELS, 'batched', 'response_code', 'result'],
  );

  readonly #httpSeconds = this.#histogram(
    'http_rpc_response_seconds',
    'Response time of HTTP requests to RPC endpoints.',
    RPC_LABELS,
    SECONDS_BUCKETS,
  );

  readonly #requestBytes = this.#histogram(
    'http_rpc_request_payload_bytes',
    'Body size of HTTP requests to RPC endpoints.',
    RPC_LABELS,
    BYTES_BUCKETS,
  );

  readonly #responseBytes = this.#histogram(
    'http_rpc_response_payload_bytes',
    'Body size of HTTP responses from RPC endpoints.',
    RPC_LABELS,
    BYTES_BUCKETS,
  );

  readonly #rpcCalls = this.#counter('rpc_request_total', 'JSON-RPC calls by method, result and JSON-RPC error code.', [
    ...RPC_LABELS,
    'method',
    'result',
    'rpc_error_code',
  ]);

  readonly #build = this.#gauge(`${MONITOR}build_info`, 'Version, branch and commit of the receiver; 1.', [
    'version',
    'branch',
    'commit',
  ]);

  readonly #events = this.#counter(`${MONITOR}events_total`, 'Accepted events by name.', ['event']);

  readonly #rejected = this.#counter(`${MONITOR}rejected_events_total`, 'Rejected requests by reason.', ['reason']);

  readonly #lastEvent = this.#gauge(`${MONITOR}last_event_timestamp_seconds`, 'Unix time the last event was accepted.');

  readonly #lastCycleEnd = this.#gauge(
    `${MONITOR}last_cycle_end_timestamp_seconds`,
    'Unix time the last finished or failed cycle was accepted.',
  );

  readonly #ready = this.#gauge(`${MONITOR}ready`, 'The daemon is fresh: events and cycle ends within their windows.');

  constructor(identity: DaemonIdentity, build: BuildInfo) {
    this.#chainId = identity.chainId;
    this.#info.set({ mode: identity.mode, guardian: identity.guardian, chain_id: identity.chainId }, 1);
    this.#build.set({ version: build.version, branch: build.branch, commit: build.commit }, 1);
    for (const outcome of CYCLE_OUTCOMES) {
      this.#cycles.inc({ outcome }, 0);
    }
    this.#ready.set(0);
    collectDefaultMetrics({ register: this.#registry });
  }

  get contentType(): string {
    return this.#registry.contentType;
  }

  render(): Promise<string> {
    return this.#registry.metrics();
  }

  accepted(event: string, level: Level, at: number): void {
    this.#events.inc({ event });
    this.#records.inc({ level });
    this.#lastEvent.set(at);
  }

  rejected(reason: RejectionReason): void {
    this.#rejected.inc({ reason });
  }

  ready(isReady: boolean): void {
    this.#ready.set(isReady ? 1 : 0);
  }

  /** One cycle end; `finishedAt` is the source's Unix time in seconds, kept monotonic per outcome. */
  cycleEnded(outcome: CycleOutcome, finishedAt: number, durationSeconds: number, acceptedAt: number): void {
    this.#cycles.inc({ outcome });
    this.#cycleDuration.observe({ outcome }, durationSeconds);
    this.#lastDuration.set(durationSeconds);
    this.#lastCycle.set({ outcome }, finishedAt);
    this.#lastCycleEnd.set(acceptedAt);
  }

  reportBlock(number: number, timestamp: number): void {
    this.#reportBlockNumber.set(number);
    this.#reportBlockTimestamp.set(timestamp);
  }

  restart(reason: string): void {
    this.#restarts.inc({ reason });
  }

  restartBudgetExhausted(): void {
    this.#budgetExhausted.inc();
  }

  cycleNotStarted(): void {
    this.#notStarted.inc();
  }

  transaction(stage: TransactionStage, method: ReportMethod): void {
    this.#transactions.inc({ event: stage, method });
  }

  inclusion(method: ReportMethod, seconds: number): void {
    this.#inclusion.observe({ method }, seconds);
  }

  anchor(result: AnchorResult): void {
    this.#anchors.inc({ result });
    if (result === 'suspect' || result === 'flag') {
      this.#decisions.inc({ action: result });
    }
  }

  skippedTargets(count: number): void {
    this.#skippedTargets.inc(count);
  }

  answersDiffer(): void {
    this.#answersDiffer.inc();
  }

  rpc(sample: RpcSample): void {
    const labels = { network: 'ethereum', layer: 'el', chain_id: this.#chainId, provider: sample.provider };
    const result = sample.isSuccess ? 'success' : 'fail';
    this.#httpRequests.inc({ ...labels, batched: 'false', response_code: sample.responseCode, result });
    this.#httpSeconds.observe(labels, sample.durationSeconds);
    this.#requestBytes.observe(labels, sample.requestBytes);
    this.#responseBytes.observe(labels, sample.responseBytes);
    this.#rpcCalls.inc({ ...labels, method: sample.method, result, rpc_error_code: sample.errorCode });
  }

  #counter(name: string, help: string, labelNames: readonly string[] = []): Counter<string> {
    return new Counter({ name, help, labelNames: [...labelNames], registers: [this.#registry] });
  }

  #gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge<string> {
    return new Gauge({ name, help, labelNames: [...labelNames], registers: [this.#registry] });
  }

  #histogram(name: string, help: string, labelNames: readonly string[], buckets: number[]): Histogram<string> {
    return new Histogram({ name, help, labelNames: [...labelNames], buckets, registers: [this.#registry] });
  }
}
