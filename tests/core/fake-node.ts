import type { DecodeFunctionDataReturnType } from 'viem';
import { lower } from '../../src/common/types.ts';
import { isRecord } from '../../src/common/validation.ts';
// A scripted node for the phase tests. It answers the JSON-RPC methods the core sends and records
// the log queries among them, so a test can assert both the decision and the reads it took.
// Everything a test does not state is derived: block fields follow the block number, and a receipt
// is built from the supply and the controller event a fixture placed in the same transaction.
import { privateKeyToAddress } from 'viem/accounts';
import {
  decodeFunctionData,
  isHex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  encodeAbiParameters,
  numberToHex,
  padHex,
  zeroAddress,
  zeroHash,
} from 'viem';
import { GUARDIAN_SIGNALS_ABI } from '../../abi/GuardianSignals.abi.ts';
import type { SignalTarget } from '../../src/core/types.ts';
import type { Address, BlockRef, Bytes32, Hex, MarketId, TxHash } from '../../src/common/types.ts';

export const CHAIN_ID = 1;

export const REGISTRY: Address = '0x00000000000000000000000000000000000000aa';

export const CORE: Address = '0x00000000000000000000000000000000000000bb';

// Deterministic test key only; never used on an external chain.
export const GUARDIAN_KEY = padHex('0x01', { size: 32 });

export const GUARDIAN: Address = lower(privateKeyToAddress(GUARDIAN_KEY));

export const CONTROLLER: Address = '0x00000000000000000000000000000000000000dd';

export const BORROWER: Address = '0x00000000000000000000000000000000000000ee';

export const MARKET: MarketId = padHex('0x01', { size: 32 });

/** Event topics, from `cast keccak` over the signatures the contracts declare. */
const TOPIC = {
  heartbeat: '0x9068f88cea09b39b23fb88cc557aa656453b96fcc7e466ebd0db0dcd16c5968e',
  guardianAdded: '0x038596bb31e2e7d3d9f184d4c98b310103f6d7f5830e5eec32bffe6f1728f969',
  supply: '0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184',
  dusted: '0xc6a9bc7a1fb9c8a298311056e9c97598080b04c3f116656a234c4bcc55a3fd0e',
  activating: '0xe84769a28e1f9422802ff886dc1dec36d33eb7188e1da176e5b55847816209ff',
  activated: '0x4ebf461d4c45e2a848f6eafbe36e98fc470738b8028aedd928ec5fb808011586',
  drained: '0xa0bb5edcf0ca45fd20c24361d63b01aff78db3208d09e6ca2de219a74861a635',
};

/** Call selectors, from `cast sig` over the signatures the contracts declare. */
const SELECTOR = {
  isGuardian: '0x0c68ba21',
  getDelegate: '0x544d8564',
  getHeartbeat: '0x8102ea0f',
  marketController: '0x961496be',
  guardianSignals: '0x0700873b',
  getFlaggedBy: '0x576fa8ba',
  getSuspectedBy: '0x3075b592',
  getSuspectWindow: '0x266e6067',
};

/** How long a suspect stays active unless the script says otherwise. */
const WEEK = 7 * 24 * 60 * 60;

/** A `Heartbeat` of this Guardian: the block it reported, and where the event itself was logged. */
interface Heartbeat {
  readonly blockNumber: number;
  readonly timestamp: number;
  /** The block the heartbeat transaction landed in, or the block after the reported one. */
  readonly includedAt?: number;
  /** The heartbeat transaction's index in that block, or zero. */
  readonly transactionIndex?: number;
}

interface Position {
  readonly dust: bigint;
  readonly activating: bigint;
  readonly activatingStart: number;
  readonly activatingDelay: number;
}

/** One controller event, and the supply it classified when the fixture gives one. */
export interface Lot {
  readonly kind: 'dusted' | 'activating' | 'activated' | 'drained';
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly amount: bigint;
  readonly position: Position;
  /** The assets of the `SupplyCollateral` at `logIndex + 1`, or absent when there is none. */
  readonly supplied?: bigint;
  /** The borrower the controller event names, or `BORROWER`. */
  readonly borrower?: Address;
  /** The block hash the node gives the lot's controller log and receipt, or the hash of the lot's block. */
  readonly controllerBlockHash?: Bytes32;
}

/** One Guardian's suspect on the borrower, as the registry reports it. */
export interface SuspectRecord {
  readonly guardian: Address;
  readonly reportedAt: number;
}

