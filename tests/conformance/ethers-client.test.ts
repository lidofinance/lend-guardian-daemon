// The same Guardian phases over ethers JSON-RPC and signing, with no viem client in the read path.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JsonRpcProvider, Wallet } from 'ethers';
import { isAddress, isHex, zeroHash } from 'viem';
import { BaseRpcProvider, Guardian } from '../../src/core/index.ts';
import type {
  Address,
  EventHandler,
  Hex,
  PreparedTransaction,
  ReceiptRef,
  RpcClient,
  SdkEvent,
  SendOptions,
  TransactionAttempt,
  TransactionPolicy,
  TransactionRequest,
  TxHash,
} from '../../src/core/index.ts';
import { DELEGATE_KEY, deployProtocolFixture } from './fixtures/protocol.ts';

const deployed = deployProtocolFixture(8624);
after(async () => {
  (await deployed).anvil.stop();
});

/** Test-only delivery policy: one broadcast, no replacements; chain reads are inherited. */
class EthersRpcClient extends BaseRpcProvider implements RpcClient {
  readonly signer: Address;
  readonly transactionPolicy: TransactionPolicy;
  readonly #wallet: Wallet;
  readonly #sendTimeoutMs: number;
  readonly #onEvent: EventHandler | undefined;

  constructor(provider: JsonRpcProvider, wallet: Wallet, sendTimeoutMs: number, onEvent?: EventHandler) {
    super({ request: ({ method, params }) => provider.send(method, params ?? []), maxLogBlockRange: 2 });
    assert.ok(isAddress(wallet.address));
    this.signer = wallet.address;
    this.#wallet = wallet;
    this.#sendTimeoutMs = sendTimeoutMs;
    this.#onEvent = onEvent;
    this.transactionPolicy = {
      maxFeePerGas: 100_000_000_000n,
      sendTimeoutMs,
      replacementFeeBumpBps: 1_000,
      replacementTimeoutMs: sendTimeoutMs,
      sendAttempts: 1,
    };
  }

  prepareTransaction(_transaction: TransactionRequest, _options: TransactionAttempt): Promise<PreparedTransaction> {
    return Promise.reject(new Error('The ethers conformance client implements send directly'));
  }

  broadcastTransaction(_transaction: PreparedTransaction, _options: TransactionAttempt): Promise<TxHash> {
    return Promise.reject(new Error('The ethers conformance client implements send directly'));
  }

  async send(transaction: TransactionRequest, options: SendOptions): Promise<ReceiptRef> {
    const sent = await this.#wallet.sendTransaction(transaction);
    this.#onEvent?.({
      event: 'transaction.broadcast',
      context: options.context,
      transactionHash: hex(sent.hash),
      nonce: sent.nonce,
      attempt: 1,
      startedAt: 0,
      finishedAt: 0,
    });
    const receipt = await sent.wait(options.confirmations, this.#sendTimeoutMs);
    assert.ok(receipt !== null);
    assert.equal(receipt.status, 1);
    return {
      transactionHash: hex(receipt.hash),
      blockHash: hex(receipt.blockHash),
      blockNumber: receipt.blockNumber,
    };
  }
}

function hex(value: string): Hex {
  assert.ok(isHex(value, { strict: true }));
  return value;
}

test('ethers request and signing run discovery, reconstruction, screening, reports and heartbeat', async () => {
  const fixture = await deployed;
  await fixture.setDelegate();
  const supply = await fixture.primaryMarket.supply(100n);
  await fixture.anvil.testClient.mine({ blocks: 4, interval: 4000 });
  const provider = new JsonRpcProvider(fixture.anvil.rpcUrl, 1, {
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
  try {
    const events: SdkEvent[] = [];
    const onEvent: EventHandler = (event) => events.push(event);
    const client = new EthersRpcClient(provider, new Wallet(DELEGATE_KEY, provider), 132_000, onEvent);
    assert.equal(await client.getChainId(), 1);
    assert.equal(await client.getReceipt(zeroHash), null);
    const guardian = new Guardian({
      deployment: {
        chainId: 1,
        slotSeconds: 12,
        lidoLend: { address: fixture.core, deploymentBlock: 0 },
        guardianSignals: { address: fixture.guardianSignals, deploymentBlock: 0 },
      },
      guardian: fixture.admin.address,
      expectedDelegate: fixture.delegate.address,
      client,
      screening: {
        screen: (request) => {
          assert.deepEqual(
            request.anchors.map((anchor) => anchor.transactionHash),
            [supply.transactionHash],
          );
          return Promise.resolve(
            request.anchors.map(() => ({ status: 'judged', requiresSuspect: true, requiresFlag: true }) as const),
          );
        },
      },
      maxSignalBatchSize: 20,
      idleHeartbeatInterval: 1,
      heartbeatReserveBlocks: 8,
      txConfirmationBlocks: 1,
      onEvent,
    });
    const plan = await guardian.buildScanPlan();
    assert.equal(plan.kind, 'plan');
    const work = await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan));
    const outcome = await guardian.signalAndHeartbeat(await guardian.screenWork(work));
    assert.equal(outcome.kind, 'attested');
    assert.deepEqual(
      events.filter((event) => event.event === 'report.confirmed').map((event) => event.context.method),
      ['suspect', 'flag', 'heartbeat'],
    );
    const receipt = await client.getReceipt(outcome.heartbeat);
    assert.ok(receipt !== null);
    assert.equal(await client.isConfirmed(receipt, await client.getBlock(), 1), true);
  } finally {
    provider.destroy();
  }
});
