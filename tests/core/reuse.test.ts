// A cycle given the work of an earlier attempt over the same coverage: a position whose newest event is
// still the one the earlier reconstruction started from keeps its anchors without a walk, and the work is
// the one a full reconstruction finds. Work from another coverage, or over a report block that left the
// chain, is walked again, and so is a position whose newest event the earlier reads lacked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { numberToHex } from 'viem';
import { BaseRpcProvider, GuardianStop } from '../../src/core/index.ts';
import type { CycleOutcome, Observed, ScreeningResult } from '../../src/core/index.ts';
import { Work } from '../../src/core/outcomes.ts';
import { isRecord } from '../../src/common/validation.ts';
import { rpcRequest } from './client.ts';
import type { NodeRequest } from './client.ts';
import { blockAt, CONTROLLER, CORE, fakeNode } from './fake-node.ts';
import type { FakeNode, Lot, Script } from './fake-node.ts';
import { guardianOver } from './setup.ts';

const HEAD = 200_000;

const NEXT_HEAD = HEAD + 300;

const DAY = 24 * 60 * 60;

/** The window starts seven days before the Guardian joined. */
const JOINED = 150_000;

const FLAG: ScreeningResult = { status: 'judged', requiresSuspect: false, requiresFlag: true };

/** A lot that started from zero at `blockNumber`, due `delay` seconds later. */
function lot(blockNumber: number, amount: bigint, delay = DAY): Lot {
  return {
    kind: 'activating',
    blockNumber,
    logIndex: 4,
    amount,
    position: { dust: 0n, activating: amount, activatingStart: blockAt(blockNumber).timestamp, activatingDelay: delay },
    supplied: amount,
  };
}

/** A walk reads one borrower's history from the core and the controller, naming the borrower in a topic. */
function isWalkRead(query: { readonly address: string; readonly topics: readonly unknown[] }): boolean {
  const isMarketRead = [CORE, CONTROLLER].some((address) => address.toLowerCase() === query.address.toLowerCase());
  return isMarketRead && query.topics.length > 1;
}

/** An observing Guardian over a scripted node. */
function observerOver(script: Script) {
  const node = fakeNode(script);
  const client = new BaseRpcProvider({ request: rpcRequest(node.transport), maxLogBlockRange: 10_000 });
  const { guardian } = guardianOver(script, { mode: 'observe', client });
  return { guardian, node };
}

function observed(outcome: CycleOutcome): Observed {
  assert.equal(outcome.kind, 'observed');
  return outcome;
}

/** The anchors a cycle screened, as their supply block and log index. */
function anchorsFound(outcome: CycleOutcome): [number, number][] {
  return observed(outcome)
    .screened.results.map(({ anchor }): [number, number] => [Number(BigInt(anchor.blockHash)), anchor.logIndex])
    .sort((left, right) => left[0] - right[0]);
}

/** A first cycle at `HEAD` and its work, then the chain moved on to `NEXT_HEAD`. */
async function firstCycle(script: Script) {
  const { guardian, node } = observerOver({ ...script, head: HEAD });
  const earlierWork = observed(await guardian.cycle()).screened.work();
  node.advanceTo(NEXT_HEAD);
  const queriesBefore = node.logQueries.length;
  return { guardian, node, earlierWork, walkReadsSince: () => node.logQueries.slice(queriesBefore).filter(isWalkRead) };
}

/** What a Guardian that never saw the first cycle finds at `NEXT_HEAD`. */
async function fullReconstruction(script: Script): Promise<CycleOutcome> {
  return observerOver({ ...script, head: NEXT_HEAD }).guardian.cycle();
}

/** An observing Guardian over `node` whose log answers pass through `changeLogs`, as a lagging or forked endpoint gives them. */
function observerChangingLogs(
  script: Script,
  node: FakeNode,
  changeLogs: (logs: readonly unknown[]) => readonly unknown[],
) {
  const endpoint: NodeRequest = async (method, params) => {
    const answer = await node.transport(method, params);
    if (method !== 'eth_getLogs' || !Array.isArray(answer)) {
      return answer;
    }
    const logs: readonly unknown[] = answer;
    return changeLogs(logs);
  };
  const client = new BaseRpcProvider({ request: rpcRequest(endpoint), maxLogBlockRange: 10_000 });
  return guardianOver(script, { mode: 'observe', client }).guardian;
}

