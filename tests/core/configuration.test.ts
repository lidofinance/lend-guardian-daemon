import { rpcRequest } from './client.ts';
import { signingClient } from './client.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { zeroAddress } from 'viem';
import { Guardian } from '../../src/core/guardian.ts';
import type { GuardianSetup } from '../../src/core/guardian.ts';
import type { RpcClient } from '../../src/core/index.ts';
import { SUPPLY_COLLATERAL_TOPICS } from '../../abi/Core.abi.ts';
import { BaseRpcProvider } from '../../src/chain/base-rpc-provider.ts';
import { blockAt, CORE, fakeNode, GUARDIAN, REGISTRY } from './fake-node.ts';

const HEAD = 200_000;

function configuration() {
  return {
    deployment: {
      chainId: 1,
      slotSeconds: 12,
      lidoLend: { address: CORE, deploymentBlock: 1_000 },
      guardianSignals: { address: REGISTRY, deploymentBlock: 900 },
    },
    guardian: GUARDIAN,

    expectedDelegate: zeroAddress,
    screening: { screen: () => Promise.resolve([]) },
    client: signingClient([{ node: fakeNode({ head: HEAD }).transport }]),
    maxLogBlockRange: 1_000,
    maxSignalBatchSize: 20,
    idleHeartbeatInterval: 43_200,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: 12,
    confirmationPollIntervalMs: 12_000,
  };
}

const NUMERIC_FIELDS = [
  'chainId',
  'slotSeconds',
  'lidoLendDeploymentBlock',
  'guardianSignalsDeploymentBlock',
  'maxSignalBatchSize',
  'idleHeartbeatInterval',
  'heartbeatReserveBlocks',
  'txConfirmationBlocks',
];

function withNumber(setup: GuardianSetup, field: string, value: unknown): GuardianSetup {
  if (field === 'lidoLendDeploymentBlock') {
    return {
      ...setup,
      deployment: {
        ...setup.deployment,
        lidoLend: Object.assign({}, setup.deployment.lidoLend, { deploymentBlock: value }),
      },
    };
  }
  if (field === 'guardianSignalsDeploymentBlock') {
    return {
      ...setup,
      deployment: {
        ...setup.deployment,
        guardianSignals: Object.assign({}, setup.deployment.guardianSignals, { deploymentBlock: value }),
      },
    };
  }
  if (field in setup.deployment) {
    return { ...setup, deployment: Object.assign({}, setup.deployment, { [field]: value }) };
  }
  return Object.assign({}, setup, { [field]: value });
}

for (const mode of ['signal', 'observe'] as const) {
  for (const field of NUMERIC_FIELDS) {
    test(`${mode} rejects malformed ${field} before any RPC, screening or submission`, () => {
      const calls: string[] = [];
      const setup = {
        ...configuration(),
        mode,
        client: configuration().client,
        screening: {
          screen: () => {
            calls.push('screen');
            return Promise.resolve([]);
          },
        },
      };
      for (const value of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined, '12']) {
        assert.throws(() => new Guardian(withNumber(setup, field, value)), RangeError);
      }
      assert.deepEqual(calls, []);
    });
  }
}

test('numeric setup accepts its documented limits and rejects values outside them', () => {
  const node = fakeNode({ head: HEAD });
  // Observe isolates each field: in signal mode the send budget also bounds slotSeconds and txConfirmationBlocks.
  const setup = { ...configuration(), mode: 'observe' as const, client: signingClient([{ node: node.transport }]) };
  const ranges = [
    { field: 'chainId', min: 1, max: Number.MAX_SAFE_INTEGER },
    { field: 'slotSeconds', min: 1, max: Number.MAX_SAFE_INTEGER },
    { field: 'maxSignalBatchSize', min: 1, max: Number.MAX_SAFE_INTEGER },
    { field: 'lidoLendDeploymentBlock', min: 0, max: Number.MAX_SAFE_INTEGER },
    { field: 'guardianSignalsDeploymentBlock', min: 0, max: Number.MAX_SAFE_INTEGER },
    { field: 'idleHeartbeatInterval', min: 1, max: Number.MAX_SAFE_INTEGER },
    { field: 'txConfirmationBlocks', min: 1, max: 64 },
    { field: 'heartbeatReserveBlocks', min: 1, max: 254 },
  ];
  for (const { field, min, max } of ranges) {
    assert.doesNotThrow(() => new Guardian(withNumber(setup, field, min)));
    assert.doesNotThrow(() => new Guardian(withNumber(setup, field, max)));
    assert.throws(() => new Guardian(withNumber(setup, field, min - 1)), RangeError);
    assert.throws(() => new Guardian(withNumber(setup, field, max + 1)), RangeError);
  }
});

