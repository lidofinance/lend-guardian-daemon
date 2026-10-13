import { signingClient } from '../core/client.ts';
// Contract-backed SDK cycles using the SDK's built-in signing and submission.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { parseEventLogs, toFunctionSelector } from 'viem';
import { isRecord } from '../../src/common/validation.ts';
import { Guardian, GuardianStop } from '../../src/core/index.ts';
import type { ScreeningProvider, ScreeningRequest, ScreeningResult } from '../../src/core/index.ts';
import { BORROWER, DEFAULT_ACTIVATION_CONFIG, DELEGATE_KEY, deployProtocolFixture } from './fixtures/protocol.ts';
import type { ActivationConfig, ProtocolFixture } from './fixtures/protocol.ts';

const deployed = deployProtocolFixture(8621);
const snapshot: { value: `0x${string}` } = { value: '0x0' };

before(
  async () => {
    await (await deployed).setDelegate();
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

test('discovers and screens complete work from two controlled markets', async () => {
  const fixture = await deployed;
  const secondMarket = await fixture.createMarket();
  const firstSupply = await fixture.primaryMarket.supply(100n);
  const secondSupply = await secondMarket.supply(100n);
  await passDeadline(fixture);
  const recording = recordingProvider(cleanResult());

  const outcome = await cycleWith(fixture, recording.provider);

  assert.equal(outcome.kind, 'attested');
  assert.equal(recording.requests.length, 1);
  const request = recording.requests[0];
  assert.ok(request !== undefined);
  assert.deepEqual(
    request.anchors.map((anchor) => anchor.transactionHash).sort(),
    [firstSupply.transactionHash, secondSupply.transactionHash].sort(),
  );
  assert.deepEqual(
    request.anchors.map((anchor) => anchor.marketId).sort(),
    [fixture.primaryMarket.id, secondMarket.id].sort(),
  );
});

test('lands required suspect, flag and heartbeat through SDK signing', async () => {
  const fixture = await deployed;
  const supplied = await fixture.primaryMarket.supply(100n);
  await passDeadline(fixture);
  const recording = recordingProvider({
    status: 'judged',
    requiresSuspect: true,
    requiresFlag: true,
  });

  const outcome = await cycleWith(fixture, recording.provider);

  assert.equal(outcome.kind, 'attested');
  assert.equal(recording.requests[0]?.anchors[0]?.transactionHash, supplied.transactionHash);
  assert.ok((await suspectedBy(fixture)).includes(fixture.admin.address.toLowerCase()));
  assert.ok((await flaggedBy(fixture)).includes(fixture.admin.address.toLowerCase()));
  assert.equal(await heartbeatTimestamp(fixture), outcome.previousHeartbeatBlock.timestamp);
});

test('reconstructs both an absorbed dust supply and the supply that absorbed it', async () => {
  const fixture = await deployed;
  const dust = await fixture.primaryMarket.supply(5n);
  const absorbing = await fixture.primaryMarket.supply(50n);
  await passDeadline(fixture);
  const recording = recordingProvider(cleanResult());

  assert.equal((await cycleWith(fixture, recording.provider)).kind, 'attested');
  assert.deepEqual(
    recording.requests[0]?.anchors.map((anchor) => anchor.transactionHash).sort(),
    [dust.transactionHash, absorbing.transactionHash].sort(),
  );
});

test('screens only a fresh supply after an earlier cycle established coverage', async () => {
  const fixture = await deployed;
  await fixture.primaryMarket.supply(100n);
  await passDeadline(fixture);
  const first = recordingProvider(cleanResult());
  assert.equal((await cycleWith(fixture, first.provider)).kind, 'attested');

  const fresh = await fixture.primaryMarket.supply(20n);
  await passDeadline(fixture);
  const second = recordingProvider(cleanResult());
  assert.equal((await cycleWith(fixture, second.provider)).kind, 'attested');
  assert.deepEqual(
    second.requests[0]?.anchors.map((anchor) => anchor.transactionHash),
    [fresh.transactionHash],
  );
});

test('dust supplied before coverage stays in work when a later activation absorbs it', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  const original = await market.supply(100n);
  const dust = await market.supply(5n);
  // A ban keeps the existing activating lot from maturing before the later supply is credited.
  await fixture.flag(market.id, [BORROWER]);
  await passDeadline(fixture);
  assert.equal((await cycleWith(fixture, recordingProvider(cleanResult()).provider)).kind, 'attested');

  const absorbing = await market.supply(15n);
  await passDeadline(fixture);
  const guardian = guardianOf(fixture, recordingProvider(cleanResult()).provider);
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  assert.ok(plan.previousHeartbeatBlock !== null);
  assert.ok(BigInt(plan.previousHeartbeatBlock.number) > dust.blockNumber);
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
  const hashes = work
    .all()
    .map((anchor) => anchor.transactionHash)
    .sort();
  assert.deepEqual(hashes, [dust.transactionHash, absorbing.transactionHash].sort());
  assert.ok(!hashes.includes(original.transactionHash));
});

test('discovers supplies around removal and re-addition from the membership-based range', async () => {
  const fixture = await deployed;
  const beforeRemoval = await fixture.primaryMarket.supply(100n);
  const readded = await fixture.removeAndReaddGuardian();
  const afterReaddition = await fixture.primaryMarket.supply(50n);
  await passDeadline(fixture);
  const recording = recordingProvider(cleanResult());
  const guardian = guardianOf(fixture, recording.provider);
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  assert.ok(BigInt(plan.discoveryRange.from.number) <= readded.blockNumber);
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
  const screened = await guardian.screenWork(work);

  assert.equal((await guardian.signalAndHeartbeat(screened)).kind, 'attested');
  const transactions = recording.requests[0]?.anchors.map((anchor) => anchor.transactionHash);
  assert.deepEqual(transactions?.sort(), [beforeRemoval.transactionHash, afterReaddition.transactionHash].sort());
});

test('uses the delay frozen in the activation event after configuration changes', async () => {
  const fixture = await deployed;
  await fixture.primaryMarket.setActivationConfig(fixedDelay(60));
  const supplied = await fixture.primaryMarket.supply(100n);
  await fixture.primaryMarket.setActivationConfig(fixedDelay(7_200));
  await fixture.anvil.testClient.mine({ blocks: 4, interval: 30 });
  const recording = recordingProvider(cleanResult());

  assert.equal((await cycleWith(fixture, recording.provider)).kind, 'attested');
  assert.equal(recording.requests[0]?.anchors[0]?.transactionHash, supplied.transactionHash);
});

test('drops a fully drained old position and screens only its later supply', async () => {
  const fixture = await deployed;
  await fixture.primaryMarket.setActivationConfig(fixedDelay(7_200));
  const old = await fixture.primaryMarket.supply(100n);
  await fixture.primaryMarket.withdraw(100n);
  const fresh = await fixture.primaryMarket.supply(60n);
  await passDeadline(fixture);
  const recording = recordingProvider(cleanResult());

  assert.equal((await cycleWith(fixture, recording.provider)).kind, 'attested');
  const transactions = recording.requests[0]?.anchors.map((anchor) => anchor.transactionHash);
  assert.deepEqual(
    { transactions, old: old.transactionHash, fresh: fresh.transactionHash },
    {
      transactions: [fresh.transactionHash],
      old: old.transactionHash,
      fresh: fresh.transactionHash,
    },
  );
});

test('keeps own-flagged work in coverage without calling the provider', async () => {
  const fixture = await deployed;
  await fixture.flag(fixture.primaryMarket.id, [BORROWER]);
  await fixture.primaryMarket.supply(100n);
  await passDeadline(fixture);
  const forbidden: ScreeningProvider = {
    screen: () => Promise.reject(new Error('own-flagged work reached the provider')),
  };

  const outcome = await cycleWith(fixture, forbidden);

  assert.equal(outcome.kind, 'attested');
  assert.equal(await heartbeatTimestamp(fixture), outcome.previousHeartbeatBlock.timestamp);
});

test('stops an incomplete real-cycle decision before reports or heartbeat', async () => {
  const fixture = await deployed;
  await fixture.primaryMarket.supply(100n);
  await passDeadline(fixture);
  const provider = recordingProvider({ status: 'incomplete' }).provider;

  await assertScreeningStop(fixture, provider, 'screening-result-incomplete');
  assert.equal(await heartbeatTimestamp(fixture), 0);
});

test('stops malformed evidence from a real cycle before reports or heartbeat', async () => {
  const fixture = await deployed;
  await fixture.primaryMarket.supply(100n);
  await passDeadline(fixture);
  const malformed = cleanResult();
  Object.assign(malformed, { evidenceReference: '' });
  const provider = recordingProvider(malformed).provider;

  await assertScreeningStop(fixture, provider, 'screening-result-malformed');
  assert.equal(await heartbeatTimestamp(fixture), 0);
});

test('a top-up after the suspect window lapses sheds the surcharge only until the next cycle suspects again', async () => {
  const fixture = await deployed;
  const market = fixture.primaryMarket;
  const chain = fixture.anvil.testClient;
  await fixture.setSuspectWindow(120);
  await market.setActivationConfig({ ...fixedDelay(60), delayPerSuspect: 600, maxGuardiansQuorumDelay: 3_600 });
  const suspicious: ScreeningResult = { status: 'judged', requiresSuspect: true, requiresFlag: false };

  await market.supply(20n);
  await becomeDue(fixture);
  assert.equal((await cycleWith(fixture, recordingProvider(suspicious).provider)).kind, 'attested');
  const firstRecordedAt = await ownSuspectRecordedAt(fixture);
  assert.ok(firstRecordedAt > 0);

  // A top-up while the suspect is inside its window restarts the timer, still under the surcharge.
  await chain.increaseTime({ seconds: 90 });
  await chain.mine({ blocks: 1 });
  const second = await market.supply(10n);
  // A top-up after the window lapsed, before the restarted delay ran out, restarts it without the surcharge.
  await chain.increaseTime({ seconds: 50 });
  await chain.mine({ blocks: 1 });
  const third = await market.supply(10n);
  const windowEnd = firstRecordedAt + 120;
  assert.ok((await blockTimestamp(fixture, second.blockNumber)) < windowEnd);
  assert.ok((await blockTimestamp(fixture, third.blockNumber)) >= windowEnd);

  // The quorum frontier still stands at the first heartbeat, so the lot cannot mature without the Guardian.
  await becomeDue(fixture);
  await assert.rejects(market.withdraw(1n), stillInactive);

  const recording = recordingProvider(suspicious);
  assert.equal((await cycleWith(fixture, recording.provider)).kind, 'attested');
  assert.deepEqual(
    recording.requests[0]?.anchors.map((anchor) => anchor.transactionHash).sort(),
    [second.transactionHash, third.transactionHash].sort(),
  );
  assert.ok((await ownSuspectRecordedAt(fixture)) > firstRecordedAt);

  // The fresh suspect's surcharge applies to the restarted lot: it stays inactive past its base delay.
  await chain.increaseTime({ seconds: 600 });
  await chain.mine({ blocks: 3, interval: 1 });
  await assert.rejects(market.withdraw(1n), stillInactive);

  // Only a heartbeat past the surcharged unlock time lets it mature.
  assert.equal((await cycleWith(fixture, recordingProvider(cleanResult()).provider)).kind, 'attested');
  const matured = parseEventLogs({
    abi: market.controllerAbi,
    logs: (await market.withdraw(1n)).logs,
    eventName: 'CollateralActivated',
    strict: true,
  });
  assert.equal(matured.length, 1);
});

/** Chain time passes the lot's base delay and the report block, two behind the head, lands after it. */
async function becomeDue(fixture: ProtocolFixture): Promise<void> {
  await fixture.anvil.testClient.increaseTime({ seconds: 61 });
  await fixture.anvil.testClient.mine({ blocks: 3, interval: 1 });
}

async function blockTimestamp(fixture: ProtocolFixture, blockNumber: bigint): Promise<number> {
  return Number((await fixture.anvil.publicClient.getBlock({ blockNumber })).timestamp);
}

const INACTIVE_NOT_CLEARED = toFunctionSelector('InactiveCollateralNotCleared(uint256,uint256)');

/** A draw of one failed on the still inactive balance, so the lot has not matured. */
function stillInactive(error: unknown): boolean {
  let current: unknown = error;
  while (isRecord(current)) {
    for (const key of ['message', 'details', 'data', 'signature']) {
      const value = current[key];
      if (typeof value === 'string' && value.includes(INACTIVE_NOT_CLEARED)) {
        return true;
      }
    }
    current = current.cause;
  }
  assert.fail(`expected InactiveCollateralNotCleared, got ${String(error)}`);
}

/** When this Guardian's suspect on the borrower was recorded, or zero without one. */
async function ownSuspectRecordedAt(fixture: ProtocolFixture): Promise<number> {
  const value = await fixture.anvil.publicClient.readContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'getSuspectedBy',
    args: [fixture.primaryMarket.id, BORROWER],
  });
  const outer = arrayOf(value, 'suspected result');
  const index = arrayOf(outer[0], 'suspected guardians').map(lowerAddress).indexOf(fixture.admin.address.toLowerCase());
  return index === -1 ? 0 : Number(arrayOf(outer[1], 'suspected timestamps')[index]);
}

