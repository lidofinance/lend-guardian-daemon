// The loopback server process for one transport or daemon scenario. Every JSON-RPC endpoint serves the
// same deterministic synthetic chain and behaves as the scenario's condition prescribes; the daemon
// family adds a screening service and an event receiver. It reports its URLs over IPC and serves until
// the parent stops it.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { isRecord } from '../src/common/validation.ts';
import type { ScreeningResult } from '../src/core/index.ts';
import { ENDPOINTS, LAGGING_BLOCKS } from './loopback.ts';
import type { EndpointBehavior } from './loopback.ts';
import { presetNamed, scenarioById } from './scenarios.ts';
import type { DaemonScenario, TransportScenario } from './scenarios.ts';
import { SLOT_SECONDS, VirtualClock, realDelay } from './synthetic-rpc.ts';
import type { SyntheticChain } from './synthetic-rpc.ts';
import { cycleWorld, logsWorld } from './worlds.ts';

const HOST = '127.0.0.1';

/** The delay of the transport family's healthy endpoint, so the daemon family repeats its observe cycle. */
const DAEMON_NODE_LATENCY_MS = 2;

const BYTES_PER_KILOBYTE = 1_024;

const CLEAN: ScreeningResult = { status: 'judged', requiresSuspect: false, requiresFlag: false };

const INCOMPLETE: ScreeningResult = { status: 'incomplete' };

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/** One JSON-RPC call as the server reads it. */
interface Call {
  readonly id: unknown;
  readonly method: string;
  readonly params: readonly unknown[];
}

async function main(): Promise<void> {
  const [presetName = '', scenarioId = ''] = process.argv.slice(2);
  const { parameters } = scenarioById(presetNamed(presetName), scenarioId);
  if (parameters.family === 'daemon') {
    process.send?.({ urls: await serveDaemon(parameters) });
    return;
  }
  if (parameters.family !== 'transport') {
    throw new TypeError(`${scenarioId} is neither a transport nor a daemon scenario`);
  }
  const chain = transportWorld(parameters);
  const urls = await Promise.all(
    ENDPOINTS[parameters.condition].map((behavior) => serve(chain, behavior, parameters.latencyMs)),
  );
  process.send?.({ urls });
}

function transportWorld(parameters: TransportScenario): SyntheticChain {
  const isCycle = parameters.condition === 'observe-cycle' || parameters.condition === 'observe-cycle-fallback';
  if (isCycle) {
    return cycleChain(parameters.positions);
  }
  return logsWorld(parameters.logs, new VirtualClock({ slotSeconds: SLOT_SECONDS, realTimeScale: 0 }));
}

/** The world of an observe cycle: clean positions, each due for screening. */
function cycleChain(positions: number): SyntheticChain {
  const world = cycleWorld(
    {
      family: 'cycle',
      profile: 'clean',
      positions,
      events: 1,
      decision: 'clean',
      providerLatencyMs: 0,
      rpcLatencyMs: 0,
      freshSupplies: 0,
      transactionScreeningMs: 0,
      screeningConcurrency: 1,
    },
    new VirtualClock({ slotSeconds: SLOT_SECONDS, realTimeScale: 0 }),
  );
  return world.chain;
}

/**
 * The daemon family's node, screening service and event receiver, in the order the client reads them.
 * Any message from the parent asks for the services' counters.
 */
async function serveDaemon(parameters: DaemonScenario): Promise<string[]> {
  const services = new DaemonServices(parameters);
  process.on('message', () => {
    process.send?.(services.totals());
  });
  const node = await serve(cycleChain(parameters.positions), 'answer', DAEMON_NODE_LATENCY_MS);
  const screening = await listen(services.screen);
  const receiver = await listen(services.receive);
  return [node, screening.url, receiver.url];
}

/**
 * The daemon's screening service, which judges the first `judgedPerRequest` anchors of a request clean,
 * answers incomplete for the rest and repeats every id, and its event receiver, which answers each post
 * after the scenario's delay. Both count what they receive.
 */
class DaemonServices {
  readonly #receiverLatencyMs: number;

  readonly #judgedPerRequest: number;

  #screeningRequests = 0;

  #screeningAnchors = 0;

  #screeningRequestBytes = 0;

  #posts = 0;

  #postBytes = 0;

  #largestPostBytes = 0;

  #postsInFlight = 0;

  #maxPostsInFlight = 0;

  constructor(parameters: DaemonScenario) {
    this.#receiverLatencyMs = parameters.receiverLatencyMs;
    this.#judgedPerRequest = parameters.judgedPerRequest;
  }

