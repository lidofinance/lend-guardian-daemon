import {
  BaseError,
  HttpRequestError,
  ResponseBodyTooLargeError,
  RpcRequestError,
  TimeoutError,
  custom,
  fallback,
} from 'viem';
import type { EIP1193Parameters, FallbackTransport, Transport } from 'viem';
import { frozenCopy } from '../common/immutable.ts';
import { isRecord, requireInteger } from '../common/validation.ts';
import { emitEvent } from '../events.ts';
import type { EventHandler, RpcRequestFinishedEvent, RpcRequestStartedEvent } from '../events.ts';

export interface ViemRpcTransportOptions {
  readonly urls: readonly string[];
  readonly timeoutMs: number;
  readonly maxResponseBodySize: number | false;
  readonly retryCount: number;
  readonly retryDelayMs: number;
  readonly userAgent: string;
  readonly onEvent?: EventHandler;
}

/** Individually addressable endpoints allow startup checks before using fallback. */
export type ViemRpcTransport = FallbackTransport & { readonly endpoints: readonly Transport[] };

interface RequestTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

type ParsedJson =
  | { readonly status: 'valid'; readonly value: unknown }
  | { readonly status: 'invalid'; readonly error: Error };

type RpcReply =
  | { readonly kind: 'result'; readonly result: unknown }
  | { readonly kind: 'error'; readonly error: JsonRpcError }
  | { readonly kind: 'malformed'; readonly message: string };

const NEITHER_RESULT_NOR_ERROR = 'The RPC endpoint returned neither a result nor a valid error.';

const BOTH_RESULT_AND_ERROR = 'The RPC endpoint returned both result and error.';

const INVALID_ERROR = 'The RPC endpoint returned an invalid error.';

/** The SDK's viem transport: direct HTTP owns an attempt; viem owns retries and endpoint selection. */
export function createViemRpcTransport(options: ViemRpcTransportOptions): ViemRpcTransport {
  if (options.urls.length === 0) {
    throw new RangeError('At least one RPC endpoint is required');
  }
  requireInteger('timeoutMs', options.timeoutMs, { min: 1, max: 2_147_483_647 });
  requireInteger('retryCount', options.retryCount, { min: 0 });
  requireInteger('retryDelayMs', options.retryDelayMs, { min: 0 });
  const endpoints = options.urls.map((url, rpcIndex) => endpointTransport(url, rpcIndex, options));
  const transport = fallback(endpoints, {
    retryCount: options.retryCount,
    retryDelay: options.retryDelayMs,
  });

  return Object.assign(transport, { endpoints });
}

/** One endpoint factory; viem may instantiate it repeatedly, but its HTTP requester is stable. */
function endpointTransport(url: string, rpcIndex: number, options: ViemRpcTransportOptions): Transport {
  const target = requestTarget(url, options.userAgent);
  let nextId = 0;
  const provider = {
    request: (args: EIP1193Parameters): Promise<unknown> => {
      nextId += 1;

      return new HttpAttempt(args, nextId, rpcIndex, target, options).request();
    },
  };

  return custom(provider, {
    key: 'http',
    name: 'Measured HTTP',
    retryCount: 0,
  });
}

/** All mutable measurement state belongs to one physical HTTP request. */
class HttpAttempt {
  readonly #args: EIP1193Parameters;

  readonly #body: Readonly<Record<string, unknown>>;

  readonly #bodyText: string;

  readonly #requestId: number;

  readonly #rpcIndex: number;

  readonly #target: RequestTarget;

  readonly #options: ViemRpcTransportOptions;

  #httpStatus = 0;

  #responseBytes = 0;

