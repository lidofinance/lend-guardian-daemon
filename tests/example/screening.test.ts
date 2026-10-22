import test from 'node:test';
import assert from 'node:assert/strict';
import { padHex } from 'viem';
import { UnconfiguredScreening } from '../../example/screening.ts';
import type { SupplyAnchor } from '../../src/core/types.ts';
import type { ScreeningRequest } from '../../src/core/screening-provider.ts';
import type { TxHash } from '../../src/common/types.ts';

test('unconfigured screening leaves every requested anchor incomplete', async () => {
  const provider = new UnconfiguredScreening();
  const results = await provider.screen(
    request([anchor(padHex('0xb', { size: 32 }), 1), anchor(padHex('0xa', { size: 32 }), 2)]),
  );
  assert.deepEqual(results, [{ status: 'incomplete' }, { status: 'incomplete' }]);
  assert.deepEqual(await provider.screen(request([])), []);
});

function anchor(transactionHash: TxHash, logIndex: number): SupplyAnchor {
  return {
    core: '0x00000000000000000000000000000000000000bb',
    blockHash: padHex('0x9', { size: 32 }),
    transactionHash,
    logIndex,
    marketId: padHex('0x1', { size: 32 }),
    borrower: '0x00000000000000000000000000000000000000ee',
  };
}

function request(anchors: readonly SupplyAnchor[]): ScreeningRequest {
  return {
    chainId: 1,
    reportBlock: { number: 100, hash: padHex('0x64', { size: 32 }), timestamp: 1_700_000_000 },
    anchors,
  };
}
