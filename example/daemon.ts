// Reference application: setup, scan phases and scheduling; the SDK owns signing and confirmation.
// Cadence and recovery timing are this application's choices.
//
// In a consuming project, use `guardian-daemon-sdk/core` and `guardian-daemon-sdk/clients`.
//
// Start with observe mode; see README.md in this directory for configuration and provider wiring.

import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, isAddressEqual } from 'viem';
import { createViemRpcTransport, ViemRpcClient } from '../src/chain/viem-client.ts';
import { Guardian } from '../src/core/index.ts';
import type { BlockRef, EventHandler, SdkEvent } from '../src/core/index.ts';
import { screening } from './screening-adapter.ts';
import { privateKeyToAccount } from 'viem/accounts';
import * as env from './env.ts';
import type { Mode } from './env.ts';

/** Mainnet and Hoodi both use 12-second slots; Guardian derives a seven-day lookback from this. */
const SLOT_SECONDS = 12;

/** The specification's reference interval: 30 blocks between cycle starts, one block per slot. */
const CYCLE_INTERVAL_MS = 30 * SLOT_SECONDS * 1_000;

/** A failed attempt is followed by the next one this much later, so a node that is down is not asked again at once. */
const RETRY_INTERVAL_MS = 5 * 60_000;

// Guardian policy for this example, chosen by the application.
const REPORT_BLOCK_LAG = 2;
const FLAGGER_READ_CONCURRENCY = 8;
const HISTORY_READ_CONCURRENCY = 8;
// A report that a reorg drops is sent again after the shared wait, so a batch waits only for its inclusion.
const INTER_BATCH_CONFIRMATION_BLOCKS = 1;
const MAX_REPORT_ATTEMPTS = 3;
const CONFIRMATION_POLL_INTERVAL_MS = 12_000;
// A report costs up to about 156,000 gas per borrower, so 50 borrowers stay under half of the
// 16,777,216 gas one transaction may use.
const MAX_SIGNAL_BATCH_SIZE = 50;
const IDLE_HEARTBEAT_INTERVAL_SECONDS = 12 * 60 * 60;
const HEARTBEAT_RESERVE_BLOCKS = 8;
// Deeper than any reorg Ethereum's proof of stake has produced, seven slots in May 2022.
const TRANSACTION_CONFIRMATION_BLOCKS = 12;
// The provider's answer is awaited no longer than this; the anchors a slower provider has not answered are incomplete.
const SCREENING_TIMEOUT_MS = 290_000;

// The SDK's viem transport applies these settings to every physical HTTP attempt. A shared provider
// can take many seconds for a log read, and viem retries an attempt that timed out.
const RPC_REQUEST_TIMEOUT_MS = 30_000;
const RPC_RETRY_COUNT = 2;
const RPC_RETRY_DELAY_MS = 150;
const MAX_RPC_RESPONSE_BODY_SIZE = 10 * 1024 * 1024;
const RPC_USER_AGENT = 'guardian-daemon-sdk-example';
const DEFAULT_MAX_LOG_BLOCK_RANGE = 10_000;

// Transaction delivery policy for this example.
const REPLACEMENT_FEE_BUMP_BPS = 1_000;
const MAX_FEE_PER_GAS_WEI = 100_000_000_000n;
const REPLACEMENT_TIMEOUT_MS = 36_000;
const SEND_ATTEMPTS = 5;
// A send fits every attempt's inclusion wait, then the confirmations and one slot.
const SEND_TIMEOUT_MS =
  SEND_ATTEMPTS * REPLACEMENT_TIMEOUT_MS + (TRANSACTION_CONFIRMATION_BLOCKS + 1) * SLOT_SECONDS * 1_000;
// A report costs more gas when other guardians report the same accounts first, so the gas limit adds
// a fifth to the node's estimate.
const GAS_HEADROOM_BPS = 2_000;

/**
 * Schedule [scan attempts](../docs/guardian-specification.md#scan-cycle). The intervals above are
 * example policy and must be chosen for the operator's agreed SLA; the SDK supplies no scheduler.
 * [Failed attempts](../docs/guardian-specification.md#failure-handling) leave the heartbeat hint unchanged
 * and are followed by another attempt after a delay.
 */
async function main(): Promise<void> {
  const mode = env.mode('MODE');
  // Only an attempt that reached sending can have left a transaction pending.
  const attempt = { hasReachedSending: false };
  const guardian = createGuardian(mode, (event) => {
    if (event.event === 'cycle.started') {
      attempt.hasReachedSending = false;
    }
    if (event.event.startsWith('transaction.')) {
      attempt.hasReachedSending = true;
    }
    logEvent(event);
  });

  // This block only spares the next plan a wider event search, so losing it on restart costs nothing else.
  let previousHeartbeatBlock: BlockRef | null = null;
  while (true) {
    const startedAt = Date.now();
    try {
      previousHeartbeatBlock = await cycle(guardian, previousHeartbeatBlock);
    } catch (error) {
      console.error('cycle failed:', error);
      if (attempt.hasReachedSending) {
        // The next attempt must not meet a transaction of this one. The signer belongs to this
        // example alone, so each of its pending transactions is awaited or cancelled. An error
        // here ends the process: the operator reconciles the signer before restarting.
        await guardian.clearPendingNonces();
      }

      await sleep(RETRY_INTERVAL_MS);
      continue;
    }

    await sleep(Math.max(0, startedAt + CYCLE_INTERVAL_MS - Date.now()));
  }
}