/** Where a log that the scripted node answered sits. */
function logPosition(log: unknown): { readonly blockNumber: number; readonly logIndex: number } {
  if (!isRecord(log)) {
    throw new TypeError('the node answered a log that is not an object');
  }
  return { blockNumber: Number(BigInt(String(log.blockNumber))), logIndex: Number(BigInt(String(log.logIndex))) };
}

/** Anchors in one block, ordered by log index. */
function byLogIndex(left: [number, number], right: [number, number]): number {
  return left[1] - right[1];
}

test('a position its controller logged nothing for since the earlier work keeps its anchors without a walk', async () => {
  const script: Script = { head: HEAD, guardianAddedAt: JOINED, lots: [lot(100_000, 5n)] };
  const { guardian, earlierWork, walkReadsSince } = await firstCycle(script);

  const outcome = await guardian.cycle(null, earlierWork);

  assert.deepEqual(anchorsFound(outcome), [[100_000, 5]]);
  assert.deepEqual(anchorsFound(outcome), anchorsFound(await fullReconstruction(script)));
  assert.deepEqual(walkReadsSince(), []);
});

test('a top-up after the earlier work is walked again and finds what a full reconstruction finds', async () => {
  const started = lot(100_000, 5n);
  const topUp: Lot = {
    kind: 'activating',
    blockNumber: HEAD + 100,
    logIndex: 4,
    amount: 3n,
    // The top-up ends no later than the lot, so the timer stays and the position remains due.
    position: { dust: 0n, activating: 8n, activatingStart: started.position.activatingStart, activatingDelay: DAY },
    supplied: 3n,
  };
  const script: Script = { head: HEAD, guardianAddedAt: JOINED, lots: [started, topUp] };
  const { guardian, earlierWork, walkReadsSince } = await firstCycle(script);

  const outcome = await guardian.cycle(null, earlierWork);

  assert.deepEqual(anchorsFound(outcome), [
    [100_000, 5],
    [HEAD + 100, 5],
  ]);
  assert.deepEqual(anchorsFound(outcome), anchorsFound(await fullReconstruction(script)));
  assert.notDeepEqual(walkReadsSince(), []);
});

test('a top-up that discovery saw is walked even when an endpoint lacks it in a later controller read', async () => {
  const started = lot(100_000, 5n);
  const topUp: Lot = {
    kind: 'activating',
    blockNumber: HEAD + 100,
    logIndex: 4,
    amount: 3n,
    position: { dust: 0n, activating: 8n, activatingStart: started.position.activatingStart, activatingDelay: DAY },
    supplied: 3n,
  };
  const script: Script = { head: HEAD, guardianAddedAt: JOINED, lots: [started, topUp] };
  const node = fakeNode(script);
  // The first cycle reports at its head less the default lag of two blocks.
  const earlierReportBlock = HEAD - 2;
  // A lagging endpoint answers the controller's events after the earlier report block without the top-up,
  // which a separate read for reuse would have taken as a position that nothing changed.
  const lagging: NodeRequest = (method, params) => {
    const [filter] = params;
    const isReadSinceEarlierWork =
      method === 'eth_getLogs' && isRecord(filter) && filter.fromBlock === numberToHex(earlierReportBlock + 1);
    return isReadSinceEarlierWork ? Promise.resolve([]) : node.transport(method, params);
  };
  const client = new BaseRpcProvider({ request: rpcRequest(lagging), maxLogBlockRange: 10_000 });
  const { guardian } = guardianOver(script, { mode: 'observe', client });
  const earlierWork = observed(await guardian.cycle()).screened.work();
  assert.equal(earlierWork.reportBlock.number, earlierReportBlock);
  node.advanceTo(NEXT_HEAD);

  const outcome = await guardian.cycle(null, earlierWork);

  assert.deepEqual(anchorsFound(outcome), [
    [100_000, 5],
    [HEAD + 100, 5],
  ]);
  assert.deepEqual(anchorsFound(outcome), anchorsFound(await fullReconstruction(script)));
});

