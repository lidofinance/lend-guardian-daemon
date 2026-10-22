// The public surface of the Guardian core, in the order the phases run.

export { Guardian } from './guardian.ts';
export type { Deployment, GuardianSetup } from './guardian.ts';
export type {
  Attested,
  BlockRange,
  CycleOutcome,
  Discovered,
  Incomplete,
  NothingDue,
  NothingDueReason,
  Observed,
  ScanPlan,
  Screened,
  ScreenedAnchor,
  SkippedTarget,
  Stale,
  StaleReason,
  Work,
} from './outcomes.ts';
export type { PositionKey, SignalTarget, SupplyAnchor } from './types.ts';
export type { ScreeningProvider, ScreeningRequest, ScreeningResult } from './screening-provider.ts';
export { GuardianStop } from './stop.ts';
export type { StopReason } from './stop.ts';
export type { RpcRequest } from '../chain/rpc.ts';
export type { Address, BlockRef, Bytes32, ContractDeployment, Hex, MarketId, TxHash } from '../common/types.ts';

export type { RpcProvider, RpcClient, ReceiptRef, TransactionRequest, SendOptions } from '../chain/rpc.ts';
export { BroadcastFailure } from '../chain/rpc.ts';

export { BaseRpcProvider } from '../chain/base-rpc-provider.ts';
export type { BaseRpcProviderOptions } from '../chain/base-rpc-provider.ts';
export type { ChainLog, ChainTransaction, LogFilter, TransactionReceipt } from '../chain/rpc.ts';

export type {
  CycleContext,
  CycleEvent,
  EventHandler,
  SdkEvent,
  OperationContext,
  ReportContext,
  TransactionDeliveryEvent,
} from '../events.ts';

export type {
  TransactionContext,
  RpcEvent,
  RpcRequestStartedEvent,
  RpcRequestFinishedEvent,
  RpcAnswersDifferEvent,
} from '../events.ts';

export type { TransactionPolicy, PreparedTransaction, TransactionAttempt } from '../chain/rpc.ts';