/**
 * Run one [scan cycle](../docs/guardian-specification.md#scan-cycle) and retain only confirmed
 * coverage. A stale result leaves the previous heartbeat hint unchanged.
 */
export async function cycle(guardian: Guardian, previousHeartbeatBlock: BlockRef | null): Promise<BlockRef | null> {
  const outcome = await guardian.cycle(previousHeartbeatBlock);
  if (outcome.kind === 'observed') {
    const { screened } = outcome;
    console.log(
      `observed: ${screened.results.length} screened, ${screened.skipped.length} targets already flagged, ` +
        `${screened.suspects.length} suspects, ${screened.flags.length} flags; no transactions sent`,
    );
    return outcome.previousHeartbeatBlock;
  }
  if (outcome.kind === 'stale') {
    console.log(`plan went stale: ${outcome.reason}`);
    return previousHeartbeatBlock;
  }
  if (outcome.kind === 'nothing-due') {
    console.log(`nothing due: ${outcome.reason}`);
    return outcome.previousHeartbeatBlock;
  }
  if (outcome.kind === 'incomplete') {
    // The reports the complete answers required are sent; the next cycle asks about the rest again.
    console.log(`incomplete: ${outcome.incomplete.length} anchors without a complete answer; no heartbeat`);
    return outcome.previousHeartbeatBlock;
  }

  console.log(
    `attested block ${outcome.previousHeartbeatBlock.number}: heartbeat ${outcome.heartbeat}, digest ${outcome.digest}`,
  );
  return outcome.previousHeartbeatBlock;
}

/** Keep the example's progress readable while retaining every lower-level SDK event. */
function logEvent(event: SdkEvent): void {
  if (event.event === 'cycle.reconstructed') {
    console.log(`block ${event.reportBlock.number}: reconstructed ${event.anchors.length} supply anchors`);
    return;
  }
  console.log(event);
}

/** Build the example Guardian with its configuration, event handler and RPC/signing connection. */
function createGuardian(mode: Mode, onEvent: EventHandler): Guardian {
  const chain = env.chain('CHAIN_ID');
  const nodeUrls = env.rpcUrls('RPC_URLS');
  const guardianAddress = env.address('GUARDIAN');
  const transport = createViemRpcTransport({
    urls: nodeUrls,
    // Unset, one endpoint answers a log read like any other request. The option stays optional; the README on
    // comparing logs explains what only a quorum catches: a range beyond an endpoint's head answered without an error.
    logQuorum: env.optionalPositiveInteger('RPC_LOG_QUORUM'),
    timeoutMs: RPC_REQUEST_TIMEOUT_MS,
    maxResponseBodySize: MAX_RPC_RESPONSE_BODY_SIZE,
    retryCount: RPC_RETRY_COUNT,
    retryDelayMs: RPC_RETRY_DELAY_MS,
    userAgent: RPC_USER_AGENT,
    onEvent,
  });
  const publicClient = createPublicClient({ chain, transport });
  // Observe does not read signing material or construct a wallet.
  const account = mode === 'signal' ? privateKeyToAccount(env.privateKey('SIGNER_KEY')) : undefined;
  // Example policy: use a hot delegate even though the SDK also permits the Guardian to sign.
  if (account !== undefined && isAddressEqual(account.address, guardianAddress)) {
    throw new Error('SIGNER_KEY is the Guardian itself, not its delegate');
  }
  const walletClient = account === undefined ? undefined : createWalletClient({ account, chain, transport });
  const client = new ViemRpcClient({
    publicClient,
    walletClient,
    onEvent,
    // A provider's own limit; a range it refuses is read again in halves, costing a request each time.
    maxLogBlockRange: env.optionalPositiveInteger('MAX_LOG_BLOCK_RANGE') ?? DEFAULT_MAX_LOG_BLOCK_RANGE,
    transactionPolicy: {
      sendTimeoutMs: SEND_TIMEOUT_MS,
      replacementFeeBumpBps: REPLACEMENT_FEE_BUMP_BPS,
      maxFeePerGas: MAX_FEE_PER_GAS_WEI,
      replacementTimeoutMs: REPLACEMENT_TIMEOUT_MS,
      sendAttempts: SEND_ATTEMPTS,
      gasHeadroomBps: GAS_HEADROOM_BPS,
    },
  });

  return new Guardian({
    mode,
    client,
    expectedDelegate: walletClient?.account.address,
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
    guardian: guardianAddress,
    screening,
    reportBlockLag: REPORT_BLOCK_LAG,
    flaggerReadConcurrency: FLAGGER_READ_CONCURRENCY,
    historyReadConcurrency: HISTORY_READ_CONCURRENCY,
    interBatchConfirmationBlocks: INTER_BATCH_CONFIRMATION_BLOCKS,
    maxReportAttempts: MAX_REPORT_ATTEMPTS,
    confirmationPollIntervalMs: CONFIRMATION_POLL_INTERVAL_MS,
    maxSignalBatchSize: MAX_SIGNAL_BATCH_SIZE,
    idleHeartbeatInterval: IDLE_HEARTBEAT_INTERVAL_SECONDS,
    heartbeatReserveBlocks: HEARTBEAT_RESERVE_BLOCKS,
    txConfirmationBlocks: TRANSACTION_CONFIRMATION_BLOCKS,
    screeningTimeoutMs: SCREENING_TIMEOUT_MS,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
