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
import { HttpScreening } from './screening.ts';

/** What the daemon reports of its own, beside the SDK's events and by the same path. */
type RunnerEvent =
  | { readonly event: 'cycle-not-started'; readonly error: unknown }
  | { readonly event: 'restart-budget-exhausted'; readonly restarts: number; readonly reason: StaleReason };

type DaemonEvent = SdkEvent | RunnerEvent;

/** Mainnet and Hoodi both use 12-second slots; Guardian derives a seven-day lookback from this. */
const SLOT_SECONDS = 12;

/** A cycle every thirty slots from the start of the previous one, a failed one included. */
const CYCLE_INTERVAL_MS = 30 * SLOT_SECONDS * 1_000;

/** How many times one cycle rebuilds a stale plan at once before it waits for the next cycle. */
const MAX_RESTARTS_PER_CYCLE = 5;

// Guardian policy of this daemon, the same as the reference example's.
const REPORT_BLOCK_LAG = 2;
const FLAGGER_READ_CONCURRENCY = 8;
const INTER_BATCH_CONFIRMATION_BLOCKS = 2;
const CONFIRMATION_POLL_INTERVAL_MS = 12_000;
const MAX_SIGNAL_BATCH_SIZE = 20;
const IDLE_HEARTBEAT_INTERVAL_SECONDS = 12 * 60 * 60;
const HEARTBEAT_RESERVE_BLOCKS = 8;
const TRANSACTION_CONFIRMATION_BLOCKS = 12;

// The SDK's viem transport applies these settings to every physical HTTP attempt.
const RPC_REQUEST_TIMEOUT_MS = 10_000;
const RPC_RETRY_COUNT = 2;
const RPC_RETRY_DELAY_MS = 150;
const MAX_RPC_RESPONSE_BODY_SIZE = 10 * 1024 * 1024;
const RPC_USER_AGENT = 'guardian-daemon';
const MAX_LOG_BLOCK_RANGE = 10_000;

// Transaction delivery policy of this daemon.
const SEND_TIMEOUT_MS = 264_000;
const REPLACEMENT_FEE_BUMP_BPS = 1_000;
const MAX_FEE_PER_GAS_WEI = 100_000_000_000n;
const REPLACEMENT_TIMEOUT_MS = 36_000;
const SEND_ATTEMPTS = 5;

const HEALTH_PORT = 8080;

/** Longer than the pause between cycles, the longest time the daemon reports no event while it works. */
const HEALTH_WINDOW_MS = 10 * 60_000;

/** A receiver that has not answered by then loses the event; see README.md, Limitations. */
const FORWARD_TIMEOUT_MS = 5_000;

/** Any URL, which may carry an endpoint's credentials in its path or query. */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/** Run a cycle every thirty slots, from the start of the previous one, for as long as the process lives. */
async function main(): Promise<void> {
  const mode = env.mode('MODE');
  const eventsUrl = process.env.EVENTS_URL === undefined ? undefined : readUrl('EVENTS_URL');
  let lastEventAt = Date.now();
  const onEvent = (event: DaemonEvent): void => {
    lastEventAt = Date.now();
    report(event, eventsUrl);
  };
  const guardian = createGuardian(mode, onEvent);
  // Liveness for Docker or Kubernetes. The server does not keep the process alive, so an error that
  // ends the cycles also ends the process.
  createServer((_request, response) => {
    const isActive = Date.now() - lastEventAt < HEALTH_WINDOW_MS;
    response.writeHead(isActive ? 200 : 503).end();
  })
    .listen(HEALTH_PORT)
    .unref();

  let previousHeartbeatBlock: BlockRef | null = null;
  while (true) {
    const startedAt = Date.now();
    previousHeartbeatBlock = await runCycle({ guardian, mode, onEvent }, previousHeartbeatBlock);
    await sleep(Math.max(0, startedAt + CYCLE_INTERVAL_MS - Date.now()));
  }
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
    if (restarts === MAX_RESTARTS_PER_CYCLE) {
      deps.onEvent({ event: 'restart-budget-exhausted', restarts, reason: outcome.reason });
      return previousHeartbeatBlock;
    }
    restarts += 1;
  }
}

/** Print the event as a JSON line and send it on; a successful RPC request is only sent. */
function report(event: DaemonEvent, eventsUrl: string | undefined): void {
  const record = toRecord(event);
  if (!isRoutineRpc(event)) {
    console.log(record);
  }
  if (eventsUrl !== undefined) {
    forward(eventsUrl, record);
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
export function forward(url: string, record: string): void {
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: record,
    // A receiver that does not answer cannot pile up requests in this process.
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
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

/** The Guardian with this daemon's policy over the configured deployment, nodes and screening service. */
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
    screening: new HttpScreening(readUrl('SCREENING_URL')),
    reportBlockLag: REPORT_BLOCK_LAG,
    flaggerReadConcurrency: FLAGGER_READ_CONCURRENCY,
    interBatchConfirmationBlocks: INTER_BATCH_CONFIRMATION_BLOCKS,
    confirmationPollIntervalMs: CONFIRMATION_POLL_INTERVAL_MS,
    maxSignalBatchSize: MAX_SIGNAL_BATCH_SIZE,
    idleHeartbeatInterval: IDLE_HEARTBEAT_INTERVAL_SECONDS,
    heartbeatReserveBlocks: HEARTBEAT_RESERVE_BLOCKS,
    txConfirmationBlocks: TRANSACTION_CONFIRMATION_BLOCKS,
  });
}

/** One transport for reads and sends; observe reads no signing material and constructs no wallet. */
function createClient(mode: Mode, chain: Chain, guardian: Address, onEvent: EventHandler): ViemRpcClient {
  const transport = createViemRpcTransport({
    urls: env.rpcUrls('RPC_URLS'),
    // Unset, one endpoint answers a log read like any other request.
    logQuorum: env.optionalPositiveInteger('RPC_LOG_QUORUM'),
    timeoutMs: RPC_REQUEST_TIMEOUT_MS,
    maxResponseBodySize: MAX_RPC_RESPONSE_BODY_SIZE,
    retryCount: RPC_RETRY_COUNT,
    retryDelayMs: RPC_RETRY_DELAY_MS,
    userAgent: RPC_USER_AGENT,
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
    maxLogBlockRange: MAX_LOG_BLOCK_RANGE,
    transactionPolicy: {
      sendTimeoutMs: SEND_TIMEOUT_MS,
      replacementFeeBumpBps: REPLACEMENT_FEE_BUMP_BPS,
      maxFeePerGas: MAX_FEE_PER_GAS_WEI,
      replacementTimeoutMs: REPLACEMENT_TIMEOUT_MS,
      sendAttempts: SEND_ATTEMPTS,
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
