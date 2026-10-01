// Read and validate the example's process configuration on demand, never during import.
import { getAddress, isAddress, isHex, size } from 'viem';
import type { Chain } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { hoodi, mainnet } from 'viem/chains';
import type { Address, Hex } from '../src/core/index.ts';

export type Mode = 'observe' | 'signal';

/** Select one of the example's two Ethereum networks; mainnet is the default. */
export function chain(name: string): Chain {
  const value = process.env[name] ?? String(mainnet.id);
  const selected = [mainnet, hoodi].find((network) => String(network.id) === value);
  if (selected === undefined) {
    throw new Error(`${name} must be 1 (mainnet) or 560048 (Hoodi)`);
  }
  return selected;
}

/** Missing MODE selects the example's read-only execution mode. */
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

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    // A parsing failure means the configured value is not a usable URL.
    return false;
  }
}

/**
 * An unset variable leaves the setting at the caller's default; a set one must be a decimal integer
 * within the range. Only digits pass, so an empty value, a sign, a fraction or an exponent fails.
 */
export function optionalInteger(
  name: string,
  range: { readonly min: number; readonly max?: number },
): number | undefined {
  const text = process.env[name];
  if (text === undefined) {
    return undefined;
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

/** An unset variable leaves the setting off; a set one must be a positive integer. */
export function optionalPositiveInteger(name: string): number | undefined {
  return process.env[name] === undefined ? undefined : positiveInteger(name);
}

/** An empty value reads as zero, so it fails here too rather than passing as zero. */
export function positiveInteger(name: string): number {
  const value = Number(required(name));
  const isWhole = Number.isSafeInteger(value);
  if (!isWhole || value <= 0) {
    throw new Error(`${name} is not a positive integer`);
  }

  return value;
}
