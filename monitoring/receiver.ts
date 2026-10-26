// What the receiver makes of each event: the metric it updates, the record it prints and the freshness
// it tracks. A payload field that is missing or malformed skips that update; the event still counts.

import { isRecord, isRoutine, levelOf } from './events.ts';
import type { EventName, Payload, ReceivedEvent } from './events.ts';
import type { AnchorResult, CycleOutcome, Metrics, ReportMethod, TransactionStage } from './metrics.ts';

export interface Freshness {
  readonly ready: boolean;
  readonly lastEventAt: number | null;
  readonly lastCycleEndAt: number | null;
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

interface Block {
  readonly number: number;
  readonly timestamp: number;
}

type Handler = (payload: Payload, now: number) => void;

const OUTCOMES: ReadonlyMap<string, CycleOutcome> = new Map([
  ['attested', 'complete'],
  ['observed', 'observed'],
  ['nothing-due', 'no-change'],
  ['stale', 'stale'],
]);

const STAGES: ReadonlyMap<EventName, TransactionStage> = new Map<EventName, TransactionStage>([
  ['transaction.preparation', 'preparation'],
  ['transaction.signing', 'signing'],
  ['transaction.broadcast', 'broadcast'],
  ['transaction.included', 'included'],
  ['transaction.replaced', 'replaced'],
  ['transaction.retry', 'retry'],
  ['transaction.failed', 'failed'],
  ['report.confirmed', 'confirmed'],
  ['report.skipped', 'skipped'],
  ['nonce.cleared', 'nonce-cleared'],
]);

const METHODS: ReadonlyMap<string, ReportMethod> = new Map([
  ['suspect', 'suspect'],
  ['flag', 'flag'],
  ['heartbeat', 'heartbeat'],
  ['cancel', 'cancel'],
]);

/** The methods the SDK sends; anything else is one label value, so the stream cannot grow the label set. */
const RPC_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
  'eth_call',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_sendRawTransaction',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
]);

/** Endpoint positions get their own label up to here; a longer `RPC_URLS` shares one. */
const MAX_PROVIDER_INDEX = 63;

/** Report blocks are kept per cycle until the cycle ends; a stuck cycle cannot grow this without bound. */
const MAX_REMEMBERED_CYCLES = 64;

export class Receiver {
  readonly #metrics: Metrics;

  readonly #windows: FreshnessWindows;

  readonly #sink: (line: string) => void;

  readonly #clock: () => number;

  readonly #reportBlocks = new Map<string, Block>();

  readonly #handlers: ReadonlyMap<EventName, Handler>;

  #sequence = 0;

  #lastEventAt: number | null = null;

  #lastCycleEndAt: number | null = null;

