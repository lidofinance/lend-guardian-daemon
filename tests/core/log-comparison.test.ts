// Log comparison of the viem transport over real HTTP and scripted JSON-RPC providers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpRequestError } from 'viem';
import { createViemRpcTransport, LogsNotConfirmedError } from '../../src/chain/viem-transport.ts';
import type { ViemRpcTransport } from '../../src/chain/viem-transport.ts';
import type { EventHandler, SdkEvent } from '../../src/core/index.ts';
import { failingProvider, malformedProvider, scriptedProvider } from './scripted-providers.ts';
import type { Answer, ScriptedProvider } from './scripted-providers.ts';

type Request = (request: { method: string; params?: unknown }) => Promise<unknown>;

interface Verified {
  readonly request: Request;
  readonly transport: ViemRpcTransport;
  readonly providers: readonly ScriptedProvider[];
  /** Differences the transport reported, without the per-request measurements. */
  readonly differences: SdkEvent[];
}

const CORE = '0x00000000000000000000000000000000000000bb';
const BLOCK_HASH = `0x${'b1'.repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${'b2'.repeat(32)}`;
const SUPPLY_LOG = {
  address: CORE,
  topics: [`0x${'a3'.repeat(32)}`],
  data: '0x',
  blockNumber: '0x5a',
  blockHash: BLOCK_HASH,
  transactionHash: `0x${'c1'.repeat(32)}`,
  transactionIndex: '0x0',
  logIndex: '0x5',
  removed: false,
};
const MIDDLE_SUPPLY_LOG = { ...SUPPLY_LOG, blockNumber: '0x5d', logIndex: '0x2' };
const LATER_SUPPLY_LOG = { ...SUPPLY_LOG, blockNumber: '0x61', logIndex: '0x7' };
const RANGE = { method: 'eth_getLogs', params: [{ address: CORE, fromBlock: '0x1', toBlock: '0x62' }] };
const FEE_READ = { method: 'eth_gasPrice' };
const OPTIONS = {
  logQuorum: 2,
  timeoutMs: 500,
  maxResponseBodySize: 1_000_000,
  retryCount: 0,
  retryDelayMs: 0,
  userAgent: 'log-comparison-test',
};

function returning(...logs: readonly unknown[]): Answer {
  return () => logs;
}

const refusing: Answer = () => {
  throw new Error('internal failure');
};

function scripted(...answers: readonly Answer[]): Promise<ScriptedProvider>[] {
  return answers.map((answer) => scriptedProvider(answer));
}

async function withProviders(
  starting: readonly Promise<ScriptedProvider>[],
  run: (verified: Verified) => Promise<void>,
  observe: EventHandler = () => undefined,
  retryCount = OPTIONS.retryCount,
): Promise<void> {
  const providers = await Promise.all(starting);
  const differences: SdkEvent[] = [];
  const transport = createViemRpcTransport({
    ...OPTIONS,
    retryCount,
    urls: providers.map((provider) => provider.url),
    onEvent: (event) => {
      if (event.event === 'rpc.answersDiffer') {
        differences.push(event);
      }
      return observe(event);
    },
  });
  try {
    await run({ request: transport({}).request, transport, providers, differences });
  } finally {
    await Promise.all(providers.map((provider) => provider.stop()));
  }
}

async function assertUnconfirmed(read: Promise<unknown>, reason: LogsNotConfirmedError['reason']): Promise<void> {
  await assert.rejects(read, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.cause instanceof LogsNotConfirmedError);
    assert.equal(error.cause.reason, reason);
    return true;
  });
}

test('logs that every provider returns alike are returned without a report', async () => {
  const providers = scripted(returning(SUPPLY_LOG), returning(SUPPLY_LOG), returning(SUPPLY_LOG));
  await withProviders(providers, async (verified) => {
    assert.deepEqual(await verified.request(RANGE), [SUPPLY_LOG]);
    assert.deepEqual(verified.differences, []);
  });
});

test('extra provider fields, letter case and order are not a difference', async () => {
  const decorated = { ...SUPPLY_LOG, address: CORE.toUpperCase().replace('0X', '0x'), blockTimestamp: '0x65' };
  const providers = scripted(
    returning(SUPPLY_LOG, LATER_SUPPLY_LOG),
    returning(LATER_SUPPLY_LOG, decorated),
    returning(SUPPLY_LOG, LATER_SUPPLY_LOG),
  );
  await withProviders(providers, async (verified) => {
    assert.deepEqual(await verified.request(RANGE), [SUPPLY_LOG, LATER_SUPPLY_LOG]);
    assert.deepEqual(verified.differences, []);
  });
});

