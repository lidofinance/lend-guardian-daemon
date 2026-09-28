import type { Address, BlockRef, Bytes32, MarketId, TxHash } from './common/types.ts';

export type ReportContext =
  | {
      readonly method: 'suspect' | 'flag';
      readonly marketId: MarketId;
      readonly accounts: readonly Address[];
    }
  | {
      readonly method: 'heartbeat';
      readonly reportBlock: BlockRef;
      readonly coverageDigest: Bytes32;
    };

/** Immutable correlation data passed through the contract and RPC layers for one report. */
export type OperationContext = ReportContext & { readonly operationId: string };

export type TransactionContext = OperationContext | { readonly operationId: string; readonly method: 'cancel' };

export type TransactionStage = 'preparation' | 'signing' | 'broadcast' | 'confirmation' | 'nonce-clearing';

/** Facts emitted by the signing client; phase timestamps are Unix milliseconds on the process's monotonic timeline. */
export type TransactionDeliveryEvent =
  | {
      readonly event: 'transaction.preparation' | 'transaction.signing';
      /** Preparation attempt, including estimates above the fee cap. */
      readonly attempt: number;
      readonly startedAt: number;
      readonly finishedAt: number;
    }
  | {
      readonly event: 'transaction.broadcast';
      readonly nonce: number;
      readonly transactionHash: TxHash;
      readonly attempt: number;
      readonly startedAt: number;
      readonly finishedAt: number;
    }
  | {
      /** First observed inclusion; this is not full-depth canonical confirmation. */
      readonly event: 'transaction.included';
      readonly transactionHash: TxHash;
      readonly receiptBlockHash: Bytes32;
      readonly receiptStatus: 'success' | 'reverted';
      /** Time since the first successful broadcast response, including replacement waits. */
      readonly durationMs: number;
    }
  | {
      readonly event: 'transaction.replaced';
      readonly nonce: number;
      readonly replacedHash: TxHash;
      readonly replacementHash: TxHash;
      readonly replacementAttempt: number;
    }
  | {
      readonly event: 'transaction.retry';
      readonly nonce: number;
      readonly attempt: number;
      readonly error: unknown;
    }
  | {
      readonly event: 'transaction.failed';
      readonly stage: TransactionStage;
      readonly reason?: string;
      readonly error?: unknown;
      readonly receiptStatus?: 'reverted';
      readonly receiptBlockHash?: Bytes32;
    };

/** All SDK event names and their payloads. A receipt inclusion is not a confirmed report. */
export type SdkEvent =
  | (TransactionDeliveryEvent & { readonly context?: TransactionContext | undefined })
  | RpcEvent
  | {
      readonly event: 'nonce.cleared';
      readonly context: TransactionContext;
      readonly nonce: number;
      readonly blockNumber: bigint;
      readonly blockHash: Bytes32;
    }
  | {
      readonly event: 'report.started';
      readonly context: OperationContext;
    }
  | {
      readonly event: 'report.confirmed';
      readonly context: OperationContext;
      readonly transactionHash: TxHash;
      readonly receiptStatus: 'success';
      readonly receiptBlockHash: Bytes32;
    };

export type EventHandler = (event: SdkEvent) => void;

/** Notify an optional observer without allowing diagnostics to change SDK behavior. */
export function emitEvent(handler: EventHandler | undefined, event: SdkEvent): void {
  try {
    handler?.(event);
  } catch {
    // An observer failure must not change the operation being observed.
  }
}

/** One physical HTTP attempt, including attempts made by viem retries or failover. */
export interface RpcRequestStartedEvent {
  readonly event: 'rpc.requestStarted';
  readonly method: string;
  readonly rpcIndex: number;
  readonly startedAt: number;
}

export interface RpcRequestFinishedEvent extends Omit<RpcRequestStartedEvent, 'event'> {
  readonly event: 'rpc.requestFinished';
  readonly finishedAt: number;
  readonly httpStatus: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly error?: unknown;
}

export type RpcEvent = RpcRequestStartedEvent | RpcRequestFinishedEvent;
