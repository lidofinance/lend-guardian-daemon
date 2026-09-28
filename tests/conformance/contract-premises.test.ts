// Independent probes of the pinned production contracts consumed by the SDK reconstruction.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createWalletClient, http, parseEventLogs, size } from 'viem';
import { BORROWER, DEFAULT_ACTIVATION_CONFIG, deployProtocolFixture } from './fixtures/protocol.ts';
import type { ActivationConfig } from './fixtures/protocol.ts';
import { ViemRpcClient } from '../../src/chain/viem-client.ts';
import { Guardian } from '../../src/core/guardian.ts';

const deployed = deployProtocolFixture(8620);
const snapshot: { value: `0x${string}` } = { value: '0x0' };

before(
  async () => {
    const fixture = await deployed;
    await fixture.setDelegate();
  },
  { timeout: 120_000 },
);

beforeEach(async () => {
  snapshot.value = await (await deployed).anvil.testClient.snapshot();
});

afterEach(async () => {
  await (await deployed).anvil.testClient.revert({ id: snapshot.value });
});

after(async () => {
  (await deployed).anvil.stop();
});

/** EIP-170 limits the runtime code of a deployed contract to 24,576 bytes. */
const EIP_170_LIMIT_BYTES = 24_576;

test('deploys the production controller within the default EIP-170 limit', async () => {
  const fixture = await deployed;
  // The limit applies to the implementation; the proxy the core calls is a separate, small contract.
  const code = await fixture.anvil.publicClient.getCode({ address: fixture.primaryMarket.controllerImplementation });
  assert.ok(code !== undefined);
  const runtimeBytes = size(code);
  assert.ok(runtimeBytes <= EIP_170_LIMIT_BYTES);
  assert.equal(runtimeBytes, 24_482);
});

test('binds the production controller and pairs its activation log with core supply', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  const created = parseEventLogs({
    abi: fixture.coreAbi,
    logs: market.createReceipt.logs,
    eventName: 'CreateMarket',
    strict: true,
  });
  const receipt = await market.supply(4n);
  const supplies = parseEventLogs({
    abi: fixture.coreAbi,
    logs: receipt.logs,
    eventName: 'SupplyCollateral',
    strict: true,
  });
  const dust = parseEventLogs({
    abi: market.controllerAbi,
    logs: receipt.logs,
    eventName: 'CollateralDusted',
    strict: true,
  });

  assert.equal(created.length, 1);
  assert.equal(supplies.length, 1);
  assert.equal(dust.length, 1);
  assert.equal(supplies[0]?.address.toLowerCase(), fixture.core.toLowerCase());
  assert.equal(dust[0]?.address.toLowerCase(), market.controller.toLowerCase());
  assert.deepEqual(supplies[0].args, [market.id, fixture.admin.address, BORROWER, 4n]);
  assert.partialDeepStrictEqual(lifecycleArguments(dust[0].args), {
    borrower: BORROWER,
    amount: 4n,
    position: { dust: 4n, activating: 0n },
  });

  const boundController = await fixture.anvil.publicClient.readContract({
    address: fixture.core,
    abi: fixture.coreAbi,
    functionName: 'marketController',
    args: [market.id],
  });
  const boundRegistry = await fixture.anvil.publicClient.readContract({
    address: market.controller,
    abi: market.controllerAbi,
    functionName: 'guardianSignals',
  });
  assert.equal(String(boundController).toLowerCase(), market.controller.toLowerCase());
  assert.equal(String(boundRegistry).toLowerCase(), fixture.guardianSignals.toLowerCase());
});

