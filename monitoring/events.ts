// The HTTP event boundary follows the SDK daemon (lend-guardian-daemon) at 7bac72aeb05560a5d48dfaf2ab98f63ceb38a553.
// Only known fields survive validation; runtime SDK classes are never reconstructed from JSON.
import { isHex } from 'viem';
import type { SdkEvent } from '../src/events.ts';

export type EventPayload = Readonly<Record<string, unknown>>;

type Check = (value: unknown) => boolean;

type Fields = Readonly<Record<string, Check>>;

const HASH = hex(32);

const ADDRESS = hex(20);

const BLOCK = object({ number: isCount, hash: HASH, timestamp: isCount });

const NULLABLE_BLOCK: Check = (value) => value === null || BLOCK(value);

const TARGET_FIELDS = { marketId: HASH, borrower: ADDRESS };

const TARGET = object(TARGET_FIELDS);

const POSITION = object({ controller: ADDRESS, ...TARGET_FIELDS });

const ANCHOR = object({ core: ADDRESS, blockHash: HASH, transactionHash: HASH, logIndex: isCount, ...TARGET_FIELDS });

const SCREENED_ANCHOR = object({ anchor: ANCHOR, result: isScreeningResult });

const SKIPPED = object({ target: TARGET, anchors: list(ANCHOR), flaggedBy: list(ADDRESS) });

const SCREENED = {
  results: list(SCREENED_ANCHOR),
  skipped: list(SKIPPED),
  suspects: list(TARGET),
  flags: list(TARGET),
};

const NOTHING_DUE = {
  previousHeartbeatBlock: NULLABLE_BLOCK,
  reason: choice(
    'report-block-before-core-deployment',
    'report-block-not-past-stored-heartbeat',
    'membership-after-report-block',
    'no-work-and-idle-heartbeat-not-due',
  ),
};

const STALE_REASON = choice(
  'head-not-past-report-block',
  'report-block-reorged',
  'report-block-aged-out',
  'stored-heartbeat-moved',
  'report-no-longer-confirmed',
);

const PLAN = variant('kind', {
  'nothing-due': NOTHING_DUE,
  plan: {
    previousHeartbeatBlock: NULLABLE_BLOCK,
    heartbeatTimestampAtStart: isCount,
    discoveryRange: object({ from: BLOCK, to: BLOCK }),
  },
});

const OUTCOME = variant('kind', {
  attested: { previousHeartbeatBlock: BLOCK, heartbeat: HASH, digest: HASH },
  'nothing-due': NOTHING_DUE,
  stale: { reason: STALE_REASON },
  observed: { previousHeartbeatBlock: NULLABLE_BLOCK, screened: object(SCREENED) },
});

const TARGET_CONTEXT = { marketId: HASH, accounts: list(ADDRESS) };

const CONTEXT = variant(
  'method',
  {
    suspect: TARGET_CONTEXT,
    flag: TARGET_CONTEXT,
    heartbeat: { reportBlock: BLOCK, coverageDigest: HASH },
    cancel: {},
  },
  { operationId: isId, cycleId: optional(isId) },
);

const ERROR = object({ name: isId, message: (value) => typeof value === 'string' });

const STAGE = choice('preparation', 'signing', 'broadcast', 'confirmation', 'nonce-clearing');

const RECEIPT_STATUS = choice('success', 'reverted');

const RPC_METHOD = choice(
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
  'eth_call',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_estimateGas',
  'eth_fillTransaction',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_sendRawTransaction',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
);

const CYCLE = { cycleId: isId };

const TIMED = { startedAt: isTimestamp, finishedAt: isTimestamp };

const RPC = { rpcIndex: isCount, requestId: isCount, method: RPC_METHOD, startedAt: isTimestamp };

const TRANSACTION = { context: optional(CONTEXT) };

