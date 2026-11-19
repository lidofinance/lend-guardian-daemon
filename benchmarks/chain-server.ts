// The synthetic chain of one benchmark scenario, served over loopback HTTP from its own process, so its
// history, its answers and their serialization take no memory or CPU time from the measured SDK. The
// benchmark child has it build worlds and moves the chain through control requests (`chain-client.ts`).
// The server takes each request's chain time from the child and sends its own back. It reports its URL
// over IPC and serves until the child stops it.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '../src/common/validation.ts';
import type { Hex } from '../src/core/index.ts';
import { ANSWER_HEADERS, CHAIN_TIME_HEADER, LIMIT_HEADERS } from './chain-client.ts';
import { presetNamed, scenarioById } from './scenarios.ts';
import type { ScenarioParameters } from './scenarios.ts';
import { SLOT_SECONDS, VirtualClock } from './synthetic-rpc.ts';
import type { Answer, SyntheticChain } from './synthetic-rpc.ts';
import { buildWorld } from './worlds.ts';
import type { WorldSpec } from './worlds.ts';

const HOST = '127.0.0.1';

/** One JSON-RPC call as the server reads it. */
interface Call {
  readonly id: unknown;
  readonly method: string;
  readonly params: readonly unknown[];
}

/** One control request: an operation on the chain and its arguments. */
interface Control {
  readonly operation: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The chain the server holds, on a clock that each request sets to the child's chain time. */
class ChainService {
  readonly #clock = new VirtualClock({ slotSeconds: SLOT_SECONDS, realTimeScale: 0 });

