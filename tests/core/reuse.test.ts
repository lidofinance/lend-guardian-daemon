// A cycle given the work of an earlier attempt over the same coverage: a position its controller logged
// nothing for since keeps its anchors without a walk, and the work is the one a full reconstruction
// finds. Work from another coverage, or over a report block that left the chain, is walked again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseRpcProvider } from '../../src/core/index.ts';
import type { CycleOutcome, Observed, ScreeningResult } from '../../src/core/index.ts';
import { Work } from '../../src/core/outcomes.ts';
import { rpcRequest } from './client.ts';
import { blockAt, CONTROLLER, CORE, fakeNode } from './fake-node.ts';
import type { Lot, Script } from './fake-node.ts';
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
      discoveryRange: { from: blockAt(JOINED), to: earlierWork.reportBlock },
    },
    earlierWork.entries(),
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
