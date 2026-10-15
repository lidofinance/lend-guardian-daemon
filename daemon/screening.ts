// Screening over HTTP: the daemon posts the anchors of a cycle to the operator's screening service in
// batches, reads one result per anchor and keeps the judged ones for the next cycle. README.md in this
// directory defines the request and response.

import type { ScreeningProvider, ScreeningRequest, ScreeningResult, SupplyAnchor } from '../src/core/index.ts';

/**
 * The longest wait for one request. Node's fetch waits at most 300 seconds for response headers, so a
 * longer timeout would never be reached.
 */
export const MAX_SCREENING_TIMEOUT_MS = 290_000;

/** Anchors in one request unless `batchSize` says otherwise: about half a megabyte of JSON. */
export const DEFAULT_SCREENING_BATCH_SIZE = 1_000;

/** The wait for the whole screening unless `budgetMs` says otherwise. */
export const DEFAULT_SCREENING_BUDGET_MS = 20 * 60_000;

/** One request to the service, which the daemon reports by the same path as the SDK's events. */
export interface ScreeningBatchEvent {
  readonly event: 'screening-batch';
  readonly anchors: number;
  readonly judged: number;
  readonly incomplete: number;
  /** Why the request gave no usable answer: its status, its shape or its timeout. */
  readonly error?: unknown;
}

export interface HttpScreeningOptions {
  /** Anchors in one request. */
  readonly batchSize?: number;
  /** The wait for one request's answer. */
  readonly timeoutMs?: number;
  /** The wait for the whole screening; the anchors not asked about by then are incomplete. */
  readonly budgetMs?: number;
  /** Receives one event per request to the service; an error it throws does not change the screening. */
  readonly onEvent?: (event: ScreeningBatchEvent) => void;
}

const INCOMPLETE: ScreeningResult = { status: 'incomplete' };

export class HttpScreening implements ScreeningProvider {
  readonly #url: string;

  readonly #batchSize: number;

  readonly #timeoutMs: number;

  readonly #budgetMs: number;

  readonly #onEvent: ((event: ScreeningBatchEvent) => void) | undefined;

  /** The judged answers of the last screening, by anchor id: what the next cycle need not ask about again. */
  #judged: ReadonlyMap<string, ScreeningResult> = new Map();

  constructor(url: string, options: HttpScreeningOptions = {}) {
    this.#url = url;
    this.#batchSize = options.batchSize ?? DEFAULT_SCREENING_BATCH_SIZE;
    this.#timeoutMs = options.timeoutMs ?? MAX_SCREENING_TIMEOUT_MS;
    this.#budgetMs = options.budgetMs ?? DEFAULT_SCREENING_BUDGET_MS;
    this.#onEvent = options.onEvent;
  }