/** A report transaction as the node recorded it. */
export interface Receipt {
  readonly transactionHash: TxHash;
  readonly blockNumber: number;
  readonly blockHash: Bytes32;
  readonly status: 'success' | 'reverted';
}

/** One `eth_getLogs` the core sent: the emitter and the inclusive block range. */
interface LogQuery {
  readonly address: string;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly topics: readonly unknown[];
}

/** What the node records of the queries it was sent. */
interface Queries {
  readonly ranges: LogQuery[];
}

/** A node's own cap on a query's results, and how it words the refusal. */
export interface LogsCap {
  /** A controller log query over more blocks than this is refused. */
  readonly over: number;
  readonly code?: number;
  readonly message: string;
}

export interface Script {
  head: number;
  /** Numbered blocks this node answers as unknown. */
  readonly missingBlocks?: readonly number[];
  /** A numbered block whose returned hash is deliberately malformed. */
  readonly invalidBlockHashAt?: number;
  /** What `eth_chainId` answers, or `CHAIN_ID`. */
  readonly chainId?: number;
  readonly isGuardian?: boolean;
  /** The delegate the registry names for the Guardian, or none. */
  readonly delegate?: Address;
  readonly heartbeatTimestamp?: number;
  readonly heartbeats?: readonly Heartbeat[];
  readonly guardianAddedAt?: number;
  /** The controller a market names, or null when it has none. */
  readonly controller?: Address | null;
  /** The registry that controller reports to. */
  readonly controllerRegistry?: Address;
  readonly lots?: readonly Lot[];
  /** Guardians this deployment reports as having flagged the borrower. */
  readonly flaggedBy?: readonly Address[];
  /** Guardians this deployment reports as having suspected the borrower, and when. */
  readonly suspectedBy?: readonly SuspectRecord[];
  /** How long a suspect stays active, or a week. */
  readonly suspectWindow?: number;
  /** The report transactions the node holds a receipt for. */
  readonly receipts?: readonly Receipt[];

  /** A controller log query over more blocks than this answers as a body the client will not read. */
  readonly logsTooLargeOver?: number;
  /** A controller log query over more blocks than `over` is refused by the node, as it words it. */
  readonly logsCapped?: LogsCap;
  /**
   * The log queries whose answers arrive broken: indexed arguments and data cut off. `supply` breaks
   * every supply query, `pairedSupply` only the one-block query phase C sends for an activation.
   */
  readonly undecodable?: readonly (LogKind | 'pairedSupply')[];
}

/** Which of the core's log queries a log answers. */
type LogKind = 'heartbeat' | 'guardianAdded' | 'supply' | 'lifecycle';

/** The script as the node plays it: its head moves, and the head it reports can sit on a fork. */
export interface Sent {
  readonly suspects: SignalTarget[][];
  readonly flags: SignalTarget[][];
  readonly heartbeats: { block: Bytes32; digest: Bytes32 }[];
  readonly calls: ('suspects' | 'flags' | 'heartbeat')[];
  readonly transactions: {
    hash: TxHash;
    from: Address;
    to: Address;
    input: Hex;
    nonce: number;
    chainId: number;
  }[];
}

interface NodeState extends Script {
  readonly sent: Sent;
  readonly submitted: Map<TxHash, Receipt | null>;
  isHeadForked: boolean;
  readonly reorgedBlockNumbers: Set<number>;
}

/** The hash a forked head reports, which no canonical block of the script carries. */
const FORKED_HEAD_HASH: Bytes32 = padHex('0xf0', { size: 32, dir: 'right' });

export function blockAt(number: number): BlockRef {
  return {
    number,
    hash: padHex(numberToHex(number), { size: 32 }),
    timestamp: 1_700_000_000 + number * 12,
  };
}

function txOf(lot: Lot): Bytes32 {
  return padHex(numberToHex(lot.blockNumber * 1000 + lot.logIndex), { size: 32 });
}

