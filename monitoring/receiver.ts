// What the receiver makes of each event: the metric it updates, the record it prints and the freshness
// it tracks. Every accepted event counts; a payload field that is missing or malformed leaves out only
// what needs it, as a duration needs both times.

import type { CycleOutcome, StaleReason, TransactionContext } from '../src/core/index.ts';
import { chooseLevel, formatRecord, isRecord, isRoutine } from './events.ts';
import type { EventName, Payload, ReceivedEvent } from './events.ts';
import type { AnchorResult, Block, Metrics, OutcomeLabel, ReportMethod, Span, TransactionStep } from './metrics.ts';

export interface Freshness {
  readonly ready: boolean;
  readonly lastEventAt: number | null;
  /** When the last cycle that made progress ended: complete, observed or no-change. */
  readonly lastProgressAt: number | null;
}

export interface FreshnessWindows {
  readonly eventTimeoutMs: number;
  readonly cycleTimeoutMs: number;
}

export interface ReceiverOptions {
  readonly metrics: Metrics;
  readonly windows: FreshnessWindows;
  /** One JSON line per printed record. */
  readonly sink: (line: string) => void;
  readonly clock?: () => number;
}

type Handler = (event: ReceivedEvent, now: number) => void;

/** The previous daemon's label of each SDK outcome kind. */
const OUTCOME_LABELS = {
  attested: 'complete',
  observed: 'observed',
  'nothing-due': 'no-change',
  stale: 'stale',
  incomplete: 'incomplete',
} as const satisfies Record<CycleOutcome['kind'], OutcomeLabel>;

/** The outcomes that move the daemon forward; `stale`, `incomplete` and `failed` do not. */
const PROGRESS: ReadonlySet<OutcomeLabel> = new Set<OutcomeLabel>(['complete', 'observed', 'no-change']);

const REPORT_METHODS = {
  suspect: true,
  flag: true,
  heartbeat: true,
  cancel: true,
} as const satisfies Record<TransactionContext['method'], true>;

/** The methods the SDK sends; anything else is one label value, so the stream cannot grow the label set. */
const RPC_METHODS = {
  eth_chainId: true,
  eth_blockNumber: true,
  eth_getBlockByNumber: true,
  eth_getBlockByHash: true,
  eth_getLogs: true,
  eth_call: true,
  eth_getCode: true,
  eth_getTransactionCount: true,
  eth_estimateGas: true,
  eth_gasPrice: true,
  eth_feeHistory: true,
  eth_maxPriorityFeePerGas: true,
  eth_sendRawTransaction: true,
  eth_getTransactionReceipt: true,
  eth_getTransactionByHash: true,
} as const;

/** The SDK's stale reasons; any other text is one label value, so the stream cannot grow the label set. */
const STALE_REASONS = {
  'head-not-past-report-block': true,
  'report-block-reorged': true,
  'report-block-aged-out': true,
  'stored-heartbeat-moved': true,
  'report-no-longer-confirmed': true,
} as const satisfies Record<StaleReason, true>;

/** JSON-RPC's reserved error codes; a node's execution error, `3`, is the one code outside them it sends. */
const MIN_RPC_ERROR_CODE = -32_768;

const MAX_RPC_ERROR_CODE = -32_000;

const EXECUTION_ERROR_CODE = 3;

/** Endpoint positions get their own label up to here; a longer `RPC_URLS` shares one. */
const MAX_PROVIDER_INDEX = 63;

/** Report blocks are kept per cycle until the cycle ends; a stuck cycle cannot grow this without bound. */
const MAX_REMEMBERED_CYCLES = 64;

export class Receiver {
  readonly #metrics: Metrics;

  readonly #windows: FreshnessWindows;

  readonly #sink: (line: string) => void;

  readonly #clock: () => number;

  /** The report block of each cycle whose reconstruction arrived, until the cycle ends. */
  readonly #reportBlocksByCycle = new Map<string, Block>();

  readonly #handlers: ReadonlyMap<EventName, Handler>;

  #sequence = 0;

  #lastEventAt: number | null = null;

  #lastProgressAt: number | null = null;

