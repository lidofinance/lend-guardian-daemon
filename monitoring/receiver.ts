import { readEvent, isObject } from './events.ts';
import type { EventName, EventPayload, ReceivedEvent } from './events.ts';
import type { Recorder, LogLevel } from './logger.ts';
import type { Metrics } from './metrics.ts';

const EVENT_LEVELS = {
  'cycle.started': 'info',
  'cycle.planned': 'info',
  'cycle.discovered': 'info',
  'cycle.reconstructed': 'info',
  'cycle.screened': 'info',
  'cycle.finished': 'info',
  'cycle.failed': 'error',
  'report.started': 'info',
  'report.confirmed': 'info',
  'report.skipped': 'info',
  'transaction.preparation': 'info',
  'transaction.signing': 'info',
  'transaction.broadcast': 'info',
  'transaction.included': 'info',
  'transaction.replaced': 'info',
  'transaction.retry': 'warn',
  'transaction.failed': 'error',
  'nonce.checked': 'info',
  'nonce.cleared': 'info',
  'rpc.requestStarted': 'info',
  'rpc.requestFinished': 'info',
  'rpc.answersDiffer': 'warn',
  'cycle-not-started': 'error',
  'restart-budget-exhausted': 'error',
  'daemon.failed': 'error',
} satisfies Record<EventName, LogLevel>;

const CYCLE_OUTCOMES: ReadonlyMap<unknown, string> = new Map([
  ['attested', 'complete'],
  ['nothing-due', 'no-change'],
  ['observed', 'observed'],
  ['stale', 'stale'],
]);

interface ReceiverOptions {
  readonly recorder: Recorder;
  readonly metrics: Metrics;
  readonly clock?: () => number;
}

/** One SDK source per receiver; source ids survive concurrent and out-of-order HTTP delivery. */
export class EventReceiver {
  readonly #options: ReceiverOptions;

  readonly #clock: () => number;

  #lastEventAt: number | null = null;

  constructor(options: ReceiverOptions) {
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
  }

  get lastEventAt(): number | null {
    return this.#lastEventAt;
  }

  /** Validation precedes all records, metrics and freshness updates. */
  receive(value: unknown): boolean {
    const event = readEvent(value);
    if (event === undefined) {
      return false;
    }
    this.#record(event);
    const at = this.#clock();
    this.#options.metrics.receivedEvent(event.name, at);
    this.#lastEventAt = at;
    return true;
  }

  #record(event: ReceivedEvent): void {
    const payload = event.payload;
    if (event.name === 'rpc.requestFinished') {
      this.#options.metrics.observeRemoteRpc(payload);
    }
    if (event.name === 'cycle.screened') {
      this.#screening(event);
    }
    this.#options.recorder.received({
      event: event.name,
      level: EVENT_LEVELS[event.name],
      details: recordDetails(event),
      ...event.metadata,
    });
  }

  #screening(event: ReceivedEvent): void {
    const results = event.payload.results;
    if (!Array.isArray(results)) {
      return;
    }
    for (const entry of results) {
      if (!isObject(entry) || !isObject(entry.result)) {
        continue;
      }
      const actions: string[] = [];
      if (entry.result.requiresSuspect === true) {
        actions.push('suspect');
      }
      if (entry.result.requiresFlag === true) {
        actions.push('flag');
      }
      let name = 'screening-result';
      const details: Record<string, unknown> = { anchor: entry.anchor };
      if (actions.length > 0) {
        details.actions = actions;
        name = 'risk-decision';
      } else {
        details.complete = entry.result.status === 'judged';
      }
      details.evidenceReference = entry.result.evidenceReference;
      this.#options.recorder.received({ event: name, level: 'info', details, ...event.metadata });
    }
  }
}

function recordDetails(event: ReceivedEvent): EventPayload {
  const { context, cycleId: _cycleId, ...payload } = event.payload;
  if (event.name === 'cycle.finished' || event.name === 'cycle.failed') {
    return cycleDetails(payload, event.name);
  }
  let operation: EventPayload = {};
  if (isObject(context)) {
    operation = context;
  }
  const { cycleId: _operationCycleId, ...operationDetails } = operation;
  const details: Record<string, unknown> = { ...payload, ...operationDetails };
  const confirmed = event.name === 'report.confirmed' || event.name === 'nonce.cleared';
  if (confirmed) {
    details.action = operation.method;
  }
  return details;
}

function cycleDetails(payload: EventPayload, event: 'cycle.finished' | 'cycle.failed'): EventPayload {
  const durationMs = Number(payload.finishedAt) - Number(payload.startedAt);
  if (event === 'cycle.failed') {
    return { ...payload, outcome: 'failed', durationMs };
  }
  let outcome: EventPayload = {};
  if (isObject(payload.outcome)) {
    outcome = payload.outcome;
  }
  const name = CYCLE_OUTCOMES.get(outcome.kind) ?? outcome.kind;
  const details: Record<string, unknown> = { ...payload, sdkOutcome: outcome, outcome: name, durationMs };
  if (outcome.kind === 'attested') {
    details.reportBlock = outcome.previousHeartbeatBlock;
  }
  details.reason = outcome.reason;
  return details;
}