function guardianOf(fixture: ProtocolFixture, screening: ScreeningProvider): Guardian {
  return new Guardian({
    deployment: {
      chainId: 1,
      slotSeconds: 12,
      lidoLend: { address: fixture.core, deploymentBlock: 0 },
      guardianSignals: { address: fixture.guardianSignals, deploymentBlock: 0 },
    },
    guardian: fixture.admin.address,
    expectedDelegate: fixture.delegate.address,
    screening,
    client: signingClient([{ node: fixture.anvil.rpcUrl }], DELEGATE_KEY, 25),
    maxSignalBatchSize: 20,
    idleHeartbeatInterval: 1,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: 1,
  });
}

async function cycleWith(fixture: ProtocolFixture, provider: ScreeningProvider) {
  const guardian = guardianOf(fixture, provider);
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
  const screened = await guardian.screenWork(work);
  return guardian.signalAndHeartbeat(screened);
}

async function assertScreeningStop(
  fixture: ProtocolFixture,
  provider: ScreeningProvider,
  reason: 'screening-result-incomplete' | 'screening-result-malformed',
): Promise<void> {
  const guardian = guardianOf(fixture, provider);
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
  await assert.rejects(guardian.screenWork(work), (error: unknown) => {
    assert.ok(error instanceof GuardianStop);
    assert.equal(error.reason, reason);
    return true;
  });
}

