// Monitoring configuration contains no signer, RPC endpoint or screening credentials.
type Environment = Readonly<Record<string, string | undefined>>;

export interface MonitorConfig {
  readonly port: number;
  readonly progressTimeoutSeconds: number;
}

export function monitorConfig(environment: Environment): MonitorConfig {
  return {
    port: integer(environment, 'MONITOR_PORT', 9464, 65535),
    progressTimeoutSeconds: integer(environment, 'MONITOR_PROGRESS_TIMEOUT_SECONDS', 1800, 2147483),
  };
}

function integer(environment: Environment, name: string, fallback: number, maximum: number): number {
  const text = environment[name];
  if (text === undefined) {
    return fallback;
  }
  const value = Number(text);
  const integer = /^\d+$/.test(text) && Number.isSafeInteger(value);
  const inRange = value > 0 && value <= maximum;
  if (!integer || !inRange) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}
