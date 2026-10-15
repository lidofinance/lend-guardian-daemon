import type { NodeRequest } from '../core/client.ts';
import { signingClient } from '../core/client.ts';
// The SDK's submission phase against the pinned registry: batching, shared wait and heartbeat.
// Internal phase values isolate submission here; guardian-cycle.test.ts also runs all five phases.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createWalletClient, http, isHex, numberToHex, padHex, zeroHash } from 'viem';
import type { PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Guardian } from '../../src/core/index.ts';
import type { Address, Bytes32, SignalTarget, TxHash } from '../../src/core/index.ts';
import { Screened, Work } from '../../src/core/outcomes.ts';
import { GuardianSignals } from '../../src/contracts/guardian-signals.ts';
import { isRecord } from '../../src/common/validation.ts';
import { BORROWER, DELEGATE_KEY, deployProtocolFixture } from './fixtures/protocol.ts';
import type { ProtocolFixture } from './fixtures/protocol.ts';

const OTHER_BORROWER: Address = '0x00000000000000000000000000000000000000d0';
const OTHER_MARKET = padHex('0x22', { size: 32 });
const deployed = deployProtocolFixture(8622);
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

type AfterRequest = (method: string, response: unknown, hashes: readonly TxHash[]) => Promise<void>;

async function prepared(
  fixture: ProtocolFixture,
  targets: readonly SignalTarget[],
  kind: 'suspect' | 'flag',
  afterRequest: AfterRequest,
) {
  const hashes: TxHash[] = [];
  const transport: NodeRequest = async (method, params) => {
    const response: unknown = await fixture.anvil.publicClient.transport.request({
      method,
      params,
    });
    if (method === 'eth_sendRawTransaction') {
      assert.ok(typeof response === 'string' && isHex(response));
      hashes.push(response);
    }
    await afterRequest(method, response, hashes);
    return response;
  };
  const guardian = guardianOf(fixture, transport);
  await fixture.anvil.testClient.mine({ blocks: 2 });
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const work = new Work(plan, new Map());
  const screened = new Screened(
    work,
    { results: [], skipped: [] },
    {
      suspects: kind === 'suspect' ? targets : [],
      flags: kind === 'flag' ? targets : [],
    },
  );
  return { guardian, screened, hashes };
}

test('sends every target in market batches before the shared depth-12 wait', async () => {
  const fixture = await deployed;
  const targets = [
    { marketId: fixture.primaryMarket.id, borrower: BORROWER },
    { marketId: fixture.primaryMarket.id, borrower: OTHER_BORROWER },
    { marketId: OTHER_MARKET, borrower: BORROWER },
  ];
  const built = await prepared(fixture, targets, 'suspect', async (method, _response, hashes) => {
    if (method !== 'eth_sendRawTransaction') {
      return;
    }
    const firstHash = hashes[0];
    assert.ok(firstHash !== undefined);
    if (hashes.length === 2) {
      const first = await fixture.anvil.publicClient.getTransactionReceipt({ hash: firstHash });
      const head = await fixture.anvil.publicClient.getBlockNumber({ cacheTime: 0 });
      assert.ok(head - first.blockNumber + 1n < 12n, 'second batch must not wait for full depth');
    }
    await fixture.anvil.testClient.mine({ blocks: hashes.length === 1 ? 1 : 12 });
  });
  const outcome = await built.guardian.signalAndHeartbeat(built.screened);
  assert.equal(outcome.kind, 'attested');
  assert.equal(built.hashes.length, 3, 'two report transactions and one heartbeat');
  const head = await fixture.anvil.publicClient.getBlockNumber({ cacheTime: 0 });
  for (const hash of built.hashes) {
    const receipt = await fixture.anvil.publicClient.getTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    assert.ok(head - receipt.blockNumber + 1n >= 12n);
    const transaction = await fixture.anvil.publicClient.getTransaction({ hash });
    assert.equal(transaction.from.toLowerCase(), fixture.delegate.address.toLowerCase());
    assert.equal(transaction.to?.toLowerCase(), fixture.guardianSignals.toLowerCase());
  }
  for (const target of targets) {
    assert.deepEqual(await suspectedBy(fixture, target.marketId, target.borrower), [fixture.admin.address]);
  }
});