  readonly screen = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await bodyOf(request);
    this.#screeningRequestBytes += Buffer.byteLength(body);
    const parsed: unknown = JSON.parse(body);
    const anchors: unknown = isRecord(parsed) ? parsed.anchors : undefined;
    const ids = Array.isArray(anchors)
      ? anchors.map((anchor: unknown) => (isRecord(anchor) ? anchor.id : undefined))
      : [];
    this.#screeningRequests += 1;
    this.#screeningAnchors += ids.length;
    const results = ids.map((id: unknown, index) => ({ id, ...(index < this.#judgedPerRequest ? CLEAN : INCOMPLETE) }));
    sendJson(response, { results });
  };

  readonly receive = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    this.#postsInFlight += 1;
    this.#maxPostsInFlight = Math.max(this.#maxPostsInFlight, this.#postsInFlight);
    // A post closes once it is answered, or earlier when the daemon gives up on it.
    response.once('close', () => {
      this.#postsInFlight -= 1;
    });
    const bytes = Buffer.byteLength(await bodyOf(request));
    this.#posts += 1;
    this.#postBytes += bytes;
    this.#largestPostBytes = Math.max(this.#largestPostBytes, bytes);
    await realDelay(this.#receiverLatencyMs);
    response.writeHead(204).end();
  };

  totals(): Record<string, number> {
    return {
      screeningRequests: this.#screeningRequests,
      screeningAnchors: this.#screeningAnchors,
      screeningRequestKb: this.#screeningRequestBytes / BYTES_PER_KILOBYTE,
      eventPosts: this.#posts,
      eventKb: this.#postBytes / BYTES_PER_KILOBYTE,
      largestEventKb: this.#largestPostBytes / BYTES_PER_KILOBYTE,
      maxConcurrentPosts: this.#maxPostsInFlight,
      postsInFlight: this.#postsInFlight,
    };
  }
}

/** Serve the chain as `behavior` prescribes; a `down` endpoint closes its port again so connections are refused. */
async function serve(chain: SyntheticChain, behavior: EndpointBehavior, latencyMs: number): Promise<string> {
  const { server, url } = await listen((request, response) =>
    respond({ chain, behavior, latencyMs }, request, response),
  );
  if (behavior === 'down') {
    await new Promise((resolve) => server.close(resolve));
  }
  return url;
}

/** Listen on an ephemeral loopback port. */
async function listen(handle: Handler): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      // A failed reply only affects this request; the client observes the broken connection.
      response.destroy();
    });
  });
  const port = await listening(server);
  return { server, url: `http://${HOST}:${String(port)}` };
}

function listening(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The loopback server has no TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function respond(
  endpoint: { readonly chain: SyntheticChain; readonly behavior: EndpointBehavior; readonly latencyMs: number },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await bodyOf(request);
  if (endpoint.behavior === 'hang') {
    return;
  }
  if (endpoint.behavior === 'reset') {
    request.socket.destroy();
    return;
  }
  await realDelay(endpoint.latencyMs);
  const call = callOf(body);
  if (endpoint.behavior === 'http-429') {
    sendText(response, 429, 'Too Many Requests');
    return;
  }
  if (endpoint.behavior === 'http-500') {
    sendText(response, 500, 'Internal Server Error');
    return;
  }
  sendJson(response, replyOf(endpoint, call));
}

function replyOf(
  endpoint: { readonly chain: SyntheticChain; readonly behavior: EndpointBehavior },
  call: Call,
): unknown {
  if (endpoint.behavior === 'rpc-error') {
    return { jsonrpc: '2.0', id: call.id, error: { code: -32005, message: 'query returned more than 10000 results' } };
  }
  try {
    const { value } = endpoint.chain.answer(call.method, call.params);
    const result = endpoint.behavior === 'lagging' ? withoutLatestLogs(call, value) : value;
    return { jsonrpc: '2.0', id: call.id, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'synthetic chain failure';
    return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message } };
  }
}

/** A lagging index answers a range as if its last blocks held no logs. */
function withoutLatestLogs(call: Call, value: unknown): unknown {
  const [filter] = call.params;
  const isRangeQuery = call.method === 'eth_getLogs' && isRecord(filter) && typeof filter.toBlock === 'string';
  if (!isRangeQuery || !Array.isArray(value)) {
    return value;
  }
  const indexedThrough = Number(BigInt(String(filter.toBlock))) - LAGGING_BLOCKS;
  return value.filter((log: unknown) => isRecord(log) && Number(BigInt(String(log.blockNumber))) <= indexedThrough);
}

function bodyOf(request: IncomingMessage): Promise<string> {
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

function callOf(body: string): Call {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    throw new TypeError('The loopback server received no JSON-RPC call');
  }
  const params: unknown = parsed.params;
  return { id: parsed.id, method: parsed.method, params: Array.isArray(params) ? params : [] };
}

function sendJson(response: ServerResponse, reply: unknown): void {
  const text = JSON.stringify(reply);
  response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  response.end(text);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(text) });
  response.end(text);
}

await main();
