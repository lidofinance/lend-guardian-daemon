// The Prometheus registry. Metric names and outcome labels are those of the previous Guardian daemon, so
// the `Guardian daemon` dashboard reads them unchanged; the receiver's own state is under
// `lido_lend_guardian_monitor_`. Label values come from closed sets, never from the stream. Times
// arrive in milliseconds, as the daemon sends them, and are exposed in seconds.

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { BuildInfo } from '../daemon/main.ts';
import type { TransactionContext } from '../src/core/index.ts';
import type { DaemonIdentity } from './config.ts';
import type { EventName, Level, RejectionReason } from './events.ts';

const DAEMON = 'lido_lend_guardian_daemon_';

const MONITOR = 'lido_lend_guardian_monitor_';

/** The `outcome` label of a cycle: the previous daemon's names for the SDK's outcome kinds, and `failed`. */
const OUTCOME_LABELS = ['complete', 'observed', 'no-change', 'stale', 'incomplete', 'failed'] as const;

export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

/** The contract method of a report, `cancel` for a nonce clearing, `unknown` without a context. */
export type ReportMethod = TransactionContext['method'] | 'unknown';

/** The `event` label of a transaction: a delivery step or a report outcome. */
export type TransactionStep =
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

/** The times of an event that took a while, in Unix milliseconds. */
export interface Span {
  readonly finishedAtMs: number;
  readonly durationMs: number;
}

/** One cycle end; without both times only the count changes. */
export interface CycleSample {
  readonly outcome: OutcomeLabel;
  readonly span: Span | undefined;
}

/** One `rpc.requestFinished`, reduced to the labels of the Lido RPC metrics policy. */
export interface RpcSample {
  readonly provider: string;
  readonly method: string;
  readonly responseCode: string;
  readonly isSuccess: boolean;
  readonly errorCode: string;
  readonly span: Span | undefined;
  readonly requestBytes: number;
  readonly responseBytes: number;
}

/** One `screening.requestFinished`: a request of the daemon to the screening service. */
export interface ScreeningSample {
  readonly responseCode: string;
  readonly isSuccess: boolean;
  readonly span: Span | undefined;
  readonly judgedAnchors: number;
  readonly incompleteAnchors: number;
}

/** The daemon's posts to this receiver since the daemon started, from `daemon.forwardsCounted`. */
export interface ForwardTotals {
  /** Posts by the class of their answer's status. */
  readonly postsByResponseCode: ReadonlyMap<string, number>;
  readonly durationMs: number;
}

/** A block by its number and its timestamp in Unix seconds. */
export interface Block {
  readonly number: number;
  readonly timestamp: number;
}

const SECONDS_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const CYCLE_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800];

const DELIVERY_BUCKETS = [1, 5, 12, 24, 36, 60, 120, 240, 336];

const BYTES_BUCKETS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

/** JSON-RPC calls in one HTTP request; the SDK sends one, never a batch. */
const BATCH_BUCKETS = [1, 2, 5, 10, 20, 50, 100];

