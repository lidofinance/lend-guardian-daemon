// The coverage digest: a heartbeat's commitment to the work set the cycle reconstructed.
//
// It covers every anchor, including those withheld from a provider because this Guardian had
// already flagged their target, because what it attests is the set of work found, not the set of
// work paid for. Anchor hashes are sorted so that the same set and bounds commit the same value
// whatever order the walk found them in, and the domain separator keeps this commitment from
// being read as any other use of the same fields.

import { encodeAbiParameters, keccak256, zeroHash } from 'viem';
import type { SupplyAnchor } from './types.ts';
import type { Address, Bytes32 } from '../common/types.ts';

/** `keccak256("LIDO_LEND_GUARDIAN_COVERAGE_V1")`, reproducible with `cast keccak`. */
const DOMAIN: Bytes32 = '0x558aac1e21a17e1d406d2adb36f4a87b153cb105c499803a1bf8b0c029579ed5';

/** What the digest binds the work set to, so a commitment cannot be replayed under other terms. */
export interface CoverageBounds {
  readonly chainId: number;
  readonly core: Address;
  readonly registry: Address;
  readonly guardian: Address;
  /** The block a previous heartbeat covered, or zero before the first one. */
  readonly previousBlockHash: Bytes32 | null;
  readonly reportBlockHash: Bytes32;
}

function anchorHash(anchor: SupplyAnchor): Bytes32 {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'address' },
      ],
      [
        anchor.core,
        anchor.blockHash,
        anchor.transactionHash,
        BigInt(anchor.logIndex),
        anchor.marketId,
        anchor.borrower,
      ],
    ),
  );
}

/**
 * Commit the complete work set under the [heartbeat requirements](../../docs/guardian-specification.md#heartbeat-requirements).
 * The domain, ABI field order and sorted anchor hashes follow the binding encoding in
 * [Appendix D](../../docs/guardian-specification.md#d-submit-signals-and-send-the-heartbeat).
 */
export function coverageDigest(anchors: readonly SupplyAnchor[], bounds: CoverageBounds): Bytes32 {
  const hashes = anchors.map(anchorHash).sort(compareHashes);

  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32[]' },
      ],
      [
        DOMAIN,
        BigInt(bounds.chainId),
        bounds.core,
        bounds.registry,
        bounds.guardian,
        bounds.previousBlockHash ?? zeroHash,
        bounds.reportBlockHash,
        hashes,
      ],
    ),
  );
}

function compareHashes(left: Bytes32, right: Bytes32): number {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  if (leftNumber === rightNumber) {
    return 0;
  }
  return leftNumber < rightNumber ? -1 : 1;
}