test('a report lands when another guardian reports its accounts between the estimate and the broadcast', async () => {
  const fixture = await deployed;
  const [late, ...early] = await otherGuardians(fixture, 4);
  assert.ok(late !== undefined);
  const accounts = Array.from({ length: 20 }, (_unused, index) => padHex(numberToHex(0x2000 + index), { size: 20 }));
  // With reports that stay current, every earlier report on an account makes a further one cost more gas.
  await fixture.setSuspectWindow(86_400);
  for (const guardian of early) {
    await suspectAs(fixture, guardian, accounts);
  }
  const targets = accounts.map((borrower) => ({ marketId: fixture.primaryMarket.id, borrower }));
  let estimate: bigint | undefined;
  const built = await prepared(fixture, targets, 'suspect', async (method, response) => {
    const gas = estimatedGas(method, response);
    if (gas !== undefined && estimate === undefined) {
      estimate = gas;
      await suspectAs(fixture, late, accounts);
    }
    if (method === 'eth_sendRawTransaction') {
      await fixture.anvil.testClient.mine({ blocks: 11 });
    }
  });
  const outcome = await built.guardian.signalAndHeartbeat(built.screened);
  assert.equal(outcome.kind, 'attested');
  const [report] = built.hashes;
  assert.ok(report !== undefined && estimate !== undefined);
  const receipt = await fixture.anvil.publicClient.getTransactionReceipt({ hash: report });
  assert.equal(receipt.status, 'success');
  // The late report raised the cost above the estimate; only the headroom kept the report from running out of gas.
  assert.ok(receipt.gasUsed > estimate);
});

test('stops before the next market batch when the plan expires during shallow confirmation', async () => {
  const fixture = await deployed;
  const targets = [
    { marketId: fixture.primaryMarket.id, borrower: BORROWER },
    { marketId: OTHER_MARKET, borrower: BORROWER },
  ];
  const built = await prepared(fixture, targets, 'flag', async (method) => {
    if (method === 'eth_sendRawTransaction') {
      await fixture.anvil.testClient.mine({ blocks: 260 });
    }
  });
  assert.deepEqual(await built.guardian.signalAndHeartbeat(built.screened), {
    kind: 'stale',
    reason: 'report-block-aged-out',
  });
  assert.equal(built.hashes.length, 1);
  assert.deepEqual(await flaggedBy(fixture, fixture.primaryMarket.id, BORROWER), [fixture.admin.address]);
  assert.deepEqual(await flaggedBy(fixture, OTHER_MARKET, BORROWER), []);
  assert.equal(await heartbeatTimestamp(fixture), 0);
});

test('a report receipt lost after inclusion stops the shared wait before heartbeat', async () => {
  const fixture = await deployed;
  const beforeReport: { value: `0x${string}` | null } = { value: null };
  const lost: TxHash[] = [];
  const built = await prepared(
    fixture,
    [{ marketId: fixture.primaryMarket.id, borrower: BORROWER }],
    'suspect',
    async (method, response, hashes) => {
      if (method === 'eth_sendRawTransaction') {
        await fixture.anvil.testClient.mine({ blocks: 1 });
      }
      if (method !== 'eth_getBlockByNumber' || hashes.length === 0) {
        return;
      }
      const hash = hashes[0];
      assert.ok(hash !== undefined);
      if (lost.includes(hash)) {
        return;
      }
      const receipt = await fixture.anvil.publicClient.getTransactionReceipt({ hash });
      assert.ok(typeof response === 'object' && response !== null);
      if (!('hash' in response) || response.hash !== receipt.blockHash) {
        return;
      }
      // Reorg after the client's initial canonical read, so the shared wait remains the guard.
      lost.push(hash);
      assert.ok(beforeReport.value !== null);
      await fixture.anvil.testClient.revert({ id: beforeReport.value });
      await fixture.anvil.testClient.mine({ blocks: 20 });
    },
  );
  beforeReport.value = await fixture.anvil.testClient.snapshot();
  assert.deepEqual(await built.guardian.signalAndHeartbeat(built.screened), {
    kind: 'stale',
    reason: 'report-no-longer-confirmed',
  });
  assert.equal(built.hashes.length, 1);
  assert.equal(await heartbeatTimestamp(fixture), 0);
});

