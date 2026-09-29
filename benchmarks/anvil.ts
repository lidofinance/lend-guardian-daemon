// The anvil family: SDK cycles over the pinned production contracts on a local Anvil chain, through the
// SDK's own viem transport and client, with real ABI encoding and decoding. Histories are real
// transactions, so they stay in the hundreds or low thousands; synthetic families cover larger ones.

import { createServer } from 'node:net';
import { createPublicClient, createWalletClient, encodeFunctionData, http, isAddress, parseEventLogs } from 'viem';
import type { Abi, Address, Chain, PrivateKeyAccount, PublicClient, Transport, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ViemRpcClient, createViemRpcTransport } from '../src/chain/viem-client.ts';
import { Guardian } from '../src/core/index.ts';
import type { CycleOutcome, Screened, ScreeningResult, SdkEvent, TransactionPolicy } from '../src/core/index.ts';
import { readArtifact } from '../tests/conformance/fixtures/anvil.ts';
import { ADMIN_KEY, DELEGATE_KEY, deployProtocolFixture } from '../tests/conformance/fixtures/protocol.ts';
import type { ProtocolFixture } from '../tests/conformance/fixtures/protocol.ts';
import { PhaseTimer, ResourceWindow, RpcMeter, check } from './metrics.ts';
import type { Check, RunReport } from './metrics.ts';
import type { AnvilScenario, Decision } from './scenarios.ts';
import { borrowerAt } from './synthetic-history.ts';
import { AttemptRecorder } from './transport.ts';

const SUPPLY_ASSETS = 100n;

/** Supplies written per block while the history is built with automine off. */
const SUPPLIES_PER_BLOCK = 50;

/** Explicit fees and gas skip estimation, so building the history costs one request per supply. */
const HISTORY_GAS = 1_000_000n;

const HISTORY_MAX_FEE_PER_GAS = 10_000_000_000n;

const HISTORY_PRIORITY_FEE_PER_GAS = 1_000_000_000n;

/** Mine far enough past every lot's deadline that the whole history is due. */
const DEADLINE_BLOCKS = 4;

const DEADLINE_INTERVAL_SECONDS = 3_600;

const TX_CONFIRMATION_BLOCKS = 12;

/** The example application's report batch size. */
const MAX_SIGNAL_BATCH_SIZE = 50;

/** The example application's history read concurrency; the SDK reads one supply or position at a time. */
const HISTORY_READ_CONCURRENCY = 8;

const POLICY: TransactionPolicy = {
  maxFeePerGas: 100_000_000_000n,
  sendTimeoutMs: 264_000,
  replacementFeeBumpBps: 1_000,
  replacementTimeoutMs: 36_000,
  sendAttempts: 5,
};

const DECISIONS: Readonly<Record<Decision, ScreeningResult>> = {
  clean: { status: 'judged', requiresSuspect: false, requiresFlag: false },
  suspect: { status: 'judged', requiresSuspect: true, requiresFlag: false },
  flag: { status: 'judged', requiresSuspect: false, requiresFlag: true },
  both: { status: 'judged', requiresSuspect: true, requiresFlag: true },
};

const REPORT_KINDS: Readonly<Record<Decision, number>> = { clean: 0, suspect: 1, flag: 1, both: 2 };

/** What a run observes through the SDK's events: HTTP attempts, phases and confirmed transactions. */
class Observers {
  readonly attempts = new AttemptRecorder();

  readonly phases = new PhaseTimer(new RpcMeter());

  #confirmedTransactions = 0;

  readonly onEvent = (event: SdkEvent): void => {
    this.attempts.onEvent(event);
    this.phases.onEvent(event);
    if (event.event === 'report.confirmed') {
      this.#confirmedTransactions += 1;
    }
  };

  confirmedTransactions(): number {
    return this.#confirmedTransactions;
  }
}

export async function runAnvil(parameters: AnvilScenario): Promise<RunReport> {
  const fixture = await deployProtocolFixture(await freePort());
  try {
    const setup = await writeHistory(fixture, parameters);
    return parameters.mode === 'observe'
      ? await observeCycle(fixture, parameters, setup)
      : await signalCycle(fixture, parameters, setup);
  } finally {
    fixture.anvil.stop();
  }
}

/** Real supplies for `borrowers` borrowers in the primary market, then enough time for every deadline. */
async function writeHistory(fixture: ProtocolFixture, parameters: AnvilScenario): Promise<Record<string, number>> {
  const startedAt = performance.now();
  await fixture.setDelegate();
  const market = marketParametersOf(fixture);
  const token = readArtifact('MockERC20.json').abi;
  const total = SUPPLY_ASSETS * BigInt(parameters.supplies);
  await fixture.anvil.testClient.setAutomine(false);
  const writer = await HistoryWriter.open(fixture);
  await writer.send(market.collateralToken, token, 'mint', [writer.address(), total]);
  await writer.send(market.collateralToken, token, 'approve', [fixture.core, total]);
  for (let index = 0; index < parameters.supplies; index += 1) {
    const borrower = borrowerAt(index % parameters.borrowers);
    await writer.send(fixture.core, fixture.coreAbi, 'supplyCollateral', [
      market.arguments,
      SUPPLY_ASSETS,
      borrower,
      '0x',
    ]);
  }
  await fixture.anvil.testClient.mine({ blocks: 1 });
  await fixture.anvil.testClient.setAutomine(true);
  await fixture.anvil.testClient.mine({ blocks: DEADLINE_BLOCKS, interval: DEADLINE_INTERVAL_SECONDS });
  return { datasetSupplies: parameters.supplies, datasetBuildMs: performance.now() - startedAt };
}

