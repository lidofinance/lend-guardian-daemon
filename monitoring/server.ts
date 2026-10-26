// The HTTP surface: the daemon posts to /events, Prometheus reads /metrics, the orchestrator probes
// /health and /ready. Requests are answered at once; nothing is queued or retried.

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http';
import { readEvent } from './events.ts';
import type { Metrics, RejectionReason } from './metrics.ts';
import type { Receiver } from './receiver.ts';

export interface EndpointOptions {
  readonly receiver: Receiver;
  readonly metrics: Metrics;
  readonly version: string;
}

/** The daemon posts one event per request; `cycle.screened` lists every anchor of a cycle. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

interface Refusal {
  readonly status: number;
  readonly reason: RejectionReason;
}

export function monitoringEndpoints(options: EndpointOptions): RequestListener {
  return (request, response) => {
    void route(request, response, options).catch((error: unknown) => {
      // A failure while reading or recording one event must not take the receiver down.
      if (!response.headersSent) {
        send(response, 500, { error: error instanceof Error ? error.message : 'internal error' });
      }
    });
  };
}

export async function startServer(port: number, options: EndpointOptions): Promise<Server> {
  const server = createServer(monitoringEndpoints(options));
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  return server;
}

async function route(request: IncomingMessage, response: ServerResponse, options: EndpointOptions): Promise<void> {
  const path = request.url ?? '/';
  switch (path) {
    case '/events':
      await events(request, response, options);
      return;
    case '/metrics':
      await metrics(request, response, options.metrics);
      return;
    case '/health':
    case '/ready':
      probe(path, request, response, options);
      return;
    default:
      send(response, 404, { error: 'not found' });
  }
}

async function events(request: IncomingMessage, response: ServerResponse, options: EndpointOptions): Promise<void> {
  const refusal = await admit(request, response, options);
  if (refusal !== undefined) {
    options.metrics.rejected(refusal.reason);
    if (!response.headersSent) {
      send(response, refusal.status, { error: refusal.reason });
    }
    return;
  }
  response.writeHead(204).end();
}

/** Read, parse and hand over one event; the refusal names the first check that failed. */
async function admit(
  request: IncomingMessage,
  response: ServerResponse,
  options: EndpointOptions,
): Promise<Refusal | undefined> {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' }).end();
    return { status: 405, reason: 'method' };
  }
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return { status: 415, reason: 'content-type' };
  }
  const body = await readBody(request);
  if (body === undefined) {
    return { status: 413, reason: 'body-size' };
  }
  const event = readEvent(body);
  if (typeof event === 'string') {
    return { status: 400, reason: event };
  }
  options.receiver.receive(event);
  return undefined;
}

async function metrics(request: IncomingMessage, response: ServerResponse, registry: Metrics): Promise<void> {
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' }).end();
    return;
  }
  const exposition = await registry.render();
  response.writeHead(200, { 'content-type': registry.contentType }).end(exposition);
}

/** `/health` says the receiver serves; `/ready` says the daemon it watches is fresh. */
function probe(path: string, request: IncomingMessage, response: ServerResponse, options: EndpointOptions): void {
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' }).end();
    return;
  }
  const freshness = options.receiver.freshness();
  const isOk = path === '/health' || freshness.ready;
  send(response, isOk ? 200 : 503, {
    status: isOk ? 'ok' : 'stale',
    version: options.version,
    lastEventAt: isoOrNull(freshness.lastEventAt),
    lastCycleEndAt: isoOrNull(freshness.lastCycleEndAt),
  });
}

/** The body as text, or undefined once it exceeds the limit; the rest is read and dropped so the answer lands. */
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      resolve(size <= MAX_BODY_BYTES ? Buffer.concat(chunks).toString('utf8') : undefined);
    });
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function isoOrNull(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}
