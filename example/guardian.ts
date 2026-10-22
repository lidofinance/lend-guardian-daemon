// The Guardian this application runs, in the order a reader needs it: its numeric settings, its setup
// over the SDK, and the schedule of its cycles. The example and the daemon both run it. The defaults
// are this application's policy, not specification requirements.
//
// In a consuming project, use `guardian-daemon-sdk/core` and `guardian-daemon-sdk/clients`.

import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, createWalletClient, isAddressEqual } from 'viem';
import type { Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createViemRpcTransport, ViemRpcClient } from '../src/chain/viem-client.ts';
import { Guardian } from '../src/core/index.ts';
import type {
  Address,
  BlockRef,
  CycleOutcome,
  EventHandler,
  ScreeningProvider,
  StaleReason,
  Work,
} from '../src/core/index.ts';
import * as env from './env.ts';
import type { Mode, Setting, Settings } from './env.ts';

/** Mainnet and Hoodi both use 12-second slots; Guardian derives a seven-day lookback from this. */
const SLOT_SECONDS = 12;

/** The longest delay Node's timers accept, in milliseconds. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Every numeric setting of the Guardian and its schedule, each read from the environment variable of
 * its name; README.md describes them. Guardian and its clients check their options again when they are
 * built, the combinations included, before any RPC request.
 */
export const GUARDIAN_SETTINGS = {
  // The specification's reference interval: 30 blocks between cycle starts, one block per slot.
  CYCLE_INTERVAL_MS: { default: 30 * SLOT_SECONDS * 1_000, min: 1, max: MAX_TIMER_MS },
  // How many times one cycle rebuilds a stale plan at once before it waits for the next cycle.
  MAX_RESTARTS_PER_CYCLE: { default: 5, min: 0 },
  // Guardian policy.
  REPORT_BLOCK_LAG: { default: 2, min: 1 },
  READ_CONCURRENCY: { default: 8, min: 1 },
  HISTORY_READ_CONCURRENCY: { default: 8, min: 1 },
  INTER_BATCH_CONFIRMATION_BLOCKS: { default: 2, min: 1 },
  CONFIRMATION_POLL_INTERVAL_MS: { default: 12_000, min: 1, max: MAX_TIMER_MS },
  // A report costs up to about 156,000 gas per borrower, so 50 borrowers stay under half of the
  // 16,777,216 gas one transaction may use.
  MAX_SIGNAL_BATCH_SIZE: { default: 50, min: 1 },
  IDLE_HEARTBEAT_INTERVAL_SECONDS: { default: 12 * 60 * 60, min: 1 },
  HEARTBEAT_RESERVE_BLOCKS: { default: 8, min: 1 },
  // Deeper than any reorg Ethereum's proof of stake has produced, seven slots in May 2022.
  TRANSACTION_CONFIRMATION_BLOCKS: { default: 12, min: 1 },
  // The provider's answer is awaited no longer than this; the anchors a slower provider has not answered are incomplete.
  SCREENING_TIMEOUT_MS: { default: 290_000, min: 1, max: MAX_TIMER_MS },
  // Transport settings. A shared provider can take many seconds for a log read, and viem retries an
  // attempt that timed out.
  RPC_REQUEST_TIMEOUT_MS: { default: 30_000, min: 1, max: MAX_TIMER_MS },
  RPC_RETRY_COUNT: { default: 2, min: 0 },
  RPC_RETRY_DELAY_MS: { default: 150, min: 0 },
  MAX_RPC_RESPONSE_BODY_SIZE: { default: 10 * 1024 * 1024, min: 1 },
  // A provider's own limit; a range it refuses is read again in halves, each refusal costing at least one request.
  MAX_LOG_BLOCK_RANGE: { default: 10_000, min: 1 },
  // Transaction delivery. A send fits every attempt's inclusion wait, then the confirmations and one
  // slot: 5 * 36 s + (12 + 1) * 12 s.
  SEND_TIMEOUT_MS: { default: 336_000, min: 1, max: MAX_TIMER_MS },
  REPLACEMENT_FEE_BUMP_BPS: { default: 1_000, min: 1 },
  MAX_FEE_PER_GAS_WEI: { default: 100_000_000_000, min: 1 },
  REPLACEMENT_TIMEOUT_MS: { default: 36_000, min: 1, max: MAX_TIMER_MS },
  SEND_ATTEMPTS: { default: 5, min: 1 },
  // A report costs more gas when other guardians report the same accounts first, so the gas limit adds
  // a fifth to the node's estimate.
  GAS_HEADROOM_BPS: { default: 2_000, min: 0 },
} satisfies Record<string, Setting>;

