// One scripted chain seen through three providers, with the SDK's Guardian over compared logs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, createWalletClient, numberToHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { isRecord } from '../../src/common/validation.ts';
import { createViemRpcTransport, LogsNotConfirmedError, ViemRpcClient } from '../../src/chain/viem-client.ts';
import { Guardian } from '../../src/core/index.ts';
import type { CycleOutcome } from '../../src/core/index.ts';
import { SEND_TIMEOUT_MS } from './client.ts';
import { blockAt, CORE, fakeNode, GUARDIAN, GUARDIAN_KEY, REGISTRY } from './fake-node.ts';
import type { FakeNode, Lot } from './fake-node.ts';
import { failingProvider, scriptedProvider } from './scripted-providers.ts';
import type { Answer, ScriptedProvider } from './scripted-providers.ts';

const HEAD = 200_000;
const REPORT_BLOCK = HEAD - 2;
const LAG_BLOCKS = 4;
/** Supplied one block before the report block and due exactly at it. */
const DUE_SUPPLY: Lot = {
  kind: 'activating',
  blockNumber: REPORT_BLOCK - 1,
  logIndex: 4,
  amount: 5n,
  supplied: 5n,
  position: {
    dust: 0n,
    activating: 5n,
    activatingStart: blockAt(REPORT_BLOCK - 1).timestamp,
    activatingDelay: 12,
  },
};

type Fault = 'none' | 'truncates-logs' | 'lags-and-truncates' | 'unreachable';

interface Observation {
  readonly outcome: CycleOutcome;
  readonly chain: FakeNode;
}

function isRange(filter: unknown): filter is { fromBlock: string; toBlock: string } {
  return isRecord(filter) && typeof filter.fromBlock === 'string' && typeof filter.toBlock === 'string';
}

/** Logs up to the provider's own head, returned without an error as a lagging backend does. */
function truncatedLogs(chain: FakeNode, filter: { fromBlock: string; toBlock: string }): Promise<unknown> {
  const providerHead = HEAD - LAG_BLOCKS;
  if (Number(filter.fromBlock) > providerHead) {
    return Promise.resolve([]);
  }
  const toBlock = numberToHex(Math.min(Number(filter.toBlock), providerHead));
  return chain.transport('eth_getLogs', [{ ...filter, toBlock }]);
}

function answerWith(chain: FakeNode, fault: Fault): Answer {
  return (method, params) => {
    const [filter] = params;
    const isLogRead = method === 'eth_getLogs' && fault !== 'none';
    if (isLogRead && isRange(filter)) {
      return truncatedLogs(chain, filter);
    }
    if (fault === 'lags-and-truncates' && method === 'eth_blockNumber') {
      return numberToHex(HEAD - LAG_BLOCKS);
    }
    return chain.transport(method, params);
  };
}

function start(chain: FakeNode, fault: Fault): Promise<ScriptedProvider> {
  return fault === 'unreachable' ? failingProvider() : scriptedProvider(answerWith(chain, fault));
}

function guardianOver(providers: readonly ScriptedProvider[], mode: 'observe' | 'signal'): Guardian {
  const transport = createViemRpcTransport({
    urls: providers.map((provider) => provider.url),
    logQuorum: 2,
    timeoutMs: 2_000,
    maxResponseBodySize: 5_000_000,
    retryCount: 1,
    retryDelayMs: 1,
    userAgent: 'log-comparison-cycle-test',
  });
  const publicClient = createPublicClient({ chain: mainnet, transport, pollingInterval: 1 });
  const account = privateKeyToAccount(GUARDIAN_KEY);
  const walletClient = mode === 'signal' ? createWalletClient({ account, chain: mainnet, transport }) : undefined;
  const client = new ViemRpcClient({
    publicClient,
    walletClient,
    maxLogBlockRange: 100_000,
    transactionPolicy: {
      sendTimeoutMs: SEND_TIMEOUT_MS,
      replacementFeeBumpBps: 1_000,
      maxFeePerGas: 1_000_000_000_000n,
      replacementTimeoutMs: 2_000,
      sendAttempts: 2,
    },
  });
  return new Guardian({
    mode,
    client,
    expectedDelegate: zeroAddress,
    deployment: {
      chainId: 1,
      slotSeconds: 12,
      lidoLend: { address: CORE, deploymentBlock: 1_000 },
      guardianSignals: { address: REGISTRY, deploymentBlock: 900 },
    },
    guardian: GUARDIAN,
    screening: {
      screen: (request) =>
        Promise.resolve(
          request.anchors.map(() => ({ status: 'judged', requiresSuspect: true, requiresFlag: false }) as const),
        ),
    },
    maxSignalBatchSize: 20,
    idleHeartbeatInterval: 43_200,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: 12,
    confirmationPollIntervalMs: 5,
  });
}

async function cycleOver(faults: readonly Fault[], mode: 'observe' | 'signal'): Promise<Observation> {
  const chain = fakeNode({ head: HEAD, guardianAddedAt: 1_000, lots: [DUE_SUPPLY] });
  const providers = await Promise.all(faults.map((fault) => start(chain, fault)));
  try {
    return { outcome: await guardianOver(providers, mode).cycle(), chain };
  } finally {
    await Promise.all(providers.map((provider) => provider.stop()));
  }
}

function screenedAnchors(outcome: CycleOutcome): number {
  assert.equal(outcome.kind, 'observed');
  return outcome.screened.results.length;
}

test('three providers in sync screen the due supply', async () => {
  const { outcome } = await cycleOver(['none', 'none', 'none'], 'observe');
  assert.equal(screenedAnchors(outcome), 1);
});

test('two agreeing providers screen the due supply while the third is unreachable', async () => {
  const { outcome } = await cycleOver(['none', 'unreachable', 'none'], 'observe');
  assert.equal(screenedAnchors(outcome), 1);
});

test('a provider that reports the head but truncates logs does not stop the other two', async () => {
  const { outcome } = await cycleOver(['none', 'truncates-logs', 'none'], 'observe');
  assert.equal(screenedAnchors(outcome), 1);
});

test('two providers that truncate logs alike cannot outvote the complete one', async () => {
  await assert.rejects(cycleOver(['truncates-logs', 'truncates-logs', 'none'], 'observe'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.cause instanceof LogsNotConfirmedError);
    assert.equal(error.cause.reason, 'answers-differ');
    return true;
  });
});

test('a provider that visibly lags is left out and the other two screen the due supply', async () => {
  const { outcome } = await cycleOver(['none', 'lags-and-truncates', 'none'], 'observe');
  assert.equal(screenedAnchors(outcome), 1);
});

test('a suspect report and the heartbeat are delivered while logs are compared', async () => {
  const { outcome, chain } = await cycleOver(['none', 'none', 'none'], 'signal');
  assert.equal(outcome.kind, 'attested');
  assert.deepEqual(chain.sent.calls, ['suspects', 'heartbeat']);
});