const ADDRESS_FIELDS = ['guardian', 'deployment.lidoLend.address', 'deployment.guardianSignals.address'] as const;

type AddressField = (typeof ADDRESS_FIELDS)[number] | 'expectedDelegate';

function withAddress(setup: GuardianSetup, field: AddressField, value: unknown): GuardianSetup {
  if (field === 'deployment.lidoLend.address') {
    const lidoLend = Object.assign({}, setup.deployment.lidoLend, { address: value });
    return { ...setup, deployment: { ...setup.deployment, lidoLend } };
  }
  if (field === 'deployment.guardianSignals.address') {
    const guardianSignals = Object.assign({}, setup.deployment.guardianSignals, { address: value });
    return { ...setup, deployment: { ...setup.deployment, guardianSignals } };
  }
  return Object.assign({}, setup, { [field]: value });
}

/** A short value, a broken checksum, and a list whose text is an address viem has already accepted. */
function listMalformedAddresses(): unknown[] {
  assert.doesNotThrow(() => new Guardian(configuration()));
  return ['0x1234', '0x52908400098527886E0F7030069857D2E4169Ee7', [GUARDIAN]];
}

for (const mode of ['signal', 'observe'] as const) {
  for (const field of ADDRESS_FIELDS) {
    test(`${mode} rejects a malformed ${field} before any RPC, screening or submission`, () => {
      const setup = { ...configuration(), mode, client: configuration().client };
      for (const value of listMalformedAddresses()) {
        assert.throws(() => new Guardian(withAddress(setup, field, value)), {
          name: 'TypeError',
          message: `${field} must be a valid address`,
        });
      }
    });
  }
}

test('signal rejects a malformed expectedDelegate before any RPC, screening or submission', () => {
  for (const value of listMalformedAddresses()) {
    assert.throws(() => new Guardian(withAddress(configuration(), 'expectedDelegate', value)), {
      name: 'TypeError',
      message: 'expectedDelegate must be a valid address',
    });
  }
});

/** A client another library could supply: the reads of a provider, and a delivery policy of its own. */
function createClientWithSendBudget(sendTimeoutMs: unknown): RpcClient {
  const provider = new BaseRpcProvider({
    request: rpcRequest(fakeNode({ head: HEAD }).transport),
    maxLogBlockRange: 1_000,
  });
  const refuse = (): Promise<never> => Promise.reject(new Error('the setup must not deliver'));
  const policy = {
    maxFeePerGas: 1n,
    sendTimeoutMs: 1,
    replacementFeeBumpBps: 1_000,
    replacementTimeoutMs: 1,
    sendAttempts: 1,
  };
  return Object.assign(provider, {
    signer: GUARDIAN,
    transactionPolicy: Object.assign(policy, { sendTimeoutMs }),
    prepareTransaction: refuse,
    broadcastTransaction: refuse,
    send: refuse,
  });
}

test('signal rejects a client whose send budget is not an integer', () => {
  for (const sendTimeoutMs of [NaN, Infinity, 1.5, null, undefined, '264000']) {
    assert.throws(() => new Guardian({ ...configuration(), client: createClientWithSendBudget(sendTimeoutMs) }), {
      name: 'RangeError',
      message: 'client.transactionPolicy.sendTimeoutMs must be a safe integer',
    });
  }
});

test('signal accepts a send budget from the confirmation depth plus one slot to 2_147_483_647 ms', () => {
  // Twelve confirmations of 12-second slots: 13 slots, 156 seconds.
  for (const sendTimeoutMs of [156_000, 2_147_483_647]) {
    assert.doesNotThrow(() => new Guardian({ ...configuration(), client: createClientWithSendBudget(sendTimeoutMs) }));
  }
  for (const sendTimeoutMs of [155_999, 60_000, 1, 0, -1, 2_147_483_648]) {
    assert.throws(() => new Guardian({ ...configuration(), client: createClientWithSendBudget(sendTimeoutMs) }), {
      name: 'RangeError',
      message: 'client.transactionPolicy.sendTimeoutMs must be between 156000 and 2147483647',
    });
  }
});

