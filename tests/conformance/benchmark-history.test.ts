// The benchmark's history generator writes the events the pinned contracts emit for the same
// operations: the core's `SupplyCollateral` and the controller's lifecycle events that the daemon
// reads, in the same order and encoding, with the same amounts and positions, the inflow-scaled
// delay and the timer restart of a top-up included.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWalletClient, decodeEventLog, encodeFunctionData, http, isAddress, parseEventLogs } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CORE_ABI } from '../../abi/Core.abi.ts';
import { MARKET_CONTROLLER_ABI } from '../../abi/MarketController.abi.ts';
import { HistoryBuilder, borrowerAt } from '../../benchmarks/synthetic-history.ts';
import { SLOT_SECONDS, TOPICS, VirtualClock, timestampOf } from '../../benchmarks/synthetic-rpc.ts';
import { HISTORY_BLOCKS, REGISTRY, syntheticChain } from '../../benchmarks/worlds.ts';
import { isRecord } from '../../src/common/validation.ts';
import { ADMIN_KEY, DEFAULT_ACTIVATION_CONFIG, deployProtocolFixture } from './fixtures/protocol.ts';
import type { ProtocolFixture } from './fixtures/protocol.ts';

/** A supply credits the borrower, a withdrawal takes its whole inactive balance, a pause mines empty blocks. */
type Operation =
  | { readonly kind: 'supply' | 'withdraw'; readonly borrower: string; readonly assets: bigint }
  | { readonly kind: 'pause'; readonly blocks: number };

const OPERATIONS: readonly Operation[] = [
  // Dust to the attacker's own address, withdrawn at once.
  { kind: 'supply', borrower: 'attacker', assets: 1n },
  { kind: 'withdraw', borrower: 'attacker', assets: 1n },
  // A lot on a new address, withdrawn in full.
  { kind: 'supply', borrower: 'lot', assets: 10n },
  { kind: 'withdraw', borrower: 'lot', assets: 10n },
  // Lots that stay, a top-up, and dust that a later supply activates.
  { kind: 'supply', borrower: 'kept', assets: 10n },
  { kind: 'supply', borrower: 'larger', assets: 25n },
  { kind: 'supply', borrower: 'kept', assets: 10n },
  { kind: 'supply', borrower: 'dust-then-lot', assets: 5n },
  { kind: 'supply', borrower: 'dust-then-lot', assets: 10n },
  // The inflow nears its cap, decays over a pause, and the whale's top-up restarts its timer.
  { kind: 'supply', borrower: 'whale', assets: 9_950n },
  { kind: 'supply', borrower: 'after-cap', assets: 10n },
  { kind: 'pause', blocks: 150 },
  { kind: 'supply', borrower: 'after-decay', assets: 10n },
  { kind: 'supply', borrower: 'whale', assets: 10n },
];

/** What the daemon reads of one event, with accounts by label and the timer start relative to its block. */
interface ReadEvent {
  readonly event: string;
  readonly topics: number;
  readonly dataBytes: number;
  readonly borrower: string;
  readonly amount: bigint;
  readonly position?: string;
}

/** A log as either side returns it. */
interface RawLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

const LIFECYCLE_TOPICS: readonly Hex[] = [TOPICS.dusted, TOPICS.activating, TOPICS.activated, TOPICS.drained];

test('the benchmark history generator writes the events the pinned contracts emit', { timeout: 180_000 }, async () => {
  const fixture = await deployProtocolFixture(8625);
  try {
    const onContracts = await runOnContracts(fixture);
    const generated = runOnGenerator();
    OPERATIONS.forEach((operation, index) => {
      assert.deepEqual(generated[index], onContracts[index], `operation ${String(index)}: ${operation.kind}`);
    });
  } finally {
    fixture.anvil.stop();
  }
});

