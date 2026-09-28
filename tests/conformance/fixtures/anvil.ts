// Local chain fixture for portable contract conformance. It never connects to an external RPC.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, createTestClient, defineChain, http, isHex } from 'viem';
import type { Abi, Chain, Hex } from 'viem';
import { isRecord } from '../../../src/common/validation.ts';

export type ArtifactName =
  | 'GuardianSignals.json'
  | 'Core.json'
  | 'MarketController.json'
  | 'MockERC20.json'
  | 'MockPriceOracle.json'
  | 'OssifiableProxy.json';

export interface ContractArtifact {
  readonly abi: Abi;
  readonly bytecode: Hex;
}

export interface AnvilFixture {
  readonly chain: Chain;
  readonly publicClient: ReturnType<typeof createPublicClient>;
  readonly testClient: ReturnType<typeof createTestClient>;
  readonly rpcUrl: string;
  stop(): void;
}

/** Read one hash-pinned normalized contract artifact. */
export function readArtifact(name: ArtifactName): ContractArtifact {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`./contracts/${name}`, import.meta.url), 'utf8'));
  if (!isRecord(parsed) || !isAbi(parsed.abi)) {
    throw new Error(`${name} does not contain a valid ABI`);
  }
  if (!isHex(parsed.bytecode, { strict: true })) {
    throw new Error(`${name} does not contain hex creation bytecode`);
  }

  return { abi: parsed.abi, bytecode: parsed.bytecode };
}

/** Start an isolated Anvil chain and stop it if readiness cannot be established. */
export async function startAnvil(port: number): Promise<AnvilFixture> {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = localChain(rpcUrl);
  const executable = process.env.ANVIL_BIN ?? 'anvil';
  const child = spawn(
    executable,
    ['--port', String(port), '--chain-id', '1', '--code-size-limit', '30000', '--silent'],
    { stdio: 'ignore' },
  );

  try {
    await once(child, 'spawn');
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
    const testClient = createTestClient({ chain, mode: 'anvil', transport: http(rpcUrl) });
    await waitUntilReady(publicClient);

    return {
      chain,
      publicClient,
      testClient,
      rpcUrl,
      stop: () => {
        child.kill();
      },
    };
  } catch (error) {
    child.kill();
    throw new Error(`Anvil did not start on port ${port}`, { cause: error });
  }
}

function localChain(rpcUrl: string): Chain {
  return defineChain({
    id: 1,
    name: 'local-mainnet-profile',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function waitUntilReady(publicClient: ReturnType<typeof createPublicClient>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await publicClient.getChainId();
      return;
    } catch {
      // Readiness polling expects connection failures until Anvil opens its local socket.
      await sleep(100);
    }
  }
  throw new Error('Anvil readiness deadline expired');
}

function isAbi(value: unknown): value is Abi {
  return Array.isArray(value) && value.every(isAbiItem);
}

function isAbiItem(value: unknown): value is Abi[number] {
  return isRecord(value) && typeof value.type === 'string';
}
