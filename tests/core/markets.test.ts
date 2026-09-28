import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, getAbiItem, pad, toEventSelector } from 'viem';
import { MARKET_CONTROLLER_ABI } from '../../abi/MarketController.abi.ts';
import { SUPPLY_COLLATERAL_ABI } from '../../abi/Core.abi.ts';
import { BaseRpcProvider } from '../../src/chain/base-rpc-provider.ts';
import type { ChainLog } from '../../src/chain/rpc.ts';
import { Markets } from '../../src/contracts/markets.ts';
import type { Lifecycle, SupplyLog } from '../../src/contracts/markets.ts';
import { blockAt, BORROWER, CONTROLLER, CORE, MARKET } from './fake-node.ts';

const BLOCK = blockAt(100_000);
const SUPPLY: SupplyLog = {
  marketId: MARKET,
  borrower: BORROWER,
  assets: 5n,
  blockHash: BLOCK.hash,
  transactionHash: blockAt(500_000).hash,
  logIndex: 5,
};
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
  readonly #logs: ChainLog[];

  constructor(logs: ChainLog[]) {
    super({
      maxLogBlockRange: 1_000,
      request: (): Promise<never> => Promise.reject(new Error('Unexpected RPC request')),
    });
    this.#logs = logs;
  }

  override getLogs(): Promise<ChainLog[]> {
    return Promise.resolve(this.#logs);
  }
}

test('supply classification accepts the adjacent controller event in the same transaction and block', async () => {
  const markets = new Markets(new EvidenceProvider([CLASSIFICATION]), { address: CORE, deploymentBlock: 1_000 });
  assert.deepEqual(await markets.activationBefore(SUPPLY, CONTROLLER), {
    blockNumber: BLOCK.number,
    position: { dust: 0n, activating: 5n, activatingStart: BLOCK.timestamp, activatingDelay: 60 },
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
  test(`supply classification rejects ${reason}`, async () => {
    const markets = new Markets(new EvidenceProvider([{ ...CLASSIFICATION, ...fields }]), {
      address: CORE,
      deploymentBlock: 1_000,
    });
    await assert.rejects(markets.activationBefore(SUPPLY, CONTROLLER), { reason: 'supply-without-controller-event' });
  });
}

test('supply classification rejects duplicate adjacent events', async () => {
  const markets = new Markets(new EvidenceProvider([CLASSIFICATION, CLASSIFICATION]), {
    address: CORE,
    deploymentBlock: 1_000,
  });
  await assert.rejects(markets.activationBefore(SUPPLY, CONTROLLER), { reason: 'supply-without-controller-event' });
});

const ACTIVATION: Lifecycle = {
  kind: 'activating',
  amount: 5n,
  position: { dust: 0n, activating: 5n, activatingStart: BLOCK.timestamp, activatingDelay: 60 },
  at: CLASSIFICATION,
};
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
