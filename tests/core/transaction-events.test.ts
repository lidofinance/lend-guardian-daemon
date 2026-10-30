import type { NodeRequest } from './client.ts';
import { rpcRequest, SEND_TIMEOUT_MS } from './client.ts';
import { BaseRpcProvider } from '../../src/core/index.ts';
// These report-phase guards were moved from the daemon with batching and confirmation ownership.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, numberToHex, padHex, zeroAddress } from 'viem';
import { Guardian } from '../../src/core/index.ts';
import type {
  ReceiptRef,
  RpcClient,
  SdkEvent,
  PreparedTransaction,
  TransactionAttempt,
  TransactionRequest,
  SendOptions,
  SignalTarget,
  Stale,
  TxHash,
  Hex,
} from '../../src/core/index.ts';
import { GUARDIAN_SIGNALS_ABI } from '../../abi/GuardianSignals.abi.ts';
import { Screened, Work } from '../../src/core/outcomes.ts';
import { BLOCK_HASH, BORROWER, GUARDIAN, MARKET, REGISTRY, TRANSACTION_HASH } from './delivery-fakes.ts';

const DEPTH = 12;
/** The block a fixed receipt names: the one after the work's report block, 98. */
const FIXED_RECEIPT_BLOCK = 99;
type CheckPlan = () => Promise<Stale | null>;
const validPlan: CheckPlan = () => Promise.resolve(null);

function targets(count: number): SignalTarget[] {
  return Array.from({ length: count }, (_, index) => ({
    marketId: MARKET,
    borrower: padHex(numberToHex(index + 1), { size: 20 }),
  }));
}

class ReportsComplete extends Error {}

interface ChainState {
  head: bigint;
  isFirstReorged: boolean;
  hasMovedHeartbeat: boolean;
  checkPlan: CheckPlan;
}

interface BatchState extends ChainState {
  nonce: number;
}

function reader(
  state: ChainState,
  receipts: ReadonlyMap<TxHash, ReceiptRef>,
  calls: ReadonlyMap<TxHash, Hex>,
  useFixedReceipt: boolean,
): NodeRequest {
  const block = (number: number) => ({
    number: numberToHex(number),
    hash: padHex(numberToHex(number)),
    timestamp: numberToHex(number * 12),
  });
  return async (method, params) => {
    if (method === 'eth_getBlockByNumber') {
      if (params[0] !== 'latest') {
        const number = Number(params[0]);
        return useFixedReceipt && number === FIXED_RECEIPT_BLOCK
          ? { ...block(number), hash: BLOCK_HASH }
          : block(number);
      }
      const stale = await state.checkPlan();
      state.hasMovedHeartbeat = stale?.reason === 'stored-heartbeat-moved';
      return block(stale?.reason === 'report-block-aged-out' ? 1000 : Number(state.head++));
    }
    if (method === 'eth_call') {
      return padHex(state.hasMovedHeartbeat ? numberToHex(2000) : '0x0');
    }
    if (method === 'eth_getTransactionByHash') {
      const input = calls.get(`0x${String(params[0]).slice(2)}`);
      assert.ok(input !== undefined);
      return { hash: params[0], from: GUARDIAN, to: REGISTRY, input, nonce: '0x0', value: '0x0' };
    }
    assert.equal(method, 'eth_getTransactionReceipt');
    const hash = params[0];
    assert.ok(typeof hash === 'string' && hash.startsWith('0x'));
    const receipt = receipts.get(`0x${hash.slice(2)}`);
    assert.ok(receipt !== undefined);
    const reorged = state.isFirstReorged && receipt === receipts.values().next().value;
    return {
      ...receipt,
      blockNumber: numberToHex(receipt.blockNumber),
      blockHash: reorged ? padHex('0xff') : receipt.blockHash,
      status: '0x1',
      logs: [],
    };
  };
}