test('emits post-state when dust is absorbed and the inactive position is fully drained', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  await market.supply(4n);
  const crossing = await market.supply(16n);
  const activating = parseEventLogs({
    abi: market.controllerAbi,
    logs: crossing.logs,
    eventName: 'CollateralActivating',
    strict: true,
  });
  assert.partialDeepStrictEqual(lifecycleArguments(activating[0]?.args), {
    borrower: BORROWER,
    amount: 20n,
    position: { dust: 0n, activating: 20n },
  });

  const full = await market.withdraw(20n);
  const fullDrain = parseEventLogs({
    abi: market.controllerAbi,
    logs: full.logs,
    eventName: 'CollateralDrained',
    strict: true,
  });
  assert.partialDeepStrictEqual(lifecycleArguments(fullDrain[0]?.args), {
    borrower: BORROWER,
    amount: 20n,
    position: { dust: 0n, activating: 0n },
  });
});

test('matures a position under its historical delay after the current config changes', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  await market.setActivationConfig(fixedDelay(60));
  const supplied = await market.supply(10n);
  const activating = parseEventLogs({
    abi: market.controllerAbi,
    logs: supplied.logs,
    eventName: 'CollateralActivating',
    strict: true,
  });
  assert.partialDeepStrictEqual(lifecycleArguments(activating[0]?.args), {
    borrower: BORROWER,
    amount: 10n,
    position: { dust: 0n, activating: 10n, activatingDelay: 60 },
  });

  await market.setActivationConfig(fixedDelay(7_200));
  await fixture.anvil.testClient.increaseTime({ seconds: 61 });
  await fixture.anvil.testClient.mine({ blocks: 1 });
  const withdrawal = await market.withdraw(1n);
  const activated = parseEventLogs({
    abi: market.controllerAbi,
    logs: withdrawal.logs,
    eventName: 'CollateralActivated',
    strict: true,
  });
  assert.partialDeepStrictEqual(lifecycleArguments(activated[0]?.args), {
    borrower: BORROWER,
    amount: 10n,
    position: { dust: 0n, activating: 0n },
  });
});

test('holds activation for Guardian quorum and releases it only at the configured fallback', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  await market.setActivationConfig({ ...fixedDelay(60), maxGuardiansQuorumDelay: 120 });
  await market.supply(10n);

  await fixture.anvil.testClient.increaseTime({ seconds: 61 });
  await fixture.anvil.testClient.mine({ blocks: 1 });
  await assert.rejects(market.withdraw(1n));

  await fixture.anvil.testClient.increaseTime({ seconds: 60 });
  await fixture.anvil.testClient.mine({ blocks: 1 });
  const withdrawal = await market.withdraw(1n);
  const activated = parseEventLogs({
    abi: market.controllerAbi,
    logs: withdrawal.logs,
    eventName: 'CollateralActivated',
    strict: true,
  });
  assert.partialDeepStrictEqual(lifecycleArguments(activated[0]?.args), {
    borrower: BORROWER,
    amount: 10n,
    position: { dust: 0n, activating: 0n },
  });
});

test('records a trusted caller supply as instant activation without changing delayed buckets', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  await market.setInstantActivation(fixture.admin.address, true);

  const supplied = await market.supply(4n);
  const activated = parseEventLogs({
    abi: market.controllerAbi,
    logs: supplied.logs,
    eventName: 'CollateralActivated',
    strict: true,
  });
  assert.partialDeepStrictEqual(lifecycleArguments(activated[0]?.args), {
    borrower: BORROWER,
    amount: 4n,
    position: { dust: 0n, activating: 0n, activatingStart: 0, activatingDelay: 0 },
  });
});

test('liquidation consumes active collateral before draining a fresh activating lot', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  await market.setActivationConfig(fixedDelay(60));
  await market.supplyLoan(1_000n);
  await market.supply(100n);
  await fixture.anvil.testClient.increaseTime({ seconds: 61 });
  await fixture.anvil.testClient.mine({ blocks: 1 });
  await market.borrow(50n);
  const fresh = await market.supply(20n);
  const before = lifecycleArguments(
    parseEventLogs({
      abi: market.controllerAbi,
      logs: fresh.logs,
      eventName: 'CollateralActivating',
      strict: true,
    })[0]?.args,
  );

  await market.setPrice(380_000_000_000_000_000_000_000_000_000_000_000n);
  const liquidated = await market.liquidate(105n);
  const drained = lifecycleArguments(
    parseEventLogs({
      abi: market.controllerAbi,
      logs: liquidated.logs,
      eventName: 'CollateralDrained',
      strict: true,
    })[0]?.args,
  );
  assert.equal(drained.borrower, BORROWER);
  assert.equal(drained.amount, 5n);
  assert.partialDeepStrictEqual(drained.position, {
    dust: 0n,
    activating: 15n,
    activatingStart: before.position.activatingStart,
    activatingDelay: before.position.activatingDelay,
  });
});

