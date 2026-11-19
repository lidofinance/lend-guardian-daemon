// The application's configuration, read once at start: each value from its environment variable or else
// from the JSON file `CONFIG_FILE` names. Keys and URLs, which may carry a credential, are read apart by
// `secrets.ts`. Importing this module reads nothing.
import { readFileSync } from 'node:fs';
import { getAddress, isAddress } from 'viem';
import type { Chain } from 'viem';
import { hoodi, mainnet } from 'viem/chains';
import type { Address } from '../src/core/index.ts';

export type Mode = 'observe' | 'signal';

/** The environment of the process, or the variables a test gives instead. */
export type Variables = Readonly<Record<string, string | undefined>>;

/** The variable that names the JSON configuration file. */
const CONFIG_FILE = 'CONFIG_FILE';

/** What an unset variable reads as; a reader given none requires its variable. */
interface Fallback<Value> {
  readonly default: Value;
}

/** A numeric setting: its value while its variable is unset, and the range a set value must fall in. */
export interface Setting {
  readonly default: number;
  readonly min: number;
  readonly max?: number;
}

/** The value of each setting of a table, by the variable of its name. */
export type Settings<Table extends Record<string, Setting>> = (name: keyof Table & string) => number;

/**
 * The variables of the process and the configuration file they name, both read once. Each reader
 * validates one value; an error names the variable, never its value.
 */
export class Configuration {
  readonly #variables: Variables;

  /** The entries of the configuration file, as the text their variables would hold. */
  readonly #fileValues: ReadonlyMap<string, string>;

  constructor(variables: Variables, fileValues: ReadonlyMap<string, string>) {
    this.#variables = variables;
    this.#fileValues = fileValues;
  }

  /** The variables and the configuration file `CONFIG_FILE` names, which is refused unless all of it is valid. */
  static read(variables: Variables): Configuration {
    const path = variables[CONFIG_FILE];
    return new Configuration(variables, path === undefined ? new Map() : readConfigFile(path));
  }

  /** The path of the configuration file, when `CONFIG_FILE` names one. */
  get configFile(): string | undefined {
    return this.#variables[CONFIG_FILE];
  }

  /** One of the application's two Ethereum networks; mainnet is the default. */
  chain(name: string): Chain {
    const value = this.#value(name) ?? String(mainnet.id);
    const selected = [mainnet, hoodi].find((network) => String(network.id) === value);
    if (selected === undefined) {
      throw new Error(`${name} must be 1 (mainnet) or 560048 (Hoodi)`);
    }
    return selected;
  }

  /** An unset mode selects the application's read-only execution mode. */
  mode(name: string): Mode {
    const value = this.#value(name);
    if (value === undefined || value === 'observe') {
      return 'observe';
    }
    if (value === 'signal') {
      return 'signal';
    }
    throw new Error(`${name} must be observe or signal`);
  }

  address(name: string): Address {
    const value = required(name, this.#value(name));
    if (!isAddress(value, { strict: true })) {
      throw new Error(`${name} is not an address`);
    }
    return getAddress(value);
  }

  /** An HTTP or HTTPS service URL; one that carries no credential, such as the screening service's. */
  url<Default = never>(name: string, fallback?: Fallback<Default>): string | Default {
    const value = this.#value(name);
    if (value === undefined) {
      return readDefault(name, fallback);
    }
    return httpUrl(name, value);
  }

  /**
   * Text for the `User-Agent` header, which must be nonempty and carry no line break or character
   * beyond Latin-1. `fetch` checks a header only when it sends a request, so a bad value is refused here, at start.
   */
  userAgent<Default = never>(name: string, fallback?: Fallback<Default>): string | Default {
    const value = this.#value(name);
    if (value === undefined) {
      return readDefault(name, fallback);
    }
    if (value === '' || !isHeaderValue(value)) {
      throw new Error(`${name} must be nonempty text that an HTTP header can carry`);
    }
    return value;
  }

  /**
   * A decimal integer within the range. Only digits pass, so an empty value, a sign, a fraction or an
   * exponent fails.
   */
  integer<Default = never>(
    name: string,
    range: { readonly min: number; readonly max?: number },
    fallback?: Fallback<Default>,
  ): number | Default {
    const text = this.#value(name);
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

  /**
   * Every setting of the table at once, from the variable of its name or its default, so a value out of
   * its range stops the application before it builds anything.
   */
  readSettings<Table extends Record<string, Setting>>(table: Table): Settings<Table> {
    const values = new Map<string, number>();
    for (const [name, setting] of Object.entries(table)) {
      values.set(name, this.integer(name, setting, { default: setting.default }));
    }
    return (name) => {
      const value = values.get(name);
      if (value === undefined) {
        throw new Error(`${name} is not a setting of this table`);
      }
      return value;
    };
  }

  /** A value that is not a credential: its variable, else the configuration file. */
  #value(name: string): string | undefined {
    return this.#variables[name] ?? this.#fileValues.get(name);
  }
}

/** The entries of the configuration file: one JSON object whose values are strings or numbers. */
function readConfigFile(path: string): ReadonlyMap<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`${CONFIG_FILE} cannot be read`, { cause });
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${CONFIG_FILE} is not JSON`, { cause });
  }
  if (!isJsonObject(config)) {
    throw new Error(`${CONFIG_FILE} must hold a JSON object`);
  }
  return new Map(Object.entries(config).map(([name, value]) => [name, toVariableText(name, value)]));
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  const isObject = typeof value === 'object' && value !== null;
  return isObject && !Array.isArray(value);
}

/** A value of the configuration file as the text its variable would hold. */
function toVariableText(name: string, value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  throw new Error(`${name} in ${CONFIG_FILE} must be a string or a number`);
}

function required(name: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** The default of an unset variable; a variable without one is required. */
function readDefault<Default>(name: string, fallback: Fallback<Default> | undefined): Default {
  if (fallback === undefined) {
    throw new Error(`${name} is not set`);
  }
  return fallback.default;
}

/** An HTTP or HTTPS URL. */
function httpUrl(name: string, value: string): string {
  if (!isHttpUrl(value)) {
    throw new Error(`${name} must be an HTTP or HTTPS URL`);
  }
  return value;
}

/** Whether the text is an HTTP or HTTPS URL. */
export function isHttpUrl(value: string): boolean {
  const protocol = URL.parse(value)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
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
