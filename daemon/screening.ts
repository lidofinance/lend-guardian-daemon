// Screening over HTTP: the daemon posts the anchors of a cycle to the operator's screening service in
// batches, up to a set number at once, reads one result per anchor and keeps the judged ones for the
// next cycle. README.md in this directory defines the request and response.

import type { ScreeningProvider, ScreeningRequest, ScreeningResult, SupplyAnchor } from '../src/core/index.ts';

/**
 * The longest wait for one request. Node's fetch waits at most 300 seconds for response headers, so a
 * longer timeout would never be reached.
 */
export const MAX_SCREENING_TIMEOUT_MS = 290_000;

/** Anchors in one request unless `batchSize` says otherwise: about half a megabyte of JSON. */
export const DEFAULT_SCREENING_BATCH_SIZE = 1_000;

/** Requests open at once unless `concurrency` says otherwise: one at a time. */
export const DEFAULT_SCREENING_CONCURRENCY = 1;

/** The wait for the whole screening unless `budgetMs` says otherwise. */
export const DEFAULT_SCREENING_BUDGET_MS = 20 * 60_000;

/** One request to the service, which the daemon reports by the same path as the SDK's events. */
export interface ScreeningRequestFinishedEvent {
  readonly event: 'screening.requestFinished';
  readonly anchors: number;
  readonly judged: number;
  readonly incomplete: number;
  /** Unix milliseconds of the request and of its end, as in the SDK's RPC events. */
  readonly startedAt: number;
  readonly finishedAt: number;
  /** The status the service answered with; absent when no answer arrived. */
  readonly httpStatus?: number;
  /** Why the request gave no usable answer: its status, its shape or its timeout. */
  readonly error?: unknown;
}

export interface HttpScreeningOptions {
  /** Anchors in one request. */
  readonly batchSize?: number;
  /** Requests open at once. */
  readonly concurrency?: number;
  /** The wait for one request's answer. */
  readonly timeoutMs?: number;
  /** The wait for the whole screening; the anchors not asked about by then are incomplete. */
  readonly budgetMs?: number;
  /** The `User-Agent` of every request; fetch's own when absent. */
  readonly userAgent?: string;
  /**
   * Receives one event per request to the service; an error it throws or a promise it rejects does not
   * change the screening.
   */
  readonly onEvent?: (event: ScreeningRequestFinishedEvent) => unknown;
}

const INCOMPLETE: ScreeningResult = { status: 'incomplete' };

/** What a request's event says beside its count and times: the answers, and why there are none. */
type RequestOutcome = Omit<ScreeningRequestFinishedEvent, 'event' | 'anchors' | 'startedAt' | 'finishedAt'>;

export class HttpScreening implements ScreeningProvider {
  readonly #url: string;

  readonly #batchSize: number;

  readonly #concurrency: number;

  readonly #timeoutMs: number;

  readonly #budgetMs: number;

  readonly #headers: Readonly<Record<string, string>>;

  readonly #onEvent: ((event: ScreeningRequestFinishedEvent) => unknown) | undefined;

  /** The judged answers of the last screening, by anchor id: what the next cycle need not ask about again. */
  #judged: ReadonlyMap<string, ScreeningResult> = new Map();

  constructor(url: string, options: HttpScreeningOptions = {}) {
    this.#url = url;
    this.#batchSize = options.batchSize ?? DEFAULT_SCREENING_BATCH_SIZE;
    this.#concurrency = options.concurrency ?? DEFAULT_SCREENING_CONCURRENCY;
    this.#timeoutMs = options.timeoutMs ?? MAX_SCREENING_TIMEOUT_MS;
    this.#budgetMs = options.budgetMs ?? DEFAULT_SCREENING_BUDGET_MS;
    const userAgent = options.userAgent === undefined ? {} : { 'user-agent': options.userAgent };
    this.#headers = { 'content-type': 'application/json', ...userAgent };
    this.#onEvent = options.onEvent;
  }

