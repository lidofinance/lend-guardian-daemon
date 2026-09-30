// A deterministic chain for benchmarks. It answers the JSON-RPC methods the SDK reads from indexed
// logs and current registry state, and mines the registry calls a synthetic client sends. Its head
// follows a virtual clock, so inclusion, confirmations and the SDK's poll waits cost blocks rather
// than wall-clock time.

import {
  custom,
  decodeAbiParameters,
  encodeAbiParameters,
  getAbiItem,
  isHex,
  numberToHex,
  padHex,
  toEventSelector,
  toFunctionSelector,
  zeroAddress,
} from 'viem';
import type { AbiFunction } from 'viem';
import { CORE_ABI } from '../abi/Core.abi.ts';
import { GUARDIAN_SIGNALS_ABI } from '../abi/GuardianSignals.abi.ts';
import { MARKET_CONTROLLER_ABI } from '../abi/MarketController.abi.ts';
import { lower } from '../src/common/types.ts';
import { isRecord } from '../src/common/validation.ts';
import type { Address, Bytes32, Hex, MarketId, RpcRequest, TxHash } from '../src/core/index.ts';

export const CHAIN_ID = 1;

export const SLOT_SECONDS = 12;

/** How far back the EVM `blockhash` opcode answers, which the registry applies to a heartbeat. */
export const BLOCKHASH_LOOKBACK = 256;

const GENESIS_TIMESTAMP = 1_700_000_000;

const MILLISECONDS_PER_SECOND = 1_000;

/** Block and transaction identifiers carry distinct tags so they never collide as 32-byte values. */
const BLOCK_TAG = 0xb10cn << 240n;

const TRANSACTION_TAG = 0x7a11n << 240n;

const WORD_BITS = 64n;

const LOW_WORD = (1n << WORD_BITS) - 1n;

/**
 * Estimated `eth_getBlockByNumber(tag, false)` size of a mainnet header with 150 transaction hashes:
 * about 1.1 KB of header fields plus 69 bytes per quoted hash. Blocks are not materialized with
 * transactions, so this models the wire size the SDK's head and header reads would cost.
 */
const BLOCK_RESPONSE_BYTES = 1_100 + 150 * 69;

/** Event topics, derived from the SDK's own ABI fragments. */
export const TOPICS = {
  supply: toEventSelector(getAbiItem({ abi: CORE_ABI, name: 'SupplyCollateral' })),
  dusted: toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDusted' })),
  activating: toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivating' })),
  activated: toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralActivated' })),
  drained: toEventSelector(getAbiItem({ abi: MARKET_CONTROLLER_ABI, name: 'CollateralDrained' })),
  guardianAdded: toEventSelector(getAbiItem({ abi: GUARDIAN_SIGNALS_ABI, name: 'GuardianAdded' })),
  heartbeat: toEventSelector(getAbiItem({ abi: GUARDIAN_SIGNALS_ABI, name: 'Heartbeat' })),
};

/** Every function the SDK calls on the core, a controller or the registry, by selector. */
const FUNCTIONS = new Map<Hex, AbiFunction>(
  [...CORE_ABI, ...MARKET_CONTROLLER_ABI, ...GUARDIAN_SIGNALS_ABI].flatMap((item) =>
    item.type === 'function' ? [[toFunctionSelector(item), item] as const] : [],
  ),
);

/** Unix seconds of a synthetic block: one block in every twelve-second slot. */
export function timestampOf(blockNumber: number): number {
  return GENESIS_TIMESTAMP + blockNumber * SLOT_SECONDS;
}

export function transactionHashOf(blockNumber: number, transactionIndex: number): TxHash {
  return numberToHex(TRANSACTION_TAG | (BigInt(blockNumber) << WORD_BITS) | BigInt(transactionIndex), { size: 32 });
}

/** An indexed address argument, as a log topic stores it. */
export function addressTopic(address: Address): Hex {
  return padHex(lower(address), { size: 32 });
}

