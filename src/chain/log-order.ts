// A node returns the logs of one query in whatever order its transport produced them, so a search
// that takes the newest or the oldest log sorts them first.

/** Where a log sits in the chain. */
export interface LogPosition {
  readonly blockNumber: bigint;
  readonly transactionIndex: number;
  readonly logIndex: number;
}

/** Orders logs oldest first: by block, then by transaction in the block, then by log in the receipt. */
export function byLogPosition(left: LogPosition, right: LogPosition): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }

  return left.logIndex - right.logIndex;
}
