import type { NodeRequest } from './client.ts';
// Submission decisions are checked at the signed JSON-RPC boundary, without a substitute sender.
import assert from 'node:assert/strict';
import { SEND_TIMEOUT_MS, signingClient } from './client.ts';
import test from 'node:test';
import * as core from '../../src/core/index.ts';
import { coverageDigest } from '../../src/core/digest.ts';
import type { ScreeningResult } from '../../src/core/screening-provider.ts';
import type { TxHash } from '../../src/core/index.ts';
import { blockAt, BORROWER, CHAIN_ID, CORE, fakeNode, GUARDIAN, MARKET, REGISTRY } from './fake-node.ts';
import type { FakeNode, Lot, Script } from './fake-node.ts';
import { guardianOver, IDLE_HEARTBEAT_SECONDS } from './setup.ts';

const HEAD = 200_000;
const REPORT = HEAD - 2;
const TARGET = { marketId: MARKET, borrower: BORROWER };
const LOT: Lot = {
  kind: 'activating',
  blockNumber: 100_000,
  logIndex: 4,
  amount: 5n,
  position: {
    dust: 0n,
    activating: 5n,
    activatingStart: blockAt(100_000).timestamp,
    activatingDelay: 86_400,
  },
  supplied: 5n,
};
const ONE_DUE: Script = { head: HEAD, guardianAddedAt: 1_000, lots: [LOT] };
type Report = 'clean' | 'suspect' | 'flag' | 'both';
type AfterRequest = (node: FakeNode, method: string, params: readonly unknown[]) => void;

async function submitOver(
  script: Script,
  report: Report,
  afterRequest?: AfterRequest,
  tuning: Partial<core.GuardianSetup> = {},
) {
  const node = fakeNode(script);
  const transport: NodeRequest = async (method, params) => {
    const response = await node.transport(method, params);
    afterRequest?.(node, method, params);
    return response;
  };
  const result: ScreeningResult = {
    status: 'judged',
    requiresSuspect: report === 'suspect' || report === 'both',
    requiresFlag: report === 'flag' || report === 'both',
  };
  const { guardian } = guardianOver(script, {
    ...tuning,
    endpoints: [{ node: transport }],
    screening: { screen: (request) => Promise.resolve(request.anchors.map(() => result)) },
  });
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
  const screened = await guardian.screenWork(work);
  return { guardian, node, sent: node.sent, work, screened };
}

async function cycle(script: Script, report: Report) {
  const built = await submitOver(script, report);
  return { ...built, outcome: await built.guardian.signalAndHeartbeat(built.screened) };
}

test('the entry point exports no constructor for discovered, work or screened phase values', () => {
  assert.deepEqual(Object.keys(core).sort(), ['BaseRpcProvider', 'BroadcastFailure', 'Guardian', 'GuardianStop']);
});

test('a clean cycle sends only the heartbeat for the report block', async () => {
  const { outcome, sent } = await cycle(ONE_DUE, 'clean');
  assert.equal(outcome.kind, 'attested');
  assert.deepEqual(sent.suspects, []);
  assert.deepEqual(sent.flags, []);
  assert.deepEqual(sent.calls, ['heartbeat']);
  assert.equal(sent.heartbeats[0]?.block, blockAt(REPORT).hash);
});

test('an invalid digest input stops before the first report transaction', async () => {
  const built = await submitOver({ ...ONE_DUE, invalidBlockHashAt: REPORT }, 'flag');

  await assert.rejects(built.guardian.signalAndHeartbeat(built.screened));

  assert.deepEqual(built.sent.calls, []);
});

test('suspects and flags are signed by the configured account for the registry before heartbeat', async () => {
  const { outcome, sent } = await cycle(ONE_DUE, 'both');
  assert.equal(outcome.kind, 'attested');
  assert.deepEqual(sent.suspects, [[TARGET]]);
  assert.deepEqual(sent.flags, [[TARGET]]);
  assert.deepEqual(sent.calls, ['suspects', 'flags', 'heartbeat']);
  assert.deepEqual(
    sent.transactions.map(({ from, to, nonce, chainId }) => ({
      from: from.toLowerCase(),
      to,
      nonce,
      chainId,
    })),
    [0, 1, 2].map((nonce) => ({ from: GUARDIAN, to: REGISTRY, nonce, chainId: CHAIN_ID })),
  );
});

