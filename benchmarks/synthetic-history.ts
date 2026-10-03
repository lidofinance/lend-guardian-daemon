// Lending history in chain order: supplies classified by their market controller, drains and
// maturations, each with the post-event position the controller records. It follows the transitions
// the specification documents and the controller's activation timer: a lot's delay grows with the
// market's decaying inflow, and a top-up restarts the timer when that ends it later. It does not model
// every contract rule, such as which operations may drain part of a bucket. Every operation is its own
// transaction, so no drain reverses inflow that the same transaction added.

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
}

/** The controller's activation delay rule: its floor, its cap and the inflow at which it reaches the cap. */
export interface ActivationDelays {
  readonly minActivationDelay: number;
  readonly maxActivationDelay: number;
  readonly maxDelayInflow: bigint;
}

/** A market's recent inflow as the controller stores it, and when it stored it. */
interface Inflow {
  inflow: bigint;
  updatedAt: number;
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

  readonly #delays: ActivationDelays;

  readonly #positions = new Map<string, PositionState>();

  readonly #inflows = new Map<Address, Inflow>();

  constructor(
    chain: SyntheticChain,
    options: { readonly minimumActivation: bigint; readonly delays: ActivationDelays },
  ) {
    this.#chain = chain;
    this.#minimumActivation = options.minimumActivation;
    this.#delays = options.delays;
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
    const now = timestampOf(at.blockNumber);
    const delay = this.#delayAfter(at.controller, amount, now);
    // A top-up restarts the whole lot's timer only when that ends it later.
    if (now + delay > position.activatingStart + position.activatingDelay) {
      position.activatingStart = now;
      position.activatingDelay = delay;
    }
    position.dust = 0n;
    position.activating += amount;
    this.#emit('activating', amount, position, place);
    return 'activating';
  }

  /** When the borrower's lot in the market becomes due, or null while it has none. */
  dueAt(input: PositionInput): number | null {
    const { controller } = input.market;
    const position = controller === null ? undefined : this.#positions.get(`${controller}:${input.borrower}`);
    const hasLot = position !== undefined && position.activatingStart !== 0;
    return hasLot ? position.activatingStart + position.activatingDelay : null;
  }

  /**
   * The delay of a lot that adds `increment` to the market's inflow at `now`. The stored inflow decays
   * by the cap over the longest delay, takes the increment, and stays at most the cap; the delay grows
   * linearly with it from the floor to the cap.
   */
  #delayAfter(controller: Address, increment: bigint, now: number): number {
    const { minActivationDelay, maxActivationDelay, maxDelayInflow } = this.#delays;
    const stored = this.#inflows.get(controller) ?? { inflow: 0n, updatedAt: now };
    const decay = (maxDelayInflow * BigInt(now - stored.updatedAt)) / BigInt(maxActivationDelay);
    const decayed = stored.inflow > decay ? stored.inflow - decay : 0n;
    const inflow = decayed + increment < maxDelayInflow ? decayed + increment : maxDelayInflow;
    this.#inflows.set(controller, { inflow, updatedAt: now });
    if (inflow >= maxDelayInflow) {
      return maxActivationDelay;
    }
    const span = BigInt(maxActivationDelay - minActivationDelay);
    return minActivationDelay + Number((span * inflow) / maxDelayInflow);
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