  /**
   * Answer every anchor of the request, in request order: from the judged answers of the last
   * screening where it has one, and from the service for the rest, posted in batches, up to
   * `concurrency` requests at once. A request that fails, answers in a shape the daemon cannot act on or outlasts its wait
   * leaves its anchors incomplete, reported with the cause; so does the budget running out, without a
   * request. The judged answers are kept for the next cycle, so a service without state of its own is
   * asked about an anchor until it has answered. Only the answers for this request's anchors stay: an
   * anchor a heartbeat covered never comes back.
   */
  async screen(request: ScreeningRequest): Promise<readonly ScreeningResult[]> {
    const asked = request.anchors.filter((anchor) => !this.#judged.has(identifyAnchor(anchor)));
    const answers = new Map([...this.#judged, ...(await this.#askService({ ...request, anchors: asked }))]);
    const results: ScreeningResult[] = [];
    const judged = new Map<string, ScreeningResult>();
    for (const anchor of request.anchors) {
      const id = identifyAnchor(anchor);
      const answer = answers.get(id);
      if (answer === undefined) {
        throw new Error(`Screening has no answer for anchor ${id}`);
      }
      results.push(answer);
      if (answer.status === 'judged') {
        judged.set(id, answer);
      }
    }
    this.#judged = judged;
    return results;
  }

  /**
   * The service's answer for each anchor, by anchor id, from requests of at most `batchSize`, up to
   * `concurrency` of them open at once, within the budget.
   */
  async #askService(request: ScreeningRequest): Promise<Map<string, ScreeningResult>> {
    const deadline = Date.now() + this.#budgetMs;
    const waiting: (readonly SupplyAnchor[])[] = [];
    for (let from = 0; from < request.anchors.length; from += this.#batchSize) {
      waiting.push(request.anchors.slice(from, from + this.#batchSize));
    }
    const answers = new Map<string, ScreeningResult>();
    // Each worker takes the next batch as soon as its request ends, so a slow request holds only its own worker.
    const work = async (): Promise<void> => {
      while (true) {
        const anchors = waiting.shift();
        if (anchors === undefined) {
          return;
        }
        const remainingMs = deadline - Date.now();
        const batch =
          remainingMs > 0
            ? await this.#askBatch({ ...request, anchors }, Math.min(this.#timeoutMs, remainingMs))
            : markIncomplete(anchors);
        for (const [id, answer] of batch) {
          answers.set(id, answer);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, waiting.length) }, work));
    return answers;
  }

  /**
   * One request; its anchors are incomplete when it gives no usable answer, and the event says why. An
   * incomplete answer is returned explicitly, and the next cycle asks about those anchors again.
   */
  async #askBatch(request: ScreeningRequest, timeoutMs: number): Promise<Map<string, ScreeningResult>> {
    const anchorCount = request.anchors.length;
    const startedAt = Date.now();
    const report = (outcome: RequestOutcome): void => {
      const { judged, incomplete, ...cause } = outcome;
      const finishedAt = Date.now();
      this.#emit({
        event: 'screening.requestFinished',
        anchors: anchorCount,
        judged,
        incomplete,
        startedAt,
        finishedAt,
        ...cause,
      });
    };
    let response: Response;
    try {
      response = await this.#post(request, timeoutMs);
    } catch (error) {
      // No answer arrived: the request failed or outlasted its wait.
      report({ judged: 0, incomplete: anchorCount, error });
      return markIncomplete(request.anchors);
    }
    try {
      const results = await readAnswer(response, request.anchors.map(identifyAnchor));
      const judged = [...results.values()].filter((result) => result.status === 'judged').length;
      report({ judged, incomplete: anchorCount - judged, httpStatus: response.status });
      return results;
    } catch (error) {
      // An answer the daemon cannot act on: another status, or a body without one valid result per anchor.
      report({ judged: 0, incomplete: anchorCount, httpStatus: response.status, error });
      return markIncomplete(request.anchors);
    }
  }

  /**
   * Post every anchor of the request with its id, and the wait for the answer in `x-request-timeout-ms`, so the
   * service can answer what it has judged before then instead of losing the whole request to the timeout.
   */
  #post(request: ScreeningRequest, timeoutMs: number): Promise<Response> {
    const anchors = request.anchors.map((anchor) => ({ id: identifyAnchor(anchor), ...anchor }));
    return fetch(this.#url, {
      method: 'POST',
      headers: { ...this.#headers, 'x-request-timeout-ms': String(timeoutMs) },
      body: JSON.stringify({ chainId: request.chainId, reportBlock: request.reportBlock, anchors }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** Report the event; an observer's failure, thrown or rejected, must not change the screening it observes. */
  #emit(event: ScreeningRequestFinishedEvent): void {
    try {
      void Promise.resolve(this.#onEvent?.(event)).catch(() => {
        // An asynchronous observer failure is lost; the answers stand.
      });
    } catch {
      // A synchronous observer failure is lost; the answers stand.
    }
  }
}

/** The id a result names: one supply log, which the block hash pins to one inclusion. */
function identifyAnchor(anchor: SupplyAnchor): string {
  return `${anchor.blockHash}:${anchor.transactionHash}:${anchor.logIndex}`;
}

/** The results of a successful answer by anchor id; throws for another status or a body the daemon cannot use. */
async function readAnswer(response: Response, ids: readonly string[]): Promise<Map<string, ScreeningResult>> {
  if (!response.ok) {
    // Only a read or cancelled body returns the connection to undici's pool; a body that fails to cancel
    // leaves only that connection unused, and the status is still the cause.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Screening service answered with HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  return readResults(body, ids);
}

/** An incomplete answer for each anchor, by anchor id. */
function markIncomplete(anchors: readonly SupplyAnchor[]): Map<string, ScreeningResult> {
  return new Map(anchors.map((anchor) => [identifyAnchor(anchor), INCOMPLETE]));
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
  // An empty reference says no more than none, and the SDK refuses it, so it is read as none.
  return entry.evidenceReference === '' ? { ...entry, evidenceReference: null } : entry;
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

/** A parsed JSON object, whose fields the daemon reads; an array is none. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  const isObject = typeof value === 'object' && value !== null;
  return isObject && !Array.isArray(value);
}
