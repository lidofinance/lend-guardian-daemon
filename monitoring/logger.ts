import { randomUUID } from 'node:crypto';
import { isObject } from './events.ts';

export type LogLevel = 'info' | 'warn' | 'error' | 'fatal';

export interface LogRecord {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly runId: string;
  readonly sequence: number;
  readonly cycleId?: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly source?: 'sdk';
}

type LogSink = (record: LogRecord) => void;

interface RecorderOptions {
  readonly sink?: LogSink;
  readonly clock?: () => number;
  readonly runId?: string;
}

interface RecordInput extends Pick<LogRecord, 'event' | 'level' | 'details' | 'cycleId' | 'source'> {
  readonly timestamp?: number;
}

export const stdoutSink: LogSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

/** The receiver owns its run id and sequence. SDK cycle ids remain source evidence. */
export class Recorder {
  readonly #sink: LogSink;

  readonly #clock: () => number;

  readonly #runId: string;

  #sequence = 0;

  constructor(options: RecorderOptions = {}) {
    this.#sink = options.sink ?? stdoutSink;
    this.#clock = options.clock ?? Date.now;
    this.#runId = options.runId ?? randomUUID();
  }

  received(record: Omit<RecordInput, 'source'>): void {
    this.#write({ ...record, source: 'sdk' });
  }

  record(level: LogLevel, event: string, details: Readonly<Record<string, unknown>>): void {
    this.#write({ level, event, details });
  }

  monitorFailed(error: unknown): void {
    let name = 'Error';
    let message: string;
    if (error instanceof Error) {
      name = error.name;
      message = error.message;
    } else {
      message = printed(error);
    }
    this.record('fatal', 'monitor-failed', {
      error: { name: bounded(name, 100), message: bounded(message, 500) },
    });
  }

  #write(record: RecordInput): void {
    const details: unknown = JSON.parse(
      JSON.stringify(record.details, (_key, value: unknown) => {
        if (typeof value === 'bigint') {
          return value.toString();
        }
        return value;
      }),
    );
    if (!isObject(details)) {
      throw new Error('Record details must be an object');
    }
    this.#sequence += 1;
    const metadata: { cycleId?: string; source?: 'sdk' } = {};
    if (record.cycleId !== undefined) {
      metadata.cycleId = record.cycleId;
    }
    if (record.source !== undefined) {
      metadata.source = record.source;
    }
    this.#sink({
      schemaVersion: 1,
      timestamp: new Date(record.timestamp ?? this.#clock()).toISOString(),
      level: record.level,
      event: record.event,
      runId: this.#runId,
      sequence: this.#sequence,
      ...metadata,
      details,
    });
  }
}

function printed(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

function bounded(value: string, maximum: number): string {
  const text = value.replace(/https?:\/\/[^\s"'<>]+/g, '[url]');
  if (text.length > maximum) {
    return `${text.slice(0, maximum - 1)}…`;
  }
  return text;
}
