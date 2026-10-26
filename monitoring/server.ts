// HTTP ingestion, Prometheus exposition, receiver liveness and SDK event freshness.

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, RequestListener, Server } from 'node:http';
import type { EventReceiver } from './receiver.ts';
import { CONTENT_TYPE } from './metrics.ts';
import type { Metrics, MetricsSource } from './metrics.ts';

type Response = Parameters<RequestListener>[1];

/** The daemon's own families first; a runtime collection that fails must not hide them. */
function serveMetrics(options: Pick<MonitoringOptions, 'metrics' | 'runtime'>, response: Response): void {
  const runtime = options.runtime?.metrics().catch(() => '') ?? Promise.resolve('');

  Promise.all([options.metrics.render(), runtime]).then(
    ([metrics, defaults]) => {
      response.writeHead(200, { 'content-type': CONTENT_TYPE });
      response.end(metrics + defaults);
    },
    () => {
      response.writeHead(500).end();
    },
  );
}

interface MonitoringOptions {
  readonly receiver: EventReceiver;
  readonly metrics: Metrics;
  readonly version: string;
  readonly progressTimeoutSeconds: number;
  readonly runtime?: MetricsSource;
  readonly clock?: () => number;
}

const MAX_EVENT_BYTES = 8 * 1024 * 1024;

class RequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('Event request rejected');
    this.status = status;
  }
}

/** The HTTP receiver is live even when its SDK source is not sending events. */
export function monitoringEndpoints(options: MonitoringOptions): RequestListener {
  return (request, response) => {
    void serveMonitoring(request, response, options).catch((error: unknown) => {
      let status = 500;
      if (error instanceof RequestError) {
        status = error.status;
      }
      let reason: 'record' | 'body' = 'body';
      if (status === 500) {
        reason = 'record';
      }
      options.metrics.receiverFailed(reason);
      response.writeHead(status).end();
    });
  };
}

export async function startReceiverServer(port: number, options: MonitoringOptions): Promise<Server> {
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 },
    monitoringEndpoints(options),
  );
  await once(server.listen(port, '0.0.0.0'), 'listening');
  return server;
}

async function serveMonitoring(
  request: IncomingMessage,
  response: Response,
  options: MonitoringOptions,
): Promise<void> {
  if (request.url === '/events') {
    await receiveEvent(request, response, options);
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(404).end();
    return;
  }
  if (request.url === '/metrics') {
    serveMetrics(options, response);
    return;
  }
  if (request.url === '/health' || request.url === '/ready') {
    serveReceiverHealth(request.url, response, options);
    return;
  }
  response.writeHead(404).end();
}

function serveReceiverHealth(path: string, response: Response, options: MonitoringOptions): void {
  const at = options.receiver.lastEventAt;
  const now = (options.clock ?? Date.now)();
  const fresh = at !== null && now - at <= options.progressTimeoutSeconds * 1000;
  let status = 503;
  let state = 'stale';
  if (path === '/health' || fresh) {
    status = 200;
    state = 'ok';
  }
  let lastEventAt: string | null = null;
  if (at !== null) {
    lastEventAt = new Date(at).toISOString();
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      status: state,
      version: options.version,
      lastEventAt,
    }),
  );
}

async function receiveEvent(request: IncomingMessage, response: Response, options: MonitoringOptions): Promise<void> {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    options.metrics.receiverFailed('content-type');
    request.resume();
    response.writeHead(415).end();
    return;
  }
  const value = await eventBody(request);
  if (!options.receiver.receive(value)) {
    options.metrics.receiverFailed('schema');
    response.writeHead(400).end();
    return;
  }
  response.writeHead(204).end();
}

async function eventBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) {
      throw new RequestError(400);
    }
    const buffer: Buffer = chunk;
    bytes += buffer.length;
    if (bytes > MAX_EVENT_BYTES) {
      request.resume();
      throw new RequestError(413);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400);
  }
}
