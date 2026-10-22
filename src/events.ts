import type { Address, BlockRef, Bytes32, MarketId, TxHash } from './common/types.ts';
import type { CycleOutcome, NothingDue, ScanPlan, ScreenedAnchor, SkippedTarget } from './core/outcomes.ts';
import type { PositionKey, SignalTarget, SupplyAnchor } from './core/types.ts';

/** Correlation data shared by every event emitted during one Guardian cycle. */
export interface CycleContext {
  readonly cycleId: string;
}

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
export type OperationContext = ReportContext & { readonly operationId: string; readonly cycleId?: string };

export type TransactionContext =
  | OperationContext
  | { readonly operationId: string; readonly method: 'cancel'; readonly cycleId?: string };

export type TransactionStage = 'preparation' | 'signing' | 'broadcast' | 'confirmation' | 'nonce-clearing';

/**
 * Delivery facts: the signing client emits them for its sends, Guardian for nonce clearing; phase
 * timestamps are Unix milliseconds on the process's monotonic timeline.
 */
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

/** Phase evidence and the terminal result of one call to `Guardian.cycle`. */
export type CycleEvent = CycleContext &
  (
    | {
        readonly event: 'cycle.started';
        readonly startedAt: number;
      }
    | {
        readonly event: 'cycle.planned';
        readonly result: ScanPlan | NothingDue;
      }
    | {
        readonly event: 'cycle.discovered';
        readonly reportBlock: BlockRef;
        readonly positions: readonly PositionKey[];
      }
    | {
        readonly event: 'cycle.reconstructed';
        readonly reportBlock: BlockRef;
        readonly positions: number;
        readonly anchors: readonly SupplyAnchor[];
      }
    | {
        readonly event: 'cycle.screened';
        readonly reportBlock: BlockRef;
        readonly results: readonly ScreenedAnchor[];
        readonly skipped: readonly SkippedTarget[];
        readonly suspects: readonly SignalTarget[];
        readonly flags: readonly SignalTarget[];
      }
    | {
        readonly event: 'cycle.finished';
        readonly startedAt: number;
        readonly finishedAt: number;
        readonly outcome: CycleOutcome;
      }
    | {
        readonly event: 'cycle.failed';
        readonly startedAt: number;
        readonly finishedAt: number;
        readonly error: unknown;
      }
  );

/** All SDK event names and their payloads. A receipt inclusion is not a confirmed report. */
export type SdkEvent =
  | (TransactionDeliveryEvent & { readonly context?: TransactionContext | undefined })
  | CycleEvent
  | RpcEvent
  | {
      /** The signer's transaction counts a clearing decision was made by, as the answering node reported them. */
      readonly event: 'nonce.checked';
      readonly context: TransactionContext;
      readonly latest: number;
      readonly pending: number;
    }
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
    }
  | {
      /** A suspect this Guardian recorded since the previous heartbeat, kept instead of sent again. */
      readonly event: 'report.skipped';
      readonly cycleId?: string;
      readonly method: 'suspect';
      readonly target: SignalTarget;
      readonly recordedAt: number;
    };

/**
 * The SDK neither awaits a handler nor uses its result, and a thrown error or a rejected promise
 * does not change the operation being observed. A client that calls the handler itself provides
 * the same isolation.
 */
export type EventHandler = (event: SdkEvent) => unknown;

/** Notify an optional observer without allowing diagnostics to change SDK behavior. */
export function emitEvent(handler: EventHandler | undefined, event: SdkEvent): void {
  try {
    void Promise.resolve(handler?.(event)).catch(() => {
      // An asynchronous observer failure must not change the operation being observed.
    });
  } catch {
    // A synchronous observer failure must not change the operation being observed.
  }
}

/** One physical HTTP attempt, including attempts made by viem retries or failover. */
export interface RpcRequestStartedEvent {
  readonly event: 'rpc.requestStarted';
  /** Monotonic within one RPC endpoint; pair with rpcIndex. */
  readonly requestId: number;
  readonly method: string;
  /** A frozen copy of the parameters sent; absent when the request has none. */
  readonly params?: unknown;
  readonly rpcIndex: number;
  readonly startedAt: number;
}

export interface RpcRequestFinishedEvent extends Omit<RpcRequestStartedEvent, 'event'> {
  readonly event: 'rpc.requestFinished';
  readonly finishedAt: number;
  readonly httpStatus: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  /**
   * The error this attempt failed with, which may differ from the error the caller receives; it names
   * the endpoint URL and the request, unlike `rpcIndex`.
   */
  readonly error?: unknown;
  /** The response's `Retry-After` as passed to viem: whole seconds in milliseconds, bounded by the transport's `timeoutMs`. */
  readonly retryAfterMs?: number;
}

/** Providers returned different logs for one read; indexes are positions in the configured URLs. */
export interface RpcAnswersDifferEvent {
  readonly event: 'rpc.answersDiffer';
  readonly method: string;
  /** Providers whose answer was returned; empty when the read was rejected. */
  readonly acceptedRpcIndexes: readonly number[];
  /** Providers that returned other logs. */
  readonly otherRpcIndexes: readonly number[];
}

export type RpcEvent = RpcRequestStartedEvent | RpcRequestFinishedEvent | RpcAnswersDifferEvent;
