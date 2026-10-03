// The Guardian daemon: the SDK's scan cycle on a schedule, screening over HTTP, SDK events to the
// log and to an optional receiver, and a liveness endpoint. It is the reference example made
// deployable; README.md in this directory describes its configuration, contracts and limits.

import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, isAddressEqual } from 'viem';
import type { Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as env from '../example/env.ts';
import type { Mode } from '../example/env.ts';
import { createViemRpcTransport, ViemRpcClient } from '../src/chain/viem-client.ts';
import { Guardian } from '../src/core/index.ts';
import type { Address, BlockRef, CycleOutcome, EventHandler, SdkEvent, StaleReason } from '../src/core/index.ts';
import { HttpScreening, MAX_SCREENING_TIMEOUT_MS } from './screening.ts';

/** What the daemon reports of its own, beside the SDK's events and by the same path. */
type RunnerEvent =
  | { readonly event: 'cycle-not-started'; readonly error: unknown }
  | { readonly event: 'restart-budget-exhausted'; readonly restarts: number; readonly reason: StaleReason };

type DaemonEvent = SdkEvent | RunnerEvent;

/** Mainnet and Hoodi both use 12-second slots; Guardian derives a seven-day lookback from this. */
const SLOT_SECONDS = 12;

/** The longest delay Node's timers accept, in milliseconds. */
const MAX_TIMER_MS = 2_147_483_647;

/** A setting's value while its environment variable is unset, and the range a set value must fall in. */
interface Setting {
  readonly default: number;
  readonly min: number;
  readonly max?: number;
}

/**
 * Every numeric setting of the daemon, each read from the environment variable of its name; README.md
 * describes them. Guardian and its clients check their options again when they are built, the
 * combinations included, before any RPC request.
 */
const SETTINGS = {
  // A cycle every thirty slots from the start of the previous one, a failed one included.
  CYCLE_INTERVAL_MS: { default: 30 * SLOT_SECONDS * 1_000, min: 1, max: MAX_TIMER_MS },
  // How many times one cycle rebuilds a stale plan at once before it waits for the next cycle.
  MAX_RESTARTS_PER_CYCLE: { default: 5, min: 0 },
  // Guardian policy; the defaults are the reference example's.
  REPORT_BLOCK_LAG: { default: 2, min: 1 },
  FLAGGER_READ_CONCURRENCY: { default: 8, min: 1 },
  HISTORY_READ_CONCURRENCY: { default: 8, min: 1 },
  // A report that a reorg drops is sent again after the shared wait, so a batch waits only for its inclusion.
  INTER_BATCH_CONFIRMATION_BLOCKS: { default: 1, min: 1 },
  MAX_REPORT_ATTEMPTS: { default: 3, min: 1 },
  CONFIRMATION_POLL_INTERVAL_MS: { default: 12_000, min: 1, max: MAX_TIMER_MS },
  // A report costs up to about 156,000 gas per borrower, so 50 borrowers stay under half of the
  // 16,777,216 gas one transaction may use.
  MAX_SIGNAL_BATCH_SIZE: { default: 50, min: 1 },
  IDLE_HEARTBEAT_INTERVAL_SECONDS: { default: 12 * 60 * 60, min: 1 },
  HEARTBEAT_RESERVE_BLOCKS: { default: 8, min: 1 },
  // Deeper than any reorg Ethereum's proof of stake has produced, seven slots in May 2022.
  TRANSACTION_CONFIRMATION_BLOCKS: { default: 12, min: 1 },
  // The SDK's viem transport applies these to every physical HTTP attempt. A shared provider can take
  // many seconds for a log read, and viem retries an attempt that timed out.
  RPC_REQUEST_TIMEOUT_MS: { default: 30_000, min: 1, max: MAX_TIMER_MS },
  RPC_RETRY_COUNT: { default: 2, min: 0 },
  RPC_RETRY_DELAY_MS: { default: 150, min: 0 },
  MAX_RPC_RESPONSE_BODY_SIZE: { default: 10 * 1024 * 1024, min: 1 },
  // A provider's own limit; a range it refuses is read again in halves, costing a request each time.
  MAX_LOG_BLOCK_RANGE: { default: 10_000, min: 1 },
  // Transaction delivery; the defaults are the reference example's. A send fits every attempt's
  // inclusion wait, then the confirmations and one slot: 5 * 36 s + (12 + 1) * 12 s.
  SEND_TIMEOUT_MS: { default: 336_000, min: 1, max: MAX_TIMER_MS },
  REPLACEMENT_FEE_BUMP_BPS: { default: 1_000, min: 1 },
  MAX_FEE_PER_GAS_WEI: { default: 100_000_000_000, min: 1 },
  REPLACEMENT_TIMEOUT_MS: { default: 36_000, min: 1, max: MAX_TIMER_MS },
  SEND_ATTEMPTS: { default: 5, min: 1 },
  GAS_HEADROOM_BPS: { default: 2_000, min: 0 },
  // The screening service, the event receiver and the liveness endpoint.
  SCREENING_TIMEOUT_MS: { default: MAX_SCREENING_TIMEOUT_MS, min: 1, max: MAX_SCREENING_TIMEOUT_MS },
  // A receiver that has not answered by then loses the event; see README.md, Limitations.
  FORWARD_TIMEOUT_MS: { default: 5_000, min: 1, max: MAX_TIMER_MS },
  HEALTH_PORT: { default: 8_080, min: 1, max: 65_535 },
  HEALTH_WINDOW_MS: { default: 10 * 60_000, min: 1 },
} satisfies Record<string, Setting>;

const DEFAULT_RPC_USER_AGENT = 'guardian-daemon';

/** Any URL, which may carry an endpoint's credentials in its path or query. */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/** Run a cycle every `CYCLE_INTERVAL_MS` from the start of the previous one, for as long as the process lives. */
async function main(): Promise<void> {
  const mode = env.mode('MODE');
  const eventsUrl = process.env.EVENTS_URL === undefined ? undefined : readUrl('EVENTS_URL');
  const forwardTimeoutMs = setting('FORWARD_TIMEOUT_MS');
  const cycleIntervalMs = setting('CYCLE_INTERVAL_MS');
  const maxRestarts = setting('MAX_RESTARTS_PER_CYCLE');
  const healthWindowMs = healthWindow(cycleIntervalMs);
  let lastEventAt = Date.now();
  const onEvent = (event: DaemonEvent): void => {
    lastEventAt = Date.now();
    report(event, eventsUrl, forwardTimeoutMs);
  };
  const guardian = createGuardian(mode, onEvent);
  // Liveness for Docker or Kubernetes. The server does not keep the process alive, so an error that
  // ends the cycles also ends the process.
  createServer((_request, response) => {
    const isActive = Date.now() - lastEventAt < healthWindowMs;
    response.writeHead(isActive ? 200 : 503).end();
  })
    .listen(setting('HEALTH_PORT'))
    .unref();

  let previousHeartbeatBlock: BlockRef | null = null;
  while (true) {
    const startedAt = Date.now();
    previousHeartbeatBlock = await runCycle({ guardian, mode, maxRestarts, onEvent }, previousHeartbeatBlock);
    await sleep(Math.max(0, startedAt + cycleIntervalMs - Date.now()));
  }
}

/** The setting from its environment variable, or its default while the variable is unset. */
function setting(name: keyof typeof SETTINGS): number {
  const range: Setting = SETTINGS[name];
  return optionalInteger(name, range) ?? range.default;
}

/**
 * An unset variable leaves the setting at the caller's default; a set one must be a decimal integer
 * within the range. Only digits pass, so an empty value, a sign, a fraction or an exponent fails.
 */
function optionalInteger(name: string, range: { readonly min: number; readonly max?: number }): number | undefined {
  const text = process.env[name];
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  const max = range.max ?? Number.MAX_SAFE_INTEGER;
  const isInteger = /^\d+$/.test(text) && Number.isSafeInteger(value);
  const isInRange = value >= range.min && value <= max;
  if (!isInteger || !isInRange) {
    const bounds = range.max === undefined ? `of at least ${range.min}` : `from ${range.min} to ${range.max}`;
    throw new Error(`${name} must be an integer ${bounds}`);
  }
  return value;
}

/**
 * The liveness window. A working daemon reports no event for at most the pause between cycles or
 * the wait for screening, so a shorter window would report a working daemon as stuck.
 */
function healthWindow(cycleIntervalMs: number): number {
  const healthWindowMs = setting('HEALTH_WINDOW_MS');
  if (healthWindowMs <= Math.max(cycleIntervalMs, setting('SCREENING_TIMEOUT_MS'))) {
    throw new Error('HEALTH_WINDOW_MS must be longer than CYCLE_INTERVAL_MS and SCREENING_TIMEOUT_MS');
  }
  return healthWindowMs;
}

/**
 * One scheduled [scan cycle](../docs/guardian-specification.md#scan-cycle) and the hint for the next:
 * the coverage its completed call confirmed, or the hint it started from. In signal mode it first
 * clears the signer's pending nonces, so no transaction of an earlier cycle or process blocks this one;
 * the signer must have no other writer. A stale plan is rebuilt at once, up to the budget. A
 * [failed call](../docs/guardian-specification.md#failure-handling) ends the cycle, which the SDK has
 * already reported as `cycle.failed`.
 */
export async function runCycle(
  deps: {
    readonly guardian: Pick<Guardian, 'cycle' | 'clearPendingNonces'>;
    readonly mode: Mode;
    readonly maxRestarts: number;
    readonly onEvent: (event: RunnerEvent) => void;
  },
  previousHeartbeatBlock: BlockRef | null,
): Promise<BlockRef | null> {
  if (deps.mode === 'signal') {
    try {
      await deps.guardian.clearPendingNonces();
    } catch (error) {
      deps.onEvent({ event: 'cycle-not-started', error });
      return previousHeartbeatBlock;
    }
  }
  let restarts = 0;
  while (true) {
    let outcome: CycleOutcome;
    try {
      outcome = await deps.guardian.cycle(previousHeartbeatBlock);
    } catch {
      // The SDK reported the failure as `cycle.failed`; the next cycle starts from the same hint.
      return previousHeartbeatBlock;
    }
    if (outcome.kind !== 'stale') {
      return outcome.previousHeartbeatBlock;
    }
    if (restarts === deps.maxRestarts) {
      deps.onEvent({ event: 'restart-budget-exhausted', restarts, reason: outcome.reason });
      return previousHeartbeatBlock;
    }
    restarts += 1;
  }
}

/** Print the event as a JSON line and send it on; a successful RPC request is only sent. */
function report(event: DaemonEvent, eventsUrl: string | undefined, forwardTimeoutMs: number): void {
  const record = toRecord(event);
  if (!isRoutineRpc(event)) {
    console.log(record);
  }
  if (eventsUrl !== undefined) {
    forward(eventsUrl, record, forwardTimeoutMs);
  }
}

/**
 * The event as one line of JSON: amounts as decimal strings, errors as their name and message, and
 * every URL replaced, because an RPC error names its endpoint, whose path or query may hold a key.
 */
export function toRecord(event: object): string {
  return JSON.stringify(event, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'string') {
      return value.replace(URL_PATTERN, '[url]');
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    return value;
  });
}

