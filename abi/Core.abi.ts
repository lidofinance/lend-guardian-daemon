// Contract ABI fragments checked against the pinned fixture ABI subsets in tests/conformance.

import { encodeEventTopics, getAbiItem, parseAbi } from 'viem';

/** Lending core: the market controller and the supply anchor. */
export const CORE_ABI = parseAbi([
  'function marketController(bytes32) view returns (address)',
  'event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)',
]);

/** The core event and topics queried across the discovery window. */
export const SUPPLY_COLLATERAL_ABI = [getAbiItem({ abi: CORE_ABI, name: 'SupplyCollateral' })] as const;

export const SUPPLY_COLLATERAL_TOPICS = encodeEventTopics({
  abi: SUPPLY_COLLATERAL_ABI,
  eventName: 'SupplyCollateral',
});