test('settlement uses the same active-first forced-seizure accounting', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  await market.setActivationConfig(fixedDelay(60));
  await market.supplyLoan(1_000n);
  await market.supply(10n);
  await fixture.anvil.testClient.increaseTime({ seconds: 61 });
  await fixture.anvil.testClient.mine({ blocks: 1 });
  await market.borrow(8n);
  const fresh = await market.supply(100n);
  const before = lifecycleArguments(
    parseEventLogs({
      abi: market.controllerAbi,
      logs: fresh.logs,
      eventName: 'CollateralActivating',
      strict: true,
    })[0]?.args,
  );

  await market.setPrice(100_000_000_000_000_000_000_000_000_000_000_000n);
  await market.setSettlementLtv(500_000_000_000_000_000n);
  const [personal] = await market.settlementFor();
  assert.deepEqual(personal, [5_000_000n, 5_000_000n, 3_000_000n]);
  const settled = await market.settle(personal[1]);
  const drained = lifecycleArguments(
    parseEventLogs({
      abi: market.controllerAbi,
      logs: settled.logs,
      eventName: 'CollateralDrained',
      strict: true,
    })[0]?.args,
  );
  // The settlement seizes 50 of the 110 supplied: the 10 active first, then 40 of the activating 100.
  assert.equal(drained.borrower, BORROWER);
  assert.equal(drained.amount, 40n);
  assert.deepEqual(drained.position, {
    dust: 0n,
    activating: 60n,
    activatingStart: before.position.activatingStart,
    activatingDelay: before.position.activatingDelay,
  });
  // The core position holds supply shares, the borrow shares left and the remaining collateral.
  assert.deepEqual(await market.position(), [0n, 3_000_000n, 60n]);
});

test('records delegate reports under the guardian and keeps a quorum ban latched', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  const suspect = await fixture.suspect(market.id, [BORROWER]);
  const suspected = parseEventLogs({
    abi: fixture.guardianAbi,
    logs: suspect.logs,
    eventName: 'Suspected',
    strict: true,
  });
  const suspectedArguments = argumentsOf(suspected[0]?.args);
  assert.deepEqual(suspectedArguments.slice(0, 4), [
    market.id,
    BORROWER,
    fixture.admin.address,
    fixture.delegate.address,
  ]);

  const flag = await fixture.flag(market.id, [BORROWER]);
  const unflag = await fixture.unflag(market.id, [BORROWER]);
  assert.deepEqual(
    parseEventLogs({
      abi: fixture.guardianAbi,
      logs: flag.logs,
      eventName: ['Flagged', 'Banned'],
      strict: true,
    }).map((log) => log.eventName),
    ['Banned', 'Flagged'],
  );
  assert.equal(
    parseEventLogs({
      abi: fixture.guardianAbi,
      logs: unflag.logs,
      eventName: 'Unflagged',
      strict: true,
    }).length,
    1,
  );
  const banned = await fixture.anvil.publicClient.readContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'isBanned',
    args: [market.id, BORROWER],
  });
  const flaggedBy = await fixture.anvil.publicClient.readContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'getFlaggedBy',
    args: [market.id, BORROWER],
  });
  assert.equal(banned, true);
  assert.deepEqual(flaggedBy, []);
});