function reportClient(
  state: BatchState,
  receipts: Map<TxHash, ReceiptRef>,
  broadcasts: bigint[],
  events: SdkEvent[],
  recordedCalls: unknown[][],
  useFixedReceipt: boolean,
): RpcClient {
  const calls = new Map<TxHash, Hex>();
  const request = rpcRequest(reader(state, receipts, calls, useFixedReceipt));
  return Object.assign(new BaseRpcProvider({ request, maxLogBlockRange: 1000 }), {
    signer: GUARDIAN,
    transactionPolicy: {
      maxFeePerGas: 100n,
      sendTimeoutMs: SEND_TIMEOUT_MS,
      replacementFeeBumpBps: 1_000,
      replacementTimeoutMs: 1_000,
      sendAttempts: 2,
    },
    request,
    prepareTransaction: (
      _transaction: TransactionRequest,
      _options: TransactionAttempt,
    ): Promise<PreparedTransaction> => Promise.reject(new Error('The report fixture implements send directly')),
    broadcastTransaction: (_transaction: PreparedTransaction, _options: TransactionAttempt): Promise<TxHash> =>
      Promise.reject(new Error('The report fixture implements send directly')),
    send: (transaction: TransactionRequest, options: SendOptions) => {
      const decoded = decodeFunctionData({ abi: GUARDIAN_SIGNALS_ABI, data: transaction.data });
      if (decoded.functionName === 'heartbeat') {
        return Promise.reject(new ReportsComplete());
      }
      recordedCalls.push([...decoded.args]);
      const hash = useFixedReceipt ? TRANSACTION_HASH : padHex(numberToHex(++state.nonce));
      const receipt = {
        transactionHash: hash,
        blockNumber: useFixedReceipt ? FIXED_RECEIPT_BLOCK : Number(state.head),
        blockHash: useFixedReceipt ? BLOCK_HASH : padHex(numberToHex(state.head)),
      };
      broadcasts.push(state.head);
      receipts.set(hash, receipt);
      calls.set(hash, transaction.data);
      events.push({
        event: 'transaction.broadcast',
        context: options.context,
        nonce: useFixedReceipt ? 7 : state.nonce,
        transactionHash: hash,
        attempt: 1,
        startedAt: 0,
        finishedAt: 0,
      });
      state.head += BigInt(options.confirmations - 1);
      return Promise.resolve(receipt);
    },
  });
}

/** A scripted chain advances one block on each head read, just as the original batching guard. */
function batches(size = 1, useFixedReceipt = false) {
  const state = {
    head: 100n,
    nonce: 0,
    isFirstReorged: false,
    hasMovedHeartbeat: false,
    checkPlan: validPlan,
  };
  const receipts = new Map<TxHash, ReceiptRef>();
  const broadcasts: bigint[] = [];
  const confirmedAt: bigint[] = [];
  const events: SdkEvent[] = [];
  const recordedCalls: unknown[][] = [];
  const client = reportClient(state, receipts, broadcasts, events, recordedCalls, useFixedReceipt);
  const run = async (
    kind: 'suspect' | 'flag',
    selected: readonly SignalTarget[],
    depth: number,
    checkPlan: CheckPlan,
  ) => {
    state.checkPlan = checkPlan;
    const guardian = new Guardian({
      deployment: {
        chainId: 1,
        slotSeconds: 1,
        lidoLend: { address: REGISTRY, deploymentBlock: 0 },
        guardianSignals: { address: REGISTRY, deploymentBlock: 0 },
      },
      guardian: GUARDIAN,
      expectedDelegate: zeroAddress,
      client,
      screening: { screen: () => Promise.resolve([]) },
      maxSignalBatchSize: size,
      txConfirmationBlocks: depth,
      heartbeatReserveBlocks: 8,
      idleHeartbeatInterval: 1,
      screeningTimeoutMs: 10_000,
      onEvent: (event) => {
        events.push(event);
        if (event.event === 'report.confirmed') {
          confirmedAt.push(state.head);
        }
      },
    });
    const reportBlock = { number: 98, hash: padHex(numberToHex(98)), timestamp: 1176 };
    const work = new Work(
      {
        kind: 'plan',
        previousHeartbeatBlock: null,
        heartbeatTimestampAtStart: 0,
        reportsSince: null,
        discoveryRange: { from: reportBlock, to: reportBlock },
      },
      new Map(),
      new Map(),
    );
    const screened = new Screened(
      work,
      { results: [], skipped: [] },
      { suspects: kind === 'suspect' ? selected : [], flags: kind === 'flag' ? selected : [] },
    );
    try {
      const outcome = await guardian.signalAndHeartbeat(screened);
      assert.equal(outcome.kind, 'stale');
      return outcome;
    } catch (error) {
      if (error instanceof ReportsComplete) {
        return [...receipts.values()];
      }
      throw error;
    }
  };
  return {
    submitter: {
      sendSuspects: (selected: readonly SignalTarget[], depth: number, check: CheckPlan) =>
        run('suspect', selected, depth, check),
      sendFlags: (selected: readonly SignalTarget[], depth: number, check: CheckPlan) =>
        run('flag', selected, depth, check),
    },
    state,
    broadcasts,
    receipts,
    confirmedAt,
    events,
    calls: recordedCalls,
  };
}

test('thirty batches share the full-depth wait and all receipts are deep before returning', async () => {
  const { submitter, broadcasts, state, confirmedAt } = batches();
  const outcome = await submitter.sendSuspects(targets(30), DEPTH, validPlan);
  assert.ok(!('kind' in outcome));
  assert.equal(outcome.length, 30);
  assert.equal(broadcasts.length, 30);
  assert.ok(state.head < 220n, `cycle spent ${String(state.head - 100n)} blocks`);
  assert.equal(confirmedAt.length, 30);
  for (const receipt of outcome) {
    assert.ok(state.head - BigInt(receipt.blockNumber) + 1n >= BigInt(DEPTH));
    assert.ok(confirmedAt.every((head) => head - BigInt(receipt.blockNumber) + 1n >= BigInt(DEPTH)));
  }
});