export interface FakeNode {
  readonly sent: Sent;
  setReceipt(hash: TxHash, receipt: Receipt | null): void;
  setHeartbeatTimestamp(timestamp: number): void;
  setSuspectedBy(entries: readonly SuspectRecord[]): void;
  readonly transport: (method: string, params: readonly unknown[]) => Promise<unknown>;
  readonly logQueries: LogQuery[];
  /** Moves the chain on, which is how a test reaches the checks a cycle makes against a fresh head. */
  advanceTo(head: number): void;
  /** Reports a head whose hash is not the canonical block at its number. */
  forkHead(): void;
  /** Replaces one numbered block while leaving the current head canonical. */
  reorgBlock(number: number): void;
  /** Makes the node answer another transaction for a recorded hash, as a broken client's receipt would name. */
  replaceTransaction(hash: TxHash, fields: Partial<Pick<Sent['transactions'][number], 'from' | 'to' | 'input'>>): void;
}

export function fakeNode(script: Script): FakeNode {
  const queries: Queries = { ranges: [] };
  const state: NodeState = {
    ...script,
    isHeadForked: false,
    reorgedBlockNumbers: new Set(),
    submitted: new Map(),
    sent: { suspects: [], flags: [], heartbeats: [], calls: [], transactions: [] },
  };
  const transport = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (method === 'eth_sendRawTransaction') {
      return recordTransaction(state, params[0]);
    }
    return await Promise.resolve(answer(state, method, params, queries));
  };
  return {
    transport,
    sent: state.sent,
    setReceipt: (hash, receipt) => {
      state.submitted.set(hash, receipt);
    },
    setHeartbeatTimestamp: (timestamp) => {
      Object.assign(state, { heartbeatTimestamp: timestamp });
    },
    setSuspectedBy: (entries) => {
      Object.assign(state, { suspectedBy: entries });
    },
    logQueries: queries.ranges,
    advanceTo: (head) => {
      state.head = head;
    },
    forkHead: () => {
      state.isHeadForked = true;
    },
    reorgBlock: (number) => {
      state.reorgedBlockNumbers.add(number);
    },
    replaceTransaction: (hash, fields) => {
      const recorded = state.sent.transactions.find((entry) => entry.hash === hash);
      if (recorded === undefined) {
        throw new Error('the node recorded no such transaction');
      }
      Object.assign(recorded, fields);
    },
  };
}

function text(value: unknown, key: string): string {
  return isRecord(value) ? String(value[key]) : '';
}

function list(value: unknown, key: string): readonly unknown[] {
  const entry = isRecord(value) ? value[key] : undefined;
  return Array.isArray(entry) ? entry : [];
}

function answer(script: NodeState, method: string, params: readonly unknown[], queries: Queries): unknown {
  const walletAnswer = walletRpcAnswer(script, method);
  if (walletAnswer !== undefined) {
    return walletAnswer;
  }
  if (method === 'eth_chainId') {
    return numberToHex(script.chainId ?? CHAIN_ID);
  }
  if (method === 'eth_getBlockByNumber') {
    return blockAnswer(script, params);
  }
  if (method === 'eth_call') {
    return callAnswer(script, params);
  }
  if (method === 'eth_getLogs') {
    return logAnswer(script, params, queries);
  }
  if (method === 'eth_getTransactionReceipt') {
    return receiptAnswer(script, params);
  }
  if (method === 'eth_getTransactionByHash') {
    return transactionAnswer(script, params);
  }
  throw new Error(`the script has no answer for ${method}`);
}

function blockAnswer(script: NodeState, params: readonly unknown[]): unknown {
  const tag = String(params[0]);
  const isLatest = tag === 'latest';
  const number = isLatest ? script.head : Number(BigInt(tag));
  if (!isLatest && script.missingBlocks?.includes(number) === true) {
    return null;
  }
  const block = blockAt(number);
  const isForkedHead = isLatest && script.isHeadForked;
  const isReorgedBlock = script.reorgedBlockNumbers.has(number);
  const canonicalHash = isForkedHead || isReorgedBlock ? FORKED_HEAD_HASH : block.hash;
  return {
    number: numberToHex(block.number),
    hash: script.invalidBlockHashAt === number ? '0x01' : canonicalHash,
    timestamp: numberToHex(block.timestamp),
    parentHash: zeroHash,
    baseFeePerGas: '0x1',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    transactions: [],
  };
}

