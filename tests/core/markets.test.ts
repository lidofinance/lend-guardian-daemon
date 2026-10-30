import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeAbiParameters, getAbiItem, pad, padHex, toEventSelector, zeroAddress } from 'viem';
import type { Hex } from 'viem';
import { MARKET_CONTROLLER_ABI } from '../../abi/MarketController.abi.ts';
import { CORE_ABI, SUPPLY_COLLATERAL_ABI } from '../../abi/Core.abi.ts';
import { BaseRpcProvider } from '../../src/chain/base-rpc-provider.ts';
import type { ChainLog, LogFilter } from '../../src/chain/rpc.ts';
import type { Address } from '../../src/common/types.ts';
import { decodeLogs } from '../../src/contracts/decode-logs.ts';
import { Markets } from '../../src/contracts/markets.ts';
import type { ScanPlan } from '../../src/core/outcomes.ts';
import { blockAt, BORROWER, CONTROLLER, CORE, MARKET, REGISTRY } from './fake-node.ts';

const BLOCK = blockAt(100_000);
const WINDOW = { from: blockAt(99_000), to: blockAt(101_000) };
const SUPPLY = {
  marketId: MARKET,
  borrower: BORROWER,
  assets: 5n,
  blockHash: BLOCK.hash,
  transactionHash: blockAt(500_000).hash,
  logIndex: 5,
} as const;
const CLASSIFICATION: ChainLog = {
  address: CONTROLLER,
  blockHash: BLOCK.hash,
  blockNumber: BigInt(BLOCK.number),
  transactionHash: SUPPLY.transactionHash,
  transactionIndex: 0,
  logIndex: 4,
  removed: false,
  topics: [toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivating' })), pad(BORROWER)],
  data: encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint40' }, { type: 'uint32' }],
    [5n, 0n, 5n, BLOCK.timestamp, 60],
  ),
};

/** Deliberately return supplied evidence regardless of the query to exercise the contract boundary. */
class EvidenceProvider extends BaseRpcProvider {
  readonly filters: LogFilter[] = [];

  readonly #logs: ChainLog[];

  constructor(logs: ChainLog[]) {
    super({
      maxLogBlockRange: 1_000,
      request: (): Promise<never> => Promise.reject(new Error('Unexpected RPC request')),
    });
    this.#logs = logs;
  }

  override getLogs(filter: LogFilter): Promise<ChainLog[]> {
    this.filters.push(filter);
    return Promise.resolve(this.#logs);
  }
}

/** `logs` decoded, as discovery reads them with a batch of supplies. */
function classifications(logs: ChainLog[]) {
  return decodeLogs(MARKET_CONTROLLER_ABI, logs);
}

test('supply classification accepts the adjacent controller event in the same transaction and block', () => {
  const markets = new Markets(new EvidenceProvider([]), { address: CORE, deploymentBlock: 1_000 });
  assert.deepEqual(markets.activationBefore(SUPPLY, CONTROLLER, classifications([CLASSIFICATION])), {
    blockNumber: BLOCK.number,
    position: { dust: 0n, activating: 5n, activatingStart: BLOCK.timestamp, activatingDelay: 60 },
    log: classifications([CLASSIFICATION])[0],
  });
});

const INVALID_CLASSIFICATIONS: Readonly<Record<string, Partial<ChainLog>>> = {
  'another emitter': { address: CORE },
  'another block': { blockHash: blockAt(1).hash },
  'another transaction': { transactionHash: blockAt(1).hash },
  'a nonadjacent log': { logIndex: 3 },
  'a removed log': { removed: true },
};

for (const [reason, fields] of Object.entries(INVALID_CLASSIFICATIONS)) {
  test(`supply classification rejects ${reason}`, () => {
    const markets = new Markets(new EvidenceProvider([]), { address: CORE, deploymentBlock: 1_000 });
    const logs = classifications([{ ...CLASSIFICATION, ...fields }]);
    assert.throws(() => markets.activationBefore(SUPPLY, CONTROLLER, logs), {
      reason: 'supply-without-controller-event',
    });
  });
}

test('supply classification rejects duplicate adjacent events', () => {
  const markets = new Markets(new EvidenceProvider([]), { address: CORE, deploymentBlock: 1_000 });
  const logs = classifications([CLASSIFICATION, CLASSIFICATION]);
  assert.throws(() => markets.activationBefore(SUPPLY, CONTROLLER, logs), {
    reason: 'supply-without-controller-event',
  });
});

const SUPPLY_EVENT: ChainLog = {
  ...CLASSIFICATION,
  address: CORE,
  logIndex: SUPPLY.logIndex,
  topics: [
    toEventSelector(getAbiItem({ abi: SUPPLY_COLLATERAL_ABI, name: 'SupplyCollateral' })),
    MARKET,
    pad(BORROWER),
    pad(BORROWER),
  ],
  data: encodeAbiParameters([{ type: 'uint256' }], [5n]),
};
const POSITION = { controller: CONTROLLER, marketId: MARKET, borrower: BORROWER };

/** Serves the walk's lifecycle read with `lifecycle`, and every supply read with `supplies`. */
class WalkEvidenceProvider extends EvidenceProvider {
  readonly #lifecycle: ChainLog[];