/** A successful RPC request: thousands per cycle, which the receiver counts and the log leaves out. */
function isRoutineRpc(event: DaemonEvent): boolean {
  if (event.event === 'rpc.requestStarted') {
    return true;
  }
  return event.event === 'rpc.requestFinished' && event.error === undefined;
}

/** Post one event and move on; README.md, Limitations, states what the receiver must do. */
export function forward(url: string, record: string, timeoutMs = SETTINGS.FORWARD_TIMEOUT_MS.default): void {
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: record,
    // A receiver that does not answer cannot pile up requests in this process.
    signal: AbortSignal.timeout(timeoutMs),
  })
    // Only a read or cancelled body returns the connection to undici's pool.
    .then((response) => response.body?.cancel())
    .catch(() => {
      // Delivery is best effort; the receiver answers for its own availability.
    });
}

function readUrl(name: string): string {
  const value = process.env[name] ?? '';
  const protocol = URL.parse(value)?.protocol;
  const isHttp = protocol === 'http:' || protocol === 'https:';
  if (!isHttp) {
    throw new Error(`${name} must be an HTTP or HTTPS URL`);
  }
  return value;
}

/** The Guardian with the configured policy over the configured deployment, nodes and screening service. */
function createGuardian(mode: Mode, onEvent: EventHandler): Guardian {
  const chain = env.chain('CHAIN_ID');
  const guardian = env.address('GUARDIAN');
  const client = createClient(mode, chain, guardian, onEvent);
  return new Guardian({
    mode,
    client,
    expectedDelegate: client.signer,
    onEvent,
    deployment: {
      chainId: chain.id,
      slotSeconds: SLOT_SECONDS,
      lidoLend: {
        address: env.address('LIDO_LEND'),
        deploymentBlock: env.positiveInteger('LIDO_LEND_DEPLOYMENT_BLOCK'),
      },
      guardianSignals: {
        address: env.address('GUARDIAN_SIGNALS'),
        deploymentBlock: env.positiveInteger('GUARDIAN_SIGNALS_DEPLOYMENT_BLOCK'),
      },
    },
    guardian,
    screening: new HttpScreening(readUrl('SCREENING_URL'), setting('SCREENING_TIMEOUT_MS')),
    reportBlockLag: setting('REPORT_BLOCK_LAG'),
    flaggerReadConcurrency: setting('FLAGGER_READ_CONCURRENCY'),
    historyReadConcurrency: setting('HISTORY_READ_CONCURRENCY'),
    interBatchConfirmationBlocks: setting('INTER_BATCH_CONFIRMATION_BLOCKS'),
    maxReportAttempts: setting('MAX_REPORT_ATTEMPTS'),
    confirmationPollIntervalMs: setting('CONFIRMATION_POLL_INTERVAL_MS'),
    maxSignalBatchSize: setting('MAX_SIGNAL_BATCH_SIZE'),
    idleHeartbeatInterval: setting('IDLE_HEARTBEAT_INTERVAL_SECONDS'),
    heartbeatReserveBlocks: setting('HEARTBEAT_RESERVE_BLOCKS'),
    txConfirmationBlocks: setting('TRANSACTION_CONFIRMATION_BLOCKS'),
  });
}

