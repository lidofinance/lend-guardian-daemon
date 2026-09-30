import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, getAbiItem, pad, toEventSelector } from 'viem';
import { MARKET_CONTROLLER_ABI } from '../../abi/MarketController.abi.ts';
import { SUPPLY_COLLATERAL_ABI } from '../../abi/Core.abi.ts';
import { BaseRpcProvider } from '../../src/chain/base-rpc-provider.ts';
import type { ChainLog, LogFilter } from '../../src/chain/rpc.ts';
import { Markets } from '../../src/contracts/markets.ts';
import { blockAt, BORROWER, CONTROLLER, CORE, MARKET } from './fake-node.ts';

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

test('supply classification accepts the adjacent controller event in the same transaction and block', async () => {
  const markets = new Markets(new EvidenceProvider([CLASSIFICATION]), { address: CORE, deploymentBlock: 1_000 });
  assert.deepEqual(await markets.activationBefore(SUPPLY, CONTROLLER, WINDOW), {
    blockNumber: BLOCK.number,
    position: { dust: 0n, activating: 5n, activatingStart: BLOCK.timestamp, activatingDelay: 60 },
  });
});

test("supplies share one read of their controller's lifecycle events over the window", async () => {
  const later = { ...SUPPLY, blockHash: blockAt(100_500).hash, transactionHash: blockAt(500_001).hash };
  const provider = new EvidenceProvider([
    CLASSIFICATION,
    { ...CLASSIFICATION, blockHash: later.blockHash, blockNumber: 100_500n, transactionHash: later.transactionHash },
  ]);
  const markets = new Markets(provider, { address: CORE, deploymentBlock: 1_000 });
  const activations = await Promise.all([
    markets.activationBefore(SUPPLY, CONTROLLER, WINDOW),
    markets.activationBefore(later, CONTROLLER, WINDOW),
  ]);
  assert.deepEqual(
    activations.map((activation) => activation?.blockNumber),
    [BLOCK.number, 100_500],
  );
  assert.deepEqual(provider.filters, [
    {
      address: CONTROLLER,
      topics: [
        [
          toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDusted' })),
          toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivating' })),
          toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivated' })),
          toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDrained' })),
        ],
      ],
      fromBlock: WINDOW.from.number,
      toBlock: WINDOW.to.number,
    },
  ]);
});

const INVALID_CLASSIFICATIONS: Readonly<Record<string, Partial<ChainLog>>> = {
  'another emitter': { address: CORE },
  'another block': { blockHash: blockAt(1).hash },
  'another transaction': { transactionHash: blockAt(1).hash },
  'a nonadjacent log': { logIndex: 3 },
  'a removed log': { removed: true },
};

for (const [reason, fields] of Object.entries(INVALID_CLASSIFICATIONS)) {
  test(`supply classification rejects ${reason}`, async () => {
    const markets = new Markets(new EvidenceProvider([{ ...CLASSIFICATION, ...fields }]), {
      address: CORE,
      deploymentBlock: 1_000,
    });
    await assert.rejects(markets.activationBefore(SUPPLY, CONTROLLER, WINDOW), {
      reason: 'supply-without-controller-event',
    });
  });
}

test('supply classification rejects duplicate adjacent events', async () => {
  const markets = new Markets(new EvidenceProvider([CLASSIFICATION, CLASSIFICATION]), {
    address: CORE,
    deploymentBlock: 1_000,
  });
  await assert.rejects(markets.activationBefore(SUPPLY, CONTROLLER, WINDOW), {
    reason: 'supply-without-controller-event',
  });
});

const ACTIVATION = {
  kind: 'activating',
  amount: 5n,
  position: { dust: 0n, activating: 5n, activatingStart: BLOCK.timestamp, activatingDelay: 60 },
  at: CLASSIFICATION,
} as const;
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

test('the zero-boundary shortcut uses the exact paired core supply', async () => {
  const markets = new Markets(new EvidenceProvider([SUPPLY_EVENT]), { address: CORE, deploymentBlock: 1_000 });
  assert.deepEqual(await markets.supplyAfter(POSITION, ACTIVATION), SUPPLY);
});

for (const [condition, logs] of [
  ['missing', []],
  ['duplicated', [SUPPLY_EVENT, SUPPLY_EVENT]],
] as const) {
  test(`the zero-boundary shortcut rejects a ${condition} supply`, async () => {
    const markets = new Markets(new EvidenceProvider([...logs]), { address: CORE, deploymentBlock: 1_000 });
    await assert.rejects(markets.supplyAfter(POSITION, ACTIVATION), { reason: 'position-history-broken' });
  });
}

test("the zero-boundary shortcut asks only for the position's supplies in the activation block", async () => {
  const provider = new EvidenceProvider([SUPPLY_EVENT]);
  const markets = new Markets(provider, { address: CORE, deploymentBlock: 1_000 });
  await markets.supplyAfter(POSITION, ACTIVATION);
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