  constructor(lifecycle: ChainLog[], supplies: ChainLog[]) {
    super(supplies);
    this.#lifecycle = lifecycle;
  }

  override async *logBatches(): AsyncGenerator<ChainLog[]> {
    yield await Promise.resolve(this.#lifecycle);
  }
}

async function walkedEvents(provider: EvidenceProvider) {
  const markets = new Markets(provider, { address: CORE, deploymentBlock: 1_000 });
  const events = [];
  for await (const event of markets.lifecycleBack(POSITION, blockAt(101_000))) {
    events.push(event);
  }
  return events;
}

test('the walk pairs an activation with the exact core supply after it', async () => {
  const [event] = await walkedEvents(new WalkEvidenceProvider([CLASSIFICATION], [SUPPLY_EVENT]));
  assert.ok(event?.kind === 'activating');
  assert.equal(event.supplied, SUPPLY.assets);
});

for (const [condition, logs] of [
  ['missing', []],
  ['duplicated', [SUPPLY_EVENT, SUPPLY_EVENT]],
] as const) {
  test(`the walk gives an activation with a ${condition} supply no supply`, async () => {
    const [event] = await walkedEvents(new WalkEvidenceProvider([CLASSIFICATION], [...logs]));
    assert.ok(event?.kind === 'activating');
    assert.equal(event.supplied, null);
  });
}

test("the walk asks only for the position's supplies in the blocks of a range's activations", async () => {
  const provider = new WalkEvidenceProvider([CLASSIFICATION], [SUPPLY_EVENT]);
  await walkedEvents(provider);
  assert.deepEqual(provider.filters, [
    {
      address: CORE,
      topics: [
        toEventSelector(getAbiItem({ abi: SUPPLY_COLLATERAL_ABI, name: 'SupplyCollateral' })),
        MARKET,
        null,
        pad(BORROWER),
      ],
      fromBlock: BLOCK.number,
      toBlock: BLOCK.number,
    },
  ]);
});

const PLAN: ScanPlan = {
  kind: 'plan',
  previousHeartbeatBlock: null,
  heartbeatTimestampAtStart: 0,
  reportsSince: null,
  discoveryRange: WINDOW,
};

/**
 * A node where `MARKET` has `CONTROLLER`, which reports to `REGISTRY`, and any other market has no
 * controller. The window's supplies arrive in `batches`; a read of the controller's events returns those
 * in its range as one piece and is recorded.
 */
class DiscoveryProvider extends BaseRpcProvider {
  readonly controllerReads: LogFilter[] = [];

  readonly #batches: ChainLog[][];

  readonly #events: ChainLog[];

  constructor(batches: ChainLog[][], events: ChainLog[]) {
    super({
      maxLogBlockRange: 1_000_000,
      request: (): Promise<never> => Promise.reject(new Error('Unexpected RPC request')),
    });
    this.#batches = batches;
    this.#events = events;
  }

  override call(to: Address, data: Hex): Promise<Hex> {
    if (to.toLowerCase() !== CORE.toLowerCase()) {
      return Promise.resolve(encodeAbiParameters([{ type: 'address' }], [REGISTRY]));
    }
    const { args } = decodeFunctionData({ abi: CORE_ABI, data });
    const controller = args[0] === MARKET ? CONTROLLER : zeroAddress;
    return Promise.resolve(encodeAbiParameters([{ type: 'address' }], [controller]));
  }

