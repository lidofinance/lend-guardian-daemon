// Read and validate the application's process configuration on demand, never during import.
import { getAddress, isAddress, isHex, size } from 'viem';
import type { Chain } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { hoodi, mainnet } from 'viem/chains';
import type { Address, Hex } from '../src/core/index.ts';

export type Mode = 'observe' | 'signal';

/** Select one of the application's two Ethereum networks; mainnet is the default. */
export function chain(name: string): Chain {
  const value = process.env[name] ?? String(mainnet.id);
  const selected = [mainnet, hoodi].find((network) => String(network.id) === value);
  if (selected === undefined) {
    throw new Error(`${name} must be 1 (mainnet) or 560048 (Hoodi)`);
  }
  return selected;
}

/** Missing MODE selects the application's read-only execution mode. */
export function mode(name: string): Mode {
  const value = process.env[name];
  if (value === undefined || value === 'observe') {
    return 'observe';
  }
  if (value === 'signal') {
    return 'signal';
  }
  throw new Error(`${name} must be observe or signal`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

export function address(name: string): Address {
  const value = required(name);
  if (!isAddress(value, { strict: true })) {
    throw new Error(`${name} is not an address`);
  }

  return getAddress(value);
}

export function privateKey(name: string): Hex {
  const value = required(name);
  const isPrivateKey = isHex(value, { strict: true }) && size(value) === 32;
  if (!isPrivateKey) {
    throw new Error(`${name} is not a 32-byte hex value`);
  }

  try {
    privateKeyToAddress(value);
  } catch {
    // Do not retain a cryptographic error that may print the supplied key.
    throw new Error(`${name} is not a valid secp256k1 key`);
  }
  return value;
}

export function rpcUrls(name: string): string[] {
  const nodeUrls = required(name)
    .split(',')
    .map((url) => url.trim());
  if (nodeUrls.some((url) => url.length === 0)) {
    throw new Error(`${name} contains an empty URL`);
  }
  if (!nodeUrls.every(isHttpUrl)) {
    throw new Error(`${name} must contain HTTP or HTTPS URLs`);
  }
  return nodeUrls;
}

/** What an unset variable reads as; a reader given none requires its variable. */
interface Fallback<Value> {
  readonly default: Value;
}

/** The default of an unset variable; a variable without one is required. */
function readDefault<Default>(name: string, fallback: Fallback<Default> | undefined): Default {
  if (fallback === undefined) {
    throw new Error(`${name} is not set`);
  }
  return fallback.default;
}

/** An HTTP or HTTPS service URL. */
export function url<Default = never>(name: string, fallback?: Fallback<Default>): string | Default {
  const value = process.env[name];
  if (value === undefined) {
    return readDefault(name, fallback);
  }
  if (!isHttpUrl(value)) {
    throw new Error(`${name} must be an HTTP or HTTPS URL`);
  }
  return value;
}

function isHttpUrl(value: string): boolean {
  const protocol = URL.parse(value)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
}

/**
 * Text for the `User-Agent` header, which must be nonempty and carry no line break or character
 * beyond Latin-1. `fetch` checks a header only when it sends a request, so a bad value is refused here, at start.
 */
export function userAgent<Default = never>(name: string, fallback?: Fallback<Default>): string | Default {
  const value = process.env[name];
  if (value === undefined) {
    return readDefault(name, fallback);
  }
  if (value === '' || !isHeaderValue(value)) {
    throw new Error(`${name} must be nonempty text that an HTTP header can carry`);
  }
  return value;
}

function isHeaderValue(value: string): boolean {
  try {
    new Headers().set('user-agent', value);
    return true;
  } catch {
    // Headers refuses a line break or a character beyond Latin-1, as fetch would on every request.
    return false;
  }
}

/**
 * A decimal integer within the range. Only digits pass, so an empty value, a sign, a fraction or an
 * exponent fails.
 */
export function integer<Default = never>(
  name: string,
  range: { readonly min: number; readonly max?: number },
  fallback?: Fallback<Default>,
): number | Default {
  const text = process.env[name];
  if (text === undefined) {
    return readDefault(name, fallback);
  }
  const value = Number(text);
  const max = range.max ?? Number.MAX_SAFE_INTEGER;
  const isInteger = /^\d+$/.test(text) && Number.isSafeInteger(value);
  const isInRange = value >= range.min && value <= max;
  if (!isInteger || !isInRange) {
    const bounds = range.max === undefined ? `of at least ${range.min}` : `from ${range.min} to ${range.max}`;
    throw new Error(`${name} must be an integer ${bounds}`);
  }
  return value;
}

/** A numeric setting: its value while its environment variable is unset, and the range a set value must fall in. */
export interface Setting {
  readonly default: number;
  readonly min: number;
  readonly max?: number;
}

/** The value of each setting of a table, by the environment variable of its name. */
export type Settings<Table extends Record<string, Setting>> = (name: keyof Table & string) => number;

/**
 * Read every setting of the table at once, from the environment variable of its name or its default,
 * so a value out of its range stops the application before it builds anything.
 */
export function readSettings<Table extends Record<string, Setting>>(table: Table): Settings<Table> {
  const values = new Map<string, number>();
  for (const [name, setting] of Object.entries(table)) {
    values.set(name, integer(name, setting, { default: setting.default }));
  }
  return (name) => {
    const value = values.get(name);
    if (value === undefined) {
      throw new Error(`${name} is not a setting of this table`);
    }
    return value;
  };
}