/** One transport for reads and sends; observe reads no signing material and constructs no wallet. */
function createClient(mode: Mode, chain: Chain, guardian: Address, onEvent: EventHandler): ViemRpcClient {
  const transport = createViemRpcTransport({
    urls: env.rpcUrls('RPC_URLS'),
    // Unset, one endpoint answers a log read like any other request.
    logQuorum: env.optionalPositiveInteger('RPC_LOG_QUORUM'),
    timeoutMs: setting('RPC_REQUEST_TIMEOUT_MS'),
    maxResponseBodySize: setting('MAX_RPC_RESPONSE_BODY_SIZE'),
    retryCount: setting('RPC_RETRY_COUNT'),
    retryDelayMs: setting('RPC_RETRY_DELAY_MS'),
    userAgent: process.env.RPC_USER_AGENT ?? DEFAULT_RPC_USER_AGENT,
    onEvent,
  });
  const publicClient = createPublicClient({ chain, transport });
  const account = mode === 'signal' ? privateKeyToAccount(env.privateKey('SIGNER_KEY')) : undefined;
  // A hot delegate signs, so the Guardian's own key stays cold.
  if (account !== undefined && isAddressEqual(account.address, guardian)) {
    throw new Error('SIGNER_KEY is the Guardian itself, not its delegate');
  }
  const walletClient = account === undefined ? undefined : createWalletClient({ account, chain, transport });
  return new ViemRpcClient({
    publicClient,
    walletClient,
    onEvent,
    maxLogBlockRange: setting('MAX_LOG_BLOCK_RANGE'),
    transactionPolicy: {
      sendTimeoutMs: setting('SEND_TIMEOUT_MS'),
      replacementFeeBumpBps: setting('REPLACEMENT_FEE_BUMP_BPS'),
      maxFeePerGas: BigInt(setting('MAX_FEE_PER_GAS_WEI')),
      replacementTimeoutMs: setting('REPLACEMENT_TIMEOUT_MS'),
      sendAttempts: setting('SEND_ATTEMPTS'),
      gasHeadroomBps: setting('GAS_HEADROOM_BPS'),
    },
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    // A configuration or recovery error ends the process. An RPC error names its endpoint, so it is
    // printed through the same redaction as the events.
    console.error(toRecord({ event: 'daemon.failed', error }));
    process.exitCode = 1;
  }
}