function callAnswer(script: Script, params: readonly unknown[]): unknown {
  const data = text(params[0], 'data');
  if (data.startsWith(SELECTOR.isGuardian)) {
    return padHex(script.isGuardian === false ? '0x00' : '0x01', { size: 32 });
  }
  if (data.startsWith(SELECTOR.getDelegate)) {
    return padHex(script.delegate ?? zeroAddress, { size: 32 });
  }
  if (data.startsWith(SELECTOR.getHeartbeat)) {
    return padHex(numberToHex(script.heartbeatTimestamp ?? 0), { size: 32 });
  }
  if (data.startsWith(SELECTOR.marketController)) {
    const controller = script.controller === undefined ? CONTROLLER : script.controller;
    return padHex(controller ?? '0x00', { size: 32 });
  }
  if (data.startsWith(SELECTOR.getFlaggedBy)) {
    return encodeAbiParameters([{ type: 'address[]' }], [[...(script.flaggedBy ?? [])]]);
  }
  const suspects = suspectAnswer(script, data);
  if (suspects !== undefined) {
    return suspects;
  }
  if (data.startsWith(SELECTOR.guardianSignals)) {
    return padHex(script.controllerRegistry ?? REGISTRY, { size: 32 });
  }
  if (isHex(data)) {
    const decoded = decodeFunctionData({ abi: GUARDIAN_SIGNALS_ABI, data });
    const isReport = decoded.functionName === 'suspect' || decoded.functionName === 'flag';
    if (isReport || decoded.functionName === 'heartbeat') {
      return '0x';
    }
  }
  throw new Error(`the script has no answer for the call ${data.slice(0, 10)}`);
}

/** The registry's suspect reads, or undefined for another call. */
function suspectAnswer(script: Script, data: string): unknown {
  if (data.startsWith(SELECTOR.getSuspectedBy)) {
    const entries = script.suspectedBy ?? [];
    return encodeAbiParameters(
      [{ type: 'address[]' }, { type: 'uint40[]' }],
      [entries.map((entry) => entry.guardian), entries.map((entry) => entry.reportedAt)],
    );
  }
  if (data.startsWith(SELECTOR.getSuspectWindow)) {
    return padHex(numberToHex(script.suspectWindow ?? WEEK), { size: 32 });
  }
  return undefined;
}

function isWithin(value: number, from: number, to: number): boolean {
  const atOrAfter = value >= from;
  return atOrAfter ? value <= to : false;
}

function logAnswer(script: Script, params: readonly unknown[], queries: Queries): unknown {
  const filter = params[0];
  const from = Number(BigInt(text(filter, 'fromBlock')));
  const to = Number(BigInt(text(filter, 'toBlock')));
  const topics = list(filter, 'topics');
  const head = topics[0];
  const first = Array.isArray(head) ? String(head[0]) : String(head);
  const kind = kindOf(first);
  const isTooLarge = script.logsTooLargeOver !== undefined && to - from + 1 > script.logsTooLargeOver;
  if (kind === 'lifecycle' && isTooLarge) {
    throw Object.assign(new Error('the response body exceeded the size limit'), {
      name: 'ResponseBodyTooLargeError',
    });
  }
  const cap = script.logsCapped;
  const isCapped = cap !== undefined && to - from + 1 > cap.over;
  if (kind === 'lifecycle' && isCapped) {
    throw Object.assign(new Error(cap.message), cap.code === undefined ? {} : { code: cap.code });
  }
  queries.ranges.push({ address: text(filter, 'address'), fromBlock: from, toBlock: to, topics });

  const logs = selectedLogs(script, kind, from, to);
  return isBroken(script, kind, from === to) ? logs.map(undecodable) : logs;
}

function isBroken(script: Script, kind: LogKind, isOneBlock: boolean): boolean {
  const broken = script.undecodable ?? [];
  if (broken.includes(kind)) {
    return true;
  }

  const isPairedLookup = kind === 'supply' && isOneBlock;
  return isPairedLookup && broken.includes('pairedSupply');
}

function kindOf(topic: string): LogKind {
  if (topic === TOPIC.heartbeat) {
    return 'heartbeat';
  }
  if (topic === TOPIC.guardianAdded) {
    return 'guardianAdded';
  }
  return topic === TOPIC.supply ? 'supply' : 'lifecycle';
}

function selectedLogs(script: Script, kind: LogKind, from: number, to: number): LogRecord[] {
  if (kind === 'heartbeat') {
    return (script.heartbeats ?? [])
      .filter((entry) => isWithin(includedAt(entry), from, to))
      .map((entry) => heartbeatLog(entry));
  }
  if (kind === 'guardianAdded') {
    const at = script.guardianAddedAt ?? -1;
    return isWithin(at, from, to)
      ? [
          logShape({
            blockNumber: at,
            logIndex: 0,
            transactionHash: zeroHash,
            topics: [TOPIC.guardianAdded, padHex(GUARDIAN, { size: 32 })],
            data: '0x',
          }),
        ]
      : [];
  }
  const logs = kind === 'supply' ? supplyLogs(script) : lifecycleLogs(script);
  return logs.filter((log) => isWithin(Number(BigInt(log.blockNumber)), from, to));
}

