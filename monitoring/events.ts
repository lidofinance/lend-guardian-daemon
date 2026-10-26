// The daemon's event stream as the receiver reads it: one JSON object per request, named by `event`.
// The names are the SDK's own union plus the daemon's runner records, so a new SDK event fails the
// typecheck here until the receiver knows its level.

import type { SdkEvent } from '../src/events.ts';

export type Level = 'info' | 'warn' | 'error';

/** The daemon's own records beside the SDK events (daemon/main.ts). */
export type RunnerEventName = 'cycle-not-started' | 'restart-budget-exhausted' | 'daemon.failed';

export type EventName = SdkEvent['event'] | RunnerEventName;

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
  'cycle-not-started': 'error',
  'restart-budget-exhausted': 'error',
  'daemon.failed': 'error',
} as const satisfies Record<EventName, Level>;

export const EVENT_NAMES: readonly EventName[] = Object.keys(LEVELS).filter(isEventName);

export type Payload = Readonly<Record<string, unknown>>;

export interface ReceivedEvent {
  readonly name: EventName;
  readonly payload: Payload;
}

/** Why a request body is not an event; each is a label of the rejection counter. */
export type Rejection = 'json' | 'shape' | 'unknown-event';

const MAX_DEPTH = 12;

const MAX_MESSAGE_LENGTH = 500;

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/** A key that may name a credential, whatever the daemon redacts upstream. */
const SECRET_KEY = /key|secret|token|password|authorization/i;

/** Fields the receiver never keeps: RPC parameters are the bulk of the stream and may echo a request body. */
const DROPPED_FIELDS = new Set(['params']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  const isObject = typeof value === 'object' && value !== null;
  return isObject && !Array.isArray(value);
}

export function levelOf(name: EventName): Level {
  return LEVELS[name];
}

function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value);
}

/** Parse one request body; the payload is scrubbed and bounded, with `event` and dropped fields removed. */
export function readEvent(body: string): ReceivedEvent | Rejection {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return 'json';
  }
  if (!isRecord(value)) {
    return 'shape';
  }
  const name = value.event;
  if (!isEventName(name)) {
    return 'unknown-event';
  }
  const { event: _event, ...rest } = value;
  return { name, payload: scrubRecord(rest, 0) };
}

/** A successful RPC request: thousands per cycle, counted but not printed. */
export function isRoutine(event: ReceivedEvent): boolean {
  if (event.name === 'rpc.requestStarted') {
    return true;
  }
  return event.name === 'rpc.requestFinished' && event.payload.error === undefined;
}

function scrubRecord(value: Record<string, unknown>, depth: number): Payload {
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
    return boundedText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, depth + 1));
  }
  if (isRecord(value)) {
    return scrubRecord(value, depth);
  }
  return value;
}

function boundedText(value: string): string {
  const text = value.replace(URL_PATTERN, '[url]');
  if (text.length > MAX_MESSAGE_LENGTH) {
    return `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
  }
  return text;
}