  #chain: SyntheticChain | undefined;

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body: unknown = JSON.parse(await readBody(request));
    this.#clock.setNow(Number(request.headers[CHAIN_TIME_HEADER] ?? 0));
    if (request.url === '/rpc') {
      this.#answer(parseCall(body), request, response);
      return;
    }
    const value = this.#apply(parseControl(body));
    sendJson(response, { value }, { [CHAIN_TIME_HEADER]: String(this.#clock.now()) });
  }

  /**
   * Answer a call with what the benchmark counts about it in headers. An answer above the request's log
   * or response limit is sent as the refusal a provider or the daemon's transport makes instead.
   */
  #answer(call: Call, request: IncomingMessage, response: ServerResponse): void {
    const startedAt = performance.now();
    let answer: Answer;
    try {
      answer = this.#requireChain().answer(call.method, call.params);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'synthetic chain failure';
      const headers = { [CHAIN_TIME_HEADER]: String(this.#clock.now()), [ANSWER_HEADERS.label]: call.method };
      sendJson(response, { jsonrpc: '2.0', id: call.id, error: { code: -32000, message } }, headers);
      return;
    }
    const headers = {
      [CHAIN_TIME_HEADER]: String(this.#clock.now()),
      [ANSWER_HEADERS.label]: answer.label,
      [ANSWER_HEADERS.logs]: String(answer.logs),
      [ANSWER_HEADERS.bytes]: String(answer.bytes),
      [ANSWER_HEADERS.spanBlocks]: String(answer.spanBlocks),
      [ANSWER_HEADERS.handlerMs]: String(performance.now() - startedAt),
    };
    const refusal = findLimitRefusal(answer, request);
    const reply =
      refusal === undefined
        ? { jsonrpc: '2.0', id: call.id, result: answer.value }
        : { jsonrpc: '2.0', id: call.id, error: refusal };
    sendJson(response, reply, headers);
  }

  #apply(control: Control): unknown {
    const { args } = control;
    switch (control.operation) {
      case 'build':
        return this.#build(args);
      case 'head':
        return this.#requireChain().head();
      case 'include':
        return this.#requireChain().include(requireHex(args.data), requireNumber(args.inclusionBlocks));
      case 'advanceTo':
        this.#requireChain().advanceTo(requireNumber(args.blockNumber));
        return null;
      case 'reorgFrom':
        this.#requireChain().reorgFrom(requireNumber(args.blockNumber));
        return null;
      case 'dropTransaction':
        this.#requireChain().dropTransaction(requireHex(args.hash));
        return null;
      case 'heartbeatTimestamp':
        return this.#requireChain().heartbeatTimestamp();
      default:
        throw new Error(`The chain server has no operation ${control.operation}`);
    }
  }

  /** Replace the chain with the world of a scenario; a probe gives its size. */
  #build(args: Readonly<Record<string, unknown>>): unknown {
    const presetName = typeof args.presetName === 'string' ? args.presetName : '';
    const scenarioId = typeof args.scenarioId === 'string' ? args.scenarioId : '';
    const scenario = scenarioById(presetNamed(presetName), scenarioId);
    this.#chain = undefined;
    const built = buildWorld(specifyWorld(scenario.parameters, scenario.seed, requireNumber(args.size)), this.#clock);
    this.#chain = built.chain;
    return { stats: built.stats, facts: built.facts };
  }

  #requireChain(): SyntheticChain {
    if (this.#chain === undefined) {
      throw new Error('The chain server has built no world');
    }
    return this.#chain;
  }
}

/** The world a scenario reads; liveness and griefing probes give their size. */
function specifyWorld(parameters: ScenarioParameters, seed: number, size: number): WorldSpec {
  switch (parameters.family) {
    case 'discovery':
      return { kind: 'discovery', parameters, seed };
    case 'reconstruction':
      return { kind: 'reconstruction', parameters };
    case 'screening':
      return { kind: 'screening', parameters };
    case 'reports':
      return { kind: 'quiet' };
    case 'cycle':
      return { kind: 'cycle', parameters };
    case 'liveness':
      return { kind: 'liveness', positions: size, markets: parameters.markets };
    case 'griefing':
      return { kind: 'griefing', parameters, operations: size };
    case 'transport':
    case 'daemon':
    case 'anvil':
      throw new Error(`The ${parameters.family} family reads no synthetic chain from this server`);
  }
}

/** The refusal for an answer above the request's limits, as a provider or the transport makes it. */
function findLimitRefusal(answer: Answer, request: IncomingMessage): { code: number; message: string } | undefined {
  const logLimit = request.headers[LIMIT_HEADERS.logs];
  if (typeof logLimit === 'string' && answer.logs > Number(logLimit)) {
    return { code: -32005, message: `query returned more than ${logLimit} results` };
  }
  const bytesLimit = request.headers[LIMIT_HEADERS.bytes];
  if (typeof bytesLimit === 'string' && answer.bytes > Number(bytesLimit)) {
    return { code: -32000, message: `response body of ${String(answer.bytes)} bytes exceeds the transport limit` };
  }
  return undefined;
}

function parseCall(body: unknown): Call {
  if (!isRecord(body) || typeof body.method !== 'string') {
    throw new TypeError('The chain server received no JSON-RPC call');
  }
  const params: unknown = body.params;
  return { id: body.id, method: body.method, params: Array.isArray(params) ? params : [] };
}

function parseControl(body: unknown): Control {
  const operation = isRecord(body) ? body.operation : undefined;
  const args = isRecord(body) ? body.args : undefined;
  if (typeof operation !== 'string' || !isRecord(args)) {
    throw new TypeError('The chain server received no control request');
  }
  return { operation, args };
}

function requireNumber(value: unknown): number {
  if (typeof value !== 'number') {
    throw new TypeError('The chain server expected a number');
  }
  return value;
}

function requireHex(value: unknown): Hex {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new TypeError('The chain server expected a hex value');
  }
  return `0x${value.slice(2)}`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, reply: unknown, headers: Readonly<Record<string, string>>): void {
  const text = JSON.stringify(reply);
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

function main(): void {
  const service = new ChainService();
  const server = createServer((request, response) => {
    service.handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'chain server failure';
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(message);
    });
  });
  server.listen(0, HOST, () => {
    const address = server.address();
    const port = address === null || typeof address === 'string' ? 0 : address.port;
    process.send?.({ url: `http://${HOST}:${String(port)}` });
  });
  process.on('disconnect', () => {
    process.exit(0);
  });
}

main();