test('propagates an unauthorized registry write instead of returning a receipt', async () => {
  const fixture = await deployed;
  const client = signingClient([{ node: fixture.anvil.rpcUrl }], DELEGATE_KEY, 25);
  const registry = new GuardianSignals({
    client,
    chainId: 1,
    deployment: { address: fixture.guardianSignals, deploymentBlock: 0 },
    guardian: OTHER_BORROWER,
  });
  await assert.rejects(registry.flag(fixture.primaryMarket.id, [BORROWER], { confirmations: 1 }));
  assert.deepEqual(await flaggedBy(fixture, fixture.primaryMarket.id, BORROWER), []);
});

test('confirms the heartbeat canonically at depth 12 before returning attested', async () => {
  const fixture = await deployed;
  const built = await prepared(fixture, [], 'suspect', async (method) => {
    if (method === 'eth_sendRawTransaction') {
      await fixture.anvil.testClient.mine({ blocks: 11 });
    }
  });
  const outcome = await built.guardian.signalAndHeartbeat(built.screened);
  assert.equal(outcome.kind, 'attested');
  assert.deepEqual(built.hashes, [outcome.heartbeat]);
  const receipt = await fixture.anvil.publicClient.getTransactionReceipt({
    hash: outcome.heartbeat,
  });
  const head = await fixture.anvil.publicClient.getBlockNumber({ cacheTime: 0 });
  assert.equal(receipt.status, 'success');
  assert.ok(head - receipt.blockNumber + 1n >= 12n);
  assert.equal(
    (await fixture.anvil.publicClient.getBlock({ blockNumber: receipt.blockNumber })).hash,
    receipt.blockHash,
  );
  assert.equal(await heartbeatTimestamp(fixture), built.screened.work().reportBlock.timestamp);
});

function guardianOf(fixture: ProtocolFixture, transport: NodeRequest): Guardian {
  return new Guardian({
    deployment: {
      chainId: 1,
      slotSeconds: 12,
      lidoLend: { address: fixture.core, deploymentBlock: 0 },
      guardianSignals: { address: fixture.guardianSignals, deploymentBlock: 0 },
    },
    guardian: fixture.admin.address,
    expectedDelegate: fixture.delegate.address,
    screening: {
      screen: () => Promise.reject(new Error('submission test must not call screening')),
    },
    client: signingClient([{ node: transport }], DELEGATE_KEY, 25),
    maxSignalBatchSize: 20,
    idleHeartbeatInterval: 1,
    screeningTimeoutMs: 10_000,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: 12,
  });
}

async function suspectedBy(
  fixture: ProtocolFixture,
  marketId: Bytes32,
  borrower: Address,
): Promise<readonly unknown[]> {
  const value = await fixture.anvil.publicClient.readContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'getSuspectedBy',
    args: [marketId, borrower],
  });
  const outer = arrayOf(value, 'suspected result');
  return arrayOf(outer[0], 'suspected guardians');
}
async function flaggedBy(fixture: ProtocolFixture, marketId: Bytes32, borrower: Address): Promise<readonly unknown[]> {
  const value = await fixture.anvil.publicClient.readContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'getFlaggedBy',
    args: [marketId, borrower],
  });
  return arrayOf(value, 'flagged guardians');
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

/** Mine two blocks a second apart and attest the one before the head, as a previous cycle would have. */
async function heartbeatBeforeHead(fixture: ProtocolFixture): Promise<void> {
  await fixture.anvil.testClient.mine({ blocks: 2, interval: 1 });
  const head = await fixture.anvil.publicClient.getBlockNumber({ cacheTime: 0 });
  const block = await fixture.anvil.publicClient.getBlock({ blockNumber: head - 1n });
  await fixture.heartbeat(block, zeroHash);
}