  constructor(
    args: EIP1193Parameters,
    id: number,
    rpcIndex: number,
    target: RequestTarget,
    options: ViemRpcTransportOptions,
  ) {
    this.#args = args;
    this.#requestId = id;
    this.#body = {
      jsonrpc: '2.0',
      id,
      method: args.method,
      ...(args.params === undefined ? {} : { params: args.params }),
    };
    this.#bodyText = JSON.stringify(this.#body);
    this.#rpcIndex = rpcIndex;
    this.#target = target;
    this.#options = options;
  }

  async request(): Promise<unknown> {
    const started = this.#started();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new TimeoutError({ body: this.#body, url: this.#target.url }));
    }, this.#options.timeoutMs);
    emitEvent(this.#options.onEvent, started);

    try {
      const response = await fetch(this.#target.url, {
        method: 'POST',
        headers: this.#target.headers,
        body: this.#bodyText,
        signal: controller.signal,
      });
      this.#httpStatus = response.status;
      const text = await this.#responseText(response, controller.signal);
      const result = this.#result(response, text);
      this.#finish(started);

      return result;
    } catch (error) {
      const failure = this.#failure(error, controller.signal);
      this.#finish(started, failure);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  #started(): RpcRequestStartedEvent {
    // viem sends the same parameters on a retry and to the next endpoint, so an observer gets a
    // frozen copy: editing what it received cannot change a later attempt.
    const params = this.#args.params === undefined ? {} : { params: frozenCopy(this.#args.params) };
    return {
      event: 'rpc.requestStarted',
      requestId: this.#requestId,
      rpcIndex: this.#rpcIndex,
      method: this.#args.method,
      ...params,
      startedAt: performance.timeOrigin + performance.now(),
    };
  }

  async #responseText(response: Response, signal: AbortSignal): Promise<string> {
    const limit = this.#options.maxResponseBodySize;
    const contentLength = response.headers.get('Content-Length');
    if (limit !== false && contentLength !== null) {
      const size = Number(contentLength);
      if (size > limit) {
        throw new ResponseBodyTooLargeError({ maxSize: limit, size });
      }
    }
    if (response.body === null) {
      return '';
    }

    return this.#readBody(response.body, signal, limit);
  }

  async #readBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, limit: number | false): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const cancel = (): void => {
      void reader.cancel(signal.reason).catch(() => {
        // The request path reports the timeout; cancellation has no separate outcome.
      });
    };
    signal.addEventListener('abort', cancel, { once: true });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) {
          throw abortReason(signal);
        }
        if (done) {
          return text + decoder.decode();
        }
        this.#responseBytes += value.byteLength;
        if (limit !== false && this.#responseBytes > limit) {
          await reader.cancel();
          throw new ResponseBodyTooLargeError({ maxSize: limit, size: this.#responseBytes });
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }

  #result(response: Response, text: string): unknown {
    const parsed = parsedJson(text);
    if (parsed.status === 'invalid') {
      if (!response.ok) {
        throw this.#httpError(response);
      }
      throw parsed.error;
    }
    const reply = classifyReply(parsed.value);
    // A JSON-RPC error keeps its code and data under any HTTP status. Every other reply of a
    // failed HTTP request is reported with that status, so its retry headers stay available.
    if (reply.kind === 'error') {
      throw new RpcRequestError({ body: this.#body, error: reply.error, url: this.#target.url });
    }
    if (!response.ok) {
      throw this.#httpError(response);
    }
    if (reply.kind === 'malformed') {
      throw new TypeError(reply.message);
    }

    return reply.result;
  }

  #httpError(response: Response): HttpRequestError {
    return new HttpRequestError({
      body: this.#body,
      details: response.statusText,
      headers: response.headers,
      status: response.status,
      url: this.#target.url,
    });
  }

  #failure(error: unknown, signal: AbortSignal): Error {
    if (signal.aborted) {
      return abortReason(signal);
    }
    if (error instanceof BaseError) {
      return error;
    }

    return new HttpRequestError({
      body: this.#body,
      cause: error instanceof Error ? error : undefined,
      url: this.#target.url,
    });
  }

  #finish(started: RpcRequestStartedEvent, error?: unknown): void {
    const finished: RpcRequestFinishedEvent = {
      ...started,
      event: 'rpc.requestFinished',
      finishedAt: performance.timeOrigin + performance.now(),
      httpStatus: this.#httpStatus,
      requestBytes: Buffer.byteLength(this.#bodyText),
      responseBytes: this.#responseBytes,
      ...(error === undefined ? {} : { error }),
    };
    emitEvent(this.#options.onEvent, finished);
  }
}

function requestTarget(url: string, userAgent: string): RequestTarget {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  };

  try {
    const target = new URL(url);
    const hasCredentials = target.username !== '' || target.password !== '';
    if (!hasCredentials) {
      return { url, headers };
    }
    const credentials = `${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`;
    target.username = '';
    target.password = '';

    return {
      url: target.toString(),
      headers: { ...headers, Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` },
    };
  } catch {
    return { url, headers };
  }
}

function parsedJson(text: string): ParsedJson {
  try {
    const parsed: unknown = JSON.parse(text);

    return { status: 'valid', value: parsed };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('The RPC endpoint returned malformed JSON.');

    return { status: 'invalid', error: failure };
  }
}

/**
 * Decide whether a JSON-RPC reply holds a result, an error or neither. Some endpoints send the
 * unused field as null, so a null `error` means no error and a null `result` beside an error is
 * not a result.
 */
function classifyReply(reply: unknown): RpcReply {
  if (!isRecord(reply)) {
    return { kind: 'malformed', message: NEITHER_RESULT_NOR_ERROR };
  }
  const hasResult = Object.hasOwn(reply, 'result');
  const hasError = reply.error !== undefined && reply.error !== null;
  if (!hasError) {
    if (!hasResult) {
      return { kind: 'malformed', message: NEITHER_RESULT_NOR_ERROR };
    }
    return { kind: 'result', result: reply.result };
  }
  const hasResultValue = hasResult && reply.result !== null;
  if (hasResultValue) {
    return { kind: 'malformed', message: BOTH_RESULT_AND_ERROR };
  }
  const error = parseRpcError(reply.error);
  if (error === undefined) {
    return { kind: 'malformed', message: INVALID_ERROR };
  }

  return { kind: 'error', error };
}

function parseRpcError(error: unknown): JsonRpcError | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const { code, message, data } = error;
  if (typeof code !== 'number' || typeof message !== 'string') {
    return undefined;
  }

  return data === undefined ? { code, message } : { code, message, data };
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;

  return reason instanceof Error ? reason : new Error('RPC request aborted');
}
