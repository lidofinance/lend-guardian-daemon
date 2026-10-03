// Discovery and reconstruction read the history in bounded batches: the limit, the order of what they
// return, one controller, registry and classification read per market, and the stop after a failed read.
// What each supply or walk decides is covered by reconstruct.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { encodeAbiParameters, getAbiItem, numberToHex, pad, padHex, toEventSelector } from 'viem';
import type { Hex } from 'viem';
import { SUPPLY_COLLATERAL_ABI } from '../../abi/Core.abi.ts';
import { MARKET_CONTROLLER_ABI } from '../../abi/MarketController.abi.ts';
import { BaseRpcProvider } from '../../src/chain/base-rpc-provider.ts';
import type { ChainLog, LogFilter } from '../../src/chain/rpc.ts';
import type { Address, BlockRef, MarketId } from '../../src/common/types.ts';
import type { Guardian } from '../../src/core/guardian.ts';
import { Discovered } from '../../src/core/outcomes.ts';
import type { ScanPlan } from '../../src/core/outcomes.ts';
import type { PositionKey } from '../../src/core/types.ts';
import { blockAt, CONTROLLER, CORE, REGISTRY } from './fake-node.ts';
import { guardianOver } from './setup.ts';

const HEAD = 200_000;

const PLAN: ScanPlan = {
  kind: 'plan',
  previousHeartbeatBlock: null,
  heartbeatTimestampAtStart: 0,
  discoveryRange: { from: blockAt(99_600), to: blockAt(HEAD - 2) },
};

function borrowerAt(index: number): Address {
  return padHex(numberToHex(index + 1), { size: 20 });
}

/** The market of position `index` among `markets` markets, all of one controller. */
function marketAt(index: number, markets: number): MarketId {
  return padHex(numberToHex((index % markets) + 1), { size: 32 });
}

/** One position in each of `count` markets. */
function positionsFor(count: number): PositionKey[] {
  return Array.from({ length: count }, (_unused, index) => ({
    controller: CONTROLLER,
    marketId: marketAt(index, count),
    borrower: borrowerAt(index),
  }));
}

/** A lot that started from zero in its own block and transaction, its timer long elapsed. */
function activation(index: number): ChainLog {
  const block = blockAt(100_000 + index);
  return {
    address: CONTROLLER,
    blockHash: block.hash,
    blockNumber: BigInt(block.number),
    transactionHash: blockAt(index + 1).hash,
    transactionIndex: 0,
    logIndex: 4,
    removed: false,
    topics: [
      toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivating' })),
      pad(borrowerAt(index)),
    ],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint40' }, { type: 'uint32' }],
      [5n, 0n, 5n, block.timestamp, 60],
    ),
  };
}

/** The core supply paired with the activation: the same transaction, the next log. */
function supply(index: number, markets: number): ChainLog {
  return {
    ...activation(index),
    address: CORE,
    logIndex: 5,
    topics: [
      toEventSelector(getAbiItem({ abi: SUPPLY_COLLATERAL_ABI, name: 'SupplyCollateral' })),
      marketAt(index, markets),
      pad(borrowerAt(index)),
      pad(borrowerAt(index)),
    ],
    data: encodeAbiParameters([{ type: 'uint256' }], [5n]),
  };
}

interface HeldRead {
  readonly answer: () => void;
  readonly fail: (error: Error) => void;
}

/**
 * A node for `count` positions spread over `markets` markets of one controller. The discovery window,
 * the controller's registry and classifications and the paired supplies answer at once; each market's
 * controller read and each position's lifecycle walk waits until the test answers it.
 */
class HistoryNode extends BaseRpcProvider {
  readonly held: HeldRead[] = [];

  readonly calledContracts: Address[] = [];

  /** The contract each log read asked, in order. */
  readonly logReads: Address[] = [];

  readonly #count: number;

  readonly #markets: number;

  constructor(count: number, markets = count) {
    super({
      maxLogBlockRange: 1_000_000,
      request: (): Promise<never> => Promise.reject(new Error('Unexpected RPC request')),
    });
    this.#count = count;
    this.#markets = markets;
  }

  override getBlock(number?: number): Promise<BlockRef> {
    return Promise.resolve(blockAt(number ?? HEAD));
  }

  /**
   * The core names each market's controller once the test answers; the controller names this
   * Guardian's registry.
   */
  override call(to: Address): Promise<Hex> {
    this.calledContracts.push(to);
    if (to.toLowerCase() === CORE.toLowerCase()) {
      return this.#hold(encodeAbiParameters([{ type: 'address' }], [CONTROLLER]));
    }
    return Promise.resolve(encodeAbiParameters([{ type: 'address' }], [REGISTRY]));
  }

