// The transport family: the SDK's viem transport against loopback endpoints that answer, lag, fail,
// hang or refuse connections. It measures HTTP attempts, bytes, latency to a result and the time lost
// on a failing first endpoint, and runs whole observe cycles over HTTP, which the daemon family repeats.

import { createPublicClient, numberToHex } from 'viem';
import type { PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { ViemRpcClient, createViemRpcTransport } from '../src/chain/viem-client.ts';
import { Guardian } from '../src/core/index.ts';
import type {
  EventHandler,
  ScreeningProvider,
  ScreeningResult,
  SdkEvent,
  TransactionPolicy,
} from '../src/core/index.ts';
import { ResourceWindow, check, spreadOf } from './metrics.ts';
import type { Check, RunReport } from './metrics.ts';
import { ENDPOINTS, startLoopback } from './loopback.ts';
import type { TransportCondition, TransportScenario } from './scenarios.ts';
import { CHAIN_ID, SLOT_SECONDS, TOPICS } from './synthetic-rpc.ts';
import { CORE, GUARDIAN, HISTORY_BLOCKS, REGISTRY, REPORT_BLOCK, REPORT_BLOCK_LAG } from './worlds.ts';

/** The example application's transport settings, except the timeout, which the scenario sets. */
const RETRY_COUNT = 2;

const RETRY_DELAY_MS = 150;

const MAX_RESPONSE_BODY_BYTES = 10 * 1_048_576;

/** The response limit of the `response-limit` condition, below the size of its log answer. */
const LIMITED_RESPONSE_BODY_BYTES = 1_048_576;

const USER_AGENT = 'guardian-daemon-sdk-benchmark';

const MAX_LOG_BLOCK_RANGE = 10_000;

const LOG_QUORUM = 2;

/** The example application's history read concurrency; the SDK reads one supply or position at a time. */
const HISTORY_READ_CONCURRENCY = 8;

const BYTES_PER_MEGABYTE = 1_048_576;

const POLICY: TransactionPolicy = {
  maxFeePerGas: 100_000_000_000n,
  sendTimeoutMs: 336_000,
  replacementFeeBumpBps: 1_000,
  replacementTimeoutMs: 36_000,
  sendAttempts: 5,
};

const CLEAN: ScreeningResult = { status: 'judged', requiresSuspect: false, requiresFlag: false };

/** A provider in this process that judges every anchor clean. */
export const CLEAN_SCREENING: ScreeningProvider = {
  screen: (request) => Promise.resolve(request.anchors.map(() => CLEAN)),
};

/** Conditions whose every request is expected to fail. */
const FAILING: ReadonlySet<TransportCondition> = new Set(['response-limit', 'exhausted']);

/** Physical HTTP attempts per endpoint, bytes and failures, from the transport's own events. */
export class AttemptRecorder {
  readonly #attempts = new Map<number, number>();

  readonly #methods = new Map<string, number>();

  readonly #failedAttemptsMs = new Map<number, number[]>();

  #requestBytes = 0;

  #responseBytes = 0;

  #answersDiffer = 0;

  readonly onEvent = (event: SdkEvent): void => {
    if (event.event === 'rpc.requestStarted') {
      this.#attempts.set(event.rpcIndex, (this.#attempts.get(event.rpcIndex) ?? 0) + 1);
      this.#methods.set(event.method, (this.#methods.get(event.method) ?? 0) + 1);
      return;
    }
    if (event.event === 'rpc.answersDiffer') {
      this.#answersDiffer += 1;
      return;
    }
    if (event.event !== 'rpc.requestFinished') {
      return;
    }
    this.#requestBytes += event.requestBytes;
    this.#responseBytes += event.responseBytes;
    if (event.error !== undefined) {
      const failed = this.#failedAttemptsMs.get(event.rpcIndex) ?? [];
      failed.push(event.finishedAt - event.startedAt);
      this.#failedAttemptsMs.set(event.rpcIndex, failed);
    }
  };

  totals(): Record<string, number> {
    const firstEndpointFailures = this.#failedAttemptsMs.get(0) ?? [];
    return {
      httpAttempts: [...this.#attempts.values()].reduce((total, attempts) => total + attempts, 0),
      primaryAttempts: this.#attempts.get(0) ?? 0,
      failedAttempts: [...this.#failedAttemptsMs.values()].reduce((total, failed) => total + failed.length, 0),
      requestKb: this.#requestBytes / 1_024,
      responseMb: this.#responseBytes / BYTES_PER_MEGABYTE,
      answersDiffer: this.#answersDiffer,
      // What each request loses on a failing first endpoint before the next one is asked.
      ...(firstEndpointFailures.length === 0 ? {} : { endpointSwitchMs: spreadOf(firstEndpointFailures).median }),
    };
  }

  attemptsByMethod(): Record<string, number> {
    return Object.fromEntries(this.#methods);
  }

  attemptsByEndpoint(): Record<string, number> {
    return Object.fromEntries(
      [...this.#attempts].map(([rpcIndex, attempts]) => [`endpoint ${String(rpcIndex)}`, attempts]),
    );
  }
}

/** One logical request: how long it took and how many logs it returned, or that it failed. */
interface Timing {
  readonly ms: number;
  readonly logs: number;
  readonly error: string | undefined;
}

export async function runTransport(
  parameters: TransportScenario,
  context: { readonly presetName: string; readonly scenarioId: string },
): Promise<RunReport> {
  const loopback = await startLoopback(context.presetName, context.scenarioId);
  try {
    const isCycle = parameters.condition === 'observe-cycle' || parameters.condition === 'observe-cycle-fallback';
    return isCycle ? await observeCycle(parameters, loopback.urls) : await requestBurst(parameters, loopback.urls);
  } finally {
    loopback.stop();
  }
}

async function requestBurst(parameters: TransportScenario, urls: readonly string[]): Promise<RunReport> {
  const attempts = new AttemptRecorder();
  const client = publicClientOf(parameters, urls, attempts.onEvent);
  const window = new ResourceWindow();
  const timings = await burst(parameters, () => requestOnce(client, parameters));
  const usage = window.close();
  const failures = timings.filter((timing) => timing.error !== undefined);
  const latencies = spreadOf(timings.map((timing) => timing.ms));
  const logsReturned = timings.reduce((total, timing) => total + timing.logs, 0);
  return {
    outcome: failures.length === 0 ? 'succeeded' : `failed ${String(failures.length)}: ${failures[0]?.error ?? ''}`,
    metrics: {
      ...usage,
      ...attempts.totals(),
      requests: timings.length,
      succeeded: timings.length - failures.length,
      failedRequests: failures.length,
      logsReturned,
      latencyP50Ms: latencies.median,
      latencyP95Ms: percentileOf(
        timings.map((timing) => timing.ms),
        0.95,
      ),
      latencyMaxMs: latencies.max,
    },
    rpcByPhase: { transport: attempts.attemptsByEndpoint() },
    checks: burstChecks(parameters, { timings, failures: failures.length, logsReturned, totals: attempts.totals() }),
  };
}

function burstChecks(
  parameters: TransportScenario,
  result: {
    readonly timings: readonly Timing[];
    readonly failures: number;
    readonly logsReturned: number;
    readonly totals: Readonly<Record<string, number>>;
  },
): Check[] {
  const expectsFailure = FAILING.has(parameters.condition);
  const checks = [
    check('failed requests', expectsFailure ? parameters.requests : 0, result.failures),
    check('requests', parameters.requests, result.timings.length),
  ];
  if (parameters.condition === 'silent-omission') {
    // The trust boundary: a lagging endpoint answers successfully, and one provider cannot show otherwise.
    const isOmitted = result.logsReturned < parameters.logs * parameters.requests;
    checks.push(check('omission detected', 'no', isOmitted ? 'no' : 'nothing omitted'));
  }
  if (parameters.condition === 'log-quorum-lagging') {
    checks.push(check('differing answers reported', parameters.requests, result.totals.answersDiffer ?? 0));
  }
  if (ENDPOINTS[parameters.condition].length > 1) {
    // viem's fallback starts every request at the first endpoint; nothing demotes a failing one.
    const isAskedFirst = (result.totals.primaryAttempts ?? 0) >= parameters.requests;
    checks.push(check('first endpoint asked for every request', 'yes', isAskedFirst ? 'yes' : 'no'));
  }
  return checks;
}

function publicClientOf(
  parameters: Pick<TransportScenario, 'condition' | 'timeoutMs'>,
  urls: readonly string[],
  onEvent: EventHandler,
): PublicClient {
  const isQuorum = parameters.condition === 'log-quorum' || parameters.condition === 'log-quorum-lagging';
  const transport = createViemRpcTransport({
    urls,
    timeoutMs: parameters.timeoutMs,
    maxResponseBodySize:
      parameters.condition === 'response-limit' ? LIMITED_RESPONSE_BODY_BYTES : MAX_RESPONSE_BODY_BYTES,
    retryCount: RETRY_COUNT,
    retryDelayMs: RETRY_DELAY_MS,
    userAgent: USER_AGENT,
    onEvent,
    ...(isQuorum ? { logQuorum: LOG_QUORUM } : {}),
  });
  return createPublicClient({ chain: mainnet, transport });
}

/** A log range over the whole history, or a head read when the scenario serves no logs. */
async function requestOnce(client: PublicClient, parameters: TransportScenario): Promise<number> {
  if (parameters.logs === 0) {
    await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
    return 0;
  }
  const logs = await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: CORE,
        topics: [TOPICS.supply],
        fromBlock: numberToHex(REPORT_BLOCK - HISTORY_BLOCKS + 1),
        toBlock: numberToHex(REPORT_BLOCK),
      },
    ],
  });
  return logs.length;
}

/** Issue `requests` requests, `concurrency` at a time, and time each one. */
async function burst(parameters: TransportScenario, request: () => Promise<number>): Promise<Timing[]> {
  const timings: Timing[] = [];
  let issued = 0;
  const worker = async (): Promise<void> => {
    while (issued < parameters.requests) {
      issued += 1;
      const startedAt = performance.now();
      const result = await request().then(
        (logs) => ({ logs, error: undefined }),
        (error: unknown) => ({ logs: 0, error: error instanceof Error ? error.name : 'unknown failure' }),
      );
      timings.push({ ms: performance.now() - startedAt, ...result });
    }
  };
  const workers = Math.max(1, Math.min(parameters.concurrency, parameters.requests));
  await Promise.all(Array.from({ length: workers }, worker));
  return timings;
}

/** One observe cycle over HTTP: every read of a real cycle, serialized and parsed. */
async function observeCycle(parameters: TransportScenario, urls: readonly string[]): Promise<RunReport> {
  const attempts = new AttemptRecorder();
  const guardian = observeGuardian(parameters, urls, { screening: CLEAN_SCREENING, onEvent: attempts.onEvent });
  const window = new ResourceWindow();
  const outcome = await observeOnce(guardian);
  const usage = window.close();
  const totals = attempts.totals();
  const rpcPerAnchor = outcome.anchors > 0 ? (totals.httpAttempts ?? 0) / outcome.anchors : 0;
  return {
    outcome: outcome.kind,
    metrics: { ...usage, ...totals, anchors: outcome.anchors, rpcPerAnchor },
    rpcByPhase: { transport: attempts.attemptsByEndpoint() },
    checks: [check('outcome', 'observed', outcome.kind), check('anchors', parameters.positions, outcome.anchors)],
  };
}

/**
 * The Guardian of every observe cycle over loopback HTTP: the example application's transport settings
 * and policy over the cycle world. The transport, the client and the cycle report to `onEvent`.
 */
export function observeGuardian(
  transport: Pick<TransportScenario, 'condition' | 'timeoutMs'>,
  urls: readonly string[],
  setup: { readonly screening: ScreeningProvider; readonly onEvent: EventHandler },
): Guardian {
  const client = new ViemRpcClient({
    publicClient: publicClientOf(transport, urls, setup.onEvent),
    onEvent: setup.onEvent,
    maxLogBlockRange: MAX_LOG_BLOCK_RANGE,
    transactionPolicy: POLICY,
  });
  const deploymentBlock = REPORT_BLOCK - HISTORY_BLOCKS + 1;
  return new Guardian({
    mode: 'observe',
    client,
    onEvent: setup.onEvent,
    guardian: GUARDIAN,
    deployment: {
      chainId: CHAIN_ID,
      slotSeconds: SLOT_SECONDS,
      lidoLend: { address: CORE, deploymentBlock },
      guardianSignals: { address: REGISTRY, deploymentBlock },
    },
    screening: setup.screening,
    reportBlockLag: REPORT_BLOCK_LAG,
    historyReadConcurrency: HISTORY_READ_CONCURRENCY,
    idleHeartbeatInterval: 43_200,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: 12,
    maxSignalBatchSize: 50,
  });
}

/** One cycle without a previous heartbeat: its outcome and the anchors it screened, or the error that ended it. */
export function observeOnce(guardian: Guardian): Promise<{ readonly kind: string; readonly anchors: number }> {
  return guardian.cycle(null).then(
    (result) => ({ kind: result.kind, anchors: result.kind === 'observed' ? result.screened.results.length : 0 }),
    (error: unknown) => ({
      kind: `error:${error instanceof Error ? error.message.slice(0, 100) : 'unknown'}`,
      anchors: 0,
    }),
  );
}

function percentileOf(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}