const SCHEMAS = {
  'cycle.started': { ...CYCLE, startedAt: isTimestamp },
  'cycle.planned': { ...CYCLE, result: PLAN },
  'cycle.discovered': { ...CYCLE, reportBlock: BLOCK, positions: list(POSITION) },
  'cycle.reconstructed': { ...CYCLE, reportBlock: BLOCK, positions: isCount, anchors: list(ANCHOR) },
  'cycle.screened': {
    ...CYCLE,
    reportBlock: BLOCK,
    ...SCREENED,
  },
  'cycle.finished': { ...CYCLE, ...TIMED, outcome: OUTCOME },
  'cycle.failed': { ...CYCLE, ...TIMED, error: ERROR },
  'report.started': { context: isReportContext },
  'report.skipped': { cycleId: optional(isId), method: choice('suspect'), target: TARGET, recordedAt: isTimestamp },
  'report.confirmed': {
    context: isReportContext,
    transactionHash: HASH,
    receiptStatus: success,
    receiptBlockHash: HASH,
  },
  'transaction.preparation': { ...TRANSACTION, ...TIMED, attempt: isCount },
  'transaction.signing': { ...TRANSACTION, ...TIMED, attempt: isCount },
  'transaction.broadcast': { ...TRANSACTION, ...TIMED, attempt: isCount, nonce: isCount, transactionHash: HASH },
  'transaction.included': {
    ...TRANSACTION,
    transactionHash: HASH,
    receiptBlockHash: HASH,
    receiptStatus: RECEIPT_STATUS,
    durationMs: isTimestamp,
  },
  'transaction.replaced': {
    ...TRANSACTION,
    nonce: isCount,
    replacedHash: HASH,
    replacementHash: HASH,
    replacementAttempt: isCount,
  },
  'transaction.retry': { ...TRANSACTION, nonce: isCount, attempt: isCount, error: ERROR },
  'transaction.failed': {
    ...TRANSACTION,
    stage: STAGE,
    reason: optional(isId),
    error: optional(ERROR),
    receiptStatus: optional(RECEIPT_STATUS),
    receiptBlockHash: optional(HASH),
  },
  'nonce.checked': { context: CONTEXT, latest: isCount, pending: isCount },
  'nonce.cleared': { context: CONTEXT, nonce: isCount, blockNumber: isDecimal, blockHash: HASH },
  'rpc.requestStarted': { ...RPC },
  'rpc.requestFinished': {
    ...RPC,
    finishedAt: isTimestamp,
    httpStatus: isHttpStatus,
    requestBytes: isCount,
    responseBytes: isCount,
    error: optional(ERROR),
  },
  'rpc.answersDiffer': {
    method: (value) => value === 'eth_getLogs',
    acceptedRpcIndexes: list(isCount),
    otherRpcIndexes: list(isCount),
  },
  'cycle-not-started': { error: ERROR },
  'restart-budget-exhausted': { restarts: isCount, reason: STALE_REASON },
  'daemon.failed': { error: ERROR },
} satisfies Record<string, Fields>;

export type EventName = keyof typeof SCHEMAS;

/** The daemon's own records beside the SDK events, defined in daemon/main.ts. */
type RunnerEventName = 'cycle-not-started' | 'restart-budget-exhausted' | 'daemon.failed';

type Assert<Missing extends never> = Missing;

/** Every event the SDK or the daemon emits has a schema; a new SDK event fails typecheck until its schema exists. */
export type SchemasCoverEveryEvent = Assert<Exclude<SdkEvent['event'] | RunnerEventName, EventName>>;

interface EventMetadata {
  cycleId?: string;
  timestamp?: number;
}

export interface ReceivedEvent {
  readonly name: EventName;
  readonly payload: EventPayload;
  readonly metadata: Readonly<EventMetadata>;
}

/** Unknown event names and malformed fields never become records or metric labels. */
export function readEvent(value: unknown): ReceivedEvent | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const name = value.event;
  if (!isEventName(name)) {
    return undefined;
  }
  const fields: Fields = SCHEMAS[name];
  if (!matches(value, fields)) {
    return undefined;
  }
  const { startedAt, finishedAt } = value;
  const isTimed = typeof startedAt === 'number' && typeof finishedAt === 'number';
  if (isTimed && finishedAt < startedAt) {
    return undefined;
  }
  const payload = Object.fromEntries(
    Object.keys(fields)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, cleanValue(value[key], 0)]),
  );
  return { name, payload, metadata: readMetadata(payload) };
}