test('keeps a suspect this Guardian recorded since its previous heartbeat and sends only the heartbeat', async () => {
  const fixture = await deployed;
  const target = { marketId: fixture.primaryMarket.id, borrower: BORROWER };
  await fixture.setSuspectWindow(86_400);
  await heartbeatBeforeHead(fixture);
  await fixture.anvil.testClient.mine({ blocks: 1, interval: 1 });
  await fixture.suspect(target.marketId, [target.borrower]);
  await fixture.anvil.testClient.mine({ blocks: 12, interval: 1 });
  const built = await prepared(fixture, [target], 'suspect', async (method) => {
    if (method === 'eth_sendRawTransaction') {
      await fixture.anvil.testClient.mine({ blocks: 11 });
    }
  });
  const outcome = await built.guardian.signalAndHeartbeat(built.screened);
  assert.equal(outcome.kind, 'attested');
  assert.deepEqual(built.hashes, [outcome.heartbeat]);
  assert.deepEqual(await suspectedBy(fixture, target.marketId, target.borrower), [fixture.admin.address]);
});

test('sends again a suspect recorded before the previous heartbeat', async () => {
  const fixture = await deployed;
  const target = { marketId: fixture.primaryMarket.id, borrower: BORROWER };
  await fixture.setSuspectWindow(86_400);
  await fixture.suspect(target.marketId, [target.borrower]);
  await heartbeatBeforeHead(fixture);
  await fixture.anvil.testClient.mine({ blocks: 12, interval: 1 });
  const built = await prepared(fixture, [target], 'suspect', async (method) => {
    if (method === 'eth_sendRawTransaction') {
      await fixture.anvil.testClient.mine({ blocks: 11 });
    }
  });
  const outcome = await built.guardian.signalAndHeartbeat(built.screened);
  assert.equal(outcome.kind, 'attested');
  assert.equal(built.hashes.length, 2);
  assert.equal(built.hashes[1], outcome.heartbeat);
});
/** The gas the node estimated, from whichever request viem prepared the transaction with. */
function estimatedGas(method: string, response: unknown): bigint | undefined {
  if (method === 'eth_estimateGas' && typeof response === 'string') {
    return BigInt(response);
  }
  if (method !== 'eth_fillTransaction') {
    return undefined;
  }
  const transaction = isRecord(response) ? response.tx : undefined;
  return isRecord(transaction) && typeof transaction.gas === 'string' ? BigInt(transaction.gas) : undefined;
}

/** Further guardians with funded keys; the snapshot taken before each test removes them again. */
async function otherGuardians(fixture: ProtocolFixture, count: number): Promise<PrivateKeyAccount[]> {
  const admin = createWalletClient({
    account: fixture.admin,
    chain: fixture.anvil.chain,
    transport: http(fixture.anvil.rpcUrl),
  });
  const guardians = Array.from({ length: count }, (_unused, index) =>
    privateKeyToAccount(padHex(numberToHex(0x1000 + index), { size: 32 })),
  );
  for (const guardian of guardians) {
    await fixture.anvil.testClient.setBalance({ address: guardian.address, value: 10n ** 20n });
    const hash = await admin.writeContract({
      address: fixture.guardianSignals,
      abi: fixture.guardianAbi,
      functionName: 'addGuardian',
      args: [guardian.address],
      gas: 1_000_000n,
    });
    assert.equal((await fixture.anvil.publicClient.waitForTransactionReceipt({ hash })).status, 'success');
  }
  return guardians;
}

/** A guardian's own suspect report, sent with ample gas so the fixture does not depend on estimates. */
async function suspectAs(
  fixture: ProtocolFixture,
  guardian: PrivateKeyAccount,
  accounts: readonly Address[],
): Promise<void> {
  const wallet = createWalletClient({
    account: guardian,
    chain: fixture.anvil.chain,
    transport: http(fixture.anvil.rpcUrl),
  });
  const hash = await wallet.writeContract({
    address: fixture.guardianSignals,
    abi: fixture.guardianAbi,
    functionName: 'suspect',
    args: [fixture.primaryMarket.id, guardian.address, accounts],
    gas: 10_000_000n,
  });
  assert.equal((await fixture.anvil.publicClient.waitForTransactionReceipt({ hash })).status, 'success');
}
