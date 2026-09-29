// Scripted JSON-RPC providers over real HTTP for the log comparison tests.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '../../src/common/validation.ts';

/** What a provider answers; a thrown Error becomes a JSON-RPC error reply. */
export type Answer = (method: string, params: readonly unknown[]) => unknown;

export interface ScriptedProvider {
  readonly url: string;
  /** The methods this provider was asked, in order. */
  readonly asked: string[];
  stop(): Promise<void>;
}

interface JsonRpcCall {
  readonly id: unknown;
  readonly method: string;
  readonly params: readonly unknown[];
}

function parseCall(body: string): JsonRpcCall {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    throw new TypeError('The transport sent a malformed JSON-RPC call');
  }
  const params: readonly unknown[] = Array.isArray(parsed.params) ? parsed.params : [];
  return { id: parsed.id, method: parsed.method, params };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}

async function encodeReply(call: JsonRpcCall, answer: Answer): Promise<string> {
  try {
    return JSON.stringify({ jsonrpc: '2.0', id: call.id, result: await answer(call.method, call.params) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'scripted failure';
    const code = isRecord(error) && typeof error.code === 'number' ? error.code : -32000;
    return JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code, message } });
  }
}

async function listen(handle: (body: string, response: ServerResponse) => Promise<void>): Promise<ScriptedProvider> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      asked.push(parseCall(body).method);
      return handle(body, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!isRecord(address) || typeof address.port !== 'number') {
    throw new TypeError('The scripted provider has no port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    asked,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A provider that answers every call through JSON-RPC. */
export function scriptedProvider(answer: Answer): Promise<ScriptedProvider> {
  return listen(async (body, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(await encodeReply(parseCall(body), answer));
  });
}

/** A provider whose gateway fails, which the transport reports as a transport failure. */
export function failingProvider(): Promise<ScriptedProvider> {
  return listen((_body, response) => {
    response.statusCode = 500;
    response.end('gateway failure');
    return Promise.resolve();
  });
}

/** A provider that answers HTTP 200 with a reply that holds neither a result nor an error. */
export function malformedProvider(): Promise<ScriptedProvider> {
  return listen((body, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: parseCall(body).id }));
    return Promise.resolve();
  });
}