test('the minimum send budget follows the confirmation depth and the slot duration', () => {
  const setup = {
    ...configuration(),
    deployment: { ...configuration().deployment, slotSeconds: 2 },
    txConfirmationBlocks: 1,
  };
  // One confirmation of 2-second slots: two slots, four seconds.
  assert.doesNotThrow(() => new Guardian({ ...setup, client: createClientWithSendBudget(4_000) }));
  assert.throws(() => new Guardian({ ...setup, client: createClientWithSendBudget(3_999) }), {
    name: 'RangeError',
    message: 'client.transactionPolicy.sendTimeoutMs must be between 4000 and 2147483647',
  });
});

test('setup rejects missing and empty node endpoints before constructing a client', () => {
  assert.throws(() => signingClient([]), /endpoints must contain at least one node/);
  assert.throws(() => signingClient([{ node: '' }]), /endpoint URL must not be empty/);
});

test('editing the caller setup cannot change the validated discovery profile', async () => {
  const node = fakeNode({ head: HEAD, guardianAddedAt: 150_000 });
  const setup = {
    ...configuration(),
    client: signingClient([{ node: node.transport }]),
  };
  const guardian = new Guardian(setup);
  Object.assign(setup, {
    activationLookbackSeconds: 1,
    txConfirmationBlocks: 0,
    maxLogBlockRange: 0,
  });
  Object.assign(setup.deployment, { chainId: 2, slotSeconds: 0 });
  Object.assign(setup.deployment.lidoLend, { deploymentBlock: HEAD });
  const plan = await guardian.buildScanPlan();
  assert.ok(plan.kind === 'plan');
  assert.equal(plan.discoveryRange.from.number, 99_600);
  const screened = await guardian.screenWork(
    await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan)),
  );
  assert.equal((await guardian.signalAndHeartbeat(screened)).kind, 'attested');
  assert.equal(node.sent.heartbeats.length, 1);
});

test('a maximum safe deployment floor stays ahead of a young chain without overflow', async () => {
  const node = fakeNode({ head: HEAD });
  const setup = withNumber(configuration(), 'lidoLendDeploymentBlock', Number.MAX_SAFE_INTEGER);
  const guardian = new Guardian({ ...setup, client: signingClient([{ node: node.transport }]) });
  const plan = await guardian.buildScanPlan();
  assert.ok(plan.kind === 'nothing-due');
  assert.equal(plan.reason, 'report-block-before-core-deployment');
});

test('log ranges preserve inclusive maximum-safe boundaries without overflow', async () => {
  const ranges: { fromBlock: number; toBlock: number }[] = [];
  const rpc = new BaseRpcProvider({
    request: rpcRequest((_method, params) => {
      const filter = params[0];
      assert.ok(typeof filter === 'object' && filter !== null);
      assert.ok('fromBlock' in filter && typeof filter.fromBlock === 'string');
      assert.ok('toBlock' in filter && typeof filter.toBlock === 'string');
      ranges.push({
        fromBlock: Number(BigInt(filter.fromBlock)),
        toBlock: Number(BigInt(filter.toBlock)),
      });
      return Promise.resolve([]);
    }),
    maxLogBlockRange: 2,
  });
  await rpc.getLogs({
    address: CORE,
    topics: SUPPLY_COLLATERAL_TOPICS,
    fromBlock: Number.MAX_SAFE_INTEGER - 2,
    toBlock: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(ranges, [
    { fromBlock: Number.MAX_SAFE_INTEGER - 2, toBlock: Number.MAX_SAFE_INTEGER - 1 },
    { fromBlock: Number.MAX_SAFE_INTEGER, toBlock: Number.MAX_SAFE_INTEGER },
  ]);
});

test('editing the caller setup cannot reduce the heartbeat confirmation depth', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const node = fakeNode({ head: HEAD, guardianAddedAt: 150_000 });
  let pollingResolve: () => void = () => {
    throw new Error('Wait was not initialized');
  };
  const polling = new Promise<void>((resolve) => {
    pollingResolve = resolve;
  });
  const setup = {
    ...configuration(),
    client: signingClient([
      {
        node: async (method: string, params: readonly unknown[]) => {
          const response = await node.transport(method, params);
          if (method === 'eth_sendRawTransaction') {
            const transaction = node.sent.transactions[0];
            assert.ok(transaction !== undefined);
            node.setReceipt(transaction.hash, {
              transactionHash: transaction.hash,
              blockNumber: HEAD - 5,
              blockHash: blockAt(HEAD - 5).hash,
              status: 'success',
            });
          }
          if (method === 'eth_blockNumber') {
            pollingResolve();
          }
          return response;
        },
      },
    ]),
  };
  const guardian = new Guardian(setup);
  Object.assign(setup, { txConfirmationBlocks: 1 });
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  const screened = await guardian.screenWork(
    await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan)),
  );
  const submitting = guardian.signalAndHeartbeat(screened);
  assert.equal(await Promise.race([polling.then(() => 'waiting'), submitting.then(() => 'finished')]), 'waiting');
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  node.advanceTo(HEAD + 6);
  context.mock.timers.tick(4_000);
  assert.equal((await submitting).kind, 'attested');
});