/** A screening request waits at most 290 seconds. */
const SCREENING_BUCKETS = [0.1, 0.5, 1, 5, 10, 30, 60, 120, 180, 240, 290];

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
    [...RPC_LABELS, 'batched', 'response_code', 'result'] as const,
  );

  readonly #httpSeconds = this.#histogram(
    'http_rpc_response_seconds',
    'Response time of HTTP requests to RPC endpoints by result.',
    [...RPC_LABELS, 'result'] as const,
    SECONDS_BUCKETS,
  );

  readonly #batchSize = this.#histogram(
    'http_rpc_batch_size',
    'JSON-RPC calls in one HTTP request to an RPC endpoint.',
    RPC_LABELS,
    BATCH_BUCKETS,
  );

  readonly #requestBytes = this.#histogram(
    'http_rpc_request_payload_bytes',
    'Body size of HTTP requests to RPC endpoints.',
    RPC_LABELS,
    BYTES_BUCKETS,
  );

  readonly #responseBytes = this.#histogram(
    'http_rpc_response_payload_bytes',
    'Body size of HTTP responses from RPC endpoints by result.',
    [...RPC_LABELS, 'result'] as const,
    BYTES_BUCKETS,
  );

  readonly #rpcCalls = this.#counter('rpc_request_total', 'JSON-RPC calls by method, result and JSON-RPC error code.', [
    ...RPC_LABELS,
    'method',
    'result',
    'rpc_error_code',
  ] as const);

  readonly #screeningRequests = this.#counter(
    `${DAEMON}screening_requests_total`,
    'Requests to the screening service by response code class and result.',
    ['response_code', 'result'],
  );

  readonly #screeningSeconds = this.#histogram(
    `${DAEMON}screening_request_duration_seconds`,
    'Duration of requests to the screening service by result.',
    ['result'],
    SCREENING_BUCKETS,
  );

  readonly #screeningAnchors = this.#counter(
    `${DAEMON}screening_request_anchors_total`,
    'Anchors the daemon asked the screening service about, by the answer: judged or incomplete.',
    ['result'],
  );

  readonly #posts = this.#gauge(
    `${DAEMON}event_posts`,
    "The daemon's posts to this receiver since the daemon started, by response code class; `0xx` had no answer. A running total: read it with increase().",
    ['response_code'],
  );

  readonly #postSeconds = this.#gauge(
    `${DAEMON}event_post_duration_seconds`,
    "Total duration of the daemon's posts to this receiver since the daemon started. A running total: read it with increase().",
  );

  readonly #build = this.#gauge(`${MONITOR}build_info`, 'Version, branch and commit of the receiver; 1.', [
    'version',
    'branch',
    'commit',
  ]);

  readonly #events = this.#counter(`${MONITOR}events_total`, 'Accepted events by name.', ['event']);

  readonly #rejected = this.#counter(`${MONITOR}rejected_events_total`, 'Rejected requests by reason.', ['reason']);

  readonly #lastEvent = this.#gauge(`${MONITOR}last_event_timestamp_seconds`, 'Unix time the last event was accepted.');

  readonly #lastProgress = this.#gauge(
    `${MONITOR}last_progress_timestamp_seconds`,
    'Unix time the last cycle that made progress was accepted: complete, observed or no-change.',
  );

  readonly #ready = this.#gauge(
    `${MONITOR}ready`,
    'The daemon is fresh: an event and a cycle that made progress within their windows.',
  );

  constructor(identity: DaemonIdentity, build: BuildInfo) {
    this.#chainId = identity.chainId;
    this.#info.set({ mode: identity.mode, guardian: identity.guardian, chain_id: identity.chainId }, 1);
    this.#build.set({ version: build.version, branch: build.branch, commit: build.commit }, 1);
    for (const outcome of OUTCOME_LABELS) {
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

  countEvent(event: EventName, level: Level, acceptedAtMs: number): void {
    this.#events.inc({ event });
    this.#records.inc({ level });
    this.#lastEvent.set(toSeconds(acceptedAtMs));
  }

  countRejection(reason: RejectionReason): void {
    this.#rejected.inc({ reason });
  }

  setReady(isReady: boolean): void {
    this.#ready.set(isReady ? 1 : 0);
  }

  recordCycle(cycle: CycleSample): void {
    const { outcome, span } = cycle;
    this.#cycles.inc({ outcome });
    if (span === undefined) {
      return;
    }
    this.#cycleDuration.observe({ outcome }, toSeconds(span.durationMs));
    this.#lastDuration.set(toSeconds(span.durationMs));
    this.#lastCycle.set({ outcome }, toSeconds(span.finishedAtMs));
  }

  recordProgress(acceptedAtMs: number): void {
    this.#lastProgress.set(toSeconds(acceptedAtMs));
  }

  setReportBlock(block: Block): void {
    this.#reportBlockNumber.set(block.number);
    this.#reportBlockTimestamp.set(block.timestamp);
  }

  countRestart(reason: string): void {
    this.#restarts.inc({ reason });
  }

  countRestartBudgetExhausted(): void {
    this.#budgetExhausted.inc();
  }

  countCycleNotStarted(): void {
    this.#notStarted.inc();
  }

  countTransaction(step: TransactionStep, method: ReportMethod): void {
    this.#transactions.inc({ event: step, method });
  }

  recordInclusion(method: ReportMethod, durationMs: number): void {
    this.#inclusion.observe({ method }, toSeconds(durationMs));
  }

  countAnchor(result: AnchorResult): void {
    this.#anchors.inc({ result });
    if (result === 'suspect' || result === 'flag') {
      this.#decisions.inc({ action: result });
    }
  }

  countSkippedTargets(count: number): void {
    this.#skippedTargets.inc(count);
  }

  countAnswersDiffer(): void {
    this.#answersDiffer.inc();
  }

  recordRpc(sample: RpcSample): void {
    const labels = { network: 'ethereum', layer: 'el', chain_id: this.#chainId, provider: sample.provider };
    const result = sample.isSuccess ? 'success' : 'fail';
    this.#httpRequests.inc({ ...labels, batched: 'false', response_code: sample.responseCode, result });
    this.#batchSize.observe(labels, 1);
    this.#requestBytes.observe(labels, sample.requestBytes);
    this.#responseBytes.observe({ ...labels, result }, sample.responseBytes);
    this.#rpcCalls.inc({ ...labels, method: sample.method, result, rpc_error_code: sample.errorCode });
    if (sample.span !== undefined) {
      this.#httpSeconds.observe({ ...labels, result }, toSeconds(sample.span.durationMs));
    }
  }

  recordScreening(sample: ScreeningSample): void {
    const result = sample.isSuccess ? 'success' : 'fail';
    this.#screeningRequests.inc({ response_code: sample.responseCode, result });
    this.#screeningAnchors.inc({ result: 'judged' }, sample.judgedAnchors);
    this.#screeningAnchors.inc({ result: 'incomplete' }, sample.incompleteAnchors);
    if (sample.span !== undefined) {
      this.#screeningSeconds.observe({ result }, toSeconds(sample.span.durationMs));
    }
  }

  /** The daemon's running totals as they arrive, so a restart of either process reads as a counter reset. */
  setForwardTotals(totals: ForwardTotals): void {
    this.#posts.reset();
    for (const [responseCode, posts] of totals.postsByResponseCode) {
      this.#posts.set({ response_code: responseCode }, posts);
    }
    this.#postSeconds.set(toSeconds(totals.durationMs));
  }

  #counter<Label extends string = never>(
    name: string,
    help: string,
    labelNames: readonly Label[] = [],
  ): Counter<Label> {
    return new Counter({ name, help, labelNames, registers: [this.#registry] });
  }

  #gauge<Label extends string = never>(name: string, help: string, labelNames: readonly Label[] = []): Gauge<Label> {
    return new Gauge({ name, help, labelNames, registers: [this.#registry] });
  }

  #histogram<Label extends string>(
    name: string,
    help: string,
    labelNames: readonly Label[],
    buckets: number[],
  ): Histogram<Label> {
    return new Histogram({ name, help, labelNames, buckets, registers: [this.#registry] });
  }
}

function toSeconds(milliseconds: number): number {
  return milliseconds / 1000;
}