  override async *logBatches(filter: LogFilter): AsyncGenerator<ChainLog[]> {
    if (filter.address.toLowerCase() === CORE.toLowerCase()) {
      for (const batch of this.#batches) {
        yield await Promise.resolve(batch);
      }
      return;
    }
    this.controllerReads.push(filter);
    yield await Promise.resolve(
      this.#events.filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock),
    );
  }
}

test("each piece of supplies reads its controller's events from the first unread block through its last supply", async () => {
  const later = { blockHash: blockAt(100_500).hash, blockNumber: 100_500n, transactionHash: blockAt(500_001).hash };
  const provider = new DiscoveryProvider(
    [[SUPPLY_EVENT], [{ ...SUPPLY_EVENT, ...later }]],
    [CLASSIFICATION, { ...CLASSIFICATION, ...later }],
  );
  const markets = new Markets(provider, { address: CORE, deploymentBlock: 1_000 });
  assert.deepEqual(await markets.discoverCandidatePositions(PLAN, REGISTRY, 8), [
    { position: POSITION, newestEvent: { blockNumber: 100_500, logIndex: 4, blockHash: blockAt(100_500).hash } },
  ]);
  const topics = [
    [
      toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDusted' })),
      toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivating' })),
      toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivated' })),
      toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDrained' })),
    ],
  ];
  // The first piece, the second piece, then the blocks after the last supply for the candidate found.
  assert.deepEqual(provider.controllerReads, [
    { address: CONTROLLER, topics, fromBlock: WINDOW.from.number, toBlock: 100_000 },
    { address: CONTROLLER, topics, fromBlock: 100_001, toBlock: 100_500 },
    { address: CONTROLLER, topics, fromBlock: 100_501, toBlock: WINDOW.to.number },
  ]);
});

/** `BORROWER`'s lot drained to nothing at `blockNumber`. */
function drainedAt(blockNumber: number): ChainLog {
  return {
    ...CLASSIFICATION,
    blockHash: blockAt(blockNumber).hash,
    blockNumber: BigInt(blockNumber),
    transactionHash: blockAt(400_000 + blockNumber).hash,
    topics: [toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDrained' })), pad(BORROWER)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint40' }, { type: 'uint32' }],
      [5n, 0n, 0n, 0, 0],
    ),
  };
}

test('a lot withdrawn after the last supply of the window is no candidate', async () => {
  const provider = new DiscoveryProvider([[SUPPLY_EVENT]], [CLASSIFICATION, drainedAt(100_800)]);
  const markets = new Markets(provider, { address: CORE, deploymentBlock: 1_000 });
  assert.deepEqual(await markets.discoverCandidatePositions(PLAN, REGISTRY, 8), []);
});

test('a lot withdrawn before a later supply of its piece is no candidate', async () => {
  // After the withdrawal the borrower supplies dust, which leaves nothing activating.
  const dust = { blockHash: blockAt(100_500).hash, blockNumber: 100_500n, transactionHash: blockAt(500_001).hash };
  const dusted: ChainLog = {
    ...CLASSIFICATION,
    ...dust,
    topics: [toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDusted' })), pad(BORROWER)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint40' }, { type: 'uint32' }],
      [1n, 1n, 0n, 0, 0],
    ),
  };
  const provider = new DiscoveryProvider(
    [[SUPPLY_EVENT, { ...SUPPLY_EVENT, ...dust }]],
    [CLASSIFICATION, drainedAt(100_300), dusted],
  );
  const markets = new Markets(provider, { address: CORE, deploymentBlock: 1_000 });
  assert.deepEqual(await markets.discoverCandidatePositions(PLAN, REGISTRY, 8), []);
});

test("a candidate's controller is read with every piece, so a lot withdrawn among other markets' supplies is no candidate", async () => {
  const otherMarket: ChainLog = {
    ...SUPPLY_EVENT,
    blockHash: blockAt(100_600).hash,
    blockNumber: 100_600n,
    transactionHash: blockAt(500_600).hash,
    topics: [
      toEventSelector(getAbiItem({ abi: SUPPLY_COLLATERAL_ABI, name: 'SupplyCollateral' })),
      padHex('0x02', { size: 32 }),
      pad(BORROWER),
      pad(BORROWER),
    ],
  };
  const provider = new DiscoveryProvider([[SUPPLY_EVENT], [otherMarket]], [CLASSIFICATION, drainedAt(100_300)]);
  const markets = new Markets(provider, { address: CORE, deploymentBlock: 1_000 });
  assert.deepEqual(await markets.discoverCandidatePositions(PLAN, REGISTRY, 8), []);
  assert.deepEqual(
    provider.controllerReads.map((read) => [read.fromBlock, read.toBlock]),
    [
      [WINDOW.from.number, BLOCK.number],
      [BLOCK.number + 1, 100_600],
    ],
  );
});

test('a supply without any controller event before it stops discovery', async () => {
  const markets = new Markets(new DiscoveryProvider([[SUPPLY_EVENT]], []), { address: CORE, deploymentBlock: 1_000 });
  await assert.rejects(markets.discoverCandidatePositions(PLAN, REGISTRY, 8), {
    reason: 'supply-without-controller-event',
  });
});
