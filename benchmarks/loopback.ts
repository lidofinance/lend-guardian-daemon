// Loopback endpoints for the transport and daemon families: how each condition's endpoints behave, and
// the client side that starts the server process. The server runs in its own process, so JSON
// serialization and socket handling do not share CPU time with the measured client.

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { isRecord } from '../src/common/validation.ts';
import { numberRecordOf } from './metrics.ts';
import type { TransportCondition } from './scenarios.ts';

/**
 * - `answer`: serve the synthetic chain after the scenario latency;
 * - `lagging`: answer, but omit the logs of the last blocks of an `eth_getLogs` range without an error;
 * - `hang`: accept the request and never answer, so the client times out;
 * - `reset`: close the connection without a response;
 * - `http-429`, `http-500`: an HTTP error without a JSON-RPC body;
 * - `rpc-error`: HTTP 200 with a JSON-RPC limit error;
 * - `down`: nothing listens on the port, so the connection is refused.
 */
export type EndpointBehavior = 'answer' | 'lagging' | 'hang' | 'reset' | 'http-429' | 'http-500' | 'rpc-error' | 'down';

/** Endpoints of each condition, in fallback order. */
export const ENDPOINTS: Readonly<Record<TransportCondition, readonly EndpointBehavior[]>> = {
  healthy: ['answer'],
  'large-response': ['answer'],
  'response-limit': ['answer'],
  'http-429': ['http-429', 'answer'],
  'http-500': ['http-500', 'answer'],
  'rpc-error': ['rpc-error', 'answer'],
  timeout: ['hang', 'answer'],
  reset: ['reset', 'answer'],
  'first-down': ['down', 'answer'],
  exhausted: ['http-500', 'http-500'],
  'silent-omission': ['lagging'],
  'log-quorum': ['answer', 'answer', 'answer'],
  'log-quorum-lagging': ['answer', 'answer', 'lagging'],
  'observe-cycle': ['answer'],
  'observe-cycle-fallback': ['hang', 'answer'],
};

/** Blocks at the end of a log range that a lagging endpoint has not indexed yet. */
export const LAGGING_BLOCKS = 5_000;

const SERVER = new URL('./loopback-server.ts', import.meta.url);

export interface Loopback {
  /**
   * The JSON-RPC endpoints in fallback order. The daemon family's server lists its one node, then the
   * screening service and the event receiver.
   */
  readonly urls: readonly string[];
  /** What the daemon family's screening service and receiver have counted so far. */
  totals(): Promise<Record<string, number>>;
  stop(): void;
}

/** Start the server process for one transport or daemon scenario and wait for its URL list. */
export function startLoopback(presetName: string, scenarioId: string): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    const server = fork(SERVER, [presetName, scenarioId], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    });
    server.once('message', (message: unknown) => {
      const urls = urlsOf(message);
      if (urls === undefined) {
        server.kill();
        reject(new Error('The loopback server sent no endpoint list'));
        return;
      }
      resolve({
        urls,
        totals: () => requestTotals(server),
        stop: () => {
          server.kill();
        },
      });
    });
    server.once('exit', (code) => {
      reject(new Error(`The loopback server exited with code ${String(code)} before it listened`));
    });
  });
}

/** The server answers any message with its counters. */
function requestTotals(server: ChildProcess): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    server.once('message', (message: unknown) => {
      const totals = numberRecordOf(message);
      if (totals === undefined) {
        reject(new Error('The loopback server sent no counters'));
        return;
      }
      resolve(totals);
    });
    server.send('totals');
  });
}

function urlsOf(message: unknown): string[] | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const { urls } = message;
  if (!Array.isArray(urls)) {
    return undefined;
  }
  const strings = urls.filter((url: unknown): url is string => typeof url === 'string');
  return strings.length === urls.length ? strings : undefined;
}