/**
 * Chain time for one benchmark process: simulated waits plus, when `realTimeScale` is positive, the
 * wall-clock time the process spends. Waiting advances it without sleeping.
 */
export class VirtualClock {
  readonly #slotMs: number;

  readonly #realTimeScale: number;

  readonly #startedAt = performance.now();

  #simulatedMs = 0;

  constructor(options: { readonly slotSeconds: number; readonly realTimeScale: number }) {
    this.#slotMs = options.slotSeconds * MILLISECONDS_PER_SECOND;
    this.#realTimeScale = options.realTimeScale;
  }

  /** Whole slots elapsed since the clock started. */
  slots(): number {
    return Math.floor(this.#elapsedMs() / this.#slotMs);
  }

  /** A timer the SDK awaits: simulated time passes and the promise settles at once. */
  sleep(milliseconds: number): Promise<void> {
    this.pass(milliseconds);
    return Promise.resolve();
  }

  /** Let simulated time pass without anything waiting for it. */
  pass(milliseconds: number): void {
    this.#simulatedMs += milliseconds;
  }

  /** Move to the start of the slot `count` slots after the current one. */
  advanceSlots(count: number): void {
    const targetMs = (this.slots() + count) * this.#slotMs;
    this.#simulatedMs += Math.max(0, targetMs - this.#elapsedMs());
  }

  #elapsedMs(): number {
    return this.#simulatedMs + this.#realTimeScale * (performance.now() - this.#startedAt);
  }
}

/**
 * Round trips to a remote node, charged to the chain clock. Requests sent together share one round
 * trip, which ends once the process has sent all it can: a batch of concurrent reads costs one round
 * trip and a sequence of dependent reads costs one per read.
 */
export class RoundTrips {
  readonly #clock: VirtualClock;

  readonly #roundTripMs: number;

  #waiting: (() => void)[] = [];

  #completed = 0;

  constructor(clock: VirtualClock, roundTripMs: number) {
    this.#clock = clock;
    this.#roundTripMs = roundTripMs;
  }

  /** Settles when the round trip that carries this request ends. */
  wait(): Promise<void> {
    return new Promise((resolve) => {
      this.#waiting.push(resolve);
      if (this.#waiting.length === 1) {
        setImmediate(() => {
          this.#complete();
        });
      }
    });
  }

  completed(): number {
    return this.#completed;
  }

  #complete(): void {
    const answered = this.#waiting;
    this.#waiting = [];
    this.#completed += 1;
    this.#clock.pass(this.#roundTripMs);
    for (const resolve of answered) {
      resolve();
    }
  }
}

/** Addresses and history bounds of one synthetic deployment. */
export interface ChainLayout {
  readonly core: Address;
  readonly registry: Address;
  readonly guardian: Address;
  readonly delegate: Address;
  readonly coreDeploymentBlock: number;
  readonly registryDeploymentBlock: number;
  /** The head when the chain is sealed; it then advances with the clock. */
  readonly startHead: number;
}

/** A log as `eth_getLogs` returns it. */
interface RpcLogRecord {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: Hex;
  readonly blockHash: Bytes32;
  readonly transactionHash: TxHash;
  readonly transactionIndex: Hex;
  readonly logIndex: Hex;
  readonly removed: false;
}

interface StoredLog {
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly topics: readonly Hex[];
  readonly record: RpcLogRecord;
  /** Serialized size, computed once when the log is stored. */
  readonly bytes: number;
}

/** A log the history adds; the chain assigns its log index and transaction hash. */
export interface LogInput {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: number;
  readonly transactionIndex: number;
}

/** A JSON-RPC result and what the benchmark counts about it. */
export interface Answer {
  readonly value: unknown;
  /** The method, refined by call target or filter kind, such as `eth_call:getFlaggedBy`. */
  readonly label: string;
  readonly bytes: number;
  readonly logs: number;
  /** Inclusive block span of an `eth_getLogs` range; zero for everything else. */
  readonly spanBlocks: number;
}

export type RegistryMethod = 'suspect' | 'flag' | 'heartbeat';