test("a top-up that the earlier attempt's reads missed is walked once discovery reads it", async () => {
  const started = lot(100_000, 5n);
  const topUpBlock = HEAD - 10;
  // The top-up restarts the lot's timer with a ten-minute delay: the lot is due at the next report block,
  // not at the earlier one, so the earlier work holds the old anchor only if its reads missed the top-up.
  const topUp: Lot = {
    kind: 'activating',
    blockNumber: topUpBlock,
    logIndex: 4,
    amount: 3n,
    position: { dust: 0n, activating: 8n, activatingStart: blockAt(topUpBlock).timestamp, activatingDelay: 600 },
    supplied: 3n,
  };
  const script: Script = { head: HEAD, guardianAddedAt: JOINED, lots: [started, topUp] };
  const node = fakeNode(script);
  // During the earlier attempt the endpoint answers every log read up to the block before the top-up,
  // without an error, while it answers blocks at the head.
  let lastLogBlock: number | null = topUpBlock - 1;
  const guardian = observerChangingLogs(script, node, (logs) => {
    const lastBlock = lastLogBlock;
    return lastBlock === null ? logs : logs.filter((log) => logPosition(log).blockNumber <= lastBlock);
  });
  const earlier = await guardian.cycle();
  assert.deepEqual(anchorsFound(earlier), [[100_000, 5]]);
  lastLogBlock = null;
  node.advanceTo(NEXT_HEAD);

  const outcome = await guardian.cycle(null, observed(earlier).screened.work());

  assert.deepEqual(anchorsFound(outcome), [
    [100_000, 5],
    [topUpBlock, 5],
  ]);
  assert.deepEqual(anchorsFound(outcome), anchorsFound(await fullReconstruction(script)));
});

test('a top-up after the recorded event in the same block, which the earlier reads omitted, is walked', async () => {
  const started = lot(100_000, 5n);
  // The top-up keeps the lot's timer, and its controller event follows the lot's in the same block.
  const topUp: Lot = {
    ...started,
    logIndex: 8,
    amount: 3n,
    position: { ...started.position, activating: 8n },
    supplied: 3n,
  };
  const script: Script = { head: HEAD, guardianAddedAt: JOINED, lots: [started, topUp] };
  const node = fakeNode(script);
  // During the earlier attempt the endpoint answers the block without the top-up's logs.
  let isOmittingTopUp = true;
  const guardian = observerChangingLogs(script, node, (logs) => {
    if (!isOmittingTopUp) {
      return logs;
    }
    return logs.filter((log) => {
      const { blockNumber, logIndex } = logPosition(log);
      return blockNumber !== topUp.blockNumber || logIndex < topUp.logIndex;
    });
  });
  const earlier = await guardian.cycle();
  assert.deepEqual(anchorsFound(earlier), [[100_000, 5]]);
  isOmittingTopUp = false;
  node.advanceTo(NEXT_HEAD);

  const outcome = await guardian.cycle(null, observed(earlier).screened.work());

  assert.deepEqual(anchorsFound(outcome).sort(byLogIndex), [
    [100_000, 5],
    [100_000, 9],
  ]);
  assert.deepEqual(
    anchorsFound(outcome).sort(byLogIndex),
    anchorsFound(await fullReconstruction(script)).sort(byLogIndex),
  );
});