test('the heartbeat commits the entire work set and returns its report block as the next hint', async () => {
  const { outcome, sent, work } = await cycle(ONE_DUE, 'flag');
  assert.equal(outcome.kind, 'attested');
  const expected = coverageDigest(work.all(), {
    chainId: CHAIN_ID,
    core: CORE,
    registry: REGISTRY,
    guardian: GUARDIAN,
    previousBlockHash: null,
    reportBlockHash: blockAt(REPORT).hash,
  });
  assert.equal(outcome.digest, expected);
  assert.equal(sent.heartbeats[0]?.digest, expected);
  assert.equal(outcome.previousHeartbeatBlock.number, REPORT);
});

/** Alter evidence after the client's final receipt read, leaving Guardian to recheck it independently. */
function afterInclusion(change: (node: FakeNode, hash: TxHash) => void): AfterRequest {
  const reads = new Map<TxHash, number>();
  return (node, method, params) => {
    const hash = node.sent.transactions.find((entry) => entry.hash === params[0])?.hash;
    if (method !== 'eth_getTransactionReceipt' || hash === undefined) {
      return;
    }
    const count = (reads.get(hash) ?? 0) + 1;
    reads.set(hash, count);
    // Inclusion lookup, viem depth wait, then the client's fresh canonical receipt check.
    if (count === 3) {
      change(node, hash);
    }
  };
}

for (const kind of ['missing', 'reverted', 'relocated', 'wrong-transaction'] as const) {
  test(`a ${kind} report receipt is sent again before heartbeat`, async () => {
    const after = afterInclusion((node, hash) => {
      if (hash !== node.sent.transactions[0]?.hash) {
        return;
      }
      if (kind === 'missing') {
        node.setReceipt(hash, null);
        return;
      }
      const number = kind === 'relocated' ? HEAD - 21 : HEAD - 20;
      node.setReceipt(hash, {
        transactionHash: kind === 'wrong-transaction' ? blockAt(123).hash : hash,
        blockNumber: number,
        blockHash: blockAt(number).hash,
        status: kind === 'reverted' ? 'reverted' : 'success',
      });
    });
    const { guardian, screened, sent } = await submitOver(ONE_DUE, 'flag', after);
    assert.equal((await guardian.signalAndHeartbeat(screened)).kind, 'attested');
    assert.deepEqual(sent.calls, ['flags', 'flags', 'heartbeat']);
  });
}

test('an orphaned report receipt is refused by delivery before the shared wait', async () => {
  const after = afterInclusion((node, hash) => {
    node.setReceipt(hash, {
      transactionHash: hash,
      blockNumber: HEAD - 20,
      blockHash: blockAt(HEAD - 20).hash,
      status: 'success',
    });
    node.reorgBlock(HEAD - 20);
  });
  const { guardian, screened, sent } = await submitOver(ONE_DUE, 'flag', after);
  await assert.rejects(guardian.signalAndHeartbeat(screened), {
    message: 'Transaction receipt is not canonical',
  });
  assert.deepEqual(sent.calls, ['flags']);
});

for (const maxReportAttempts of [undefined, 1] as const) {
  const passes = maxReportAttempts ?? 3;
  test(`a report lost on each of ${passes} passes leaves the attempt stale`, async () => {
    const after = afterInclusion((node, hash) => {
      node.setReceipt(hash, null);
    });
    const tuning = maxReportAttempts === undefined ? {} : { maxReportAttempts };
    const { guardian, screened, sent } = await submitOver(ONE_DUE, 'flag', after, tuning);
    assert.deepEqual(await guardian.signalAndHeartbeat(screened), {
      kind: 'stale',
      reason: 'report-no-longer-confirmed',
    });
    assert.deepEqual(
      sent.calls,
      Array.from({ length: passes }, () => 'flags'),
    );
  });
}

test('a report that loses confirmation depth after the shared wait prevents heartbeat', async () => {
  const reads = { count: 0 };
  const { guardian, screened, sent } = await submitOver(ONE_DUE, 'flag', (node, method) => {
    if (method === 'eth_getTransactionReceipt' && node.sent.calls.length === 1) {
      reads.count += 1;
      if (reads.count === 4) {
        // Keep the report block valid but lift the receipt near the current head.
        const transaction = node.sent.transactions[0];
        assert.ok(transaction !== undefined);
        node.setReceipt(transaction.hash, {
          transactionHash: transaction.hash,
          blockNumber: HEAD - 1,
          blockHash: blockAt(HEAD - 1).hash,
          status: 'success',
        });
      }
    }
  });
  assert.deepEqual(await guardian.signalAndHeartbeat(screened), {
    kind: 'stale',
    reason: 'report-no-longer-confirmed',
  });
  assert.deepEqual(sent.calls, ['flags']);
});

