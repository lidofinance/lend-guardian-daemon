import { ViemRpcClient } from '../../src/chain/viem-client.ts';
import { createPublicClient, createWalletClient, custom, fallback, http, isHex, size } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

import type { EventHandler, Hex, RpcRequest } from '../../src/core/index.ts';
import { GUARDIAN_KEY } from './fake-node.ts';

/** The delivery budget of every client built here, which Guardian also applies to its shared wait. */
export const SEND_TIMEOUT_MS = 264_000;

export function signingClient(
  endpoints: readonly NodeEndpoint[],
  privateKey: Hex = GUARDIAN_KEY,
  maxLogBlockRange = 1_000_000,
  onEvent?: EventHandler,
): ViemRpcClient {
  if (endpoints.length === 0) {
    throw new RangeError('endpoints must contain at least one node');
  }
  if (endpoints.some(({ node }) => node === '')) {
    throw new TypeError('endpoint URL must not be empty');
  }
  const account = signingAccount(privateKey);
  const transport = fallback(
    endpoints.map(({ node }) => {
      if (typeof node === 'string') {
        return http(node, { retryCount: 0 });
      }
      return custom(
        {
          request: ({ method, params }: { method: string; params?: readonly unknown[] }) => node(method, params ?? []),
        },
        { retryCount: 0 },
      );
    }),
    { retryCount: 0 },
  );
  const publicClient = createPublicClient({ chain: mainnet, transport, pollingInterval: 1 });
  const walletClient = createWalletClient({ account, chain: mainnet, transport });
  return new ViemRpcClient({
    publicClient,
    walletClient,
    maxLogBlockRange,
    transactionPolicy: {
      sendTimeoutMs: SEND_TIMEOUT_MS,
      replacementFeeBumpBps: 1_000,
      maxFeePerGas: 1_000_000_000_000n,
      replacementTimeoutMs: 3,
      sendAttempts: 2,
      // The example's headroom; conformance reports race other guardians on the same accounts.
      gasHeadroomBps: 2_000,
    },
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}

/** Synthetic key validation belongs to the fixture that creates the wallet. */
export function signingAccount(privateKey: Hex): ReturnType<typeof privateKeyToAccount> {
  if (!isHex(privateKey, { strict: true }) || size(privateKey) !== 32) {
    throw new TypeError('privateKey must be a valid 32-byte secp256k1 key');
  }
  try {
    return privateKeyToAccount(privateKey);
  } catch {
    throw new TypeError('privateKey must be a valid 32-byte secp256k1 key');
  }
}

/** Scripted nodes deliberately admit malformed replies to exercise the RPC boundary. */
export type NodeRequest = (method: string, params: readonly unknown[]) => Promise<unknown>;

export interface NodeEndpoint {
  readonly node: string | NodeRequest;
}

/** Adapt a scripted node through the same schema-bearing request boundary as a configured client. */
export function rpcRequest(request: NodeRequest): RpcRequest {
  return custom(
    {
      request: ({ method, params }: { method: string; params?: readonly unknown[] }) => request(method, params ?? []),
    },
    { retryCount: 0 },
  )({}).config.request;
}