test('a newest event under another block hash than the recorded one is walked, and the walk stops on it', async () => {
  const script: Script = { head: HEAD, guardianAddedAt: JOINED, lots: [lot(100_000, 5n)] };
  const node = fakeNode(script);
  // In the later attempt the endpoint answers the lot's block from a branch the chain does not hold.
  let isForked = false;
  const otherBranchHash = blockAt(1).hash;
  const guardian = observerChangingLogs(script, node, (logs) => {
    if (!isForked) {
      return logs;
    }
    return logs.map((log) => {
      const isLotBlock = isRecord(log) && logPosition(log).blockNumber === 100_000;
      return isLotBlock ? { ...log, blockHash: otherBranchHash } : log;
    });
  });
  const earlierWork = observed(await guardian.cycle()).screened.work();
  isForked = true;
  node.advanceTo(NEXT_HEAD);

  await assert.rejects(guardian.cycle(null, earlierWork), (error: unknown) => {
    assert.ok(error instanceof GuardianStop);
    assert.equal(error.reason, 'log-not-canonical');
    return true;
  });
});

test('a lot that comes due after the earlier work is walked', async () => {
  // Due after the first report block and before the next one.
  const script: Script = { head: HEAD, guardianAddedAt: JOINED, lots: [lot(199_000, 5n, 1_100 * 12)] };
  const { guardian, earlierWork, walkReadsSince } = await firstCycle(script);
  assert.equal(earlierWork.positions, 0);

  const outcome = await guardian.cycle(null, earlierWork);

  assert.deepEqual(anchorsFound(outcome), [[199_000, 5]]);
  assert.deepEqual(anchorsFound(outcome), anchorsFound(await fullReconstruction(script)));
  assert.notDeepEqual(walkReadsSince(), []);
});

test('earlier work over a report block that left the chain is walked again', async () => {
  const script: Script = { head: HEAD, guardianAddedAt: JOINED, lots: [lot(100_000, 5n)] };
  const { guardian, node, earlierWork, walkReadsSince } = await firstCycle(script);
  node.reorgBlock(earlierWork.reportBlock.number);

  const outcome = await guardian.cycle(null, earlierWork);

  assert.deepEqual(anchorsFound(outcome), [[100_000, 5]]);
  assert.notDeepEqual(walkReadsSince(), []);
});

test('earlier work from another previous heartbeat is walked again', async () => {
  const script: Script = { head: HEAD, guardianAddedAt: JOINED, lots: [lot(100_000, 5n)] };
  const { guardian, earlierWork, walkReadsSince } = await firstCycle(script);
  const otherCoverage = new Work(
    {
      kind: 'plan',
      previousHeartbeatBlock: blockAt(JOINED),
      heartbeatTimestampAtStart: blockAt(JOINED).timestamp,
      reportsSince: null,
      discoveryRange: { from: blockAt(JOINED), to: earlierWork.reportBlock },
    },
    earlierWork.entries(),
    earlierWork.newestEvents(),
  );

  const outcome = await guardian.cycle(null, otherCoverage);

  assert.deepEqual(anchorsFound(outcome), [[100_000, 5]]);
  assert.notDeepEqual(walkReadsSince(), []);
});

test('a stale signal cycle carries its work, and the next attempt attests without walking again', async () => {
  let beforeAnswer = (): void => undefined;
  const built = guardianOver(
    { head: HEAD, guardianAddedAt: JOINED, lots: [lot(100_000, 5n)] },
    {
      screening: {
        screen: (request) => {
          beforeAnswer();
          return Promise.resolve(request.anchors.map(() => FLAG));
        },
      },
    },
  );
  // The screening answer arrives after the report block left the blockhash window.
  beforeAnswer = () => {
    built.node.advanceTo(HEAD + 250);
  };

  const stale = await built.guardian.cycle();

  assert.equal(stale.kind, 'stale');
  assert.equal(stale.reason, 'report-block-aged-out');
  assert.equal(stale.work?.positions, 1);
  beforeAnswer = () => undefined;
  const queriesBefore = built.node.logQueries.length;
  const outcome = await built.guardian.cycle(null, stale.work);
  assert.equal(outcome.kind, 'attested');
  assert.deepEqual(built.sent.calls, ['flags', 'heartbeat']);
  assert.deepEqual(built.node.logQueries.slice(queriesBefore).filter(isWalkRead), []);
});