type GuardianSettings = Settings<typeof GUARDIAN_SETTINGS>;

/** What `createGuardian` builds the Guardian from besides the deployment the environment names. */
interface GuardianOptions {
  readonly mode: Mode;
  readonly onEvent: EventHandler;
  readonly screening: ScreeningProvider;
  readonly settings: GuardianSettings;
  readonly userAgent: string;
}

/**
 * The Guardian with these options over the deployment, nodes and signer the environment names:
 * `CHAIN_ID`, `RPC_URLS`, `RPC_LOG_QUORUM`, `GUARDIAN`, `LIDO_LEND`, `GUARDIAN_SIGNALS`, their
 * deployment blocks and, in signal mode, `SIGNER_KEY`. A missing or invalid value throws before any
 * RPC request.
 */
export function createGuardian(options: GuardianOptions): Guardian {
  const { mode, onEvent, settings } = options;
  const chain = env.chain('CHAIN_ID');
  const guardian = env.address('GUARDIAN');
  const client = createClient(options, chain, guardian);
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
        deploymentBlock: env.integer('LIDO_LEND_DEPLOYMENT_BLOCK', { min: 1 }),
      },
      guardianSignals: {
        address: env.address('GUARDIAN_SIGNALS'),
        deploymentBlock: env.integer('GUARDIAN_SIGNALS_DEPLOYMENT_BLOCK', { min: 1 }),
      },
    },
    guardian,
    screening: options.screening,
    reportBlockLag: settings('REPORT_BLOCK_LAG'),
    readConcurrency: settings('READ_CONCURRENCY'),
    historyReadConcurrency: settings('HISTORY_READ_CONCURRENCY'),
    interBatchConfirmationBlocks: settings('INTER_BATCH_CONFIRMATION_BLOCKS'),
    confirmationPollIntervalMs: settings('CONFIRMATION_POLL_INTERVAL_MS'),
    maxSignalBatchSize: settings('MAX_SIGNAL_BATCH_SIZE'),
    idleHeartbeatInterval: settings('IDLE_HEARTBEAT_INTERVAL_SECONDS'),
    heartbeatReserveBlocks: settings('HEARTBEAT_RESERVE_BLOCKS'),
    txConfirmationBlocks: settings('TRANSACTION_CONFIRMATION_BLOCKS'),
    screeningTimeoutMs: settings('SCREENING_TIMEOUT_MS'),
  });
}

/** One transport for reads and sends; observe reads no signing material and constructs no wallet. */
function createClient(options: GuardianOptions, chain: Chain, guardian: Address): ViemRpcClient {
  const { mode, onEvent, settings } = options;
  const transport = createViemRpcTransport({
    urls: env.rpcUrls('RPC_URLS'),
    // Signal mode requires a quorum of at least 2 when an endpoint can answer a log range beyond its head
    // without an error: [RPC requirements](../README.md#rpc-requirements). This launcher does not check it.
    logQuorum: env.integer('RPC_LOG_QUORUM', { min: 1 }, { default: undefined }),
    timeoutMs: settings('RPC_REQUEST_TIMEOUT_MS'),
    maxResponseBodySize: settings('MAX_RPC_RESPONSE_BODY_SIZE'),
    retryCount: settings('RPC_RETRY_COUNT'),
    retryDelayMs: settings('RPC_RETRY_DELAY_MS'),
    userAgent: options.userAgent,
    onEvent,
  });
  const publicClient = createPublicClient({ chain, transport });
  const account = mode === 'signal' ? privateKeyToAccount(env.privateKey('SIGNER_KEY')) : undefined;
  // Application policy: a hot delegate signs, so the Guardian's own key stays cold, even though the SDK
  // also permits the Guardian to sign.
  if (account !== undefined && isAddressEqual(account.address, guardian)) {
    throw new Error('SIGNER_KEY is the Guardian itself, not its delegate');
  }
  const walletClient = account === undefined ? undefined : createWalletClient({ account, chain, transport });
  return new ViemRpcClient({
    publicClient,
    walletClient,
    onEvent,
    maxLogBlockRange: settings('MAX_LOG_BLOCK_RANGE'),
    transactionPolicy: {
      sendTimeoutMs: settings('SEND_TIMEOUT_MS'),
      replacementFeeBumpBps: settings('REPLACEMENT_FEE_BUMP_BPS'),
      maxFeePerGas: BigInt(settings('MAX_FEE_PER_GAS_WEI')),
      replacementTimeoutMs: settings('REPLACEMENT_TIMEOUT_MS'),
      sendAttempts: settings('SEND_ATTEMPTS'),
      gasHeadroomBps: settings('GAS_HEADROOM_BPS'),
    },
  });
}