/** A registry call the chain mined. */
export interface MinedTransaction {
  readonly hash: TxHash;
  readonly method: RegistryMethod;
  /** Borrowers in a report, or zero for a heartbeat. */
  readonly accounts: number;
  readonly blockNumber: number;
  readonly blockHash: Bytes32;
  readonly status: 'success' | 'reverted';
}

type TopicFilter = readonly (Hex | readonly Hex[] | null)[];

interface RangeFilter {
  readonly address: Address;
  readonly topics: TopicFilter;
  readonly fromBlock: number;
  readonly toBlock: number;
}

interface RegistryWrite {
  readonly method: RegistryMethod;
  readonly accounts: number;
  readonly status: 'success' | 'reverted';
}

/** Where a mined transaction sits. */
interface Inclusion {
  readonly blockNumber: number;
  readonly transactionIndex: number;
}

/**
 * The synthetic chain. History is appended before `seal`; afterwards the head advances with the
 * clock and only mined registry calls add logs. Registry reads answer current state whatever block
 * a call is pinned to, after checking that the pinned block is canonical.
 */
export class SyntheticChain {
  readonly layout: ChainLayout;

  readonly #clock: VirtualClock;

  readonly #logsByAddress = new Map<Address, StoredLog[]>();

  readonly #logsByTopic = new Map<string, StoredLog[]>();

  readonly #nextLogIndex = new Map<number, number>();

  readonly #nextTransactionIndex = new Map<number, number>();

  readonly #controllers = new Map<MarketId, Address>();

  readonly #registries = new Map<Address, Address>();

  readonly #flags = new Map<string, Set<Address>>();

  readonly #transactions = new Map<TxHash, MinedTransaction>();

  readonly #droppedTransactions = new Set<TxHash>();

  readonly #failingLogRanges: { readonly address: Address; readonly blockNumber: number }[] = [];

  readonly #reorgs: { readonly fromBlock: number; readonly epoch: number }[] = [];

  #heartbeatTimestamp = 0;

  #clockSlotsAtSeal: number | undefined;

  #storedLogs = 0;

  #storedBytes = 0;

  constructor(layout: ChainLayout, clock: VirtualClock) {
    this.layout = { ...layout, core: lower(layout.core), registry: lower(layout.registry) };
    this.#clock = clock;
  }

  // ─── History, before the run.

  /** Bind a market to its controller and the registry that controller reports to. */
  setMarket(marketId: MarketId, controller: Address | null, registry: Address): void {
    if (controller === null) {
      return;
    }
    this.#controllers.set(marketId, lower(controller));
    this.#registries.set(lower(controller), lower(registry));
  }

  /** The next transaction index in a block. */
  beginTransaction(blockNumber: number): number {
    const transactionIndex = this.#nextTransactionIndex.get(blockNumber) ?? 0;
    this.#nextTransactionIndex.set(blockNumber, transactionIndex + 1);
    return transactionIndex;
  }

  appendLog(input: LogInput): void {
    const logIndex = this.#nextLogIndex.get(input.blockNumber) ?? 0;
    this.#nextLogIndex.set(input.blockNumber, logIndex + 1);
    const record: RpcLogRecord = {
      address: lower(input.address),
      topics: input.topics,
      data: input.data,
      blockNumber: numberToHex(input.blockNumber),
      blockHash: this.hashOf(input.blockNumber),
      transactionHash: transactionHashOf(input.blockNumber, input.transactionIndex),
      transactionIndex: numberToHex(input.transactionIndex),
      logIndex: numberToHex(logIndex),
      removed: false,
    };
    const bytes = JSON.stringify(record).length;
    const log: StoredLog = { blockNumber: input.blockNumber, logIndex, topics: input.topics, record, bytes };
    appendTo(this.#logsByAddress, record.address, log);
    appendTo(this.#logsByTopic, topicKey(record.address, input.topics[1]), log);
    this.#storedLogs += 1;
    this.#storedBytes += bytes;
  }

  flag(marketId: MarketId, borrower: Address, guardian: Address): void {
    const key = flagKey(marketId, borrower);
    const flaggers = this.#flags.get(key) ?? new Set<Address>();
    flaggers.add(lower(guardian));
    this.#flags.set(key, flaggers);
  }

  /** Record a heartbeat that `includedAt` mined for `reportBlock`, as a previous cycle would have. */
  recordHeartbeat(reportBlock: number, includedAt: number): void {
    this.#heartbeatTimestamp = timestampOf(reportBlock);
    this.#appendHeartbeatLog(reportBlock, {
      blockNumber: includedAt,
      transactionIndex: this.beginTransaction(includedAt),
    });
  }

