// Screening over HTTP: the daemon posts the anchors of a cycle to the operator's screening service
// and reads one result per anchor. README.md in this directory defines the request and response.

import type { ScreeningProvider, ScreeningRequest, ScreeningResult, SupplyAnchor } from '../src/core/index.ts';

/**
 * The longest wait for the service. Node's fetch waits at most 300 seconds for response headers, so a
 * longer timeout would never be reached.
 */
export const MAX_SCREENING_TIMEOUT_MS = 290_000;

export class HttpScreening implements ScreeningProvider {
  readonly #url: string;

  readonly #timeoutMs: number;

  /** A service that has not answered within `timeoutMs` fails the attempt, which the next cycle repeats. */
  constructor(url: string, timeoutMs = MAX_SCREENING_TIMEOUT_MS) {
    this.#url = url;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Post every anchor of the request at once, each with its id. Any failure throws, including a
   * result that does not name the anchor at its position, so the attempt sends no report.
   */
  async screen(request: ScreeningRequest): Promise<readonly ScreeningResult[]> {
    const anchors = request.anchors.map((anchor) => ({ id: identifyAnchor(anchor), ...anchor }));
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId: request.chainId, reportBlock: request.reportBlock, anchors }),
      signal: AbortSignal.timeout(this.#timeoutMs),
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
}

/** The id a result names: one supply log, which the block hash pins to one inclusion. */
function identifyAnchor(anchor: SupplyAnchor): string {
  return `${anchor.blockHash}:${anchor.transactionHash}:${anchor.logIndex}`;
}

/**
 * The results in request order. The SDK pairs results with anchors by position, so a service that
 * reorders them would report the wrong borrower; the id each result repeats catches that.
 */
function readResults(body: unknown, ids: readonly string[]): ScreeningResult[] {
  const results = isRecord(body) ? body.results : undefined;
  if (!Array.isArray(results)) {
    throw new Error('Screening response has no results list');
  }
  if (results.length !== ids.length) {
    throw new Error(`Screening response has ${results.length} results for ${ids.length} anchors`);
  }
  return ids.map((id, index) => readResult(results[index], id));
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