function recordingProvider(result: ScreeningResult): {
  readonly provider: ScreeningProvider;
  readonly requests: ScreeningRequest[];
} {
  const requests: ScreeningRequest[] = [];
  return {
    requests,
    provider: {
      screen: (request) => {
        requests.push(request);
        return Promise.resolve(request.anchors.map(() => result));
      },
    },
  };
}

function cleanResult(): ScreeningResult {
  return { status: 'judged', requiresSuspect: false, requiresFlag: false };
}

async function passDeadline(fixture: ProtocolFixture): Promise<void> {
  await fixture.anvil.testClient.mine({ blocks: 4, interval: 3_600 });
}

function fixedDelay(seconds: number): ActivationConfig {
  return {
    ...DEFAULT_ACTIVATION_CONFIG,
    minActivationDelay: seconds,
    maxActivationDelay: seconds,
  };
}

async function suspectedBy(fixture: ProtocolFixture): Promise<string[]> {
  const value = await fixture.anvil.publicClient.readContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'getSuspectedBy',
    args: [fixture.primaryMarket.id, BORROWER],
  });
  const outer = arrayOf(value, 'suspected result');
  return arrayOf(outer[0], 'suspected guardians').map(lowerAddress);
}

async function flaggedBy(fixture: ProtocolFixture): Promise<string[]> {
  const value = await fixture.anvil.publicClient.readContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'getFlaggedBy',
    args: [fixture.primaryMarket.id, BORROWER],
  });
  return arrayOf(value, 'flagged guardians').map(lowerAddress);
}

async function heartbeatTimestamp(fixture: ProtocolFixture): Promise<number> {
  const value = await fixture.anvil.publicClient.readContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'getHeartbeat',
    args: [fixture.admin.address],
  });
  return Number(value);
}

function arrayOf(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} is not an array`);
  }
  return value;
}

function lowerAddress(value: unknown): string {
  return String(value).toLowerCase();
}
