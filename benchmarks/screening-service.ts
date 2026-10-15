// The screening service of the cycle family's `slow-screening` profile: a service of limited throughput
// that answers at once with what it has judged and keeps working between requests. It listens on
// loopback HTTP inside the benchmark process, so the daemon's `HttpScreening` posts to it as to a
// partner's service while the service reads the chain clock the scenario runs on.

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json } from 'node:stream/consumers';
import { isRecord } from '../src/common/validation.ts';
import type { ScreeningResult } from '../src/core/index.ts';
import { SeededRandom } from './synthetic-history.ts';
import { realDelay } from './synthetic-rpc.ts';
import type { VirtualClock } from './synthetic-rpc.ts';

const HOST = '127.0.0.1';

/** Real time before each answer: the shortest, and how much longer an answer can take. */
const SHORTEST_ANSWER_MS = 500;

const ANSWER_SPREAD_MS = 1_000;

const INCOMPLETE: ScreeningResult = { status: 'incomplete' };

/** The fields of a posted anchor that the service reads. */
interface PostedAnchor {
  readonly id: string;
  readonly transactionHash: string;
}

export interface ScreeningServiceOptions {
  readonly clock: VirtualClock;
  /** Seed of the answer delays. */
  readonly seed: number;
  /** Chain time one worker spends on one transaction. */
  readonly transactionScreeningMs: number;
  /** Transactions judged at once. */
  readonly concurrency: number;
  /** The answer for every judged transaction. */
  readonly judgement: ScreeningResult;
}

export interface ScreeningServiceTotals {
  readonly screeningRequests: number;
  readonly screeningAnchors: number;
  /** Transactions posted again after the service had answered them as judged. */
  readonly transactionsAskedAgain: number;
}

/**
 * Judges each transaction once, in the order it first receives them: each of `concurrency` workers takes
 * the next waiting transaction and spends `transactionScreeningMs` of chain time on it. Every request is
 * answered after 0.5 to 1.5 seconds of real time with the transactions judged by then; the others are
 * incomplete and stay in the queue.
 */
export class ScreeningService {
  readonly #options: ScreeningServiceOptions;

  readonly #random: SeededRandom;

  /** Chain time from which each worker is free. */
  readonly #workerFreeAtMs: number[];

  readonly #judgedAtMsByTransaction = new Map<string, number>();

  readonly #answeredJudged = new Set<string>();

  readonly #server = createServer((request, response) => {
    this.#answer(request, response).catch(() => {
      // The daemon's adapter records the broken request as a failed batch, which the scenario checks.
      response.destroy();
    });
  });

  #requests = 0;

  #anchors = 0;

  #askedAgain = 0;

  constructor(options: ScreeningServiceOptions) {
    this.#options = options;
    this.#random = new SeededRandom(options.seed);
    this.#workerFreeAtMs = Array.from({ length: options.concurrency }, () => 0);
  }

  /** Listen on an ephemeral loopback port and return the service's URL. */
  async listen(): Promise<string> {
    this.#server.listen(0, HOST);
    await once(this.#server, 'listening');
    const address = this.#server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The screening service has no TCP port');
    }
    return `http://${HOST}:${String(address.port)}`;
  }

  close(): void {
    this.#server.close();
  }

  /** Chain time at which the service has judged every transaction it received. */
  finishedAtMs(): number {
    return Math.max(...this.#workerFreeAtMs);
  }

  totals(): ScreeningServiceTotals {
    return {
      screeningRequests: this.#requests,
      screeningAnchors: this.#anchors,
      transactionsAskedAgain: this.#askedAgain,
    };
  }

  async #answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const anchors = readAnchors(await json(request));
    this.#requests += 1;
    this.#anchors += anchors.length;
    for (const anchor of anchors) {
      this.#accept(anchor.transactionHash);
    }
    await realDelay(SHORTEST_ANSWER_MS + this.#random.below(ANSWER_SPREAD_MS + 1));
    const nowMs = this.#options.clock.now();
    const results = anchors.map((anchor) => ({ id: anchor.id, ...this.#judge(anchor.transactionHash, nowMs) }));
    const text = JSON.stringify({ results });
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    response.end(text);
  }

  /** Queue a transaction the service has not received before; count one it has already answered as judged. */
  #accept(transactionHash: string): void {
    if (this.#answeredJudged.has(transactionHash)) {
      this.#askedAgain += 1;
      return;
    }
    if (this.#judgedAtMsByTransaction.has(transactionHash)) {
      return;
    }
    const freeAtMs = Math.min(...this.#workerFreeAtMs);
    const worker = this.#workerFreeAtMs.indexOf(freeAtMs);
    const judgedAtMs = Math.max(this.#options.clock.now(), freeAtMs) + this.#options.transactionScreeningMs;
    this.#workerFreeAtMs[worker] = judgedAtMs;
    this.#judgedAtMsByTransaction.set(transactionHash, judgedAtMs);
  }

  #judge(transactionHash: string, nowMs: number): ScreeningResult {
    const judgedAtMs = this.#judgedAtMsByTransaction.get(transactionHash) ?? Number.POSITIVE_INFINITY;
    if (judgedAtMs > nowMs) {
      return INCOMPLETE;
    }
    this.#answeredJudged.add(transactionHash);
    return this.#options.judgement;
  }
}

/** The posted anchors; a body of another shape is a broken request. */
function readAnchors(body: unknown): PostedAnchor[] {
  const anchors = isRecord(body) ? body.anchors : undefined;
  if (!Array.isArray(anchors)) {
    throw new TypeError('The screening request has no anchors list');
  }
  return anchors.map(readAnchor);
}

function readAnchor(anchor: unknown): PostedAnchor {
  if (!isRecord(anchor)) {
    throw new TypeError('The screening request has an anchor that is not an object');
  }
  const { id, transactionHash } = anchor;
  if (typeof id !== 'string' || typeof transactionHash !== 'string') {
    throw new TypeError('The screening request has an anchor without its id or transaction hash');
  }
  return { id, transactionHash };
}
