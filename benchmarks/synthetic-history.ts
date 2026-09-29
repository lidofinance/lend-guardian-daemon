// Lending history in chain order: supplies classified by their market controller, drains and
// maturations, each with the post-event position the controller records. It follows the transitions
// the specification documents; it does not model every contract rule, such as which operations may
// drain part of a bucket.

import { encodeAbiParameters, numberToHex } from 'viem';
import type { Address, MarketId } from '../src/core/index.ts';
import { addressTopic, timestampOf, TOPICS } from './synthetic-rpc.ts';
import type { SyntheticChain } from './synthetic-rpc.ts';

/** The account that calls `supplyCollateral`; each supply credits a separate borrower. */
const SUPPLIER: Address = '0x00000000000000000000000000000000005e1f00';

/** A static tuple encodes in place, so the `Position` fields follow the amount as flat words. */
const LIFECYCLE_DATA = [
  { type: 'uint256' },
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'uint40' },
  { type: 'uint32' },
] as const;

/** Identifier families carry distinct high bytes, so no market, controller or borrower collides. */
const MARKET_TAG = 0x6d6bn << 240n;

const CONTROLLER_TAG = 0xc0n << 152n;

const BORROWER_TAG = 0xb0n << 152n;

/** One borrower's delayed collateral as its controller holds it; the builder advances it. */
interface PositionState {
  dust: bigint;
  activating: bigint;
  activatingStart: number;
  activatingDelay: number;
}

type LifecycleKind = 'dusted' | 'activating' | 'drained';

/** Where a lifecycle event is logged. */
interface EventPlace {
  readonly controller: Address;
  readonly borrower: Address;
  readonly blockNumber: number;
  readonly transactionIndex: number;
}

/** A market as the history created it; `controller` is null when the core names no controller. */
export interface Market {
  readonly id: MarketId;
  readonly controller: Address | null;
}

export type Classification = 'dusted' | 'activating' | 'unclassified';

interface PositionInput {
  readonly market: Market;
  readonly borrower: Address;
}

interface SupplyInput extends PositionInput {
  readonly assets: bigint;
  /** The base delay of a lot this supply starts; a top-up keeps the lot's deadline. */
  readonly delaySeconds: number;
}

export function marketIdAt(index: number): MarketId {
  return numberToHex(MARKET_TAG | BigInt(index), { size: 32 });
}

export function controllerAt(index: number): Address {
  return numberToHex(CONTROLLER_TAG | BigInt(index), { size: 20 });
}

export function borrowerAt(index: number): Address {
  return numberToHex(BORROWER_TAG | BigInt(index), { size: 20 });
}

/** Deterministic pseudo-random integers (mulberry32), so one seed reproduces one history. */
export class SeededRandom {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** An integer in `[0, bound)`. */
  below(bound: number): number {
    this.#state = (this.#state + 0x6d2b79f5) | 0;
    let value = Math.imul(this.#state ^ (this.#state >>> 15), 1 | this.#state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return Math.floor((((value ^ (value >>> 14)) >>> 0) / 4_294_967_296) * bound);
  }
}

/** Appends a consistent lending history to a synthetic chain, one transaction at a time. */
export class HistoryBuilder {
  readonly #chain: SyntheticChain;

  readonly #minimumActivation: bigint;

  readonly #positions = new Map<string, PositionState>();

  constructor(chain: SyntheticChain, options: { readonly minimumActivation: bigint }) {
    this.#chain = chain;
    this.#minimumActivation = options.minimumActivation;
  }

  /** A market whose controller reports to `registry`, or an uncontrolled market for null. */
  market(index: number, registry: Address | null): Market {
    if (registry === null) {
      return { id: marketIdAt(index), controller: null };
    }
    const market = { id: marketIdAt(index), controller: controllerAt(index) };
    this.#chain.setMarket(market.id, market.controller, registry);
    return market;
  }

  guardianAdded(blockNumber: number): void {
    const { registry, guardian } = this.#chain.layout;
    this.#chain.appendLog({
      address: registry,
      topics: [TOPICS.guardianAdded, addressTopic(guardian)],
      data: '0x',
      blockNumber,
      transactionIndex: this.#chain.beginTransaction(blockNumber),
    });
  }

  /** One `supplyCollateral`: the controller's classification, then the core's `SupplyCollateral`. */
  supply(blockNumber: number, input: SupplyInput): Classification {
    const transactionIndex = this.#chain.beginTransaction(blockNumber);
    const { controller } = input.market;
    const classification =
      controller === null ? 'unclassified' : this.#classify(input, { controller, blockNumber, transactionIndex });
    this.#chain.appendLog({
      address: this.#chain.layout.core,
      topics: [TOPICS.supply, input.market.id, addressTopic(SUPPLIER), addressTopic(input.borrower)],
      data: encodeAbiParameters([{ type: 'uint256' }], [input.assets]),
      blockNumber,
      transactionIndex,
    });
    return classification;
  }

  /** A forced seizure: dust goes first, then activating; an empty activating balance clears the timer. */
  drain(blockNumber: number, input: PositionInput & { readonly amount: bigint }): void {
    const place = this.#placeOf(blockNumber, input);
    const position = this.#position(place);
    const fromDust = input.amount < position.dust ? input.amount : position.dust;
    const fromActivating = input.amount - fromDust;
    if (fromActivating > position.activating) {
      throw new RangeError('A drain cannot remove more than the position holds');
    }
    position.dust -= fromDust;
    position.activating -= fromActivating;
    if (position.activating === 0n) {
      position.activatingStart = 0;
      position.activatingDelay = 0;
    }
    this.#emit('drained', input.amount, position, place);
  }

  #classify(
    input: SupplyInput,
    at: { readonly controller: Address; readonly blockNumber: number; readonly transactionIndex: number },
  ): 'dusted' | 'activating' {
    const place = { ...at, borrower: input.borrower };
    const position = this.#position(place);
    if (position.dust === 0n && input.assets < this.#minimumActivation) {
      position.dust = input.assets;
      this.#emit('dusted', input.assets, position, place);
      return 'dusted';
    }
    const amount = position.dust + input.assets;
    if (position.activating === 0n) {
      position.activatingStart = timestampOf(at.blockNumber);
      position.activatingDelay = input.delaySeconds;
    }
    position.dust = 0n;
    position.activating += amount;
    this.#emit('activating', amount, position, place);
    return 'activating';
  }

  #placeOf(blockNumber: number, input: PositionInput): EventPlace {
    const { controller } = input.market;
    if (controller === null) {
      throw new TypeError('An uncontrolled market has no lifecycle events');
    }
    return {
      controller,
      borrower: input.borrower,
      blockNumber,
      transactionIndex: this.#chain.beginTransaction(blockNumber),
    };
  }

  #position(place: { readonly controller: Address; readonly borrower: Address }): PositionState {
    const key = `${place.controller}:${place.borrower}`;
    const existing = this.#positions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: PositionState = { dust: 0n, activating: 0n, activatingStart: 0, activatingDelay: 0 };
    this.#positions.set(key, created);
    return created;
  }

  #emit(kind: LifecycleKind, amount: bigint, position: PositionState, place: EventPlace): void {
    this.#chain.appendLog({
      address: place.controller,
      topics: [TOPICS[kind], addressTopic(place.borrower)],
      data: encodeAbiParameters(LIFECYCLE_DATA, [
        amount,
        position.dust,
        position.activating,
        position.activatingStart,
        position.activatingDelay,
      ]),
      blockNumber: place.blockNumber,
      transactionIndex: place.transactionIndex,
    });
  }
}
