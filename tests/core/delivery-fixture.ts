// Test fixture for isolated registry encoding and generic delivery. Full report sequencing and
// `report.confirmed` events are exercised through Guardian in transaction-events.test.ts.
import assert from 'node:assert/strict';
import { parseAbi } from 'viem';
import { GuardianSignals } from '../../src/contracts/guardian-signals.ts';
import { GUARDIAN_SIGNALS_ABI } from '../../abi/GuardianSignals.abi.ts';
import type { ViemRpcClientOptions } from '../../src/chain/viem-client.ts';
import type { SendOptions } from '../../src/chain/rpc.ts';
import { ViemRpcClient } from '../../src/chain/viem-client.ts';
import type {
  BlockRef,
  Bytes32,
  EventHandler,
  SignalTarget,
  ReceiptRef,
  TransactionContext,
  TxHash,
} from '../../src/core/index.ts';
import { REGISTRY, GUARDIAN } from './delivery-fakes.ts';

export const REGISTRY_ERRORS = parseAbi([
  'error InvalidBlockHash()',
  'error HeartbeatTimestampRegressed()',
  'error Unauthorized()',
  'error BlockInTheFuture()',
  'error TimestampInTheFuture()',
]);
export const REGISTRY_WRITES = [...GUARDIAN_SIGNALS_ABI, ...REGISTRY_ERRORS] as const;

interface Delivery {
  sendSuspects(targets: readonly SignalTarget[], depth: number): Promise<ReceiptRef[]>;
  sendFlags(targets: readonly SignalTarget[], depth: number): Promise<ReceiptRef[]>;
  sendHeartbeat(block: BlockRef, digest: Bytes32, depth: number): Promise<TxHash>;
}

export function registryDelivery(options: ViemRpcClientOptions, observe: EventHandler, timeoutMs = 10000): Delivery {
  const client = new ViemRpcClient({
    ...options,
    onEvent: observe,
    transactionPolicy: { ...options.transactionPolicy, sendTimeoutMs: timeoutMs },
  });
  const registry = new GuardianSignals({
    client,
    chainId: 1,
    deployment: { address: REGISTRY, deploymentBlock: 0 },
    guardian: GUARDIAN,
  });
  const sendOptions = (context: TransactionContext, confirmations: number): SendOptions => ({
    confirmations,
    context,
  });
  const report = async (method: 'suspect' | 'flag', targets: readonly SignalTarget[], depth: number) => {
    assert.equal(targets.length, 1, 'Batch scenarios must run through Guardian');
    const target = targets[0];
    assert.ok(target !== undefined);
    return [
      await registry[method](
        target.marketId,
        [target.borrower],
        sendOptions(
          { operationId: `${method}-fixture`, method, marketId: target.marketId, accounts: [target.borrower] },
          depth,
        ),
      ),
    ];
  };
  return {
    sendSuspects: (targets: readonly SignalTarget[], depth: number) => report('suspect', targets, depth),
    sendFlags: (targets: readonly SignalTarget[], depth: number) => report('flag', targets, depth),
    sendHeartbeat: async (block: BlockRef, digest: Bytes32, depth: number) =>
      (
        await registry.heartbeat(
          block,
          digest,
          sendOptions(
            { operationId: 'heartbeat-fixture', method: 'heartbeat', reportBlock: block, coverageDigest: digest },
            depth,
          ),
        )
      ).transactionHash,
  };
}
