// The delegate's balance: the one chain read of the receiver. The daemon reads no balance and its events
// carry none, so the receiver asks an RPC endpoint itself and keeps the answer as a gauge. The delegate
// comes from the registry at each read, as the daemon checks it, so a rotated key needs no new setting.
// A failed read prints a record and changes nothing else: the events, the other metrics and the probes go on.

import type { BalanceSource } from './config.ts';
import { formatRecord, isRecord } from './events.ts';
import type { Metrics } from './metrics.ts';

/** One endpoint's answer; the next endpoint is asked after it. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A JSON-RPC quantity: hex digits after `0x`. */
const QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;

/** `getDelegate(address)` of `GuardianSignals`; a test checks the call against the ABI encoding. */
const GET_DELEGATE_SELECTOR = '0x544d8564';

/** An ABI-encoded address: one 32-byte word with twelve zero bytes before the twenty of the address. */
const ADDRESS_WORD_PATTERN = /^0x0{24}([0-9a-fA-F]{40})$/;

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export interface BalanceUpdate {
  readonly source: BalanceSource;
  readonly metrics: Metrics;
  /** One JSON line per printed record. */
  readonly sink: (line: string) => void;
  readonly clock: () => number;
}

/**
 * Read the delegate and its balance once and set the gauge. When no endpoint answers, the gauge keeps its
 * last value, whose timestamp shows the age, and the failure is printed.
 */
export async function updateBalance(update: BalanceUpdate): Promise<void> {
  const { source, metrics } = update;
  const failures: string[] = [];
  for (const [index, url] of source.rpcUrls.entries()) {
    try {
      const delegate = await requestDelegate(url, source);
      metrics.setDelegateBalance(delegate, await requestBalance(url, delegate), update.clock());
      return;
    } catch (error) {
      // The next endpoint may answer. The failure is kept by the endpoint's position, never by its URL.
      failures.push(`rpc-${String(index)}: ${describeFailure(error)}`);
    }
  }
  update.sink(formatRecord({ event: 'monitor.balanceFailed', level: 'warn', error: failures.join('; ') }));
}

/** An error's message, with the code of its cause when it has one, as a failed connection has `ECONNREFUSED`. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = isRecord(error.cause) ? error.cause.code : undefined;
  return typeof code === 'string' ? `${error.message} (${code})` : error.message;
}

/** The delegate the registry names for the Guardian at the latest block, in lowercase; none throws. */
async function requestDelegate(url: string, source: BalanceSource): Promise<string> {
  const data = `${GET_DELEGATE_SELECTOR}${source.guardian.slice(2).toLowerCase().padStart(64, '0')}`;
  const word = await request(url, 'eth_call', [{ to: source.registry, data }, 'latest']);
  const address = ADDRESS_WORD_PATTERN.exec(word)?.[1];
  if (address === undefined) {
    throw new Error('the answer holds no address');
  }
  const delegate = `0x${address.toLowerCase()}`;
  if (delegate === ZERO_ADDRESS) {
    throw new Error('the registry names no delegate for GUARDIAN');
  }
  return delegate;
}

/** `eth_getBalance` of the address at the latest block, in wei. */
async function requestBalance(url: string, address: string): Promise<bigint> {
  return BigInt(await request(url, 'eth_getBalance', [address, 'latest']));
}

/** The hex result of one JSON-RPC call; any other answer throws. */
async function request(url: string, method: string, params: readonly unknown[]): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Only a read or cancelled body returns the connection to undici's pool.
    await response.body?.cancel();
    throw new Error(`HTTP ${String(response.status)}`);
  }
  const answer: unknown = await response.json();
  const result = isRecord(answer) ? answer.result : undefined;
  if (typeof result === 'string' && QUANTITY_PATTERN.test(result)) {
    return result;
  }
  throw new Error(describeRefusal(answer));
}

/** Why an answer holds no result: the node's JSON-RPC error code, whose message a provider words freely, or nothing. */
function describeRefusal(answer: unknown): string {
  const error = isRecord(answer) && isRecord(answer.error) ? answer.error : {};
  return typeof error.code === 'number' ? `JSON-RPC error ${String(error.code)}` : 'the answer holds no result';
}
