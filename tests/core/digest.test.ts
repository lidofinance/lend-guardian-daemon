// The coverage digest, against values produced by `cast keccak` and `cast abi-encode` over the
// fields the specification lists. An independent monitor recomputes this from chain history, so a
// drift on either side must fail here rather than surface as a false mismatch in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { padHex, zeroHash } from 'viem';
import { coverageDigest } from '../../src/core/digest.ts';
import type { CoverageBounds } from '../../src/core/digest.ts';
import type { SupplyAnchor } from '../../src/core/types.ts';

const CORE = '0x00000000000000000000000000000000000000bb';

const REGISTRY = '0x00000000000000000000000000000000000000aa';

const GUARDIAN = '0x00000000000000000000000000000000000000cc';

const BORROWER = '0x00000000000000000000000000000000000000ee';

const ANCHOR: SupplyAnchor = {
  core: CORE,
  blockHash: padHex('0x9', { size: 32 }),
  transactionHash: padHex('0x7', { size: 32 }),
  logIndex: 5,
  marketId: padHex('0x1', { size: 32 }),
  borrower: BORROWER,
};

const BOUNDS: CoverageBounds = {
  chainId: 1,
  core: CORE,
  registry: REGISTRY,
  guardian: GUARDIAN,
  previousCoverage: null,
  reportBlock: padHex('0xa', { size: 32 }),
};

test('one anchor commits to the value cast computes from the fields the specification lists', () => {
  // cast keccak $(cast abi-encode "f(address,bytes32,bytes32,uint256,bytes32,address)" ...) gives
  // 0x4cb58d72cbf4fdf5828ce8d8865732b70fdb2e173d1ea93b62dea6e65d4419d5 for this anchor, and the
  // outer commitment over it is:
  assert.equal(coverageDigest([ANCHOR], BOUNDS), '0x6d5635fbbb2010c9d99b7edef19500af6d9c91ad77bf3c105cefca8f79969f63');
});

test('the empty work set still commits to its boundaries, and does so deterministically', () => {
  const first = coverageDigest([], BOUNDS);
  assert.equal(first, coverageDigest([], BOUNDS));
  assert.notEqual(first, coverageDigest([ANCHOR], BOUNDS));
});

test('the order anchors were found in does not change the commitment', () => {
  const other: SupplyAnchor = {
    ...ANCHOR,
    logIndex: 9,
    transactionHash: padHex('0x8', { size: 32 }),
  };
  assert.equal(coverageDigest([ANCHOR, other], BOUNDS), coverageDigest([other, ANCHOR], BOUNDS));
});

test('every bound changes the commitment, so none of them can be swapped silently', () => {
  const base = coverageDigest([ANCHOR], BOUNDS);
  const changed: CoverageBounds[] = [
    { ...BOUNDS, chainId: 560_048 },
    { ...BOUNDS, core: REGISTRY },
    { ...BOUNDS, registry: CORE },
    { ...BOUNDS, guardian: BORROWER },
    { ...BOUNDS, previousCoverage: padHex('0xb', { size: 32 }) },
    { ...BOUNDS, reportBlock: padHex('0xc', { size: 32 }) },
  ];
  for (const bounds of changed) {
    assert.notEqual(coverageDigest([ANCHOR], bounds), base);
  }
});

test('every anchor field changes the commitment', () => {
  const base = coverageDigest([ANCHOR], BOUNDS);
  const changed: SupplyAnchor[] = [
    { ...ANCHOR, core: REGISTRY },
    { ...ANCHOR, blockHash: padHex('0xb', { size: 32 }) },
    { ...ANCHOR, transactionHash: padHex('0xb', { size: 32 }) },
    { ...ANCHOR, logIndex: 6 },
    { ...ANCHOR, marketId: padHex('0x2', { size: 32 }) },
    { ...ANCHOR, borrower: GUARDIAN },
  ];
  for (const anchor of changed) {
    assert.notEqual(coverageDigest([anchor], BOUNDS), base);
  }
});

test('an absent previous coverage is the zero word, not an omitted field', () => {
  assert.equal(coverageDigest([ANCHOR], BOUNDS), coverageDigest([ANCHOR], { ...BOUNDS, previousCoverage: zeroHash }));
});
