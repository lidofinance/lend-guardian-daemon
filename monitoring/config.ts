// The receiver's configuration: two ports, two freshness windows, the identity labels of the daemon it
// watches and, for the optional balance read, the Guardian registry and the RPC endpoints, all from the
// environment. It reads no signing key and no screening credential.

import { readFileSync } from 'node:fs';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The daemon as the pod configures it. The labels come from here rather than from the daemon's
 * `daemon.started`, so they exist before the first event arrives.
 */
export interface DaemonIdentity {
  readonly guardian: string;
  readonly mode: string;
  readonly chainId: string;
}

/**
 * What the balance read needs: the registry that names the Guardian's delegate, and the RPC endpoints,
 * asked in their order. The delegate is read from the registry, so a rotation needs no change here.
 */
export interface BalanceSource {
  /** `GuardianSignals`, the same contract as the daemon's `GUARDIAN_SIGNALS`. */
  readonly registry: string;
  readonly guardian: string;
  /** They may carry provider keys, so a record names an endpoint by its position, never by its URL. */
  readonly rpcUrls: readonly string[];
}

export interface MonitorConfig {
  /** The port of `/metrics`, `/health` and `/ready`. */
  readonly port: number;
  /** The port of `POST /events`, on the loopback interface only. */
  readonly eventsPort: number;
  /** `/ready` is 503 after this long without an accepted event. */
  readonly eventTimeoutSeconds: number;
  /** `/ready` is 503 after this long without a cycle that made progress. */
  readonly cycleTimeoutSeconds: number;
  readonly identity: DaemonIdentity;
  /** Absent unless `GUARDIAN_SIGNALS` and the `RPC_URLS` secret are set: the receiver then reads no chain. */
  readonly balance?: BalanceSource;
}

interface Range {
  readonly fallback: number;
  readonly max: number;
}

/** The daemon's longest timer, `MAX_TIMER_MS` of `example/guardian.ts`, in whole seconds; no window needs more. */
const MAX_WINDOW_SECONDS = 2_147_483;

/**
 * Longer than the daemon's `CYCLE_INTERVAL_MS`, 6 minutes by default: the daemon posts RPC events
 * throughout a cycle and none between cycles.
 */
const EVENT_TIMEOUT: Range = { fallback: 15 * 60, max: MAX_WINDOW_SECONDS };

/** A cycle with screening and a full send budget ends within an hour. */
const CYCLE_TIMEOUT: Range = { fallback: 60 * 60, max: MAX_WINDOW_SECONDS };

const PORT: Range = { fallback: 9464, max: 65_535 };

const EVENTS_PORT: Range = { fallback: 9465, max: 65_535 };

export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function readMonitorConfig(environment: Environment): MonitorConfig {
  const port = readInteger(environment, 'MONITOR_PORT', PORT);
  const eventsPort = readInteger(environment, 'MONITOR_EVENTS_PORT', EVENTS_PORT);
  if (eventsPort === port) {
    throw new Error('MONITOR_EVENTS_PORT must differ from MONITOR_PORT');
  }
  const identity = {
    guardian: readLabel(environment, 'GUARDIAN'),
    mode: readLabel(environment, 'MODE'),
    chainId: readLabel(environment, 'CHAIN_ID'),
  };
  const balance = readBalanceSource(environment, identity.guardian);
  return {
    port,
    eventsPort,
    eventTimeoutSeconds: readInteger(environment, 'MONITOR_EVENT_TIMEOUT_SECONDS', EVENT_TIMEOUT),
    cycleTimeoutSeconds: readInteger(environment, 'MONITOR_CYCLE_TIMEOUT_SECONDS', CYCLE_TIMEOUT),
    identity,
    ...(balance === undefined ? {} : { balance }),
  };
}

/**
 * The registry from `GUARDIAN_SIGNALS` and the endpoints from the `RPC_URLS` secret, or neither. One
 * without the other is refused: the pod meant a balance read that could not run. The read also needs
 * `GUARDIAN`, the identity label, as an address.
 */
function readBalanceSource(environment: Environment, guardian: string): BalanceSource | undefined {
  const registry = environment.GUARDIAN_SIGNALS?.trim();
  const rpcUrls = readRpcUrls(environment);
  if (registry === undefined && rpcUrls === undefined) {
    return undefined;
  }
  if (registry === undefined || rpcUrls === undefined) {
    throw new Error('GUARDIAN_SIGNALS and RPC_URLS must be set together');
  }
  if (!ADDRESS_PATTERN.test(registry)) {
    throw new Error('GUARDIAN_SIGNALS must be a 20-byte hex address');
  }
  if (!ADDRESS_PATTERN.test(guardian)) {
    throw new Error('GUARDIAN must be a 20-byte hex address for the balance read');
  }
  return { registry, guardian, rpcUrls };
}

/**
 * The comma-separated URLs of `RPC_URLS`, or of the file `RPC_URLS_FILE` names, as the daemon reads the
 * same secret. An error names the variable, never what it holds.
 */
function readRpcUrls(environment: Environment): string[] | undefined {
  const value = environment.RPC_URLS;
  const path = environment.RPC_URLS_FILE;
  if (value !== undefined && path !== undefined) {
    throw new Error('RPC_URLS and RPC_URLS_FILE are both set');
  }
  const text = path === undefined ? value : readSecretFile(path);
  if (text === undefined) {
    return undefined;
  }
  const urls = text.split(',').map((url) => url.trim());
  if (!urls.every(isHttpUrl)) {
    throw new Error('RPC_URLS must contain HTTP or HTTPS URLs');
  }
  return urls;
}

function readSecretFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error('RPC_URLS_FILE cannot be read', { cause });
  }
}

function isHttpUrl(text: string): boolean {
  return URL.canParse(text) && /^https?:$/.test(new URL(text).protocol);
}

function readInteger(environment: Environment, name: string, range: Range): number {
  const value = environment[name];
  if (value === undefined) {
    return range.fallback;
  }
  const number = Number(value);
  const isInteger = /^\d+$/.test(value) && Number.isSafeInteger(number);
  const isInRange = number >= 1 && number <= range.max;
  if (!isInteger || !isInRange) {
    throw new Error(`${name} must be an integer from 1 to ${String(range.max)}`);
  }
  return number;
}

/** An identity label; absent means the pod did not say, and the label stays empty. */
function readLabel(environment: Environment, name: string): string {
  return environment[name]?.trim() ?? '';
}
