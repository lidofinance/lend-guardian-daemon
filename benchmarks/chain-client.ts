// The benchmark child's side of the chain server (`chain-server.ts`): it starts the server process,
// has it build worlds, moves its chain and reads it as a node over loopback HTTP. Every request carries
// the child's chain time and every answer brings back the server's, so waits on either side move one
// clock. The SDK parses each answer from the response body, as it does with a real node.

import { fork } from 'node:child_process';
import { isRecord } from '../src/common/validation.ts';
import type { Hex } from '../src/core/index.ts';
import { numberRecordOf } from './metrics.ts';
import { realDelay } from './synthetic-rpc.ts';
import type {
  Answer,
  MinedTransaction,
  NodeRequest,
  ProviderProfile,
  RegistryMethod,
  RpcLatency,
  RpcObserver,
  VirtualClock,
} from './synthetic-rpc.ts';

/** The request header with the child's chain time, and the response header with the server's. */
export const CHAIN_TIME_HEADER = 'x-chain-time';

/** Response headers with what the benchmark counts about an answer. */
export const ANSWER_HEADERS = {
  label: 'x-answer-label',
  logs: 'x-answer-logs',
  bytes: 'x-answer-bytes',
  spanBlocks: 'x-answer-span',
  handlerMs: 'x-handler-ms',
} as const;

/** Request headers with the limits a modelled provider and the daemon's transport put on an answer. */
export const LIMIT_HEADERS = { logs: 'x-log-limit', bytes: 'x-response-limit' } as const;

/** The daemon's transport refuses a response body above ten megabytes (`maxResponseBodySize`). */
const TRANSPORT_RESPONSE_LIMIT_BYTES = 10 * 1_048_576;

/**
 * Delays of a paid shared provider, modelled on one we measured: a log read that finds nothing is the
 * slowest, one that returns logs takes a fraction of that, and any other request one network exchange.
 */
const SHARED_PROVIDER_DELAYS = { emptyLogReadMs: 2_000, logReadMs: 400, otherMs: 50 } as const;

const REGISTRY_METHODS: readonly RegistryMethod[] = ['suspect', 'flag', 'heartbeat'];

const TRANSACTION_STATUSES: readonly MinedTransaction['status'][] = ['success', 'reverted'];

const SERVER = new URL('./chain-server.ts', import.meta.url);

/** The scenario's delays on answers: real latency, or a modelled provider's delays in chain time. */
export interface NodeDelays {
  readonly latency: RpcLatency;
  readonly provider: ProviderProfile | undefined;
}

/** A world the server built: the size and cost of its history, and the numbers the checks read. */
export interface WorldFacts {
  readonly stats: Readonly<Record<string, number>>;
  readonly facts: Readonly<Record<string, number>>;
}

export interface ChainServer {
  readonly chain: RemoteChain;
  stop(): void;
}

/** An answer as the server sent it, or the error it sent instead. */
interface RpcReply {
  readonly answer: Answer;
  readonly handlerMs: number;
  readonly error: string | undefined;
}

/** Start the chain server process and wait for its URL. */
export function startChainServer(clock: VirtualClock): Promise<ChainServer> {
  return new Promise((resolve, reject) => {
    // The server inherits the heap limit, but writes no profile of its own.
    const execArgv = process.execArgv.filter(
      (flag) => !flag.startsWith('--cpu-prof') && !flag.startsWith('--heap-prof'),
    );
    const server = fork(SERVER, [], {
      execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    });
    server.once('message', (message: unknown) => {
      const url = isRecord(message) && typeof message.url === 'string' ? message.url : undefined;
      if (url === undefined) {
        server.kill();
        reject(new Error('The chain server sent no URL'));
        return;
      }
      resolve({
        chain: new RemoteChain(url, clock),
        stop: () => {
          server.kill();
        },
      });
    });
    server.once('exit', (code) => {
      reject(new Error(`The chain server exited with code ${String(code)} before it listened`));
    });
  });
}

/** The synthetic chain in the server process, as the benchmark child builds, moves and reads it. */
export class RemoteChain {
  readonly #url: string;

  readonly #clock: VirtualClock;

  constructor(url: string, clock: VirtualClock) {
    this.#url = url;
    this.#clock = clock;
  }

  /**
   * Build the world of a scenario, with `size` positions or operations for a probe. Building is setup:
   * the server seals the history at the request's chain time, so the real time it took is taken back.
   */
  async build(presetName: string, scenarioId: string, size = 0): Promise<WorldFacts> {
    const startedAt = performance.now();
    const value = await this.#sendControl('build', { presetName, scenarioId, size });
    this.#clock.discountRealTime(performance.now() - startedAt);
    const stats = isRecord(value) ? numberRecordOf(value.stats) : undefined;
    const facts = isRecord(value) ? numberRecordOf(value.facts) : undefined;
    if (stats === undefined || facts === undefined) {
      throw new TypeError('The chain server sent no world facts');
    }
    return { stats, facts };
  }