/** Every operation in its own transaction and block, twelve seconds apart like the generator's chain. */
async function runOnContracts(fixture: ProtocolFixture): Promise<ReadEvent[][]> {
  const market = marketArgumentsOf(fixture);
  const admin = createWalletClient({
    account: privateKeyToAccount(ADMIN_KEY),
    chain: fixture.anvil.chain,
    transport: http(fixture.anvil.rpcUrl),
  });
  const accounts = new Labels(admin.account.address);
  await fixture.anvil.testClient.setBlockTimestampInterval({ interval: SLOT_SECONDS });
  const read: ReadEvent[][] = [];
  for (const operation of OPERATIONS) {
    if (operation.kind === 'pause') {
      await fixture.anvil.testClient.mine({ blocks: operation.blocks, interval: SLOT_SECONDS });
      read.push([]);
      continue;
    }
    const borrower = accounts.addressOf(operation.borrower);
    const hash = await sendOperation(fixture, { admin, market, borrower, operation });
    const receipt = await fixture.anvil.publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    const block = await fixture.anvil.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const logs = receipt.logs.filter((log) => isReadByDaemon(log, fixture.core, fixture.primaryMarket.controller));
    read.push(logs.map((log) => readEvent(log, accounts, Number(block.timestamp))));
  }
  return read;
}

async function sendOperation(
  fixture: ProtocolFixture,
  input: {
    readonly admin: ReturnType<typeof createWalletClient>;
    readonly market: readonly unknown[];
    readonly borrower: Address;
    readonly operation: Operation & { readonly kind: 'supply' | 'withdraw' };
  },
): Promise<Hex> {
  const { admin, market, borrower, operation } = input;
  if (operation.kind === 'supply') {
    return admin.sendTransaction({
      account: admin.account ?? null,
      chain: fixture.anvil.chain,
      to: fixture.core,
      data: encodeFunctionData({
        abi: fixture.coreAbi,
        functionName: 'supplyCollateral',
        args: [market, operation.assets, borrower, '0x'],
      }),
    });
  }
  // The borrower withdraws its own collateral; the impersonated account needs gas.
  await fixture.anvil.testClient.impersonateAccount({ address: borrower });
  await fixture.anvil.testClient.setBalance({ address: borrower, value: 10n ** 18n });
  const wallet = createWalletClient({
    account: borrower,
    chain: fixture.anvil.chain,
    transport: http(fixture.anvil.rpcUrl),
  });
  return wallet.sendTransaction({
    to: fixture.core,
    data: encodeFunctionData({
      abi: fixture.coreAbi,
      functionName: 'withdrawCollateral',
      args: [market, operation.assets, borrower, borrower],
    }),
  });
}

/** The same operations through the generator with the fixture's activation config, one block each. */
function runOnGenerator(): ReadEvent[][] {
  const chain = syntheticChain(HISTORY_BLOCKS, new VirtualClock({ slotSeconds: SLOT_SECONDS, realTimeScale: 0 }));
  const history = new HistoryBuilder(chain, {
    minimumActivation: DEFAULT_ACTIVATION_CONFIG.minActivationAmount,
    delays: DEFAULT_ACTIVATION_CONFIG,
  });
  const market = history.market(0, REGISTRY);
  const controller = market.controller;
  assert.ok(controller !== null);
  const accounts = new Labels(borrowerAt(8_999));
  const blocks: number[] = [];
  let block = chain.layout.coreDeploymentBlock + 1;
  for (const operation of OPERATIONS) {
    if (operation.kind === 'pause') {
      block += operation.blocks;
      blocks.push(-1);
      continue;
    }
    const borrower = accounts.addressOf(operation.borrower);
    if (operation.kind === 'supply') {
      history.supply(block, { market, borrower, assets: operation.assets });
    } else {
      history.drain(block, { market, borrower, amount: operation.assets });
    }
    blocks.push(block);
    block += 1;
  }
  chain.seal();
  return blocks.map((at) => (at < 0 ? [] : generatedEvents(chain, { controller, block: at, accounts })));
}

function generatedEvents(
  chain: ReturnType<typeof syntheticChain>,
  at: { readonly controller: Address; readonly block: number; readonly accounts: Labels },
): ReadEvent[] {
  const range = { fromBlock: `0x${at.block.toString(16)}`, toBlock: `0x${at.block.toString(16)}` };
  const supplies = rawLogsOf(
    chain.answer('eth_getLogs', [{ address: chain.layout.core, topics: [[TOPICS.supply]], ...range }]).value,
  );
  const lifecycle = rawLogsOf(
    chain.answer('eth_getLogs', [{ address: at.controller, topics: [LIFECYCLE_TOPICS], ...range }]).value,
  );
  const ordered = [...supplies, ...lifecycle].sort((left, right) => left.logIndex - right.logIndex);
  return ordered.map((log) => readEvent(log, at.accounts, timestampOf(at.block)));
}