  /** Order the indexes and start the head at `startHead`; generation time does not advance it. */
  seal(): void {
    for (const logs of [...this.#logsByAddress.values(), ...this.#logsByTopic.values()]) {
      logs.sort(compareLogs);
    }
    this.#clockSlotsAtSeal = this.#clock.slots();
  }

  /** Logs and serialized bytes the history holds. */
  size(): { readonly logs: number; readonly bytes: number } {
    return { logs: this.#storedLogs, bytes: this.#storedBytes };
  }

  // ─── Time and faults.

  head(): number {
    const slotsAtSeal = this.#clockSlotsAtSeal;
    if (slotsAtSeal === undefined) {
      return this.layout.startHead;
    }
    return this.layout.startHead + this.#clock.slots() - slotsAtSeal;
  }

  advanceTo(blockNumber: number): void {
    const missing = blockNumber - this.head();
    if (missing > 0) {
      this.#clock.advanceSlots(missing);
    }
  }

  hashOf(blockNumber: number): Bytes32 {
    const epoch = this.#epochOf(blockNumber);
    return numberToHex(BLOCK_TAG | (BigInt(epoch) << WORD_BITS) | BigInt(blockNumber), { size: 32 });
  }

  /** Replace every block from `blockNumber` with a new fork; receipts in those blocks disappear. */
  reorgFrom(blockNumber: number): void {
    this.#reorgs.push({ fromBlock: blockNumber, epoch: this.#reorgs.length + 1 });
  }

  /** Make a mined transaction's receipt disappear, as if a reorg had dropped it. */
  dropTransaction(hash: TxHash): void {
    this.#droppedTransactions.add(hash);
  }

  /** Fail every `eth_getLogs` range of `address` that covers `blockNumber`. */
  failLogsCovering(address: Address, blockNumber: number): void {
    this.#failingLogRanges.push({ address: lower(address), blockNumber });
  }

  heartbeatTimestamp(): number {
    return this.#heartbeatTimestamp;
  }

  // ─── JSON-RPC.

  answer(method: string, params: readonly unknown[]): Answer {
    switch (method) {
      case 'eth_chainId':
        return valueAnswer(numberToHex(CHAIN_ID), method);
      case 'eth_getBlockByNumber':
        return this.#blockAnswer(params[0]);
      case 'eth_call':
        return this.#callAnswer(params);
      case 'eth_getLogs':
        return this.#logsAnswer(logFilterOf(params[0]));
      case 'eth_getTransactionReceipt':
        return this.#receiptAnswer(params[0]);
      default:
        throw new Error(`The synthetic chain has no answer for ${method}`);
    }
  }

  // ─── Registry writes from the synthetic client.

  /** Mine a registry call `inclusionBlocks` after the current head and apply its effects. */
  include(data: Hex, inclusionBlocks: number): MinedTransaction {
    this.advanceTo(this.head() + inclusionBlocks);
    const blockNumber = this.head();
    const transactionIndex = this.beginTransaction(blockNumber);
    const write = this.#applyWrite(data, { blockNumber, transactionIndex });
    const mined: MinedTransaction = {
      hash: transactionHashOf(blockNumber, transactionIndex),
      method: write.method,
      accounts: write.accounts,
      blockNumber,
      blockHash: this.hashOf(blockNumber),
      status: write.status,
    };
    this.#transactions.set(mined.hash, mined);
    return mined;
  }

  #applyWrite(data: Hex, at: Inclusion): RegistryWrite {
    const call = decodedCall(data);
    switch (call.name) {
      case 'suspect':
        return { method: 'suspect', accounts: addressesAt(call.args, 2).length, status: 'success' };
      case 'flag':
        return this.#applyFlag(call.args);
      case 'heartbeat':
        return { method: 'heartbeat', accounts: 0, status: this.#applyHeartbeat(call.args, at) };
      default:
        throw new Error(`The synthetic registry does not accept ${call.name}`);
    }
  }

  #applyFlag(args: readonly unknown[]): RegistryWrite {
    const marketId = hexAt(args, 0);
    const onBehalf = hexAt(args, 1);
    const accounts = addressesAt(args, 2);
    for (const account of accounts) {
      this.flag(marketId, account, onBehalf);
    }
    return { method: 'flag', accounts: accounts.length, status: 'success' };
  }

  /** The registry's heartbeat checks: a recent canonical block, and no regression of the timestamp. */
  #applyHeartbeat(args: readonly unknown[], at: Inclusion): 'success' | 'reverted' {
    const block = blockInfoAt(args, 1);
    const age = at.blockNumber - block.number;
    const isWithinLookback = age > 0 && age <= BLOCKHASH_LOOKBACK;
    const isCanonical = this.hashOf(block.number) === block.hash;
    if (!isWithinLookback || !isCanonical) {
      return 'reverted';
    }
    if (block.timestamp < this.#heartbeatTimestamp) {
      return 'reverted';
    }
    this.#heartbeatTimestamp = block.timestamp;
    this.#appendHeartbeatLog(block.number, at);
    return 'success';
  }