test('a plan invalidated after one batch prevents every later batch', async () => {
  const { submitter, broadcasts, confirmedAt } = batches();
  const stale = { kind: 'stale', reason: 'report-block-aged-out' } as const;
  const checkPlan: CheckPlan = () => Promise.resolve(broadcasts.length === 0 ? null : stale);
  assert.deepEqual(await submitter.sendFlags(targets(3), DEPTH, checkPlan), stale);
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(confirmedAt, []);
});

test('a plan invalidated during the shared confirmation wait returns stale', async () => {
  const { submitter, broadcasts, confirmedAt } = batches();
  const stale = { kind: 'stale', reason: 'stored-heartbeat-moved' } as const;
  const checkPlan: CheckPlan = () => Promise.resolve(broadcasts.length < 3 ? null : stale);
  assert.deepEqual(await submitter.sendFlags(targets(3), DEPTH, checkPlan), stale);
  assert.equal(broadcasts.length, 3);
  assert.deepEqual(confirmedAt, []);
});

test('a report reorged while later batches land cannot complete the shared confirmation', async () => {
  const { submitter, state, broadcasts, confirmedAt } = batches();
  const checkPlan: CheckPlan = () => {
    state.isFirstReorged = broadcasts.length === 3;
    return Promise.resolve(null);
  };
  assert.deepEqual(await submitter.sendSuspects(targets(3), DEPTH, checkPlan), {
    kind: 'stale',
    reason: 'report-no-longer-confirmed',
  });
  assert.deepEqual(confirmedAt, []);
});

test('a failing plan check aborts before broadcasting a batch', async () => {
  const { submitter, broadcasts } = batches();
  const failure = new Error('scripted RPC failure');
  const checkPlan: CheckPlan = () => Promise.reject(failure);
  await assert.rejects(submitter.sendSuspects(targets(3), DEPTH, checkPlan), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });
  assert.deepEqual(broadcasts, []);
});

test('a confirmed report is recorded as its broadcast and its confirmed action, with the receipt', async () => {
  const { submitter, events } = batches(20, true);
  const receipts = await submitter.sendSuspects([{ marketId: MARKET, borrower: BORROWER }], 1, validPlan);
  assert.deepEqual(receipts, [
    { transactionHash: TRANSACTION_HASH, blockNumber: FIXED_RECEIPT_BLOCK, blockHash: BLOCK_HASH },
  ]);
  const suspectEvents = events.filter((event) => 'context' in event && event.context?.method === 'suspect');
  const [started, broadcast, confirmed] = suspectEvents;
  assert.ok(started !== undefined && 'context' in started);
  assert.ok(broadcast !== undefined && 'context' in broadcast);
  assert.ok(confirmed !== undefined && 'context' in confirmed);
  assert.deepEqual(suspectEvents, [
    {
      event: 'report.started',
      context: started.context,
    },
    {
      event: 'transaction.broadcast',
      context: broadcast.context,
      nonce: 7,
      transactionHash: TRANSACTION_HASH,
      attempt: 1,
      startedAt: 0,
      finishedAt: 0,
    },
    {
      event: 'report.confirmed',
      context: confirmed.context,
      transactionHash: TRANSACTION_HASH,
      receiptStatus: 'success',
      receiptBlockHash: BLOCK_HASH,
    },
  ]);
  assert.partialDeepStrictEqual(started.context, { method: 'suspect', marketId: MARKET, accounts: [BORROWER] });
});

test('targets are batched per market and per batch size, one transaction each', async () => {
  const { submitter, calls, broadcasts } = batches(2);
  const other = `0x${'44'.repeat(32)}` as const;
  const second = '0x00000000000000000000000000000000000000b2';
  const third = '0x00000000000000000000000000000000000000b3';
  const receipts = await submitter.sendFlags(
    [
      { marketId: MARKET, borrower: BORROWER },
      { marketId: MARKET, borrower: second },
      { marketId: MARKET, borrower: third },
      { marketId: other, borrower: BORROWER },
    ],
    1,
    validPlan,
  );
  assert.ok(!('kind' in receipts));
  assert.equal(receipts.length, 3);
  assert.deepEqual(calls, [
    [MARKET, GUARDIAN, [BORROWER, second]],
    [MARKET, GUARDIAN, [third]],
    [other, GUARDIAN, [BORROWER]],
  ]);
  assert.equal(broadcasts.length, 3);
});