/** The same log with its indexed arguments and its data cut off, as a broken endpoint might send it. */
function undecodable(log: LogRecord): LogRecord {
  return { ...log, topics: list(log, 'topics').slice(0, 1), data: '0x' };
}

function supplyLogs(script: Script): LogRecord[] {
  return (script.lots ?? [])
    .filter((lot) => lot.supplied !== undefined)
    .map((lot) =>
      logShape({
        blockNumber: lot.blockNumber,
        logIndex: lot.logIndex + 1,
        transactionHash: txOf(lot),
        topics: [TOPIC.supply, MARKET, padHex(GUARDIAN, { size: 32 }), padHex(BORROWER, { size: 32 })],
        data: encodeAbiParameters([{ type: 'uint256' }], [lot.supplied ?? 0n]),
      }),
    );
}

function lifecycleLogs(script: Script): LogRecord[] {
  return (script.lots ?? []).map((lot) =>
    logShape({
      blockNumber: lot.blockNumber,
      blockHash: lot.controllerBlockHash,
      logIndex: lot.logIndex,
      transactionHash: txOf(lot),
      topics: [TOPIC[lot.kind], padHex(lot.borrower ?? BORROWER, { size: 32 })],
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint40' }, { type: 'uint32' }],
        [
          lot.amount,
          lot.position.dust,
          lot.position.activating,
          lot.position.activatingStart,
          lot.position.activatingDelay,
        ],
      ),
    }),
  );
}

/** A report's receipt when the script holds one, a supply's when a lot sent it, and null otherwise. */
function transactionAnswer(script: NodeState, params: readonly unknown[]): unknown {
  const hash = String(params[0]);
  const recorded = script.sent.transactions.find((entry) => entry.hash === hash);
  if (recorded === undefined) {
    return null;
  }
  const receipt = script.submitted.get(recorded.hash);
  return {
    hash,
    from: recorded.from,
    to: recorded.to,
    input: recorded.input,
    nonce: numberToHex(recorded.nonce),
    blockHash: receipt?.blockHash ?? null,
    blockNumber: receipt === undefined || receipt === null ? null : numberToHex(receipt.blockNumber),
    transactionIndex: '0x0',
    value: '0x0',
  };
}

function receiptAnswer(script: NodeState, params: readonly unknown[]): unknown {
  const hash = String(params[0]);
  const submitted = [...script.submitted.entries()].find(([key]) => key === hash);
  if (submitted?.[1] === null) {
    return null;
  }
  const report = submitted?.[1] ?? (script.receipts ?? []).find((entry) => entry.transactionHash === hash);
  if (report !== undefined) {
    return {
      blockHash: report.blockHash,
      blockNumber: numberToHex(report.blockNumber),
      transactionHash: report.transactionHash,
      transactionIndex: '0x0',
      status: report.status === 'success' ? '0x1' : '0x0',
      logs: [],
    };
  }

  const lot = (script.lots ?? []).find((entry) => txOf(entry) === hash);
  if (lot === undefined) {
    return null;
  }
  const supply = supplyLogs(script).filter((log) => text(log, 'transactionHash') === hash);
  const lifecycle = lifecycleLogs(script).filter((log) => text(log, 'transactionHash') === hash);
  return {
    blockHash: lot.controllerBlockHash ?? blockAt(lot.blockNumber).hash,
    blockNumber: numberToHex(lot.blockNumber),
    transactionHash: hash,
    status: '0x1',
    logs: [...lifecycle, ...supply],
  };
}

function includedAt(entry: Heartbeat): number {
  return entry.includedAt ?? entry.blockNumber + 1;
}

function heartbeatLog(entry: Heartbeat): LogRecord {
  return logShape({
    blockNumber: includedAt(entry),
    transactionIndex: entry.transactionIndex ?? 0,
    logIndex: 0,
    transactionHash: zeroHash,
    topics: [TOPIC.heartbeat, padHex(GUARDIAN, { size: 32 })],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
      [BigInt(entry.blockNumber), BigInt(entry.timestamp), '0x'],
    ),
  });
}

