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
import type { Cursor, EventHandler, SdkEvent } from '../src/core/index.ts';
import { screening } from './screening-adapter.ts';
import { privateKeyToAccount } from 'viem/accounts';
import * as env from './env.ts';
import type { Mode } from './env.ts';

/** Mainnet and Hoodi both use 12-second slots; Guardian derives a seven-day lookback from this. */
const SLOT_SECONDS = 12;

/** A cycle with nothing due is a handful of reads, so the pace is how soon new work should be seen. */
const CYCLE_INTERVAL_MS = 60_000;

/** A failed cycle waits longer, so a node that is down is not asked again every minute. */
const RETRY_INTERVAL_MS = 5 * 60_000;

// Guardian policy for this example, chosen by the application.
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
const RPC_USER_AGENT = 'guardian-daemon-sdk-example';
const MAX_LOG_BLOCK_RANGE = 10_000;

// Transaction delivery policy for this example.
const SEND_TIMEOUT_MS = 264_000;
const REPLACEMENT_FEE_BUMP_BPS = 1_000;
const MAX_FEE_PER_GAS_WEI = 100_000_000_000n;
const REPLACEMENT_TIMEOUT_MS = 36_000;
const SEND_ATTEMPTS = 5;

/**
 * Schedule [scan attempts](../docs/guardian-specification.md#scan-cycle). The intervals below are
 * example policy and must be chosen for the operator's agreed SLA; the SDK supplies no scheduler.
 * [Failed attempts](../docs/guardian-specification.md#failure-handling) leave the cursor unchanged;
 * signal exceptions stop for reconciliation, while observe retries after a delay.
 */
async function main(): Promise<void> {
  const mode = env.mode('MODE');
  const guardian = createGuardian(mode);

  // The cursor only spares the next plan a search, so losing it on a restart costs nothing else.
  let cursor: Cursor | undefined;
  while (true) {
    try {
      cursor = await cycle(guardian, cursor);
    } catch (error) {
      console.error('cycle failed:', error);
      // A failed send may still have reached the chain. This example has no pending-write journal.
      if (mode === 'signal') {
        console.error('Signal mode stopped; reconcile pending transactions before restarting.');
        process.exitCode = 1;
        return;
      }

      await sleep(RETRY_INTERVAL_MS);
      continue;
    }

    await sleep(CYCLE_INTERVAL_MS);
  }
}

/**
 * Run one [scan cycle](../docs/guardian-specification.md#scan-cycle) and retain only confirmed
 * coverage. A stale or observed result leaves the previous cursor unchanged.
 */
export async function cycle(guardian: Guardian, hint: Cursor | undefined): Promise<Cursor | undefined> {
  const outcome = await guardian.cycle(hint);
  if (outcome.kind === 'observed') {
    const { screened } = outcome;
    console.log(
      `observed: ${screened.results.length} screened, ${screened.skipped.length} targets already flagged, ` +
        `${screened.suspects.length} suspects, ${screened.flags.length} flags; no transactions sent`,
    );
    return hint;
  }
  if (outcome.kind === 'stale') {
    console.log(`plan went stale: ${outcome.reason}`);
    return hint;
  }
  if (outcome.kind === 'nothing-due') {
    console.log(`nothing due: ${outcome.reason}`);
    return outcome.cursor;
  }

  console.log(
    `attested block ${outcome.cursor.verifiedAt.number}: heartbeat ${outcome.heartbeat}, digest ${outcome.digest}`,
  );
  return outcome.cursor;
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
function createGuardian(mode: Mode): Guardian {
  const chain = env.chain('CHAIN_ID');
  const nodeUrls = env.rpcUrls('RPC_URLS');
  const guardianAddress = env.address('GUARDIAN');
  const onEvent: EventHandler = logEvent;
  const transport = createViemRpcTransport({
    urls: nodeUrls,
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
    maxLogBlockRange: MAX_LOG_BLOCK_RANGE,
    transactionPolicy: {
      sendTimeoutMs: SEND_TIMEOUT_MS,
      replacementFeeBumpBps: REPLACEMENT_FEE_BUMP_BPS,
      maxFeePerGas: MAX_FEE_PER_GAS_WEI,
      replacementTimeoutMs: REPLACEMENT_TIMEOUT_MS,
      sendAttempts: SEND_ATTEMPTS,
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
    interBatchConfirmationBlocks: INTER_BATCH_CONFIRMATION_BLOCKS,
    confirmationPollIntervalMs: CONFIRMATION_POLL_INTERVAL_MS,
    maxSignalBatchSize: MAX_SIGNAL_BATCH_SIZE,
    idleHeartbeatInterval: IDLE_HEARTBEAT_INTERVAL_SECONDS,
    heartbeatReserveBlocks: HEARTBEAT_RESERVE_BLOCKS,
    txConfirmationBlocks: TRANSACTION_CONFIRMATION_BLOCKS,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
