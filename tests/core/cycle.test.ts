import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseRpcProvider } from '../../src/core/index.ts';
import type { CycleEvent, EventHandler, ScreeningResult, SdkEvent } from '../../src/core/index.ts';
import { rpcRequest } from './client.ts';
import { blockAt, fakeNode } from './fake-node.ts';
import type { Script } from './fake-node.ts';
import { guardianOver } from './setup.ts';

const DUE: Script = {
  head: 200_000,
  guardianAddedAt: 1_000,
  lots: [
    {
      kind: 'activating',
      blockNumber: 199_000,
      logIndex: 4,
      amount: 5n,
      supplied: 5n,
      position: {
        dust: 0n,
        activating: 5n,
        activatingStart: blockAt(199_000).timestamp,
        activatingDelay: 60,
      },
    },
  ],
};

const FLAG: ScreeningResult = {
  status: 'judged',
  requiresSuspect: false,
  requiresFlag: true,
};

function cycleEvents(events: readonly SdkEvent[]): CycleEvent[] {
  return events.filter((event): event is CycleEvent => 'cycleId' in event);
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let complete: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (complete === undefined) {
        throw new Error('deferred promise has no resolver');
      }
      complete(value);
    },
  };
}

test('cycle runs every signal phase and correlates its reports with one cycle id', async () => {
  const events: SdkEvent[] = [];
  const { guardian, sent } = guardianOver(DUE, {
    onEvent: (event) => events.push(event),
    screening: { screen: () => Promise.resolve([FLAG]) },
  });

  const outcome = await guardian.cycle();
  assert.equal(outcome.kind, 'attested');
  assert.deepEqual(sent.calls, ['flags', 'heartbeat']);

  const observed = cycleEvents(events);
  assert.deepEqual(
    observed.map((event) => event.event),
    ['cycle.started', 'cycle.planned', 'cycle.discovered', 'cycle.reconstructed', 'cycle.screened', 'cycle.finished'],
  );
  assert.equal(new Set(observed.map((event) => event.cycleId)).size, 1);
  const cycleId = observed[0]?.cycleId;
  assert.ok(cycleId !== undefined);
  const reconstructed = observed.find((event) => event.event === 'cycle.reconstructed');
  assert.equal(reconstructed?.event, 'cycle.reconstructed');
  assert.equal(reconstructed.positions, 1);
  assert.equal(reconstructed.anchors.length, 1);
  const screened = observed.find((event) => event.event === 'cycle.screened');
  assert.equal(screened?.event, 'cycle.screened');
  assert.equal(screened.results.length, 1);
  assert.deepEqual(screened.results[0]?.result, FLAG);
  const finished = observed.find((event) => event.event === 'cycle.finished');
  assert.equal(finished?.event, 'cycle.finished');
  assert.equal(finished.outcome, outcome);
  for (const event of events) {
    if (event.event === 'report.started' || event.event === 'report.confirmed') {
      assert.equal(event.context.cycleId, cycleId);
    }
  }
});

test('observe cycle returns screened evidence and never submits', async () => {
  const events: SdkEvent[] = [];
  const node = fakeNode(DUE);
  const client = new BaseRpcProvider({ request: rpcRequest(node.transport), maxLogBlockRange: 10_000 });
  const { guardian } = guardianOver(DUE, {
    mode: 'observe',
    client,
    onEvent: (event) => events.push(event),
    screening: { screen: () => Promise.resolve([FLAG]) },
  });

  const outcome = await guardian.cycle();
  assert.equal(outcome.kind, 'observed');
  assert.equal(outcome.previousHeartbeatBlock, null);
  assert.equal(outcome.screened.results.length, 1);
  assert.equal(outcome.screened.flags.length, 1);
  assert.deepEqual(node.sent.calls, []);
  assert.equal(cycleEvents(events).at(-1)?.event, 'cycle.finished');
});

test('nothing due is a finished cycle without discovery or screening', async () => {
  const events: SdkEvent[] = [];
  const { guardian, sent } = guardianOver(
    { head: 1_000, guardianAddedAt: 900 },
    { onEvent: (event) => events.push(event) },
  );

  const outcome = await guardian.cycle();
  assert.equal(outcome.kind, 'nothing-due');
  assert.equal(outcome.reason, 'report-block-before-core-deployment');
  assert.deepEqual(sent.calls, []);
  assert.deepEqual(
    cycleEvents(events).map((event) => event.event),
    ['cycle.started', 'cycle.planned', 'cycle.finished'],
  );
  assert.throws(() => Object.assign(outcome, { reason: 'report-block-not-past-stored-heartbeat' }), TypeError);
});

test('cycle emits the original failure, releases its lock and rethrows', async () => {
  const failure = new Error('screening service unavailable');
  const events: SdkEvent[] = [];
  const { guardian } = guardianOver(DUE, {
    onEvent: (event) => events.push(event),
    screening: { screen: () => Promise.reject(failure) },
  });

  await assert.rejects(guardian.cycle(), (error) => error === failure);
  const failed = cycleEvents(events).at(-1);
  assert.equal(failed?.event, 'cycle.failed');
  assert.equal(failed.error, failure);
  await assert.rejects(guardian.cycle(), (error) => error === failure);
});

test('cycle rejects overlapping iterations and observer failures do not affect the result', async () => {
  const screeningStarted = deferred<undefined>();
  const answers = deferred<readonly ScreeningResult[]>();
  const node = fakeNode(DUE);
  const client = new BaseRpcProvider({ request: rpcRequest(node.transport), maxLogBlockRange: 10_000 });
  const onEvent: EventHandler = () => {
    throw new Error('observer failed');
  };
  const { guardian } = guardianOver(DUE, {
    mode: 'observe',
    client,
    onEvent,
    screening: {
      screen: () => {
        screeningStarted.resolve(undefined);
        return answers.promise;
      },
    },
  });

  const first = guardian.cycle();
  await screeningStarted.promise;
  await assert.rejects(guardian.cycle(), /another cycle is in progress/);
  answers.resolve([FLAG]);
  assert.equal((await first).kind, 'observed');
});
