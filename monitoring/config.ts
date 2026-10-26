// The receiver's configuration: a port, two freshness windows and the identity labels of the daemon it
// watches, all from the environment. It reads no signer, RPC endpoint or screening credential.

type Environment = Readonly<Record<string, string | undefined>>;

/** What the pod's values say the daemon is; the stream itself carries no identity record. */
export interface DaemonIdentity {
  readonly guardian: string;
  readonly mode: string;
  readonly chainId: string;
}

export interface MonitorConfig {
  readonly port: number;
  /** `/ready` is 503 after this long without an accepted event. */
  readonly eventTimeoutSeconds: number;
  /** `/ready` is 503 after this long without a finished or failed cycle. */
  readonly cycleTimeoutSeconds: number;
  readonly identity: DaemonIdentity;
}

interface Range {
  readonly fallback: number;
  readonly max: number;
}

/** The daemon posts RPC requests throughout a cycle and pauses six minutes between cycles. */
const EVENT_TIMEOUT: Range = { fallback: 15 * 60, max: 2_147_483 };

/** A cycle with screening and a full send budget ends within an hour. */
const CYCLE_TIMEOUT: Range = { fallback: 60 * 60, max: 2_147_483 };

const PORT: Range = { fallback: 9464, max: 65_535 };

export function monitorConfig(environment: Environment): MonitorConfig {
  return {
    port: integer(environment, 'MONITOR_PORT', PORT),
    eventTimeoutSeconds: integer(environment, 'MONITOR_EVENT_TIMEOUT_SECONDS', EVENT_TIMEOUT),
    cycleTimeoutSeconds: integer(environment, 'MONITOR_CYCLE_TIMEOUT_SECONDS', CYCLE_TIMEOUT),
    identity: {
      guardian: text(environment, 'GUARDIAN'),
      mode: text(environment, 'MODE'),
      chainId: text(environment, 'CHAIN_ID'),
    },
  };
}

function integer(environment: Environment, name: string, range: Range): number {
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
function text(environment: Environment, name: string): string {
  return environment[name]?.trim() ?? '';
}