  override getLogs(filter: LogFilter): Promise<ChainLog[]> {
    this.logReads.push(filter.address);
    if (filter.address.toLowerCase() === CONTROLLER.toLowerCase()) {
      return Promise.resolve(Array.from({ length: this.#count }, (_unused, index) => activation(index)));
    }
    const borrower = filter.topics?.[3];
    if (borrower === undefined) {
      return Promise.resolve(Array.from({ length: this.#count }, (_unused, index) => supply(index, this.#markets)));
    }
    const index = this.#indexWhere((candidate) => pad(borrowerAt(candidate)) === borrower);
    return Promise.resolve([supply(index, this.#markets)]);
  }

  /** Discovery's window reads arrive as one piece; a lifecycle walk waits until the test answers it. */
  override async *logBatches(filter: LogFilter): AsyncGenerator<ChainLog[]> {
    const borrower = filter.topics?.[1];
    if (borrower === undefined) {
      yield await this.getLogs(filter);
      return;
    }
    const index = this.#indexWhere((candidate) => pad(borrowerAt(candidate)) === borrower);
    yield await this.#hold([activation(index)]);
  }

  #hold<Result>(result: Result): Promise<Result> {
    return new Promise((resolve, reject) => {
      this.held.push({
        answer: () => {
          resolve(result);
        },
        fail: reject,
      });
    });
  }

  #indexWhere(isMatch: (index: number) => boolean): number {
    const index = Array.from({ length: this.#count }, (_unused, candidate) => candidate).findIndex(isMatch);
    assert.ok(index >= 0, 'every query names a known position');
    return index;
  }
}

function guardianWith(node: HistoryNode, limit: number | undefined): Guardian {
  return guardianOver(
    { head: HEAD },
    {
      mode: 'observe',
      client: node,
      ...(limit === undefined ? {} : { historyReadConcurrency: limit }),
    },
  ).guardian;
}

/** Each phase over `count` positions, returning the borrowers of its result in order. */
const PHASES: Readonly<Record<string, (guardian: Guardian, count: number) => Promise<Address[]>>> = {
  discovery: async (guardian) => {
    const discovered = await guardian.discoverCandidatePositions(PLAN);
    return discovered.all().map((position) => position.borrower);
  },
  reconstruction: async (guardian, count) => {
    const work = await guardian.reconstructWork(new Discovered(PLAN, positionsFor(count)));
    return [...work.entries()].map(([position]) => position.borrower);
  },
};

for (const [phase, run] of Object.entries(PHASES)) {
  for (const limit of [undefined, 3]) {
    const expected = limit ?? 1;
    test(`${phase} batches its reads by the limit of ${expected} and keeps the order`, async () => {
      const node = new HistoryNode(7);
      const result = run(guardianWith(node, limit), 7);
      for (let from = 0; from < 7; from += expected) {
        await setImmediate();
        assert.equal(node.held.length, Math.min(from + expected, 7));
        // Later reads finish first; the result still lists the positions in their order.
        for (const read of node.held.slice(from).reverse()) {
          read.answer();
        }
      }
      assert.deepEqual(
        await result,
        Array.from({ length: 7 }, (_unused, index) => borrowerAt(index)),
      );
    });
  }

  test(`a failed read ends ${phase} once its batch has settled, before the next batch`, async () => {
    const node = new HistoryNode(4);
    let outcome = 'pending';
    const result = run(guardianWith(node, 2), 4).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : 'unknown';
      },
    );
    await setImmediate();
    const [first, second] = node.held;
    assert.ok(first !== undefined && second !== undefined);
    first.fail(new Error('node refused the read'));
    await setImmediate();
    assert.equal(outcome, 'pending');
    second.answer();
    await result;
    assert.equal(outcome, 'node refused the read');
    assert.equal(node.held.length, 2);
  });
}

test('supplies of one market share one controller and registry read, and their piece one read of controller events', async () => {
  const node = new HistoryNode(3, 1);
  const discovery = guardianWith(node, 3).discoverCandidatePositions(PLAN);
  await setImmediate();
  const [controllerRead] = node.held;
  assert.ok(controllerRead !== undefined);
  assert.equal(node.held.length, 1);
  controllerRead.answer();
  assert.equal((await discovery).all().length, 3);
  assert.deepEqual(
    node.calledContracts.map((contract) => contract.toLowerCase()),
    [CORE.toLowerCase(), CONTROLLER.toLowerCase()],
  );
  // The supplies, their controller's events through their last block, then through the report block.
  assert.deepEqual(
    node.logReads.map((contract) => contract.toLowerCase()),
    [CORE.toLowerCase(), CONTROLLER.toLowerCase(), CONTROLLER.toLowerCase()],
  );
});