function isReadByDaemon(log: RawLog, core: Address, controller: Address): boolean {
  const topic = log.topics[0];
  if (log.address.toLowerCase() === core.toLowerCase()) {
    return topic === TOPICS.supply;
  }
  return log.address.toLowerCase() === controller.toLowerCase() && LIFECYCLE_TOPICS.some((known) => known === topic);
}

function readEvent(log: RawLog, accounts: Labels, blockTimestamp: number): ReadEvent {
  const [signature, ...indexed] = log.topics;
  assert.ok(signature !== undefined);
  const shape = { topics: log.topics.length, dataBytes: (log.data.length - 2) / 2 };
  if (signature === TOPICS.supply) {
    const decoded = decodeEventLog({
      abi: CORE_ABI,
      eventName: 'SupplyCollateral',
      data: log.data,
      topics: [signature, ...indexed],
    });
    return {
      event: decoded.eventName,
      ...shape,
      borrower: accounts.labelOf(decoded.args.onBehalf),
      amount: decoded.args.assets,
    };
  }
  const decoded = decodeEventLog({ abi: MARKET_CONTROLLER_ABI, data: log.data, topics: [signature, ...indexed] });
  const { position } = decoded.args;
  const start = position.activatingStart;
  const startText = start === 0 ? 'none' : `${String(start - blockTimestamp)}s from its block`;
  return {
    event: decoded.eventName,
    ...shape,
    borrower: accounts.labelOf(decoded.args.borrower),
    amount: decoded.args.amount,
    position: `dust ${String(position.dust)}, activating ${String(position.activating)}, start ${startText}, delay ${String(position.activatingDelay)}`,
  };
}

/** The generator's JSON-RPC log records, with their log index. */
function rawLogsOf(value: unknown): (RawLog & { readonly logIndex: number })[] {
  assert.ok(Array.isArray(value));
  return value.map((entry: unknown) => {
    assert.ok(isRecord(entry));
    const { address, topics, data, logIndex } = entry;
    assert.ok(typeof address === 'string' && isAddress(address));
    assert.ok(Array.isArray(topics));
    assert.ok(typeof data === 'string' && typeof logIndex === 'string');
    return { address, topics: topics.map(hexOf), data: hexOf(data), logIndex: Number(logIndex) };
  });
}

function hexOf(value: unknown): Hex {
  assert.ok(typeof value === 'string' && value.startsWith('0x'));
  return `0x${value.slice(2)}`;
}

/** The fixture market's parameters, as its `CreateMarket` event records them. */
function marketArgumentsOf(fixture: ProtocolFixture): readonly unknown[] {
  const [created] = parseEventLogs({
    abi: fixture.coreAbi,
    logs: fixture.primaryMarket.createReceipt.logs,
    eventName: 'CreateMarket',
    strict: true,
  });
  const args: unknown = created?.args;
  const parameters: unknown = Array.isArray(args) ? args[1] : undefined;
  assert.ok(Array.isArray(parameters));
  return parameters;
}

/** Accounts by label: the attacker is the given address, every other label a fresh borrower. */
class Labels {
  readonly #byLabel = new Map<string, Address>();

  readonly #byAddress = new Map<string, string>();

  constructor(attacker: Address) {
    this.#add('attacker', attacker);
  }

  addressOf(label: string): Address {
    const known = this.#byLabel.get(label);
    if (known !== undefined) {
      return known;
    }
    const created = borrowerAt(9_000 + this.#byLabel.size);
    this.#add(label, created);
    return created;
  }

  labelOf(address: string): string {
    return this.#byAddress.get(address.toLowerCase()) ?? 'unknown';
  }

  #add(label: string, address: Address): void {
    this.#byLabel.set(label, address);
    this.#byAddress.set(address.toLowerCase(), label);
  }
}