/** Where a log sits and what it carries. The transaction index is zero unless a fixture orders by it. */
interface LogFields {
  readonly blockNumber: number;
  /** The hash the log names, or the hash of the block at its number. */
  readonly blockHash?: Bytes32 | undefined;
  readonly transactionIndex?: number;
  readonly logIndex: number;
  readonly transactionHash: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** A log as the node answers it. */
type LogRecord = { blockNumber: string } & Record<string, unknown>;

function logShape(fields: LogFields): LogRecord {
  return {
    address: fields.topics[0] === TOPIC.supply ? CORE : logAddress(String(fields.topics[0])),
    topics: fields.topics,
    data: fields.data,
    blockNumber: numberToHex(fields.blockNumber),
    blockHash: fields.blockHash ?? blockAt(fields.blockNumber).hash,
    transactionHash: fields.transactionHash,
    transactionIndex: numberToHex(fields.transactionIndex ?? 0),
    logIndex: numberToHex(fields.logIndex),
    removed: false,
  };
}

function logAddress(topic: string): Address {
  const registryTopics: readonly string[] = [TOPIC.heartbeat, TOPIC.guardianAdded];
  return registryTopics.includes(topic) ? REGISTRY : CONTROLLER;
}

function walletRpcAnswer(script: NodeState, method: string): string | undefined {
  switch (method) {
    case 'eth_fillTransaction':
      throw Object.assign(new Error('eth_fillTransaction is not available'), { code: -32601 });
    case 'eth_blockNumber':
      return numberToHex(script.head);
    case 'eth_getTransactionCount':
      return numberToHex(script.sent.transactions.length);
    case 'eth_estimateGas':
      return '0x186a0';
    case 'eth_gasPrice':
      return '0x2';
    case 'eth_maxPriorityFeePerGas':
      return '0x1';
    default:
      return undefined;
  }
}

/** Decode and recover a real locally signed transaction at the JSON-RPC boundary. */
async function recordTransaction(script: NodeState, raw: unknown): Promise<TxHash> {
  if (typeof raw !== 'string' || !isHex(raw)) {
    throw new Error('Expected a serialized transaction');
  }
  const transaction = parseTransaction(raw);
  if (transaction.to == null || transaction.data === undefined) {
    throw new Error('Expected a registry call');
  }
  const from = await recoverTransactionAddress({
    serializedTransaction: serializeTransaction(transaction),
  });
  const hash = keccak256(raw);
  const decoded = decodeFunctionData({ abi: GUARDIAN_SIGNALS_ABI, data: transaction.data });
  recordRegistryCall(script.sent, decoded);
  script.sent.transactions.push({
    hash,
    from,
    to: transaction.to,
    input: transaction.data,
    nonce: transaction.nonce ?? 0,
    chainId: transaction.chainId ?? 0,
  });
  // The transaction lands after the head, so after the report block as on a real chain, and the head
  // moves twenty blocks on, deep enough for every depth the tests ask for.
  const includedAt = script.head + 1;
  script.head = includedAt + 20;
  script.submitted.set(hash, {
    transactionHash: hash,
    blockNumber: includedAt,
    blockHash: blockAt(includedAt).hash,
    status: 'success',
  });
  return hash;
}

function recordRegistryCall(sent: Sent, decoded: DecodeFunctionDataReturnType<typeof GUARDIAN_SIGNALS_ABI>): void {
  if (decoded.functionName === 'heartbeat') {
    if (lower(decoded.args[0]) !== GUARDIAN) {
      throw new Error('Wrong heartbeat identity');
    }
    sent.calls.push('heartbeat');
    sent.heartbeats.push({ block: decoded.args[1].hash, digest: decoded.args[2] });
    return;
  }
  if (decoded.functionName !== 'suspect' && decoded.functionName !== 'flag') {
    throw new Error('Expected a report or heartbeat');
  }
  const [marketId, onBehalf, borrowers] = decoded.args;
  if (lower(onBehalf) !== GUARDIAN) {
    throw new Error('Wrong report identity');
  }
  const kind = decoded.functionName === 'suspect' ? 'suspects' : 'flags';
  sent.calls.push(kind);
  sent[kind].push(borrowers.map((borrower) => ({ marketId, borrower: lower(borrower) })));
}