function readMetadata(payload: EventPayload): EventMetadata {
  let context: EventPayload = {};
  if (isObject(payload.context)) {
    context = payload.context;
  }
  const cycleId = payload.cycleId ?? context.cycleId;
  const timestamp = payload.finishedAt ?? payload.startedAt;
  const metadata: EventMetadata = {};
  if (typeof cycleId === 'string') {
    metadata.cycleId = cycleId;
  }
  if (typeof timestamp === 'number') {
    metadata.timestamp = timestamp;
  }
  return metadata;
}

function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && Object.hasOwn(SCHEMAS, value);
}

function matches(value: EventPayload, fields: Fields): boolean {
  return Object.entries(fields).every(([key, check]) => check(value[key]));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  const object = typeof value === 'object' && value !== null;
  return object && !Array.isArray(value);
}

function optional(check: Check): Check {
  return (value) => value === undefined || check(value);
}

function list(check: Check): Check {
  return (value) => Array.isArray(value) && value.every(check);
}

function isId(value: unknown): value is string {
  const text = typeof value === 'string' && value.length > 0;
  return text && value.length <= 200;
}

function isCount(value: unknown): value is number {
  const integer = typeof value === 'number' && Number.isSafeInteger(value);
  return integer && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  const number = typeof value === 'number' && Number.isFinite(value);
  const inRange = number && value >= 0;
  return inRange && value <= 8_640_000_000_000_000;
}

function hex(bytes: number): Check {
  return (value) => {
    const text = typeof value === 'string' && value.length === bytes * 2 + 2;
    return text && isHex(value, { strict: true });
  };
}

function object(fields: Fields): Check {
  return (value) => isObject(value) && matches(value, fields);
}

function choice(...choices: readonly string[]): Check {
  return (value) => typeof value === 'string' && choices.includes(value);
}

function variant(field: string, choices: Readonly<Record<string, Fields>>, common: Fields = {}): Check {
  const schemas = new Map(Object.entries(choices).map(([name, fields]) => [name, { ...common, ...fields }]));
  return function hasVariant(value: unknown): boolean {
    if (!isObject(value)) {
      return false;
    }
    const name = value[field];
    if (typeof name !== 'string') {
      return false;
    }
    const fields = schemas.get(name);
    return fields !== undefined && matches(value, fields);
  };
}

function isDecimal(value: unknown): boolean {
  return typeof value === 'string' && /^\d{1,78}$/.test(value);
}

function success(value: unknown): boolean {
  return value === 'success';
}

function isScreeningResult(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  const reference = value.evidenceReference;
  const absent = reference === undefined || reference === null;
  const text = typeof reference === 'string' && reference.length > 0;
  if (!absent && !text) {
    return false;
  }
  if (value.status === 'incomplete') {
    return true;
  }
  const judged = value.status === 'judged';
  const decisions = typeof value.requiresSuspect === 'boolean' && typeof value.requiresFlag === 'boolean';
  return judged && decisions;
}

function isReportContext(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  return CONTEXT(value) && value.method !== 'cancel';
}

function isHttpStatus(value: unknown): boolean {
  return isCount(value) && value <= 599;
}

function cleanValue(value: unknown, depth: number): unknown {
  if (depth > 12) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/[^\s"'<>]+/g, '[url]');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cleanValue(entry, depth + 1));
  }
  if (!isObject(value)) {
    return value;
  }
  if (ERROR(value)) {
    return { name: cleanValue(value.name, depth + 1), message: boundedMessage(value.message) };
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/key|secret|token|password|authorization/i.test(key))
      .map(([key, entry]) => [key, cleanValue(entry, depth + 1)]),
  );
}

function boundedMessage(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const message = value.replace(/https?:\/\/[^\s"'<>]+/g, '[url]');
  if (message.length > 500) {
    return `${message.slice(0, 499)}…`;
  }
  return message;
}
