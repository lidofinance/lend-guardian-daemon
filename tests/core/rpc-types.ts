// Compiler-only integration contract; these calls are never executed against a node.
import type { RpcBlock, RpcLog, RpcTransactionReceipt } from 'viem';
import type { Hex, RpcRequest } from '../../src/core/index.ts';

export async function standardRequests(
  request: RpcRequest,
  hash: Hex,
): Promise<[Hex, RpcBlock | null, RpcTransactionReceipt | null, RpcLog[], number]> {
  const chainId: Hex = await request({ method: 'eth_chainId' });
  const block: RpcBlock | null = await request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
  const receipt: RpcTransactionReceipt | null = await request({ method: 'eth_getTransactionReceipt', params: [hash] });
  const logs: RpcLog[] = await request({ method: 'eth_getLogs', params: [{ blockHash: hash }] });

  // @ts-expect-error The method name must belong to the standard public RPC schema.
  await request({ method: 'eth_chainID' });
  // @ts-expect-error eth_chainId has no positional parameters.
  await request({ method: 'eth_chainId', params: [hash] });
  // @ts-expect-error Receipt lookup requires a hex hash, not a number.
  await request({ method: 'eth_getTransactionReceipt', params: [42] });
  // @ts-expect-error Block lookup requires the include-transactions boolean.
  await request({ method: 'eth_getBlockByNumber', params: ['latest'] });
  // @ts-expect-error The chain ID response is a hex quantity, not a JavaScript number.
  const number: number = await request({ method: 'eth_chainId' });
  return [chainId, block, receipt, logs, number];
}
