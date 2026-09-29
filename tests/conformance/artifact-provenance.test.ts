// Fixture ABIs are trimmed; production creation bytecode remains pinned to the approved baseline.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Abi, AbiParameter } from 'viem';
import { MARKET_CONTROLLER_ABI } from '../../abi/MarketController.abi.ts';
import { CORE_ABI } from '../../abi/Core.abi.ts';
import { GUARDIAN_SIGNALS_ABI } from '../../abi/GuardianSignals.abi.ts';
import { isRecord } from '../../src/common/validation.ts';
import { readArtifact } from './fixtures/anvil.ts';
import type { ArtifactName } from './fixtures/anvil.ts';

const ARTIFACT_HASHES: Readonly<Record<ArtifactName, { readonly sha256: string; readonly bytecodeSha256: string }>> = {
  'GuardianSignals.json': {
    sha256: '4ba561ef0a1d7dd38db1c0a7f8b7cf7fd58f21b9ed73847ad604209618da2950',
    bytecodeSha256: '0304f4faa89addfbd8b7a2c7da4d34b5e2f42a652087adc4262a2f7e0304a88c',
  },
  'OssifiableProxy.json': {
    sha256: '572d3442ca5749d37454fb80aefb8af7d63654a6aeafacbd9e6d446b00feec8b',
    bytecodeSha256: '5618732d389b8c746134b41da82f679335584c18372d533109f10490e4477e19',
  },
  'Core.json': {
    sha256: '5b7007b7556dabd60e4ff5b40be00f3e8066467e9d544aafe2571eee449b819b',
    bytecodeSha256: '8f042a44ed49296e547c8e4b386f6dcfbdd4f02c58c28bf16aeeec6f375ef35c',
  },
  'MarketController.json': {
    sha256: 'f72e6f895984bbff0a77ee3fc09ddbd962937c4114df5a45304e2ab048ac285b',
    bytecodeSha256: '58a12440a63d8a40663568b1117bd159bc3cc9e743280e5a276d6da9b847884f',
  },
  'MockERC20.json': {
    sha256: 'bd83b9b0ea56fdec31f734fffc44b41bb660cfd6399b2c5c45c3d70c8c3be82d',
    bytecodeSha256: 'ef28462f7d098de4820ff10e7c8df944a7f42b6bb6b215a6875e54db733a8432',
  },
  'MockPriceOracle.json': {
    sha256: '45d61d70f91e968729dd3974dde87e140eedd06fe145a4018d637f80b06b9cce',
    bytecodeSha256: 'b09b8647f5a1308e475a551f81c89a2b87dabc567b9b4c9be8b1bd3d5e645494',
  },
};

test('records the approved source revision, build and exact artifact hashes', () => {
  const manifest = objectOf(readJson('upstream-manifest.json'), 'manifest');
  assert.equal(objectOf(manifest.repository, 'repository').revision, 'bdf9e5047525c5b6f7489385fd494d53242db9a3');
  assert.partialDeepStrictEqual(manifest.build, {
    forge: 'forge Version: 1.7.1',
    compiler: '0.8.36+commit.8a079791',
    evmVersion: 'osaka',
    viaIR: false,
    bytecodeHash: 'none',
  });
  const artifacts = objectOf(manifest.artifacts, 'artifacts');
  for (const [name, expected] of Object.entries(ARTIFACT_HASHES)) {
    assert.equal(hash(fixture(name)), expected.sha256, name);
    const artifact = objectOf(readJson(name), name);
    assert.equal(typeof artifact.bytecode, 'string');
    const bytecode = artifact.bytecode;
    assert.ok(typeof bytecode === 'string');
    assert.equal(hash(Buffer.from(bytecode.slice(2), 'hex')), expected.bytecodeSha256, name);
    assert.partialDeepStrictEqual(artifacts[name], expected);
  }
});

test('distinguishes production artifacts from synthetic deployment dependencies', () => {
  const manifest = objectOf(readJson('upstream-manifest.json'), 'manifest');
  const artifacts = objectOf(manifest.artifacts, 'artifacts');
  const classifications = Object.fromEntries(
    Object.entries(artifacts).map(([name, entry]) => [name, objectOf(entry, name).classification]),
  );
  assert.deepEqual(classifications, {
    'GuardianSignals.json': 'production',
    'OssifiableProxy.json': 'production',
    'Core.json': 'production',
    'MarketController.json': 'production',
    'MockERC20.json': 'synthetic-test-dependency',
    'MockPriceOracle.json': 'synthetic-test-dependency',
  });
});

test('preserves every SDK ABI signature, tuple layout, indexed field and mutability', () => {
  const contracts: readonly [ArtifactName, Abi][] = [
    ['GuardianSignals.json', GUARDIAN_SIGNALS_ABI],
    ['Core.json', CORE_ABI],
    ['MarketController.json', MARKET_CONTROLLER_ABI],
  ];
  for (const [name, sdkAbi] of contracts) {
    const approved = readArtifact(name).abi;
    for (const item of sdkAbi) {
      assert.deepEqual(abiLayout(approved.find((candidate) => isSameAbiItem(candidate, item))), abiLayout(item));
    }
  }
});

function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/contracts/${name}`, import.meta.url));
}

function readJson(name: string): unknown {
  return JSON.parse(fixture(name).toString('utf8'));
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${field} is not an object`);
  }
  return value;
}

function isSameAbiItem(left: Abi[number], right: Abi[number]): boolean {
  if (left.type !== right.type) {
    return false;
  }
  const leftName = 'name' in left ? left.name : undefined;
  const rightName = 'name' in right ? right.name : undefined;
  return leftName === rightName;
}

// Compare wire layouts without names/source types; absent indexed/anonymous flags mean false.
function abiLayout(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(abiLayout);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'name' && key !== 'internalType')
        .filter(([key, nested]) => nested !== false || !['indexed', 'anonymous'].includes(key))
        .map(([key, nested]) => [key, abiLayout(nested)]),
    );
  }
  return value;
}

test('fixture ABI parameters contain no variable names or Solidity source type names', () => {
  const artifacts: readonly ArtifactName[] = [
    'Core.json',
    'GuardianSignals.json',
    'MarketController.json',
    'MockERC20.json',
    'MockPriceOracle.json',
    'OssifiableProxy.json',
  ];
  for (const name of artifacts) {
    for (const item of readArtifact(name).abi) {
      if ('inputs' in item) {
        assertUnnamed(item.inputs);
      }
      if ('outputs' in item) {
        assertUnnamed(item.outputs);
      }
    }
  }
});

function assertUnnamed(parameters: readonly AbiParameter[]): void {
  for (const parameter of parameters) {
    assert.equal('name' in parameter, false);
    assert.equal('internalType' in parameter, false);
    if ('components' in parameter) {
      assertUnnamed(parameter.components);
    }
  }
}