test('accepts the exact canonical heartbeat block and rejects a forged hash', async () => {
  const fixture = await deployed;
  await fixture.anvil.testClient.mine({ blocks: 2 });
  const head = await fixture.anvil.publicClient.getBlockNumber();
  const block = await fixture.anvil.publicClient.getBlock({ blockNumber: head - 1n });
  const receipt = await fixture.heartbeat(block, '0x1234');
  const heartbeat = parseEventLogs({
    abi: fixture.guardianAbi,
    logs: receipt.logs,
    eventName: 'Heartbeat',
    strict: true,
  });
  assert.deepEqual(heartbeat[0]?.args, [fixture.admin.address, block.number, block.timestamp, '0x1234']);

  await assert.rejects(fixture.heartbeat({ ...block, hash: `0x${'00'.repeat(32)}` }, '0x'));
});

test('the SDK commits its computed coverage digest in Heartbeat.data', async () => {
  const fixture = await deployed;
  const walletClient = createWalletClient({
    account: fixture.delegate,
    chain: fixture.anvil.chain,
    transport: http(fixture.anvil.rpcUrl),
  });
  const client = new ViemRpcClient({
    publicClient: fixture.anvil.publicClient,
    walletClient,
    maxLogBlockRange: 1_000,
    transactionPolicy: {
      sendTimeoutMs: 10_000,
      replacementFeeBumpBps: 1_000,
      maxFeePerGas: 100_000_000_000n,
      replacementTimeoutMs: 1_000,
      sendAttempts: 2,
    },
  });
  const guardian = new Guardian({
    mode: 'signal',
    client,
    expectedDelegate: fixture.delegate.address,
    deployment: {
      chainId: 1,
      slotSeconds: 12,
      lidoLend: { address: fixture.core, deploymentBlock: 0 },
      guardianSignals: { address: fixture.guardianSignals, deploymentBlock: 0 },
    },
    guardian: fixture.admin.address,
    screening: {
      screen: (request) =>
        Promise.resolve(
          request.anchors.map(() => ({ status: 'judged' as const, requiresSuspect: false, requiresFlag: false })),
        ),
    },
    reportBlockLag: 2,
    flaggerReadConcurrency: 2,
    interBatchConfirmationBlocks: 1,
    confirmationPollIntervalMs: 10,
    idleHeartbeatInterval: 1,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: 1,
    maxSignalBatchSize: 20,
  });

  const outcome = await guardian.cycle();
  assert.equal(outcome.kind, 'attested');
  const receipt = await fixture.anvil.publicClient.getTransactionReceipt({ hash: outcome.heartbeat });
  const heartbeats = parseEventLogs({
    abi: fixture.guardianAbi,
    logs: receipt.logs,
    eventName: 'Heartbeat',
    strict: true,
  });
  assert.deepEqual(heartbeats[0]?.args, [
    fixture.admin.address,
    BigInt(outcome.previousHeartbeatBlock.number),
    BigInt(outcome.previousHeartbeatBlock.timestamp),
    outcome.digest,
  ]);
});

function fixedDelay(seconds: number): ActivationConfig {
  return {
    ...DEFAULT_ACTIVATION_CONFIG,
    minActivationDelay: seconds,
    maxActivationDelay: seconds,
  };
}

function argumentsOf(value: unknown): readonly unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

/** Interpret the positional lifecycle ABI independently of the SDK's named fragments. */
function lifecycleArguments(value: unknown): {
  readonly borrower: unknown;
  readonly amount: bigint;
  readonly position: {
    readonly dust: bigint;
    readonly activating: bigint;
    readonly activatingStart: number;
    readonly activatingDelay: number;
  };
} {
  const [borrower, amount, position] = argumentsOf(value);
  const [dust, activating, activatingStart, activatingDelay] = argumentsOf(position);
  const hasBigintAmounts = typeof amount === 'bigint' && typeof dust === 'bigint' && typeof activating === 'bigint';
  const hasNumericTimer = typeof activatingStart === 'number' && typeof activatingDelay === 'number';
  if (!hasBigintAmounts || !hasNumericTimer) {
    throw new TypeError('Lifecycle event has unexpected numeric types');
  }
  return { borrower, amount, position: { dust, activating, activatingStart, activatingDelay } };
}