for (const nextHead of [REPORT, REPORT + 250]) {
  test(`a plan invalid at head ${nextHead} sends no transactions`, async () => {
    const { guardian, node, screened, sent } = await submitOver(ONE_DUE, 'clean');
    node.advanceTo(nextHead);
    assert.deepEqual(await guardian.signalAndHeartbeat(screened), {
      kind: 'stale',
      reason: nextHead === REPORT ? 'head-not-past-report-block' : 'report-block-aged-out',
    });
    assert.deepEqual(sent.calls, []);
  });
}

test('a stored heartbeat rollback invalidates the plan before any transaction', async () => {
  const covered = blockAt(95_000);
  const built = await submitOver(
    {
      ...ONE_DUE,
      heartbeatTimestamp: covered.timestamp,
      heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
    },
    'clean',
  );
  built.node.setHeartbeatTimestamp(covered.timestamp - 1);

  assert.deepEqual(await built.guardian.signalAndHeartbeat(built.screened), {
    kind: 'stale',
    reason: 'stored-heartbeat-moved',
  });
  assert.deepEqual(built.sent.calls, []);
});

test('heartbeat digest binds the recovered previous coverage block', async () => {
  const covered = blockAt(95_000);
  const { outcome, sent, work } = await cycle(
    {
      ...ONE_DUE,
      heartbeatTimestamp: covered.timestamp,
      heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
    },
    'clean',
  );
  assert.equal(outcome.kind, 'attested');
  const expected = coverageDigest(work.all(), {
    chainId: CHAIN_ID,
    core: CORE,
    registry: REGISTRY,
    guardian: GUARDIAN,
    previousBlockHash: covered.hash,
    reportBlockHash: blockAt(REPORT).hash,
  });
  assert.equal(outcome.digest, expected);
  assert.equal(sent.heartbeats[0]?.digest, expected);
});

test('a plan that expires during report confirmation stops before flags and heartbeat', async () => {
  const after = afterInclusion((node) => {
    node.advanceTo(REPORT + 250);
  });
  const { guardian, screened, sent } = await submitOver(ONE_DUE, 'both', after);
  assert.deepEqual(await guardian.signalAndHeartbeat(screened), {
    kind: 'stale',
    reason: 'report-block-aged-out',
  });
  assert.deepEqual(sent.calls, ['suspects']);
});

for (const after of ['none', 'suspects', 'flags'] as const) {
  test(`a noncanonical head after ${after} stops before any further transaction`, async () => {
    const hook = afterInclusion((node) => {
      if (node.sent.calls.at(-1) === after) {
        node.forkHead();
      }
    });
    const { guardian, node, screened, sent } = await submitOver(ONE_DUE, 'both', hook);
    if (after === 'none') {
      node.forkHead();
    }
    await assert.rejects(guardian.signalAndHeartbeat(screened), { reason: 'head-not-canonical' });
    const expected = { none: [], suspects: ['suspects'], flags: ['suspects', 'flags'] };
    assert.deepEqual(sent.calls, expected[after]);
  });
}

test('a heartbeat whose canonical receipt disappears cannot return attested', async () => {
  const after = afterInclusion((node, hash) => {
    node.setReceipt(hash, null);
  });
  const { guardian, screened, sent } = await submitOver(ONE_DUE, 'clean', after);
  await assert.rejects(guardian.signalAndHeartbeat(screened), /Heartbeat .* is no longer confirmed/);
  assert.deepEqual(sent.calls, ['heartbeat']);
});

function idleSince(age: number): Script {
  const covered = blockAt(REPORT - age / 12);
  return {
    head: HEAD,
    guardianAddedAt: 1_000,
    heartbeatTimestamp: covered.timestamp,
    heartbeats: [{ blockNumber: covered.number, timestamp: covered.timestamp }],
  };
}

test('a cycle with no work inside the idle interval sends nothing', async () => {
  const { outcome, sent, work } = await cycle(idleSince(IDLE_HEARTBEAT_SECONDS - 12), 'clean');
  assert.equal(work.anchors, 0);
  assert.equal(outcome.kind, 'nothing-due');
  assert.equal(outcome.reason, 'no-work-and-idle-heartbeat-not-due');
  assert.deepEqual(sent.calls, []);
  assert.deepEqual(sent.transactions, []);
});

test('a cycle with no work heartbeats once the idle interval has passed', async () => {
  const { outcome, sent } = await cycle(idleSince(IDLE_HEARTBEAT_SECONDS), 'clean');
  assert.equal(outcome.kind, 'attested');
  assert.equal(sent.heartbeats.length, 1);
});

