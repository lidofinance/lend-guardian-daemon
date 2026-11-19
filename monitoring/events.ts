// The daemon's event stream as the receiver reads it: one JSON object per request, named by `event`.
// The names are those of the daemon's own event union, so a new daemon or SDK event fails the
// typecheck here until the receiver knows its level.

import type { DaemonEvent } from '../daemon/main.ts';

export type Level = 'info' | 'warn' | 'error';

export type EventName = DaemonEvent['event'];

const LEVELS = {
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
  'transaction.replaced': 'warn',
  'transaction.retry': 'warn',
  'transaction.failed': 'error',
  'nonce.checked': 'info',
  'nonce.cleared': 'warn',
  'rpc.requestStarted': 'info',
  'rpc.requestFinished': 'info',
  'rpc.answersDiffer': 'warn',
  'schedule.cycleNotStarted': 'error',
  'schedule.restartBudgetExhausted': 'error',
  'screening.requestFinished': 'info',
  'daemon.started': 'info',
  'daemon.forwardsCounted': 'info',
} as const satisfies Record<EventName, Level>;

export const EVENT_NAMES: readonly EventName[] = Object.keys(LEVELS).filter(isEventName);

export type Payload = Readonly<Record<string, unknown>>;

export interface ReceivedEvent {
  readonly name: EventName;
  /** The cycle the event belongs to, when it names one. */
  readonly cycleId: string | undefined;
  /** Every other field, scrubbed and bounded. */
  readonly payload: Payload;
}

/** Why a request is refused; each is a label of the rejection counter. */
export type RejectionReason = 'method' | 'content-type' | 'body-size' | 'json' | 'shape' | 'unknown-event';

/** A request body: an event, or why it is none. */
export type ParsedBody =
  | { readonly kind: 'event'; readonly event: ReceivedEvent }
  | { readonly kind: 'rejected'; readonly reason: Extract<RejectionReason, 'json' | 'shape' | 'unknown-event'> };

const MAX_DEPTH = 12;

const MAX_MESSAGE_LENGTH = 500;

/** Any URL, which may carry an endpoint's credentials; the receiver replaces it in any text, whatever the sender masked. */
const URL_PATTERN = /https?:\/\/[^\s"<>]+/gi;

/** A key that may name a credential, whatever the daemon redacts upstream. */
const SECRET_KEY = /key|secret|token|pass|private|credential|authorization/i;

/** Fields the receiver never keeps: RPC parameters are the bulk of the stream and may echo a request body. */
const DROPPED_FIELDS = new Set(['params']);

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  const isObject = typeof value === 'object' && value !== null;
  return isObject && !Array.isArray(value);
}

/** The level of an event's record; a screening request without a usable answer is a warning. */
export function chooseLevel(event: ReceivedEvent): Level {
  const isFailedScreening = event.name === 'screening.requestFinished' && event.payload.error !== undefined;
  return isFailedScreening ? 'warn' : LEVELS[event.name];
}

function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value);
}

/** Parse one request body; the payload is scrubbed and bounded, without `event`, `cycleId` and dropped fields. */
export function readEvent(body: string): ParsedBody {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    // The refusal says the body is not JSON; the parser's message adds nothing the sender can act on.
    return { kind: 'rejected', reason: 'json' };
  }
  if (!isRecord(value)) {
    return { kind: 'rejected', reason: 'shape' };
  }
  const { event: name, cycleId, ...rest } = value;
  if (!isEventName(name)) {
    return { kind: 'rejected', reason: 'unknown-event' };
  }
  const event = { name, cycleId: typeof cycleId === 'string' ? cycleId : undefined, payload: scrubRecord(rest, 0) };
  return { kind: 'event', event };
}

/**
 * A successful RPC request: thousands per cycle, counted but not printed. `EventReporter.report` in
 * `daemon/main.ts` leaves the same events out of the daemon's log.
 */
export function isRoutine(event: ReceivedEvent): boolean {
  if (event.name === 'rpc.requestStarted') {
    return true;
  }
  return event.name === 'rpc.requestFinished' && event.payload.error === undefined;
}

/**
 * One line of the receiver's output, for an event's record and for the receiver's own: every line goes
 * through the same scrub, so no credential-named field, URL or unbounded text is printed.
 */
export function formatRecord(record: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(scrubRecord(record, 0));
}

function scrubRecord(value: Readonly<Record<string, unknown>>, depth: number): Payload {
  const entries = Object.entries(value)
    .filter(([key]) => !DROPPED_FIELDS.has(key))
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, entry]): [string, unknown] => [key, scrub(entry, depth + 1)]);
  return Object.fromEntries(entries);
}

function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  if (typeof value === 'string') {
    return scrubText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, depth + 1));
  }
  if (isRecord(value)) {
    return scrubRecord(value, depth);
  }
  return value;
}

/** The text with every URL replaced and cut to the longest message a record keeps. */
function scrubText(value: string): string {
  const text = value.replace(URL_PATTERN, '[url]');
  if (text.length > MAX_MESSAGE_LENGTH) {
    return `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
  }
  return text;
}
