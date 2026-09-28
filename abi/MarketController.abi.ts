// Contract ABI fragments checked against the pinned fixture ABI subsets in tests/conformance.

import { parseAbi } from 'viem';

/** Market controller: its registry and the four position lifecycle events. */
export const MARKET_CONTROLLER_ABI = parseAbi([
  'struct Position { uint128 dust; uint128 activating; uint40 activatingStart; uint32 activatingDelay; }',
  'function guardianSignals() view returns (address)',
  'event CollateralActivated(address indexed borrower, uint256 amount, Position position)',
  'event CollateralActivating(address indexed borrower, uint256 amount, Position position)',
  'event CollateralDrained(address indexed borrower, uint256 amount, Position position)',
  'event CollateralDusted(address indexed borrower, uint256 amount, Position position)',
]);