test('a Guardian that never heartbeated heartbeats even with no work', async () => {
  const { outcome, sent, work } = await cycle({ head: HEAD, guardianAddedAt: 1_000 }, 'clean');
  assert.equal(work.anchors, 0);
  assert.equal(outcome.kind, 'attested');
  assert.equal(sent.heartbeats.length, 1);
});

test('rechecks the plan while waiting for all report confirmations', { timeout: 20_000 }, async () => {
  let waitingResolve: () => void = () => {
    throw new Error('Wait was not initialized');
  };
  const waiting = new Promise<void>((resolve) => {
    waitingResolve = resolve;
  });
  const reads = { latestAfterSend: 0 };
  const built = await submitOver(ONE_DUE, 'flag', (node, method, params) => {
    if (method === 'eth_sendRawTransaction') {
      const transaction = node.sent.transactions[0];
      assert.ok(transaction !== undefined);
      node.setReceipt(transaction.hash, {
        transactionHash: transaction.hash,
        blockNumber: HEAD - 1,
        blockHash: blockAt(HEAD - 1).hash,
        status: 'success',
      });
    }
    const isLatestRead = method === 'eth_getBlockByNumber' && params[0] === 'latest';
    if (node.sent.calls.length === 1 && isLatestRead) {
      reads.latestAfterSend += 1;
      if (reads.latestAfterSend === 2) {
        waitingResolve();
      }
    }
  });
  const submitting = built.guardian.signalAndHeartbeat(built.screened);
  assert.equal(await Promise.race([waiting.then(() => 'waiting'), submitting.then(() => 'finished')]), 'waiting');
  // Let the real full-depth wait start before changing the head; the next slot must recheck the plan.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(built.sent.calls, ['flags']);
  built.node.advanceTo(REPORT + 250);
  assert.deepEqual(await submitting, { kind: 'stale', reason: 'report-block-aged-out' });
  assert.deepEqual(built.sent.calls, ['flags']);
});

test('Guardian forwards delivery context and confirms each action once in protocol order', async () => {
  const events: core.SdkEvent[] = [];
  const { guardian, node } = guardianOver(ONE_DUE, {
    onEvent: (event) => {
      events.push(event);
    },
    screening: {
      screen: (request) =>
        Promise.resolve(
          request.anchors.map(() => ({
            status: 'judged',
            requiresSuspect: true,
            requiresFlag: true,
          })),
        ),
    },
  });
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
  const outcome = await guardian.signalAndHeartbeat(await guardian.screenWork(work));
  assert.equal(outcome.kind, 'attested');
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.event === 'transaction.broadcast' ||
          event.event === 'transaction.included' ||
          event.event === 'report.confirmed',
      )
      .map((event) => [event.event, event.context?.method]),
    [
      ['transaction.broadcast', 'suspect'],
      ['transaction.included', 'suspect'],
      ['report.confirmed', 'suspect'],
      ['transaction.broadcast', 'flag'],
      ['transaction.included', 'flag'],
      ['report.confirmed', 'flag'],
      ['transaction.broadcast', 'heartbeat'],
      ['transaction.included', 'heartbeat'],
      ['report.confirmed', 'heartbeat'],
    ],
  );
  assert.equal(node.sent.transactions.length, 3);
  for (const event of events) {
    if (!('context' in event) || event.context === undefined) {
      continue;
    }
    if (event.context.method === 'heartbeat') {
      assert.deepEqual(event.context.reportBlock, plan.discoveryRange.to);
      assert.equal(event.context.coverageDigest, outcome.digest);
    } else if (event.context.method === 'cancel') {
      assert.fail('submission must not emit nonce-clearing events');
    } else {
      assert.equal(event.context.marketId, MARKET);
      assert.deepEqual(event.context.accounts, [BORROWER]);
    }
  }
  assert.deepEqual(
    events
      .filter((event) => event.event === 'report.confirmed')
      .map((event) => [event.transactionHash, event.receiptStatus]),
    node.sent.transactions.map((transaction) => [transaction.hash, 'success']),
  );
});

