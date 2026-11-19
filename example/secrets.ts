// The application's secrets: each key or URL that may carry a credential, read once at start from its environment
// variable or from the file `<NAME>_FILE` names, their readers by format, and their mask in text. Importing this
// module reads nothing.
import { readFileSync } from 'node:fs';
import { isHex, size } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import type { Hex } from '../src/core/index.ts';
import { isHttpUrl } from './configuration.ts';
import type { Variables } from './configuration.ts';

/** What `mask` puts in place of a secret. */
export const MASK = '***';

/** A shorter value is not masked: it would hide ordinary text. */
const MIN_MASKED_LENGTH = 5;

/**
 * A shorter password, path segment or query value of a URL is not masked: a provider key is longer, and short parts
 * such as `v3` or `screening` are ordinary text.
 */
const MIN_MASKED_URL_PART_LENGTH = 16;

/**
 * The secrets of the given names, their readers, and their mask. `mask` replaces each secret in a text with `***`: the value itself,
 * each URL of a comma-separated URL list, and for a URL the form without userinfo that the transport prints and its
 * long password, path segments and query values. A transformed value, for example in Base64, is not masked.
 */
export class Secrets {
  readonly #values: ReadonlyMap<string, string>;

  /** The forms `mask` replaces, longest first, so a form inside a longer one does not leave the rest of it. */
  readonly #forms: readonly string[];

  constructor(values: ReadonlyMap<string, string>) {
    this.#values = values;
    const forms = new Set([...values.values()].flatMap(maskedForms));
    this.#forms = [...forms].sort((left, right) => right.length - left.length);
  }

  /**
   * Each secret of `names` from its variable, or from the file `<NAME>_FILE` names, trimmed. Throws for a secret in
   * both forms and for a file that cannot be read; an error names the variable, never its value.
   */
  static read(names: readonly string[], variables: Variables): Secrets {
    const values = new Map<string, string>();
    for (const name of names) {
      const value = readSecret(name, variables);
      if (value !== undefined) {
        values.set(name, value);
      }
    }
    return new Secrets(values);
  }

  /** The value of a secret, or `undefined` when it is not set. */
  value(name: string): string | undefined {
    return this.#values.get(name);
  }

  /** The value of a secret; throws an error that names the secret when it is not set. */
  required(name: string): string {
    const value = this.#values.get(name);
    if (value === undefined) {
      throw new Error(`${name} is not set`);
    }
    return value;
  }

  /**
   * A comma-separated list of HTTP or HTTPS URLs, each trimmed, in their order. Throws when the secret is not set, or
   * when an entry is empty or not such a URL.
   */
  urlList(name: string): string[] {
    const urls = this.required(name)
      .split(',')
      .map((url) => url.trim());
    if (urls.some((url) => url.length === 0)) {
      throw new Error(`${name} contains an empty URL`);
    }
    if (!urls.every(isHttpUrl)) {
      throw new Error(`${name} must contain HTTP or HTTPS URLs`);
    }
    return urls;
  }

  /**
   * A 32-byte hex secp256k1 private key. Throws when the secret is not set or is not such a key, and the error names
   * the secret, never its value.
   */
  privateKey(name: string): Hex {
    const value = this.required(name);
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

  /** The text with each secret, in each of its forms, replaced with `***`. */
  mask(text: string): string {
    return this.#forms.reduce((masked, form) => masked.replaceAll(form, MASK), text);
  }
}

/** One secret: its variable, or the trimmed text of the file `<NAME>_FILE` names, as an orchestrator mounts a secret. */
function readSecret(name: string, variables: Variables): string | undefined {
  const value = variables[name];
  const path = variables[`${name}_FILE`];
  if (path === undefined) {
    return value;
  }
  if (value !== undefined) {
    throw new Error(`${name} and ${name}_FILE are both set`);
  }
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (cause) {
    // The error names the variable, never what the file holds.
    throw new Error(`${name}_FILE cannot be read`, { cause });
  }
}

/** The texts `mask` replaces for one secret: the value, the URLs of a URL list, and the forms of each URL. */
function maskedForms(value: string): string[] {
  const entries = urlEntries(value);
  return [value, ...entries, ...entries.flatMap(urlForms)].filter((text) => text.length >= MIN_MASKED_LENGTH);
}

/** The URLs of a comma-separated URL list, such as `RPC_URLS`; a comma that does not separate URLs splits nothing. */
function urlEntries(value: string): string[] {
  const parts = value.split(',').map((part) => part.trim());
  return parts.every((part) => URL.canParse(part)) ? parts : [value];
}

/** A URL without its userinfo, as the transport prints it, and its long password, path segments and query values. */
function urlForms(text: string): string[] {
  if (!URL.canParse(text)) {
    return [];
  }
  const url = new URL(text);
  const parts = [url.password, ...url.pathname.split('/'), ...url.searchParams.values()];
  url.username = '';
  url.password = '';
  return [url.href, ...parts.filter((part) => part.length >= MIN_MASKED_URL_PART_LENGTH)];
}