/** Sends the history from the admin with explicit gas, fees and consecutive nonces, a block per batch. */
class HistoryWriter {
  readonly #fixture: ProtocolFixture;

  readonly #admin: WalletClient<Transport, Chain, PrivateKeyAccount>;

  #nonce: number;

  private constructor(
    fixture: ProtocolFixture,
    admin: WalletClient<Transport, Chain, PrivateKeyAccount>,
    nonce: number,
  ) {
    this.#fixture = fixture;
    this.#admin = admin;
    this.#nonce = nonce;
  }

  static async open(fixture: ProtocolFixture): Promise<HistoryWriter> {
    const admin = createWalletClient({
      account: privateKeyToAccount(ADMIN_KEY),
      chain: fixture.anvil.chain,
      transport: http(fixture.anvil.rpcUrl),
    });
    const nonce = await fixture.anvil.publicClient.getTransactionCount({ address: admin.account.address });
    return new HistoryWriter(fixture, admin, nonce);
  }

  address(): Address {
    return this.#admin.account.address;
  }

  async send(to: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<void> {
    await this.#admin.sendTransaction({
      to,
      data: encodeFunctionData({ abi, functionName, args }),
      gas: HISTORY_GAS,
      maxFeePerGas: HISTORY_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: HISTORY_PRIORITY_FEE_PER_GAS,
      nonce: this.#nonce,
    });
    this.#nonce += 1;
    if (this.#nonce % SUPPLIES_PER_BLOCK === 0) {
      await this.#fixture.anvil.testClient.mine({ blocks: 1 });
    }
  }
}

/** The market parameters and collateral token, read back from the fixture's `CreateMarket` event. */
function marketParametersOf(fixture: ProtocolFixture): {
  readonly arguments: readonly unknown[];
  readonly collateralToken: Address;
} {
  const [created] = parseEventLogs({
    abi: fixture.coreAbi,
    logs: fixture.primaryMarket.createReceipt.logs,
    eventName: 'CreateMarket',
    strict: true,
  });
  const args: unknown = created?.args;
  const parameters: unknown = Array.isArray(args) ? args[1] : undefined;
  if (!Array.isArray(parameters)) {
    throw new TypeError('The fixture market has no CreateMarket parameters');
  }
  const collateralToken: unknown = parameters[1];
  if (typeof collateralToken !== 'string' || !isAddress(collateralToken)) {
    throw new TypeError('The fixture market has no collateral token');
  }
  return { arguments: parameters, collateralToken };
}

async function observeCycle(
  fixture: ProtocolFixture,
  parameters: AnvilScenario,
  setup: Record<string, number>,
): Promise<RunReport> {
  const observers = new Observers();
  const { client } = sdkClients(fixture, parameters, observers, undefined);
  const guardian = guardianOf(fixture, parameters, { mode: 'observe', client, observers });
  const window = new ResourceWindow();
  const outcome = await guardian.cycle(null).then(outcomeOf, errorOutcome);
  const usage = window.close();
  const anchors = outcome.anchors;
  return {
    outcome: outcome.label,
    metrics: {
      ...usage,
      ...setup,
      ...observers.attempts.totals(),
      ...observers.phases.durationsMs(),
      anchors,
      rpcPerAnchor: anchors > 0 ? (observers.attempts.totals().httpAttempts ?? 0) / anchors : 0,
    },
    rpcByPhase: { transport: observers.attempts.attemptsByMethod() },
    checks: [check('outcome', 'observed', outcome.label), check('anchors', parameters.supplies, anchors)],
  };
}

async function signalCycle(
  fixture: ProtocolFixture,
  parameters: AnvilScenario,
  setup: Record<string, number>,
): Promise<RunReport> {
  const observers = new Observers();
  const { client, publicClient } = sdkClients(fixture, parameters, observers, privateKeyToAccount(DELEGATE_KEY));
  const guardian = guardianOf(fixture, parameters, { mode: 'signal', client, observers });
  const window = new ResourceWindow();
  const screened = await screenedWork(guardian);
  const headBefore = await publicClient.getBlockNumber({ cacheTime: 0 });
  const miner = backgroundMiner(fixture, parameters.blockIntervalMs);
  const outcome = await guardian
    .signalAndHeartbeat(screened)
    .then(outcomeOf, errorOutcome)
    .finally(() => {
      miner.stop();
    });
  const usage = window.close();
  const headAfter = await publicClient.getBlockNumber({ cacheTime: 0 });
  return {
    outcome: outcome.label,
    metrics: {
      ...usage,
      ...setup,
      ...observers.attempts.totals(),
      ...observers.phases.durationsMs(),
      anchors: screened.work().anchors,
      transactions: observers.confirmedTransactions(),
      blocksConsumed: Number(headAfter - headBefore),
    },
    rpcByPhase: { transport: observers.attempts.attemptsByMethod() },
    checks: await signalChecks(fixture, parameters, { outcome: outcome.label, observers, publicClient }),
  };
}