for (const [interBatchConfirmationBlocks, txConfirmationBlocks] of [
  [1, 12],
  [5, 12],
  [20, 3],
] as const) {
  test(`intermediate depth ${interBatchConfirmationBlocks} is capped at full depth ${txConfirmationBlocks}`, async (context) => {
    const node = fakeNode(ONE_DUE);
    const client = signingClient([{ node: node.transport }]);
    const send = client.send.bind(client);
    const depths: number[] = [];
    context.mock.method(client, 'send', (transaction: core.TransactionRequest, options: core.SendOptions) => {
      depths.push(options.confirmations);
      return send(transaction, options);
    });
    const { guardian } = guardianOver(ONE_DUE, {
      client,
      interBatchConfirmationBlocks,
      txConfirmationBlocks,
      screening: {
        screen: (request) =>
          Promise.resolve(
            request.anchors.map(() => ({
              status: 'judged',
              requiresSuspect: true,
              requiresFlag: true,
            })),
          ),
      },
    });
    const plan = await guardian.buildScanPlan();
    assert.equal(plan.kind, 'plan');
    const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
    assert.equal((await guardian.signalAndHeartbeat(await guardian.screenWork(work))).kind, 'attested');
    const intermediate = Math.min(interBatchConfirmationBlocks, txConfirmationBlocks);
    assert.deepEqual(depths, [intermediate, intermediate, txConfirmationBlocks]);
  });
}

/** Counts the head reads that follow the first report, so a test can wait for the shared wait to poll. */
function trackHeadReads() {
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  let count = 0;
  return {
    record(): void {
      count += 1;
      for (const waiter of waiters.filter((entry) => count >= entry.count)) {
        waiter.resolve();
      }
    },
    further(reads: number): Promise<void> {
      return new Promise((resolve) => {
        waiters.push({ count: count + reads, resolve });
      });
    },
  };
}

test('shared report confirmation stops when the client delivery budget ends', { timeout: 2_000 }, async (context) => {
  // Only the clock is mocked: a send cannot use up its own budget, while the wait keeps polling.
  context.mock.timers.enable({ apis: ['Date'] });
  const headReads = trackHeadReads();
  const built = await submitOver(
    ONE_DUE,
    'flag',
    (node, method, params) => {
      if (method === 'eth_sendRawTransaction') {
        const transaction = node.sent.transactions[0];
        assert.ok(transaction !== undefined);
        // Deep enough for the batch, and one block short of every deeper requirement.
        node.setReceipt(transaction.hash, {
          transactionHash: transaction.hash,
          blockNumber: HEAD,
          blockHash: blockAt(HEAD).hash,
          status: 'success',
        });
      }
      const isLatestRead = method === 'eth_getBlockByNumber' && params[0] === 'latest';
      if (node.sent.calls.length === 1 && isLatestRead) {
        headReads.record();
      }
    },
    { interBatchConfirmationBlocks: 1, confirmationPollIntervalMs: 1 },
  );
  // An aged-out plan ends the wait under any verdict, so a failing run cannot keep polling.
  context.after(() => {
    built.node.advanceTo(REPORT + 250);
  });
  const submitting = built.guardian.signalAndHeartbeat(built.screened);
  const settled = submitting.then(
    () => 'settled',
    () => 'settled',
  );

  await headReads.further(2);
  context.mock.timers.tick(SEND_TIMEOUT_MS - 1);
  await headReads.further(4);
  assert.equal(await Promise.race([settled, Promise.resolve('waiting')]), 'waiting');
  context.mock.timers.tick(1);

  await assert.rejects(submitting, { reason: 'report-confirmation-timeout' });
  assert.deepEqual(built.sent.calls, ['flags']);
});

test('shared report confirmation uses the configured polling interval', { timeout: 1000 }, async () => {
  let latestReads = 0;
  const built = await submitOver(
    ONE_DUE,
    'flag',
    (node, method, params) => {
      if (method === 'eth_sendRawTransaction') {
        const transaction = node.sent.transactions[0];
        assert.ok(transaction !== undefined);
        node.setReceipt(transaction.hash, {
          transactionHash: transaction.hash,
          blockNumber: HEAD - 1,
          blockHash: blockAt(HEAD - 1).hash,
          status: 'success',
        });
      }
      const isLatestRead = method === 'eth_getBlockByNumber' && params[0] === 'latest';
      if (node.sent.calls.length === 1 && isLatestRead) {
        latestReads += 1;
        if (latestReads === 2) {
          // The returned head still lacks full depth. Only the next poll sees the expired plan.
          node.advanceTo(REPORT + 250);
        }
      }
    },
    { confirmationPollIntervalMs: 5 },
  );
  assert.deepEqual(await built.guardian.signalAndHeartbeat(built.screened), {
    kind: 'stale',
    reason: 'report-block-aged-out',
  });
  assert.ok(latestReads >= 3);
  assert.deepEqual(built.sent.calls, ['flags']);
});
