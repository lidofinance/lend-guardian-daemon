// The HTTP surface on two ports: the daemon posts to /events on the loopback interface; Prometheus reads
// /metrics and the orchestrator probes /health and /ready on the other. Requests are answered at once;
// nothing is queued or retried.

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http';
import { readEvent } from './events.ts';
import type { ReceivedEvent, RejectionReason } from './events.ts';
import type { Metrics } from './metrics.ts';
import type { Receiver } from './receiver.ts';

export interface EndpointOptions {
  readonly receiver: Receiver;
  readonly metrics: Metrics;
  readonly version: string;
}

/** The daemon posts one event per request; `cycle.screened` lists every anchor of a cycle. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** A request refused: its status, the reason it is counted by, and any header the answer needs. */
interface Refusal {
  readonly status: number;
  readonly reason: RejectionReason;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A posted body checked: the event it holds, or why it is refused. */
type Admission =
  | { readonly kind: 'event'; readonly event: ReceivedEvent }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

type Handle = (path: string, request: IncomingMessage, response: ServerResponse) => Promise<void>;

/**
 * `POST /events` on the loopback interface. An event can make the daemon look ready, so only a process on the
 * same host or in the same pod, such as the daemon, may post one.
 */
export function startEventServer(port: number, options: EndpointOptions): Promise<Server> {
  const listener = serveRequests(async (path, request, response) => {
    if (path !== '/events') {
      send(response, 404, { error: 'not found' });
      return;
    }
    await serveEvents(request, response, options);
  });
  return startServer(listener, port, '127.0.0.1');
}

/** `/metrics`, `/health` and `/ready` for Prometheus and the orchestrator, on the host given: `main.ts` gives every interface. */
export function startMonitoringServer(port: number, host: string, options: EndpointOptions): Promise<Server> {
  const listener = serveRequests(async (path, request, response) => {
    switch (path) {
      case '/metrics':
        await serveMetrics(request, response, options);
        return;
      case '/health':
      case '/ready':
        serveProbe(path, request, response, options);
        return;
      default:
        send(response, 404, { error: 'not found' });
    }
  });
  return startServer(listener, port, host);
}

/** Answer each request by its path; a failure while answering one must not take the receiver down. */
function serveRequests(handle: Handle): RequestListener {
  return (request, response) => {
    void handle(request.url ?? '/', request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        send(response, 500, { error: error instanceof Error ? error.message : 'internal error' });
      }
    });
  };
}

async function startServer(listener: RequestListener, port: number, host: string): Promise<Server> {
  const server = createServer(listener);
  server.listen(port, host);
  await once(server, 'listening');
  return server;
}

async function serveEvents(
  request: IncomingMessage,
  response: ServerResponse,
  options: EndpointOptions,
): Promise<void> {
  const admission = await admit(request);
  if (admission.kind === 'refused') {
    const { status, reason, headers } = admission.refusal;
    options.metrics.countRejection(reason);
    send(response, status, { error: reason }, headers);
    return;
  }
  options.receiver.receive(admission.event);
  response.writeHead(204).end();
}

/** Check a posted body and parse its event; the refusal names the first check that failed. */
async function admit(request: IncomingMessage): Promise<Admission> {
  if (request.method !== 'POST') {
    return refuse({ status: 405, reason: 'method', headers: { allow: 'POST' } });
  }
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return refuse({ status: 415, reason: 'content-type' });
  }
  const body = await readBody(request);
  if (body === undefined) {
    return refuse({ status: 413, reason: 'body-size' });
  }
  const parsed = readEvent(body);
  if (parsed.kind === 'rejected') {
    return refuse({ status: 400, reason: parsed.reason });
  }
  return { kind: 'event', event: parsed.event };
}

function refuse(refusal: Refusal): Admission {
  return { kind: 'refused', refusal };
}

/** The exposition; the ready gauge is set from the clock first, so a window that lapsed without events reads 0. */
async function serveMetrics(
  request: IncomingMessage,
  response: ServerResponse,
  options: EndpointOptions,
): Promise<void> {
  if (request.method !== 'GET') {
    send(response, 405, { error: 'method' }, { allow: 'GET' });
    return;
  }
  options.metrics.setReady(options.receiver.freshness().ready);
  const exposition = await options.metrics.render();
  response.writeHead(200, { 'content-type': options.metrics.contentType }).end(exposition);
}

/** `/health` says the receiver serves; `/ready` says the daemon it watches is fresh. */
function serveProbe(path: string, request: IncomingMessage, response: ServerResponse, options: EndpointOptions): void {
  if (request.method !== 'GET') {
    send(response, 405, { error: 'method' }, { allow: 'GET' });
    return;
  }
  const freshness = options.receiver.freshness();
  const isOk = path === '/health' || freshness.ready;
  send(response, isOk ? 200 : 503, {
    status: isOk ? 'ok' : 'stale',
    version: options.version,
    lastEventAt: formatTime(freshness.lastEventAt),
    lastProgressAt: formatTime(freshness.lastProgressAt),
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

function send(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function formatTime(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}
