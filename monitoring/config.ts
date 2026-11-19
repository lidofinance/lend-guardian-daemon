// The receiver's configuration: two ports, two freshness windows and the identity labels of the daemon it
// watches, all from the environment. It reads no signer, RPC endpoint or screening credential.

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

export function readMonitorConfig(environment: Environment): MonitorConfig {
  const port = readInteger(environment, 'MONITOR_PORT', PORT);
  const eventsPort = readInteger(environment, 'MONITOR_EVENTS_PORT', EVENTS_PORT);
  if (eventsPort === port) {
    throw new Error('MONITOR_EVENTS_PORT must differ from MONITOR_PORT');
  }
  return {
    port,
    eventsPort,
    eventTimeoutSeconds: readInteger(environment, 'MONITOR_EVENT_TIMEOUT_SECONDS', EVENT_TIMEOUT),
    cycleTimeoutSeconds: readInteger(environment, 'MONITOR_CYCLE_TIMEOUT_SECONDS', CYCLE_TIMEOUT),
    identity: {
      guardian: readLabel(environment, 'GUARDIAN'),
      mode: readLabel(environment, 'MODE'),
      chainId: readLabel(environment, 'CHAIN_ID'),
    },
  };
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