for (const [name, lagging] of [
  ['the last log', [SUPPLY_LOG, MIDDLE_SUPPLY_LOG]],
  ['a log in the middle', [SUPPLY_LOG, LATER_SUPPLY_LOG]],
  ['every log', []],
] as const) {
  test(`a provider that lacks ${name} is reported and the complete logs are returned`, async () => {
    const complete = [SUPPLY_LOG, MIDDLE_SUPPLY_LOG, LATER_SUPPLY_LOG];
    const providers = scripted(returning(...complete), returning(...complete), returning(...lagging));
    await withProviders(providers, async (verified) => {
      assert.deepEqual(await verified.request(RANGE), complete);
      assert.deepEqual(verified.differences, [
        { event: 'rpc.answersDiffer', method: 'eth_getLogs', acceptedRpcIndexes: [0, 1], otherRpcIndexes: [2] },
      ]);
    });
  });
}

test('a provider that has a log the quorum lacks rejects the read', async () => {
  const providers = scripted(returning(SUPPLY_LOG), returning(SUPPLY_LOG), returning(SUPPLY_LOG, LATER_SUPPLY_LOG));
  await withProviders(providers, async (verified) => {
    await assertUnconfirmed(verified.request(RANGE), 'answers-differ');
    assert.deepEqual(verified.differences, [
      { event: 'rpc.answersDiffer', method: 'eth_getLogs', acceptedRpcIndexes: [], otherRpcIndexes: [0, 1, 2] },
    ]);
  });
});

test('a log that one provider places in another block rejects the read', async () => {
  const relocated = { ...SUPPLY_LOG, blockHash: OTHER_BLOCK_HASH };
  const providers = scripted(returning(SUPPLY_LOG), returning(SUPPLY_LOG), returning(relocated));
  await withProviders(providers, async (verified) => {
    await assertUnconfirmed(verified.request(RANGE), 'answers-differ');
  });
});

for (const [name, changed] of [
  ['data', { ...SUPPLY_LOG, data: '0x01' }],
  ['topics', { ...SUPPLY_LOG, topics: [`0x${'a4'.repeat(32)}`] }],
] as const) {
  test(`a log that one provider returns with other ${name} rejects the read`, async () => {
    const providers = scripted(returning(SUPPLY_LOG), returning(SUPPLY_LOG), returning(changed));
    await withProviders(providers, async (verified) => {
      await assertUnconfirmed(verified.request(RANGE), 'answers-differ');
    });
  });
}

test('a log that one provider reports as removed rejects the read', async () => {
  const removed = { ...SUPPLY_LOG, removed: true };
  const providers = scripted(returning(SUPPLY_LOG), returning(SUPPLY_LOG), returning(removed));
  await withProviders(providers, async (verified) => {
    await assertUnconfirmed(verified.request(RANGE), 'answers-differ');
  });
});

test('three providers that all differ cannot confirm a read', async () => {
  const providers = scripted(returning(SUPPLY_LOG), returning(MIDDLE_SUPPLY_LOG), returning(LATER_SUPPLY_LOG));
  await withProviders(providers, async (verified) => {
    await assertUnconfirmed(verified.request(RANGE), 'answers-differ');
  });
});

for (const [name, invalid] of [
  ['is not a list', () => 'no logs'],
  ['holds a log that is not an object', returning('no log')],
  ['holds a log without topics', returning({ ...SUPPLY_LOG, topics: undefined })],
  ['holds a log whose address is not a text', returning({ ...SUPPLY_LOG, address: 7 })],
  ['repeats a log', returning(SUPPLY_LOG, SUPPLY_LOG)],
] as const) {
  test(`a reply that ${name} is left out and the other providers decide`, async () => {
    await withProviders(scripted(returning(SUPPLY_LOG), invalid, returning(SUPPLY_LOG)), async (verified) => {
      assert.deepEqual(await verified.request(RANGE), [SUPPLY_LOG]);
      assert.deepEqual(verified.differences, []);
    });
  });
}

test('two providers that repeat a log alike cannot form a quorum', async () => {
  const repeating = returning(SUPPLY_LOG, SUPPLY_LOG);
  await withProviders(scripted(repeating, repeating, returning(SUPPLY_LOG)), async (verified) => {
    await assertUnconfirmed(verified.request(RANGE), 'too-few-answers');
  });
});

for (const [name, absent] of [
  ['answers with an error', () => scriptedProvider(refusing)],
  ['cannot be reached', failingProvider],
  ['sends a malformed reply', malformedProvider],
] as const) {
  test(`a provider that ${name} is absent rather than differing`, async () => {
    const providers = [scriptedProvider(returning(SUPPLY_LOG)), absent(), scriptedProvider(returning(SUPPLY_LOG))];
    await withProviders(providers, async (verified) => {
      assert.deepEqual(await verified.request(RANGE), [SUPPLY_LOG]);
      assert.deepEqual(verified.differences, []);
    });
  });
}

