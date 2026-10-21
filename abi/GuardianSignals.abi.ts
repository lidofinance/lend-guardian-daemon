// Contract ABI fragments checked against the pinned fixture ABI subsets in tests/conformance.

import { parseAbi } from 'viem';

/** GuardianSignals: membership, delegation, coverage, flags and suspects. */
export const GUARDIAN_SIGNALS_ABI = parseAbi([
  'struct BlockInfoWithHash { bytes32 hash; uint40 number; uint40 timestamp; }',
  'function flag(bytes32 marketId, address onBehalf, address[] accounts)',
  'function heartbeat(address onBehalf, BlockInfoWithHash lastScannedBlock, bytes data)',
  'function suspect(bytes32 marketId, address onBehalf, address[] accounts)',
  'function getDelegate(address guardian) view returns (address)',
  'function getFlaggedBy(bytes32 marketId, address account) view returns (address[])',
  'function getHeartbeat(address guardian) view returns (uint40 timestamp)',
  'function getSuspectWindow() view returns (uint256)',
  'function getSuspectedBy(bytes32 marketId, address account) view returns (address[] guardians, uint40[] reportedAt)',
  'function isGuardian(address account) view returns (bool)',
  'event GuardianAdded(address indexed guardian)',
  'event Heartbeat(address indexed guardian, uint256 blockNumber, uint256 timestamp, bytes data)',
]);