  constructor(options: ReceiverOptions) {
    this.#metrics = options.metrics;
    this.#windows = options.windows;
    this.#sink = options.sink;
    this.#clock = options.clock ?? Date.now;
    this.#handlers = new Map<EventName, Handler>([
      ['cycle.reconstructed', (event) => this.#rememberReportBlock(event)],
      ['cycle.screened', (event) => this.#countScreened(event)],
      ['cycle.finished', (event, now) => this.#recordFinishedCycle(event, now)],
      ['cycle.failed', (event) => this.#recordFailedCycle(event)],
      ['transaction.preparation', ({ payload }) => this.#countTransaction('preparation', payload)],
      ['transaction.signing', ({ payload }) => this.#countTransaction('signing', payload)],
      ['transaction.broadcast', ({ payload }) => this.#countTransaction('broadcast', payload)],
      ['transaction.included', ({ payload }) => this.#countTransaction('included', payload)],
      ['transaction.replaced', ({ payload }) => this.#countTransaction('replaced', payload)],
      ['transaction.retry', ({ payload }) => this.#countTransaction('retry', payload)],
      ['transaction.failed', ({ payload }) => this.#countTransaction('failed', payload)],
      ['report.confirmed', ({ payload }) => this.#countTransaction('confirmed', payload)],
      ['report.skipped', ({ payload }) => this.#countTransaction('skipped', payload)],
      ['nonce.cleared', ({ payload }) => this.#countTransaction('nonce-cleared', payload)],
      ['rpc.requestFinished', ({ payload }) => this.#recordRpc(payload)],
      ['rpc.answersDiffer', () => this.#metrics.countAnswersDiffer()],
      ['schedule.restartBudgetExhausted', () => this.#metrics.countRestartBudgetExhausted()],
      ['schedule.cycleNotStarted', () => this.#metrics.countCycleNotStarted()],
      ['screening.requestFinished', ({ payload }) => this.#recordScreening(payload)],
      ['daemon.forwardsCounted', ({ payload }) => this.#setForwardTotals(payload)],
    ]);
  }

  receive(event: ReceivedEvent): void {
    const now = this.#clock();
    this.#lastEventAt = now;
    this.#metrics.countEvent(event.name, chooseLevel(event), now);
    this.#handlers.get(event.name)?.(event, now);
    if (!isRoutine(event)) {
      this.#print(event, now);
    }
  }

  /** Fresh means an event within the event window and a cycle that made progress within the cycle window. */
  freshness(now: number = this.#clock()): Freshness {
    const hasEvent = this.#lastEventAt !== null && now - this.#lastEventAt <= this.#windows.eventTimeoutMs;
    const hasProgress = this.#lastProgressAt !== null && now - this.#lastProgressAt <= this.#windows.cycleTimeoutMs;
    return { ready: hasEvent && hasProgress, lastEventAt: this.#lastEventAt, lastProgressAt: this.#lastProgressAt };
  }

  #recordFinishedCycle(event: ReceivedEvent, now: number): void {
    const outcome = isRecord(event.payload.outcome) ? event.payload.outcome : {};
    const kind = outcome.kind;
    if (!isTableKey(OUTCOME_LABELS, kind)) {
      return;
    }
    const label = OUTCOME_LABELS[kind];
    const reconstructedBlock = this.#takeReportBlock(event.cycleId);
    this.#metrics.recordCycle({ outcome: label, span: readSpan(event.payload) });
    if (PROGRESS.has(label)) {
      this.#lastProgressAt = now;
      this.#metrics.recordProgress(now);
    }
    if (kind === 'stale') {
      this.#metrics.countRestart(labelStaleReason(outcome.reason));
    }
    // An attested outcome's `previousHeartbeatBlock` is the block this heartbeat committed; in the other
    // outcomes it is the earlier heartbeat's, so an observed cycle reports the block it reconstructed.
    const coveredBlock = kind === 'attested' ? readBlock(outcome.previousHeartbeatBlock) : reconstructedBlock;
    const hasCoverage = kind === 'attested' || kind === 'observed';
    if (coveredBlock !== undefined && hasCoverage) {
      this.#metrics.setReportBlock(coveredBlock);
    }
  }

  #recordFailedCycle(event: ReceivedEvent): void {
    this.#takeReportBlock(event.cycleId);
    this.#metrics.recordCycle({ outcome: 'failed', span: readSpan(event.payload) });
  }

  #rememberReportBlock(event: ReceivedEvent): void {
    const block = readBlock(event.payload.reportBlock);
    if (event.cycleId === undefined || block === undefined) {
      return;
    }
    if (this.#reportBlocksByCycle.size >= MAX_REMEMBERED_CYCLES) {
      const oldest = this.#reportBlocksByCycle.keys().next().value;
      if (oldest !== undefined) {
        this.#reportBlocksByCycle.delete(oldest);
      }
    }
    this.#reportBlocksByCycle.set(event.cycleId, block);
  }

  /** The report block remembered for the cycle, which ends here, so it is forgotten. */
  #takeReportBlock(cycleId: string | undefined): Block | undefined {
    if (cycleId === undefined) {
      return undefined;
    }
    const block = this.#reportBlocksByCycle.get(cycleId);
    this.#reportBlocksByCycle.delete(cycleId);
    return block;
  }

  #countScreened(event: ReceivedEvent): void {
    this.#rememberReportBlock(event);
    const { results, skipped } = event.payload;
    for (const entry of Array.isArray(results) ? results : []) {
      const result = isRecord(entry) && isRecord(entry.result) ? entry.result : {};
      this.#metrics.countAnchor(classifyAnchor(result));
    }
    if (Array.isArray(skipped)) {
      this.#metrics.countSkippedTargets(skipped.length);
    }
  }

  #countTransaction(step: TransactionStep, payload: Payload): void {
    const method = readReportMethod(payload);
    this.#metrics.countTransaction(step, method);
    const durationMs = readNumber(payload.durationMs);
    if (step === 'included' && durationMs !== undefined) {
      this.#metrics.recordInclusion(method, durationMs);
    }
  }

  #recordRpc(payload: Payload): void {
    const error = isRecord(payload.error) ? payload.error : undefined;
    this.#metrics.recordRpc({
      provider: labelProvider(payload.rpcIndex),
      method: labelRpcMethod(payload.method),
      responseCode: classifyStatus(readNumber(payload.httpStatus)),
      isSuccess: error === undefined,
      errorCode: labelErrorCode(error),
      span: readSpan(payload),
      requestBytes: readNumber(payload.requestBytes) ?? 0,
      responseBytes: readNumber(payload.responseBytes) ?? 0,
    });
  }

  #recordScreening(payload: Payload): void {
    this.#metrics.recordScreening({
      responseCode: classifyStatus(readNumber(payload.httpStatus)),
      isSuccess: payload.error === undefined,
      span: readSpan(payload),
      judgedAnchors: readNumber(payload.judged) ?? 0,
      incompleteAnchors: readNumber(payload.incomplete) ?? 0,
    });
  }

  /** The daemon's post totals, whose statuses are summed by class; a malformed entry skips the update. */
  #setForwardTotals(payload: Payload): void {
    const durationMs = readNumber(payload.durationMs);
    if (!isRecord(payload.posts) || durationMs === undefined) {
      return;
    }
    const postsByResponseCode = new Map<string, number>();
    for (const [status, value] of Object.entries(payload.posts)) {
      const posts = readNumber(value);
      if (posts === undefined) {
        return;
      }
      const responseCode = classifyStatus(Number(status));
      postsByResponseCode.set(responseCode, (postsByResponseCode.get(responseCode) ?? 0) + posts);
    }
    this.#metrics.setForwardTotals({ postsByResponseCode, durationMs });
  }

  #print(event: ReceivedEvent, now: number): void {
    this.#sequence += 1;
    const record = {
      timestamp: new Date(now).toISOString(),
      sequence: this.#sequence,
      level: chooseLevel(event),
      event: event.name,
      cycleId: event.cycleId,
      details: event.payload,
    };
    this.#sink(formatRecord(record));
  }
}

/** Whether a value is a key of a closed table, narrowed to that key. */
function isTableKey<Key extends string>(table: Readonly<Record<Key, unknown>>, value: unknown): value is Key {
  return typeof value === 'string' && Object.hasOwn(table, value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBlock(value: unknown): Block | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const number = readNumber(value.number);
  const timestamp = readNumber(value.timestamp);
  if (number === undefined || timestamp === undefined) {
    return undefined;
  }
  return { number, timestamp };
}

/** The span of an event from its `startedAt` and `finishedAt`, or none without both. */
function readSpan(payload: Payload): Span | undefined {
  const startedAt = readNumber(payload.startedAt);
  const finishedAt = readNumber(payload.finishedAt);
  if (startedAt === undefined || finishedAt === undefined) {
    return undefined;
  }
  return { finishedAtMs: finishedAt, durationMs: Math.max(0, finishedAt - startedAt) };
}

/** The contract method of a report, from its context; `report.skipped` names it at the top level. */
function readReportMethod(payload: Payload): ReportMethod {
  const context = isRecord(payload.context) ? payload.context : payload;
  return isTableKey(REPORT_METHODS, context.method) ? context.method : 'unknown';
}

function classifyAnchor(result: Readonly<Record<string, unknown>>): AnchorResult {
  if (result.status !== 'judged') {
    return 'incomplete';
  }
  if (result.requiresFlag === true) {
    return 'flag';
  }
  return result.requiresSuspect === true ? 'suspect' : 'none';
}

/** The `response_code` label: the class of an HTTP status, `0xx` without one. */
function classifyStatus(status: number | undefined): string {
  if (status === undefined) {
    return '0xx';
  }
  const isHttp = status >= 100 && status <= 599;
  return isHttp ? `${String(Math.floor(status / 100))}xx` : '0xx';
}

function labelProvider(value: unknown): string {
  const index = readNumber(value);
  if (index === undefined || !Number.isInteger(index)) {
    return 'rpc-other';
  }
  const isInRange = index >= 0 && index <= MAX_PROVIDER_INDEX;
  return isInRange ? `rpc-${String(index)}` : 'rpc-other';
}

function labelRpcMethod(value: unknown): string {
  return isTableKey(RPC_METHODS, value) ? value : 'other';
}

/**
 * The daemon keeps an error's numeric code, such as the node's JSON-RPC error code; other errors have none.
 * A code outside the JSON-RPC set is one label value, so the stream cannot grow the label set.
 */
function labelErrorCode(error: Readonly<Record<string, unknown>> | undefined): string {
  const code = error?.code;
  if (typeof code !== 'number' || !Number.isInteger(code)) {
    return '';
  }
  const isReserved = code >= MIN_RPC_ERROR_CODE && code <= MAX_RPC_ERROR_CODE;
  return isReserved || code === EXECUTION_ERROR_CODE ? String(code) : 'other';
}

function labelStaleReason(value: unknown): string {
  return isTableKey(STALE_REASONS, value) ? value : 'other';
}