test('fewer answers than the quorum cannot confirm a read and name the first failure', async () => {
  const providers = [scriptedProvider(returning(SUPPLY_LOG)), failingProvider(), failingProvider()];
  await withProviders(providers, async (verified) => {
    await assert.rejects(verified.request(RANGE), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.cause instanceof LogsNotConfirmedError);
      assert.equal(error.cause.reason, 'too-few-answers');
      assert.deepEqual(error.cause.rpcIndexes, [0]);
      assert.ok(error.cause.cause instanceof HttpRequestError);
      return true;
    });
  });
});

const THREE_URLS = ['http://a.test', 'http://b.test', 'http://c.test'];

for (const [name, urls, logQuorum] of [
  ['of one', THREE_URLS, 1],
  ['above the number of providers', THREE_URLS.slice(0, 2), 3],
  ['that is not an integer', THREE_URLS, 2.5],
] as const) {
  test(`a quorum ${name} is refused at construction`, () => {
    assert.throws(() => createViemRpcTransport({ ...OPTIONS, urls, logQuorum }), RangeError);
  });
}

test('a provider that could not be reached is asked again for the next logs', async () => {
  const providers = [failingProvider(), ...scripted(returning(SUPPLY_LOG), returning(SUPPLY_LOG))];
  await withProviders(providers, async (verified) => {
    await verified.request(RANGE);
    await verified.request(RANGE);
    assert.deepEqual(verified.providers[0]?.asked, ['eth_getLogs', 'eth_getLogs']);
  });
});

test('logs that are not confirmed are read again before the read fails', async () => {
  const providers = scripted(returning(SUPPLY_LOG), returning(MIDDLE_SUPPLY_LOG), returning(LATER_SUPPLY_LOG));
  const readTwice = async (verified: Verified): Promise<void> => {
    await assertUnconfirmed(verified.request(RANGE), 'answers-differ');
    assert.deepEqual(
      verified.providers.map((provider) => provider.asked),
      [
        ['eth_getLogs', 'eth_getLogs'],
        ['eth_getLogs', 'eth_getLogs'],
        ['eth_getLogs', 'eth_getLogs'],
      ],
    );
  };
  await withProviders(providers, readTwice, undefined, 1);
});

test('a request other than logs is retried as often as without the quorum', async () => {
  const providers = [failingProvider(), failingProvider(), failingProvider()];
  const failTwice = async (verified: Verified): Promise<void> => {
    await assert.rejects(verified.request(FEE_READ), HttpRequestError);
    assert.deepEqual(
      verified.providers.map((provider) => provider.asked),
      [
        ['eth_gasPrice', 'eth_gasPrice'],
        ['eth_gasPrice', 'eth_gasPrice'],
        ['eth_gasPrice', 'eth_gasPrice'],
      ],
    );
  };
  await withProviders(providers, failTwice, undefined, 1);
});

test('an observer that edits request parameters cannot change what the providers are asked', async () => {
  const askedFilters: unknown[] = [];
  const recording: Answer = (_method, params) => {
    askedFilters.push(params[0]);
    return [SUPPLY_LOG];
  };
  const editing: EventHandler = (event) => {
    if (event.event === 'rpc.requestStarted' && Array.isArray(event.params)) {
      event.params[0] = { address: CORE, fromBlock: '0x62', toBlock: '0x62' };
    }
  };
  await withProviders(
    scripted(recording, recording, recording),
    async (verified) => {
      assert.deepEqual(await verified.request(RANGE), [SUPPLY_LOG]);
      assert.deepEqual(askedFilters, [RANGE.params[0], RANGE.params[0], RANGE.params[0]]);
    },
    editing,
  );
});

test('a request other than logs is answered by the first provider without comparison', async () => {
  const providers = scripted(
    () => '0x1',
    () => '0x2',
    () => '0x3',
  );
  await withProviders(providers, async (verified) => {
    assert.equal(await verified.request(FEE_READ), '0x1');
    assert.deepEqual(
      verified.providers.map((provider) => provider.asked),
      [['eth_gasPrice'], [], []],
    );
  });
});

test('a request other than logs moves to the next provider when the first cannot be reached', async () => {
  const providers = [
    failingProvider(),
    ...scripted(
      () => '0x7',
      () => '0x8',
    ),
  ];
  await withProviders(providers, async (verified) => {
    assert.equal(await verified.request(FEE_READ), '0x7');
    assert.deepEqual(
      verified.providers.map((provider) => provider.asked),
      [['eth_gasPrice'], ['eth_gasPrice'], []],
    );
  });
});

test('the endpoints of the transport remain individually addressable', async () => {
  await withProviders(scripted(returning(), returning(), returning()), (verified) => {
    assert.equal(verified.transport.endpoints.length, 3);
    return Promise.resolve();
  });
});
