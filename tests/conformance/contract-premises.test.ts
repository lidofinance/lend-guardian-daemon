// Independent probes of the pinned production contracts consumed by the SDK reconstruction.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { parseEventLogs } from 'viem';
import { BORROWER, DEFAULT_ACTIVATION_CONFIG, deployProtocolFixture } from './fixtures/protocol.ts';
import type { ActivationConfig } from './fixtures/protocol.ts';

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
function lifecycleArguments(value: unknown) {
  const [borrower, amount, position] = argumentsOf(value);
  const [dust, activating, activatingStart, activatingDelay] = argumentsOf(position);
  return { borrower, amount, position: { dust, activating, activatingStart, activatingDelay } };
}