for (const [chainId, slotSeconds, expectedFrom] of [
  [560048, 12, 99600],
  [31337, 13, 103476],
] as const) {
  test(`chain ${chainId} derives a rounded-up seven-day window from ${slotSeconds}-second slots`, async () => {
    const node = fakeNode({ head: HEAD, chainId, guardianAddedAt: 150000 });
    const setup = configuration();
    const guardian = new Guardian({
      ...setup,
      deployment: { ...setup.deployment, chainId, slotSeconds },
      client: signingClient([{ node: node.transport }]),
    });
    const plan = await guardian.buildScanPlan();
    assert.equal(plan.kind, 'plan');
    assert.equal(plan.discoveryRange.from.number, expectedFrom);
  });
}

test('a caller cannot supply an activation lookback in blocks', () => {
  assert.throws(() => new Guardian(Object.assign(configuration(), { activationLookbackBlocks: 10 })), {
    name: 'TypeError',
    message: 'The activation lookback is fixed at seven days',
  });
});

test('the RPC client validates the range limit before any request', () => {
  const request = () => Promise.reject(new Error('No RPC expected'));
  for (const value of [NaN, Infinity, -Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined, '12']) {
    assert.throws(
      () => new BaseRpcProvider(Object.assign({ request, maxLogBlockRange: 1 }, { maxLogBlockRange: value })),
      RangeError,
    );
  }
  for (const maxLogBlockRange of [1, Number.MAX_SAFE_INTEGER]) {
    assert.doesNotThrow(() => new BaseRpcProvider({ request: rpcRequest(request), maxLogBlockRange }));
  }
});

for (const field of [
  'reportBlockLag',
  'flaggerReadConcurrency',
  'interBatchConfirmationBlocks',
  'confirmationPollIntervalMs',
]) {
  test(`optional ${field} defaults only when omitted and rejects malformed values`, () => {
    const setup = configuration();
    for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '12']) {
      assert.throws(() => new Guardian(withNumber(setup, field, value)), RangeError);
    }
    assert.doesNotThrow(() => new Guardian(withNumber(setup, field, undefined)));
  });
}

test('report lag and heartbeat reserve must fit together in the blockhash window', () => {
  for (const reportBlockLag of [1, 12, 255]) {
    const setup = { ...configuration(), reportBlockLag, heartbeatReserveBlocks: 256 - reportBlockLag };
    assert.doesNotThrow(() => new Guardian(setup));
    assert.throws(
      () => new Guardian({ ...setup, heartbeatReserveBlocks: setup.heartbeatReserveBlocks + 1 }),
      RangeError,
    );
  }
  assert.throws(() => new Guardian({ ...configuration(), confirmationPollIntervalMs: 2_147_483_648 }), RangeError);
});

test('the configured report lag selects a stable block even after caller setup changes', async () => {
  const node = fakeNode({ head: HEAD, guardianAddedAt: 150_000 });
  const setup = { ...configuration(), reportBlockLag: 7, client: signingClient([{ node: node.transport }]) };
  const guardian = new Guardian(setup);
  setup.reportBlockLag = 1;
  const plan = await guardian.buildScanPlan();
  assert.equal(plan.kind, 'plan');
  assert.deepEqual(plan.discoveryRange.to, blockAt(HEAD - 7));
});