async function signalChecks(
  fixture: ProtocolFixture,
  parameters: AnvilScenario,
  result: { readonly outcome: string; readonly observers: Observers; readonly publicClient: PublicClient },
): Promise<Check[]> {
  const perKind = Math.ceil(parameters.borrowers / MAX_SIGNAL_BATCH_SIZE);
  const stored = await result.publicClient.readContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'getHeartbeat',
    args: [fixture.admin.address],
  });
  return [
    check('outcome', 'attested', result.outcome),
    check('transactions', perKind * REPORT_KINDS[parameters.decision] + 1, result.observers.confirmedTransactions()),
    check('heartbeat stored', 'yes', typeof stored === 'number' && stored > 0 ? 'yes' : 'no'),
  ];
}

/** Run the phases before submission, so background mining starts only when the submission waits. */
async function screenedWork(guardian: Guardian): Promise<Screened> {
  const plan = await guardian.buildScanPlan();
  if (plan.kind !== 'plan') {
    throw new Error(`Expected a scan plan, got ${plan.reason}`);
  }
  const discovered = await guardian.discoverCandidatePositions(plan);
  return guardian.screenWork(await guardian.reconstructWork(discovered));
}

function sdkClients(
  fixture: ProtocolFixture,
  parameters: AnvilScenario,
  observers: Observers,
  account: PrivateKeyAccount | undefined,
): { readonly client: ViemRpcClient; readonly publicClient: PublicClient } {
  const transport = createViemRpcTransport({
    urls: [fixture.anvil.rpcUrl],
    timeoutMs: 10_000,
    maxResponseBodySize: 10 * 1_048_576,
    retryCount: 2,
    retryDelayMs: 150,
    userAgent: 'guardian-daemon-sdk-benchmark',
    onEvent: observers.onEvent,
  });
  const chain = fixture.anvil.chain;
  const publicClient = createPublicClient({ chain, transport, pollingInterval: parameters.blockIntervalMs });
  const walletClient = account === undefined ? undefined : createWalletClient({ account, chain, transport });
  const client = new ViemRpcClient({
    publicClient,
    walletClient,
    maxLogBlockRange: 10_000,
    transactionPolicy: POLICY,
    onEvent: observers.onEvent,
  });
  return { client, publicClient };
}

function guardianOf(
  fixture: ProtocolFixture,
  parameters: AnvilScenario,
  setup: { readonly mode: 'observe' | 'signal'; readonly client: ViemRpcClient; readonly observers: Observers },
): Guardian {
  const decision = DECISIONS[parameters.decision];
  const common = {
    guardian: fixture.admin.address,
    deployment: {
      chainId: fixture.anvil.chain.id,
      slotSeconds: 12,
      lidoLend: { address: fixture.core, deploymentBlock: 0 },
      guardianSignals: { address: fixture.guardianSignals, deploymentBlock: 0 },
    },
    screening: {
      screen: (request: { readonly anchors: readonly unknown[] }) =>
        Promise.resolve(request.anchors.map(() => decision)),
    },
    onEvent: setup.observers.onEvent,
    confirmationPollIntervalMs: parameters.blockIntervalMs,
    historyReadConcurrency: HISTORY_READ_CONCURRENCY,
    idleHeartbeatInterval: 43_200,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: TX_CONFIRMATION_BLOCKS,
    maxSignalBatchSize: MAX_SIGNAL_BATCH_SIZE,
  };
  if (setup.mode === 'observe') {
    return new Guardian({ ...common, mode: 'observe', client: setup.client });
  }
  return new Guardian({ ...common, client: setup.client, expectedDelegate: fixture.delegate.address });
}

/** Mine one block every `intervalMs` until stopped: accelerated confirmations for a signal submission. */
function backgroundMiner(fixture: ProtocolFixture, intervalMs: number): { stop(): void } {
  const timer = setInterval(() => {
    fixture.anvil.testClient.mine({ blocks: 1 }).catch(() => {
      // A missed tick only delays the next block; the submission keeps waiting for depth.
    });
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

function outcomeOf(outcome: CycleOutcome): { readonly label: string; readonly anchors: number } {
  if (outcome.kind === 'observed') {
    return { label: 'observed', anchors: outcome.screened.results.length };
  }
  return { label: 'reason' in outcome ? `${outcome.kind}:${outcome.reason}` : outcome.kind, anchors: 0 };
}

function errorOutcome(error: unknown): { readonly label: string; readonly anchors: number } {
  const message = error instanceof Error ? error.message.slice(0, 100) : 'unknown failure';
  return { label: `error:${message}`, anchors: 0 };
}

/** An ephemeral loopback port for Anvil, released just before Anvil binds it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address !== null && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}