  #appendHeartbeatLog(reportBlock: number, at: Inclusion): void {
    this.appendLog({
      address: this.layout.registry,
      topics: [TOPICS.heartbeat, addressTopic(this.layout.guardian)],
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
        [BigInt(reportBlock), BigInt(timestampOf(reportBlock)), '0x'],
      ),
      ...at,
    });
  }

  // ─── Answers.

  #blockAnswer(tag: unknown): Answer {
    const head = this.head();
    const isLatest = tag === 'latest';
    const blockNumber = isLatest ? head : quantityOf(tag);
    const label = isLatest ? 'eth_getBlockByNumber:latest' : 'eth_getBlockByNumber:number';
    if (blockNumber > head) {
      return { value: null, label, bytes: 4, logs: 0, spanBlocks: 0 };
    }
    const value = {
      number: numberToHex(blockNumber),
      hash: this.hashOf(blockNumber),
      timestamp: numberToHex(timestampOf(blockNumber)),
    };
    return { value, label, bytes: BLOCK_RESPONSE_BYTES, logs: 0, spanBlocks: 0 };
  }

  #callAnswer(params: readonly unknown[]): Answer {
    const [call, pinned] = params;
    if (!isRecord(call) || !isRecord(pinned)) {
      throw new TypeError('eth_call needs a call object and a block reference');
    }
    this.#canonicalNumberOf(hexOf(pinned.blockHash));
    const decoded = decodedCall(hexOf(call.data));
    const value = this.#readCall(decoded.name, lower(hexOf(call.to)), decoded.args);
    return { value, label: `eth_call:${decoded.name}`, bytes: value.length + 2, logs: 0, spanBlocks: 0 };
  }

  #readCall(name: string, to: Address, args: readonly unknown[]): Hex {
    switch (name) {
      case 'marketController':
        return encodeAbiParameters([{ type: 'address' }], [this.#controllers.get(hexAt(args, 0)) ?? zeroAddress]);
      case 'guardianSignals':
        return encodeAbiParameters([{ type: 'address' }], [this.#registryOf(to)]);
      case 'isGuardian':
        return encodeAbiParameters([{ type: 'bool' }], [lower(hexAt(args, 0)) === lower(this.layout.guardian)]);
      case 'getDelegate':
        return encodeAbiParameters([{ type: 'address' }], [this.layout.delegate]);
      case 'getHeartbeat':
        return encodeAbiParameters([{ type: 'uint40' }], [this.#heartbeatTimestamp]);
      case 'getFlaggedBy':
        return encodeAbiParameters([{ type: 'address[]' }], [this.#flaggers(hexAt(args, 0), hexAt(args, 1))]);
      default:
        throw new Error(`The synthetic chain cannot answer ${name}`);
    }
  }

  #registryOf(controller: Address): Address {
    const registry = this.#registries.get(controller);
    if (registry === undefined) {
      throw new Error(`${controller} is not a synthetic market controller`);
    }
    return registry;
  }

  #flaggers(marketId: MarketId, borrower: Address): Address[] {
    return [...(this.#flags.get(flagKey(marketId, borrower)) ?? [])];
  }

  #logsAnswer(filter: RangeFilter): Answer {
    if (filter.toBlock > this.head()) {
      throw new Error('The log range extends beyond the synthetic head');
    }
    const isFailing = this.#failingLogRanges.some(
      (failure) => failure.address === filter.address && isWithin(failure.blockNumber, filter),
    );
    if (isFailing) {
      throw new Error(`Synthetic eth_getLogs failure for blocks ${filter.fromBlock}-${filter.toBlock}`);
    }
    const candidates = this.#candidateLogs(filter);
    const start = firstAtOrAfter(candidates, filter.fromBlock);
    const end = firstAtOrAfter(candidates, filter.toBlock + 1);
    const logs = candidates.slice(start, end).filter((log) => matchesTopics(log.topics, filter.topics));
    return this.#logListAnswer(
      logs,
      `eth_getLogs:${this.#roleOf(filter.address)}-range`,
      filter.toBlock - filter.fromBlock + 1,
    );
  }

  /** The narrowest index for a filter: by address and second topic when the filter fixes one. */
  #candidateLogs(filter: RangeFilter): readonly StoredLog[] {
    const secondTopic = filter.topics[1];
    if (typeof secondTopic === 'string') {
      return this.#logsByTopic.get(topicKey(filter.address, secondTopic)) ?? [];
    }
    return this.#logsByAddress.get(filter.address) ?? [];
  }

  #logListAnswer(logs: readonly StoredLog[], label: string, spanBlocks: number): Answer {
    const value = logs.map((log) => this.#currentRecord(log));
    const bytes = logs.reduce((total, log) => total + log.bytes, 2);
    return { value, label, bytes, logs: logs.length, spanBlocks };
  }

  /** A log carries the hash of the fork its block is on now. */
  #currentRecord(log: StoredLog): RpcLogRecord {
    if (this.#reorgs.length === 0) {
      return log.record;
    }
    return { ...log.record, blockHash: this.hashOf(log.blockNumber) };
  }

  #roleOf(address: Address): string {
    if (address === this.layout.core) {
      return 'core';
    }
    if (address === this.layout.registry) {
      return 'registry';
    }
    return this.#registries.has(address) ? 'controller' : 'unknown';
  }

  #receiptAnswer(hash: unknown): Answer {
    const mined = typeof hash === 'string' ? this.#transactions.get(hexOf(hash)) : undefined;
    const isAvailable = mined !== undefined && !this.#droppedTransactions.has(mined.hash);
    if (!isAvailable || this.hashOf(mined.blockNumber) !== mined.blockHash) {
      return valueAnswer(null, 'eth_getTransactionReceipt');
    }
    return valueAnswer(
      {
        transactionHash: mined.hash,
        blockHash: mined.blockHash,
        blockNumber: numberToHex(mined.blockNumber),
        transactionIndex: '0x0',
        status: mined.status === 'success' ? '0x1' : '0x0',
        logs: [],
      },
      'eth_getTransactionReceipt',
    );
  }

  /** A block hash names its number and fork; it must be the canonical block at or below the head. */
  #canonicalNumberOf(hash: Bytes32): number {
    const blockNumber = Number(BigInt(hash) & LOW_WORD);
    const isCanonical = this.hashOf(blockNumber) === lower(hash);
    if (!isCanonical || blockNumber > this.head()) {
      throw new Error(`Unknown block ${hash}`);
    }
    return blockNumber;
  }

  #epochOf(blockNumber: number): number {
    let epoch = 0;
    for (const reorg of this.#reorgs) {
      if (reorg.fromBlock <= blockNumber) {
        epoch = reorg.epoch;
      }
    }
    return epoch;
  }
}