  async head(): Promise<number> {
    return requireNumber(await this.#sendControl('head'), 'head');
  }

  /** Mine a registry call `inclusionBlocks` after the current head. */
  async include(data: Hex, inclusionBlocks: number): Promise<MinedTransaction> {
    return requireMinedTransaction(await this.#sendControl('include', { data, inclusionBlocks }));
  }

  async advanceTo(blockNumber: number): Promise<void> {
    await this.#sendControl('advanceTo', { blockNumber });
  }

  async reorgFrom(blockNumber: number): Promise<void> {
    await this.#sendControl('reorgFrom', { blockNumber });
  }

  async dropTransaction(hash: Hex): Promise<void> {
    await this.#sendControl('dropTransaction', { hash });
  }

  async heartbeatTimestamp(): Promise<number> {
    return requireNumber(await this.#sendControl('heartbeatTimestamp'), 'heartbeat timestamp');
  }

  /** A node request to this chain: every answer is counted by `observer` and delayed as `delays` say. */
  createNodeRequest(observer: RpcObserver, delays: NodeDelays): NodeRequest {
    const { provider } = delays;
    if (provider === undefined) {
      return (method, params) => this.#requestNode(observer, delays.latency, method, params);
    }
    return (method, params) => this.#requestProvider(observer, provider, method, params);
  }

  async #requestNode(
    observer: RpcObserver,
    latency: RpcLatency,
    method: string,
    params: readonly unknown[],
  ): Promise<unknown> {
    const reply = await this.#call(method, params, {});
    if (reply.error !== undefined) {
      observer.failed(method, reply.handlerMs);
      throw new Error(reply.error);
    }
    const latencyMs = latency.byLabelMs.get(reply.answer.label) ?? latency.everyRequestMs;
    observer.answered(reply.answer, reply.handlerMs, latencyMs);
    await realDelay(latencyMs);
    return reply.answer.value;
  }

  /**
   * An answer of the modelled provider arrives after the delay of its kind, from when it was sent. A log
   * list above the provider's limit or a response above the transport's limit fails after that delay.
   */
  async #requestProvider(
    observer: RpcObserver,
    provider: ProviderProfile,
    method: string,
    params: readonly unknown[],
  ): Promise<unknown> {
    const limits: Record<string, string> = { [LIMIT_HEADERS.bytes]: String(TRANSPORT_RESPONSE_LIMIT_BYTES) };
    if (provider.logLimit !== undefined) {
      limits[LIMIT_HEADERS.logs] = String(provider.logLimit);
    }
    const sentAt = provider.queue.startRequest();
    let reply: RpcReply;
    try {
      reply = await this.#call(method, params, limits);
    } catch (error) {
      await provider.queue.waitForAnswer(sentAt, 0);
      throw error;
    }
    await provider.queue.waitForAnswer(sentAt, answerDelayMs(method, reply.answer));
    if (reply.error !== undefined) {
      observer.failed(method, reply.handlerMs);
      throw new Error(reply.error);
    }
    observer.answered(reply.answer, reply.handlerMs, 0);
    return reply.answer.value;
  }

  async #call(
    method: string,
    params: readonly unknown[],
    headers: Readonly<Record<string, string>>,
  ): Promise<RpcReply> {
    const response = await this.#post('/rpc', { jsonrpc: '2.0', id: 1, method, params }, headers);
    const reply: unknown = JSON.parse(await response.text());
    const error = isRecord(reply) && isRecord(reply.error) ? String(reply.error.message) : undefined;
    const answer: Answer = {
      value: isRecord(reply) ? reply.result : undefined,
      label: response.headers.get(ANSWER_HEADERS.label) ?? method,
      logs: Number(response.headers.get(ANSWER_HEADERS.logs) ?? 0),
      bytes: Number(response.headers.get(ANSWER_HEADERS.bytes) ?? 0),
      spanBlocks: Number(response.headers.get(ANSWER_HEADERS.spanBlocks) ?? 0),
    };
    return { answer, handlerMs: Number(response.headers.get(ANSWER_HEADERS.handlerMs) ?? 0), error };
  }

  async #sendControl(operation: string, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    const response = await this.#post('/control', { operation, args }, {});
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`The chain server refused ${operation}: ${text}`);
    }
    const reply: unknown = JSON.parse(text);
    return isRecord(reply) ? reply.value : undefined;
  }

  /** Send the child's chain time with the request, and move the clock forward to the server's. */
  async #post(path: string, body: unknown, headers: Readonly<Record<string, string>>): Promise<Response> {
    const response = await fetch(`${this.#url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CHAIN_TIME_HEADER]: String(this.#clock.now()), ...headers },
      body: JSON.stringify(body),
    });
    this.#clock.catchUp(Number(response.headers.get(CHAIN_TIME_HEADER) ?? 0));
    return response;
  }
}

/** The modelled provider's delay before `answer` arrives. */
function answerDelayMs(method: string, answer: Answer): number {
  if (method !== 'eth_getLogs') {
    return SHARED_PROVIDER_DELAYS.otherMs;
  }
  return answer.logs === 0 ? SHARED_PROVIDER_DELAYS.emptyLogReadMs : SHARED_PROVIDER_DELAYS.logReadMs;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`The chain server sent no ${name}`);
  }
  return value;
}

/** A mined transaction as the server sent it. */
function requireMinedTransaction(value: unknown): MinedTransaction {
  const method = isRecord(value) ? REGISTRY_METHODS.find((known) => known === value.method) : undefined;
  if (!isRecord(value) || method === undefined) {
    throw new TypeError('The chain server sent no mined transaction');
  }
  const status = TRANSACTION_STATUSES.find((known) => known === value.status);
  if (status === undefined) {
    throw new TypeError('The chain server sent no transaction status');
  }
  return {
    hash: requireHex(value.hash),
    method,
    accounts: requireNumber(value.accounts, 'account count'),
    blockNumber: requireNumber(value.blockNumber, 'block number'),
    blockHash: requireHex(value.blockHash),
    status,
  };
}

function requireHex(value: unknown): Hex {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new TypeError('The chain server sent no hex value');
  }
  return `0x${value.slice(2)}`;
}