  constructor(options: ReceiverOptions) {
    this.#metrics = options.metrics;
    this.#windows = options.windows;
    this.#sink = options.sink;
    this.#clock = options.clock ?? Date.now;
    this.#handlers = new Map<EventName, Handler>([
      ['cycle.reconstructed', (payload) => this.#rememberReportBlock(payload)],
      ['cycle.screened', (payload) => this.#screened(payload)],
      ['cycle.finished', (payload, now) => this.#cycleFinished(payload, now)],
      ['cycle.failed', (payload, now) => this.#cycleEnded('failed', payload, now)],
      ['rpc.requestFinished', (payload) => this.#rpcFinished(payload)],
      ['rpc.answersDiffer', () => this.#metrics.answersDiffer()],
      ['restart-budget-exhausted', () => this.#metrics.restartBudgetExhausted()],
      ['cycle-not-started', () => this.#metrics.cycleNotStarted()],
    ]);
  }

  receive(event: ReceivedEvent): void {
    const now = this.#clock();
    this.#lastEventAt = now;
    this.#metrics.accepted(event.name, levelOf(event.name), now / 1000);
    const stage = STAGES.get(event.name);
    if (stage !== undefined) {
      this.#transaction(stage, event.payload);
    }
    this.#handlers.get(event.name)?.(event.payload, now);
    this.freshness(now);
    if (!isRoutine(event)) {
      this.#print(event, now);
    }
  }

  /** Fresh means an event within the event window and a cycle end within the cycle window. */
  freshness(now: number = this.#clock()): Freshness {
    const hasEvent = this.#lastEventAt !== null && now - this.#lastEventAt <= this.#windows.eventTimeoutMs;
    const hasCycle = this.#lastCycleEndAt !== null && now - this.#lastCycleEndAt <= this.#windows.cycleTimeoutMs;
    const ready = hasEvent && hasCycle;
    this.#metrics.ready(ready);
    return { ready, lastEventAt: this.#lastEventAt, lastCycleEndAt: this.#lastCycleEndAt };
  }

  #cycleFinished(payload: Payload, now: number): void {
    const outcome = isRecord(payload.outcome) ? payload.outcome : {};
    const kind = OUTCOMES.get(typeof outcome.kind === 'string' ? outcome.kind : '');
    if (kind === undefined) {
      return;
    }
    const block = kind === 'complete' ? blockOf(outcome.previousHeartbeatBlock) : this.#rememberedBlock(payload);
    this.#cycleEnded(kind, payload, now);
    if (kind === 'stale') {
      this.#metrics.restart(typeof outcome.reason === 'string' ? outcome.reason : 'unknown');
    }
    const hasCoverage = kind === 'complete' || kind === 'observed';
    if (block !== undefined && hasCoverage) {
      this.#metrics.reportBlock(block.number, block.timestamp);
    }
  }

  #cycleEnded(outcome: CycleOutcome, payload: Payload, now: number): void {
    this.#lastCycleEndAt = now;
    const finishedAt = numberOf(payload.finishedAt) ?? now;
    const startedAt = numberOf(payload.startedAt) ?? finishedAt;
    const durationSeconds = Math.max(0, finishedAt - startedAt) / 1000;
    this.#metrics.cycleEnded(outcome, finishedAt / 1000, durationSeconds, now / 1000);
    if (typeof payload.cycleId === 'string') {
      this.#reportBlocks.delete(payload.cycleId);
    }
  }

  #rememberReportBlock(payload: Payload): void {
    const block = blockOf(payload.reportBlock);
    if (typeof payload.cycleId !== 'string' || block === undefined) {
      return;
    }
    if (this.#reportBlocks.size >= MAX_REMEMBERED_CYCLES) {
      const oldest = this.#reportBlocks.keys().next().value;
      if (oldest !== undefined) {
        this.#reportBlocks.delete(oldest);
      }
    }
    this.#reportBlocks.set(payload.cycleId, block);
  }

  #rememberedBlock(payload: Payload): Block | undefined {
    return typeof payload.cycleId === 'string' ? this.#reportBlocks.get(payload.cycleId) : undefined;
  }

  #screened(payload: Payload): void {
    this.#rememberReportBlock(payload);
    const results = Array.isArray(payload.results) ? payload.results : [];
    for (const entry of results) {
      const result = isRecord(entry) && isRecord(entry.result) ? entry.result : {};
      this.#metrics.anchor(anchorResult(result));
    }
    if (Array.isArray(payload.skipped)) {
      this.#metrics.skippedTargets(payload.skipped.length);
    }
  }

  #transaction(stage: TransactionStage, payload: Payload): void {
    const method = methodOf(payload);
    this.#metrics.transaction(stage, method);
    const durationMs = numberOf(payload.durationMs);
    if (stage === 'included' && durationMs !== undefined) {
      this.#metrics.inclusion(method, durationMs / 1000);
    }
  }

  #rpcFinished(payload: Payload): void {
    const startedAt = numberOf(payload.startedAt);
    const finishedAt = numberOf(payload.finishedAt);
    if (startedAt === undefined || finishedAt === undefined) {
      return;
    }
    const error = isRecord(payload.error) ? payload.error : undefined;
    this.#metrics.rpc({
      provider: providerOf(payload.rpcIndex),
      method: rpcMethodOf(payload.method),
      responseCode: responseClass(numberOf(payload.httpStatus)),
      isSuccess: error === undefined,
      errorCode: errorCodeOf(error),
      durationSeconds: Math.max(0, finishedAt - startedAt) / 1000,
      requestBytes: numberOf(payload.requestBytes) ?? 0,
      responseBytes: numberOf(payload.responseBytes) ?? 0,
    });
  }

  #print(event: ReceivedEvent, now: number): void {
    this.#sequence += 1;
    const { cycleId, ...details } = event.payload;
    const record = {
      timestamp: new Date(now).toISOString(),
      sequence: this.#sequence,
      level: levelOf(event.name),
      event: event.name,
      cycleId: typeof cycleId === 'string' ? cycleId : undefined,
      details,
    };
    this.#sink(JSON.stringify(record));
  }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function blockOf(value: unknown): Block | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const number = numberOf(value.number);
  const timestamp = numberOf(value.timestamp);
  if (number === undefined || timestamp === undefined) {
    return undefined;
  }
  return { number, timestamp };
}

/** The contract method of a report, from its context; `report.skipped` names it at the top level. */
function methodOf(payload: Payload): ReportMethod {
  const context = isRecord(payload.context) ? payload.context : payload;
  const method = context.method;
  return typeof method === 'string' ? (METHODS.get(method) ?? 'unknown') : 'unknown';
}

function anchorResult(result: Record<string, unknown>): AnchorResult {
  if (result.status !== 'judged') {
    return 'incomplete';
  }
  if (result.requiresFlag === true) {
    return 'flag';
  }
  return result.requiresSuspect === true ? 'suspect' : 'none';
}

function providerOf(value: unknown): string {
  const index = numberOf(value);
  if (index === undefined || !Number.isInteger(index)) {
    return 'rpc-other';
  }
  const isInRange = index >= 0 && index <= MAX_PROVIDER_INDEX;
  return isInRange ? `rpc-${String(index)}` : 'rpc-other';
}

function rpcMethodOf(value: unknown): string {
  return typeof value === 'string' && RPC_METHODS.has(value) ? value : 'other';
}

function responseClass(status: number | undefined): string {
  if (status === undefined) {
    return '0xx';
  }
  const isHttp = status >= 100 && status <= 599;
  return isHttp ? `${String(Math.floor(status / 100))}xx` : '0xx';
}

/** The daemon serializes an error as name and message; a `code` is used when a later daemon adds one. */
function errorCodeOf(error: Record<string, unknown> | undefined): string {
  const code = error?.code;
  if (typeof code === 'number' && Number.isInteger(code)) {
    return String(code);
  }
  return '';
}