/** What the schedule reports of its own, beside the SDK's events and by the same handler. */
export type ScheduleEvent =
  | { readonly event: 'schedule.cycleNotStarted'; readonly error: unknown }
  | { readonly event: 'schedule.restartBudgetExhausted'; readonly restarts: number; readonly reason: StaleReason };

/**
 * Run a cycle every `cycleIntervalMs` from the start of the previous one, for as long as the process
 * lives. The [reference scheduler](../docs/guardian-specification.md#execution-rules) counts
 * `scanIntervalBlocks` new blocks between starts; this application counts time instead. Cadence and
 * recovery are this application's choices; the SDK supplies no scheduler.
 */
export async function runCycles(options: {
  readonly guardian: Pick<Guardian, 'cycle' | 'clearPendingNonces'>;
  readonly mode: Mode;
  readonly cycleIntervalMs: number;
  readonly maxRestarts: number;
  readonly onEvent: (event: ScheduleEvent) => void;
}): Promise<never> {
  // The heartbeat hint only spares the next plan a wider event search, so losing it on restart costs nothing else.
  let start: CycleStart = { previousHeartbeatBlock: null };
  while (true) {
    const startedAt = Date.now();
    start = await runCycle(options, start);
    await sleep(Math.max(0, startedAt + options.cycleIntervalMs - Date.now()));
  }
}

/** Where a cycle starts from: the heartbeat hint, and the work an earlier attempt handed on. */
export interface CycleStart {
  readonly previousHeartbeatBlock: BlockRef | null;
  readonly earlierWork?: Work | undefined;
}

/**
 * One scheduled [scan cycle](../docs/guardian-specification.md#scan-cycle), as `runCycle` in
 * [Run one cycle](../docs/guardian-specification.md#run-one-cycle), and where the next one starts: the
 * coverage its completed call confirmed, or the hint it started from, with the work to reuse. Two
 * application safeguards differ from that pseudocode. In signal mode the cycle first clears the
 * signer's pending nonces, so no transaction of an earlier cycle or process blocks this one; the
 * signer must have no other writer. A stale plan is rebuilt at once, as RESTART does there, but at most
 * `maxRestarts` times, so a plan that keeps going stale waits for the next scheduled cycle instead of
 * being rebuilt in a tight loop; the new attempt reuses the work the stale one reconstructed where it
 * still holds. An incomplete screening ends the cycle instead: its work goes to the next scheduled
 * cycle, which gives the provider time. A [failed call](../docs/guardian-specification.md#failure-handling)
 * ends the cycle, which the SDK has already reported as `cycle.failed`, with the work it was given.
 */
export async function runCycle(
  options: {
    readonly guardian: Pick<Guardian, 'cycle' | 'clearPendingNonces'>;
    readonly mode: Mode;
    readonly maxRestarts: number;
    readonly onEvent: (event: ScheduleEvent) => void;
  },
  start: CycleStart,
): Promise<CycleStart> {
  if (options.mode === 'signal') {
    try {
      await options.guardian.clearPendingNonces();
    } catch (error) {
      // The next scheduled cycle tries again; until the signer is reconciled no cycle starts.
      options.onEvent({ event: 'schedule.cycleNotStarted', error });
      return start;
    }
  }
  let restarts = 0;
  let earlierWork = start.earlierWork;
  while (true) {
    let outcome: CycleOutcome;
    try {
      outcome = await options.guardian.cycle(start.previousHeartbeatBlock, earlierWork);
    } catch {
      // The SDK reported the failure as `cycle.failed`; the next cycle starts from the same hint and work.
      return {
        previousHeartbeatBlock: start.previousHeartbeatBlock,
        ...(earlierWork === undefined ? {} : { earlierWork }),
      };
    }
    if (outcome.kind !== 'stale') {
      return {
        previousHeartbeatBlock: outcome.previousHeartbeatBlock,
        ...(outcome.kind === 'incomplete' ? { earlierWork: outcome.work } : {}),
      };
    }
    if (restarts === options.maxRestarts) {
      options.onEvent({ event: 'schedule.restartBudgetExhausted', restarts, reason: outcome.reason });
      return { previousHeartbeatBlock: start.previousHeartbeatBlock, earlierWork: outcome.work };
    }
    restarts += 1;
    earlierWork = outcome.work;
  }
}
