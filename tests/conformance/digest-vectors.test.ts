// Cast-derived vectors are data fixtures so an external reviewer can recompute them independently.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isAddress, isHex, size } from 'viem';
import { coverageDigest } from '../../src/core/digest.ts';
import type { CoverageBounds } from '../../src/core/digest.ts';
import type { SupplyAnchor } from '../../src/core/types.ts';
import type { Address, Bytes32 } from '../../src/common/types.ts';
import { isRecord } from '../../src/common/validation.ts';

test('matches every independent coverage-digest vector', () => {
  const document = objectOf(
    JSON.parse(readFileSync(new URL('./fixtures/digest-vectors.json', import.meta.url), 'utf8')),
    'document',
  );
  const vectors = arrayOf(document.vectors, 'vectors');
  assert.equal(vectors.length, 2);
  for (const entry of vectors) {
    const vector = objectOf(entry, 'vector');
    const anchors = arrayOf(vector.anchors, 'anchors').map(anchorOf);
    const bounds = boundsOf(objectOf(vector.bounds, 'bounds'));
    assert.equal(coverageDigest(anchors, bounds), bytes32Of(vector.expectedDigest, 'digest'));
    assert.equal(arrayOf(vector.anchorHashes, 'anchor hashes').length, anchors.length);
  }
});

test('the multiple-anchor vector is insensitive to discovery order', () => {
  const vector = vectorAt(1);
  const anchors = arrayOf(vector.anchors, 'anchors').map(anchorOf);
  const bounds = boundsOf(objectOf(vector.bounds, 'bounds'));
  assert.equal(coverageDigest([...anchors].reverse(), bounds), vector.expectedDigest);
});

function vectorAt(index: number): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(new URL('./fixtures/digest-vectors.json', import.meta.url), 'utf8'));
  const vectors = arrayOf(objectOf(parsed, 'document').vectors, 'vectors');
  return objectOf(vectors[index], `vector ${index}`);
}

function anchorOf(value: unknown): SupplyAnchor {
  const anchor = objectOf(value, 'anchor');
  return {
    core: addressOf(anchor.core, 'anchor core'),
    blockHash: bytes32Of(anchor.blockHash, 'anchor block hash'),
    transactionHash: bytes32Of(anchor.transactionHash, 'anchor transaction hash'),
    logIndex: safeIntegerOf(anchor.logIndex, 'anchor log index'),
    marketId: bytes32Of(anchor.marketId, 'anchor market'),
    borrower: addressOf(anchor.borrower, 'anchor borrower'),
  };
}

function boundsOf(value: Record<string, unknown>): CoverageBounds {
  return {
    chainId: safeIntegerOf(value.chainId, 'chain ID'),
    core: addressOf(value.core, 'core'),
    registry: addressOf(value.registry, 'registry'),
    guardian: addressOf(value.guardian, 'guardian'),
    previousBlockHash:
      value.previousCoverage === null ? null : bytes32Of(value.previousCoverage, 'previous block hash'),
    reportBlockHash: bytes32Of(value.reportBlock, 'report block hash'),
  };
}

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${field} is not an object`);
  }
  return value;
}

function arrayOf(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} is not an array`);
  }
  return value;
}

function addressOf(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: true })) {
    throw new Error(`${field} is not an address`);
  }
  return value;
}

function bytes32Of(value: unknown, field: string): Bytes32 {
  const isBytes32 = typeof value === 'string' && isHex(value, { strict: true });
  if (!isBytes32 || size(value) !== 32) {
    throw new Error(`${field} is not a bytes32 value`);
  }
  return value;
}

function safeIntegerOf(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${field} is not a safe integer`);
  }
  return value;
}