/** A node request as the benchmark serves it. */
export type NodeRequest = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** Receives every answer and failure the measured node produces. */
export interface RpcObserver {
  answered(answer: Answer, handlerMs: number, latencyMs: number): void;
  failed(method: string, handlerMs: number): void;
}

/** Latency added to answers, in real milliseconds: per answer label, otherwise for every request. */
export interface RpcLatency {
  readonly everyRequestMs: number;
  readonly byLabelMs: ReadonlyMap<string, number>;
}

/** The node boundary the SDK reads through: every answer is timed and counted before it returns. */
export function measuredNode(chain: SyntheticChain, observer: RpcObserver, latency: RpcLatency): NodeRequest {
  return async (method, params) => {
    const { answer, handlerMs } = answerOrRecordFailure(chain, observer, method, params);
    const latencyMs = latency.byLabelMs.get(answer.label) ?? latency.everyRequestMs;
    observer.answered(answer, handlerMs, latencyMs);
    await realDelay(latencyMs);
    return answer.value;
  };
}

/** The daemon's transport refuses a response body above ten megabytes (`maxResponseBodySize`). */
const TRANSPORT_RESPONSE_LIMIT_BYTES = 10 * 1_048_576;

/** A public provider as a cycle meets it: a round trip per exchange, and the largest log list it serves. */
export interface ProviderProfile {
  readonly roundTrips: RoundTrips;
  /** Undefined when the provider serves a log list of any length. */
  readonly logLimit: number | undefined;
}

