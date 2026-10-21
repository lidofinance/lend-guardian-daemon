// Position identities, report targets and supply anchors shared across Guardian phases.

import type { Address, Bytes32, MarketId, TxHash } from '../common/types.ts';

/**
 * One borrower in one market: the unit both registry write methods take. It is not a `PositionKey`
 * because the controller a position is read through is not part of a registry report.
 */
export interface SignalTarget {
  readonly marketId: MarketId;
  readonly borrower: Address;
}

/** One borrower's delayed collateral in one market. The controller is where its events are read. */
export interface PositionKey {
  readonly controller: Address;
  readonly marketId: MarketId;
  readonly borrower: Address;
}

/** Where a controller logged a position's newest event through the report block. */
export interface LifecycleEventRef {
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly blockHash: Bytes32;
}

/** A candidate position with the newest event discovery read for it, which reconstruction must find first. */
export interface DiscoveredPosition {
  readonly position: PositionKey;
  readonly newestEvent: LifecycleEventRef;
}

/**
 * One supply to screen. `transactionHash` and `logIndex` identify it, and `blockHash` ties that
 * identity to a chain state, so a reorged anchor is not silently the same anchor. `borrower` names
 * the position the supply credits, and a payer screener asks about it only when it paid. `marketId`
 * and `core` are what a payer resolver needs to find the market's collateral token. Every field is
 * committed to the coverage digest.
 */
export interface SupplyAnchor {
  readonly core: Address;
  readonly blockHash: Bytes32;
  readonly transactionHash: TxHash;
  readonly logIndex: number;
  readonly marketId: MarketId;
  readonly borrower: Address;
}