  /**
   * Answer every anchor of the request, in request order: from the judged answers of the last
   * screening where it has one, and from the service for the rest, posted in batches, one request at
   * a time. A request that fails, answers in a shape the daemon cannot act on or outlasts its wait
   * leaves its anchors incomplete, reported with the cause; so does the budget running out, without a
   * request. The judged answers are kept for the next cycle, so a service without state of its own is
   * asked about an anchor until it has answered. Only the answers for this request's anchors stay: an
   * anchor a heartbeat covered never comes back.
   */
  async screen(request: ScreeningRequest): Promise<readonly ScreeningResult[]> {
    const asked = request.anchors.filter((anchor) => !this.#judged.has(identifyAnchor(anchor)));
    const answers = new Map([...this.#judged, ...(await this.#askInBatches({ ...request, anchors: asked }))]);
    const results: ScreeningResult[] = [];
    const judged = new Map<string, ScreeningResult>();
    for (const anchor of request.anchors) {
      const answer = answerFor(answers, anchor);
      results.push(answer);
      if (answer.status === 'judged') {
        judged.set(identifyAnchor(anchor), answer);
      }
    }
    this.#judged = judged;
    return results;
  }

  /** The service's answer for each anchor, by anchor id, from requests of at most `batchSize` within the budget. */
  async #askInBatches(request: ScreeningRequest): Promise<Map<string, ScreeningResult>> {
    const deadline = Date.now() + this.#budgetMs;
    const answers = new Map<string, ScreeningResult>();
    for (let from = 0; from < request.anchors.length; from += this.#batchSize) {
      const anchors = request.anchors.slice(from, from + this.#batchSize);
      const remainingMs = deadline - Date.now();
      const batch =
        remainingMs > 0
          ? await this.#ask({ ...request, anchors }, Math.min(this.#timeoutMs, remainingMs))
          : incompleteFor(anchors);
      for (const [id, answer] of batch) {
        answers.set(id, answer);
      }
    }
    return answers;
  }

  /** One request; its anchors are incomplete when it gives no usable answer, and the event says why. */
  async #ask(request: ScreeningRequest, timeoutMs: number): Promise<Map<string, ScreeningResult>> {
    const anchors = request.anchors.length;
    let results: Map<string, ScreeningResult>;
    try {
      results = await post(this.#url, request, timeoutMs);
    } catch (error) {
      // Incompleteness returned explicitly: the cause goes to the event, and the next cycle asks again.
      this.#emit({ event: 'screening-batch', anchors, judged: 0, incomplete: anchors, error });
      return incompleteFor(request.anchors);
    }
    const judged = [...results.values()].filter((result) => result.status === 'judged').length;
    this.#emit({ event: 'screening-batch', anchors, judged, incomplete: anchors - judged });
    return results;
  }

  /** Report the event; an observer's failure must not change the screening it observes. */
  #emit(event: ScreeningBatchEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // The event is lost; the answers stand.
    }
  }
}

/** The id a result names: one supply log, which the block hash pins to one inclusion. */
function identifyAnchor(anchor: SupplyAnchor): string {
  return `${anchor.blockHash}:${anchor.transactionHash}:${anchor.logIndex}`;
}

/** An incomplete answer for each anchor, by anchor id. */
function incompleteFor(anchors: readonly SupplyAnchor[]): Map<string, ScreeningResult> {
  return new Map(anchors.map((anchor) => [identifyAnchor(anchor), INCOMPLETE]));
}

/** The answer for the anchor; every anchor of a screening has one, kept or fresh. */
function answerFor(answers: ReadonlyMap<string, ScreeningResult>, anchor: SupplyAnchor): ScreeningResult {
  const answer = answers.get(identifyAnchor(anchor));
  if (answer === undefined) {
    throw new Error(`Screening has no answer for anchor ${identifyAnchor(anchor)}`);
  }
  return answer;
}

/** Post every anchor of the request with its id and read the results by anchor id. */
async function post(url: string, request: ScreeningRequest, timeoutMs: number): Promise<Map<string, ScreeningResult>> {
  const anchors = request.anchors.map((anchor) => ({ id: identifyAnchor(anchor), ...anchor }));
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: request.chainId, reportBlock: request.reportBlock, anchors }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Screening service answered with HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  return readResults(
    body,
    anchors.map(({ id }) => id),
  );
}

/**
 * The results by anchor id. The SDK pairs results with anchors by position, so a service that
 * reorders them would report the wrong borrower; the id each result repeats, at its position, catches that.
 */
function readResults(body: unknown, ids: readonly string[]): Map<string, ScreeningResult> {
  const results = isRecord(body) ? body.results : undefined;
  if (!Array.isArray(results)) {
    throw new Error('Screening response has no results list');
  }
  if (results.length !== ids.length) {
    throw new Error(`Screening response has ${results.length} results for ${ids.length} anchors`);
  }
  return new Map(ids.map((id, index) => [id, readResult(results[index], id)]));
}

function readResult(entry: unknown, id: string): ScreeningResult {
  if (!isRecord(entry) || entry.id !== id) {
    throw new Error(`Screening response does not answer anchor ${id} at its position`);
  }
  if (!isScreeningResult(entry)) {
    throw new Error(`Screening response has a malformed result for anchor ${id}`);
  }
  return entry;
}

/** A known status, both decisions when judged, and an evidence reference that is text or absent. */
function isScreeningResult(entry: Readonly<Record<string, unknown>>): entry is ScreeningResult {
  const reference = entry.evidenceReference;
  const hasNoReference = reference === undefined || reference === null;
  if (!hasNoReference && typeof reference !== 'string') {
    return false;
  }
  if (entry.status === 'incomplete') {
    return true;
  }
  const hasDecisions = typeof entry.requiresSuspect === 'boolean' && typeof entry.requiresFlag === 'boolean';
  return entry.status === 'judged' && hasDecisions;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