/**
 * The node behind a public provider: every answer arrives after its round trip, and a log list above
 * the provider's limit or a response above the transport's limit fails as those do.
 */
export function providerNode(chain: SyntheticChain, observer: RpcObserver, profile: ProviderProfile): NodeRequest {
  return async (method, params) => {
    const { answer, handlerMs } = answerOrRecordFailure(chain, observer, method, params);
    await profile.roundTrips.wait();
    const isOverLogLimit = profile.logLimit !== undefined && answer.logs > profile.logLimit;
    if (isOverLogLimit) {
      observer.failed(method, handlerMs);
      throw new Error(`query returned more than ${String(profile.logLimit)} results`);
    }
    if (answer.bytes > TRANSPORT_RESPONSE_LIMIT_BYTES) {
      observer.failed(method, handlerMs);
      throw new Error(`response body of ${String(answer.bytes)} bytes exceeds the transport limit`);
    }
    observer.answered(answer, handlerMs, 0);
    return answer.value;
  };
}

/**
 * Give a node request the SDK's typed JSON-RPC signature. The test fixtures use the same `custom`
 * transport idiom; it is repeated here so a benchmark child loads no delivery module before it
 * installs virtual timers.
 */
export function typedRequest(node: NodeRequest): RpcRequest {
  return custom(
    {
      request: ({ method, params }: { method: string; params?: readonly unknown[] }) => node(method, params ?? []),
    },
    { retryCount: 0 },
  )({}).config.request;
}

function answerOrRecordFailure(
  chain: SyntheticChain,
  observer: RpcObserver,
  method: string,
  params: readonly unknown[],
): { readonly answer: Answer; readonly handlerMs: number } {
  const startedAt = performance.now();
  try {
    const answer = chain.answer(method, params);
    return { answer, handlerMs: performance.now() - startedAt };
  } catch (error) {
    observer.failed(method, performance.now() - startedAt);
    throw error;
  }
}

/** Real latency uses the global timer, which the child's virtual SDK timers do not replace. */
export function realDelay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function valueAnswer(value: unknown, label: string): Answer {
  return { value, label, bytes: JSON.stringify(value).length, logs: 0, spanBlocks: 0 };
}

function appendTo<Key>(index: Map<Key, StoredLog[]>, key: Key, log: StoredLog): void {
  const logs = index.get(key);
  if (logs === undefined) {
    index.set(key, [log]);
    return;
  }
  logs.push(log);
}

function topicKey(address: Address, topic: Hex | undefined): string {
  return `${address}:${topic ?? ''}`;
}

function flagKey(marketId: MarketId, borrower: Address): string {
  return `${lower(marketId)}:${lower(borrower)}`;
}

function compareLogs(left: StoredLog, right: StoredLog): number {
  const byBlock = left.blockNumber - right.blockNumber;
  return byBlock === 0 ? left.logIndex - right.logIndex : byBlock;
}

/** The first position whose log is at or after `blockNumber`, in logs ordered by block. */
function firstAtOrAfter(logs: readonly StoredLog[], blockNumber: number): number {
  let low = 0;
  let high = logs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const log = logs[middle];
    if (log !== undefined && log.blockNumber < blockNumber) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function isWithin(blockNumber: number, filter: RangeFilter): boolean {
  return blockNumber >= filter.fromBlock && blockNumber <= filter.toBlock;
}

function matchesTopics(topics: readonly Hex[], filter: TopicFilter): boolean {
  return filter.every((expected, position) => matchesTopic(topics[position], expected));
}

function matchesTopic(actual: Hex | undefined, expected: Hex | readonly Hex[] | null): boolean {
  if (expected === null) {
    return true;
  }
  if (actual === undefined) {
    return false;
  }
  return typeof expected === 'string' ? actual === expected : expected.includes(actual);
}

function decodedCall(data: Hex): { readonly name: string; readonly args: readonly unknown[] } {
  const selector = lower(`0x${data.slice(2, 10)}`);
  const item = FUNCTIONS.get(selector);
  if (item === undefined) {
    throw new Error(`The synthetic chain does not know selector ${selector}`);
  }
  return { name: item.name, args: decodeAbiParameters(item.inputs, `0x${data.slice(10)}`) };
}

function logFilterOf(value: unknown): RangeFilter {
  if (!isRecord(value)) {
    throw new TypeError('eth_getLogs needs a filter object');
  }
  return {
    address: lower(hexOf(value.address)),
    topics: topicFilterOf(value.topics),
    fromBlock: quantityOf(value.fromBlock),
    toBlock: quantityOf(value.toBlock),
  };
}

function topicFilterOf(value: unknown): TopicFilter {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError('Log topics must be an array');
  }
  return value.map((topic: unknown) => {
    if (topic === null) {
      return null;
    }
    return Array.isArray(topic) ? topic.map((alternative: unknown) => hexOf(alternative)) : hexOf(topic);
  });
}

function hexOf(value: unknown): Hex {
  if (typeof value !== 'string' || !isHex(value)) {
    throw new TypeError('Expected a hex string');
  }
  return value;
}

function quantityOf(value: unknown): number {
  return Number(BigInt(hexOf(value)));
}

function hexAt(values: readonly unknown[], index: number): Hex {
  return hexOf(values[index]);
}

function addressesAt(values: readonly unknown[], index: number): Address[] {
  const value = values[index];
  if (!Array.isArray(value)) {
    throw new TypeError('Expected an address list');
  }
  return value.map((address: unknown) => hexOf(address));
}

function blockInfoAt(
  values: readonly unknown[],
  index: number,
): { readonly hash: Bytes32; readonly number: number; readonly timestamp: number } {
  const value = values[index];
  if (!isRecord(value)) {
    throw new TypeError('Expected the reported block');
  }
  const { hash, number, timestamp } = value;
  if (typeof number !== 'number' || typeof timestamp !== 'number') {
    throw new TypeError('Expected the reported block number and timestamp');
  }
  return { hash: lower(hexOf(hash)), number, timestamp };
}
