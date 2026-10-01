# Guardian SDK benchmarks

The benchmark suite measures what the SDK costs and whether a cycle fits its blockhash budget. It answers five questions:

1. **Workload:** how much history and how large a work set one cycle can process.
2. **Amplification:** how many RPC requests, returned logs, response bytes, provider decisions and transactions a given amount of useful work creates.
3. **Liveness:** whether required reports and the heartbeat are confirmed before the report block ages out, including repeated work after faults and reorgs.
4. **Daemon overhead:** what the deployable daemon in `daemon/` adds to a cycle: CPU time, memory, event posts and the screening request.
5. **Griefing:** the largest attack a Guardian's first cycle still attests through, and what exceeding it costs the attacker.

[RESULTS.md](RESULTS.md) lists the latest results of a pre-release version, which later versions may change. The suite is not part of `npm run check`: absolute timings are not stable on shared CI. Its code is typechecked, linted and formatted with the rest of the repository. Correctness tests stay in `tests/`; for example, `tests/core/resources.test.ts` asserts behaviour on large histories but measures no time, memory or amplification.

## Running

```bash
npm run benchmark:smoke
npm run benchmark -- --commit <revision>
npm run benchmark:profile -- --from benchmarks/results/<run>/results.json
```

`benchmark:smoke` runs small deterministic instances of every scenario family once and fails if any scenario's own checks fail. It makes no timing claims. `benchmark` runs the `full` preset: two warm-up runs and five measured runs of every scenario. `benchmark:profile` re-runs the slowest and the most memory-heavy scenario of an earlier run once, by median CPU time and median peak RSS, with Node's CPU profiler and sampling heap profiler; `--profile --preset <preset> --scenario <id>` profiles a named scenario instead.

The `anvil` family and the conformance fixtures it reuses need Anvil 1.7.1 on `PATH` or selected through `ANVIL_BIN`. The `griefing` family searches for a capacity in every run and builds histories of hundreds of thousands of logs, so run it once per scenario with a larger heap and an hour per scenario:

```bash
npm run benchmark -- --filter griefing --repeat 1 --warmup 0 --max-old-space-mb 16384 --timeout-ms 3600000
```

Runner options:

| Option                         | Meaning                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `--preset smoke\|full`         | Scenario set; `smoke` by default.                                                                      |
| `--filter <text>`              | Only scenarios whose identifier contains the text.                                                     |
| `--repeat <n>`, `--warmup <n>` | Override the preset's measured and warm-up runs.                                                       |
| `--commit <revision>`          | Revision recorded with the results; also read from `BENCHMARK_COMMIT`. The runner runs no Git command. |
| `--output <directory>`         | Parent of the result directory; `benchmarks/results/` by default.                                      |
| `--timeout-ms <n>`             | Wall-clock limit of one child process; 600000 by default.                                              |
| `--max-old-space-mb <n>`       | Heap limit of one child process; 4096 by default.                                                      |
| `--profile`                    | Profile scenarios instead of measuring a preset; needs `--from <results.json>` or `--scenario <id>`.   |

Each invocation writes a new directory `<output>/<timestamp>-<preset>/` with `results.json` (environment, parameters, every run's raw measurements and per-metric median, minimum and maximum) and `summary.md` (the tables the runner prints). A profile invocation writes `<timestamp>-profile/` with one directory of `.cpuprofile` and `.heapprofile` files per scenario and `profiles.json`; the files open in Chrome DevTools. An existing directory is never overwritten. `benchmarks/results/` is ignored by Git and Prettier; results are local measurements, not repository documentation.

## Method

Every measured run starts a fresh Node process for one scenario, so heap, garbage collection and peak RSS belong to that run, a heavy scenario does not warm the next one, and an out-of-memory failure stops only that run. The child runs with `--expose-gc`, collects garbage before and after the measured operation, and records wall time, CPU time, heap before and after, retained heap, peak RSS and event-loop delay.

The SDK runs unmodified. The benchmark supplies its own implementations of the three caller-owned boundaries:

- `synthetic-rpc.ts` is a deterministic chain that answers the JSON-RPC methods the SDK reads from indexed logs and current registry state. Every answer is counted by method and label, with its returned logs, estimated wire bytes and `eth_getLogs` block span, and attributed to the SDK phase that was running.
- `synthetic-client.ts` is an `RpcClient` whose sends are mined by the synthetic chain. Reads, receipts and confirmation checks go through the SDK's own `BaseRpcProvider`.
- `metrics.ts` wraps the screening provider to count calls, anchors and decisions, and measures resources, phases and amplification.

Chain time is virtual. The synthetic head advances when a transaction waits for inclusion or confirmations, when the SDK's poll timer sleeps, and, in the `full` preset, with real processing time at one block per twelve seconds. The child replaces the SDK's `node:timers/promises` timer with the virtual clock through Node's module mocks, so a wait of one slot costs one block and no wall-clock time. Blocks consumed and the remaining blockhash budget are therefore exact for simulated waits and realistic for processing time. Liveness capacity searches use chain time only, so their answer does not depend on the machine.

The `liveness` and `griefing` families run the synthetic node as a paid shared provider. Each request is answered after a delay of chain time modelled on one provider we measured: 2 s for a log read that finds nothing, 0.4 s for one that returns logs and 50 ms for any other request. Requests in flight overlap, and processing time counts as elsewhere.

The `liveness` family runs a Guardian's whole first cycle over due positions, with a screening service that answers at once, and bisects the largest number whose reports and heartbeat still land within the blockhash budget. Each probe starts at a slot boundary, so the answer does not depend on where in a slot the previous probe ended.

In the `griefing` family a capped provider refuses a log list above 10,000 entries, and every provider fails a response above the daemon's 10 MB transport limit. The node passes every answer through JSON, as a transport parses a response, so the SDK keeps its own copy of each log rather than the node's records. Each scenario writes an attack into the first blocks of a Guardian's discovery window and runs the Guardian's first cycle against it in signal mode: it doubles the attack from 100 operations until the cycle no longer attests, then bisects to within two percent. The SDK reads a refused range again in halves, so a refusal fails a cycle only when a single block's answer is refused. In the report flood the screening service answers after 290 seconds of chain time, the longest the daemon waits for it. A cycle also fails when the report block ages out or its heap in use grows by more than 2,800 MB above the history it built, sampled every 50 ms: the daemon's default 3 GB heap less what an idle daemon holds. Heap in use counts garbage between collections, so the capacity errs low. The attack's price uses the gas of each operation measured on Anvil against the pinned contracts, at the 10th percentile and the median of mainnet base fees over 30 days of 2026, 0.07 and 0.35 gwei.

`synthetic-history.ts` generates lending histories with a seeded pseudo-random source: supplies classified by their controller, drains, maturations and absorbed dust, each with the post-event position the controller records. It follows the transitions in the specification and the controller's activation timer: a lot's delay grows with the market's decaying inflow, and a top-up restarts the timer when that ends it later. The histories cap the delay at two minutes, so every lot is due at the report block; production delays can be far longer. It is not a model of every contract rule; [`tests/conformance/benchmark-history.test.ts`](../tests/conformance/benchmark-history.test.ts) checks that it writes the events the pinned contracts emit for the same operations. `worlds.ts` builds each family's deployment and history from scenario parameters alone, so a separate server process can rebuild the same chain.

Three families leave the synthetic node. The `transport` family runs the SDK's `createViemRpcTransport` against loopback HTTP endpoints served by a separate process (`loopback-server.ts`), so JSON serialization and sockets do not share CPU time with the measured client; each endpoint answers, lags, hangs, resets, refuses connections or returns HTTP and JSON-RPC errors as the scenario prescribes. The `daemon` family runs the transport family's observe cycle over one loopback node twice: by the SDK alone with a provider in the same process, and as `daemon/main.ts` runs it, with screening through the daemon's `HttpScreening` and every event serialized by `toRecord` and posted by `forward`. The same server process serves a screening service that judges every anchor clean and a receiver that answers each post after `receiverLatencyMs`; both count what they receive, and the run ends once the receiver has answered every event. The `anvil` family deploys the pinned production contracts with the conformance fixtures, writes real supply transactions and runs observe and signal cycles through `ViemRpcClient` and the SDK transport; it keeps real timers and mines a block every `blockIntervalMs` while a submission waits for confirmations.

## Scenario families

| Family           | What it isolates                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery`      | Supply log chunks, market-controller and registry reads and lifecycle log chunks per controller, varying range length, `maxLogBlockRange`, supply count, markets, block layout and the share of foreign-registry and dust supplies.                                                                                                                             |
| `reconstruction` | Backward lifecycle walks: many short histories, long histories of drains, drained dust later absorbed, top-ups, and lots whose first contributor is far behind the report block.                                                                                                                                                                                |
| `screening`      | Own-flag reads, the provider request and positional validation, varying anchors, anchors per target, own-flag share, read concurrency, latency and the position of an incomplete result.                                                                                                                                                                        |
| `reports`        | Report batching, the shared confirmation wait and the heartbeat, varying targets, markets, decisions, batch size and confirmation depths, and faults after the first, middle or last report.                                                                                                                                                                    |
| `cycle`          | `Guardian.cycle()` end to end, including provider and RPC latency, a failed last log chunk, a reorg before the heartbeat, a lost report confirmation, a restart after a stale attempt, and steady-state cycles after a previous heartbeat with and without new supplies.                                                                                        |
| `liveness`       | The largest number of due positions whose first cycle, reads from the modelled provider included, fits the blockhash budget, by bisection, for several confirmation, batching and inclusion settings.                                                                                                                                                           |
| `transport`      | HTTP attempts, bytes, latency to a result and time lost on a failing first endpoint: healthy, slow and concurrent endpoints, large and over-limit answers, HTTP 429 and 500, JSON-RPC errors, timeouts, resets, refused connections, exhausted fallbacks, silent log omission, log quorum, and observe cycles over HTTP with and without a hung first endpoint. |
| `daemon`         | What the daemon adds to an observe cycle of the SDK alone: CPU time, peak memory, event posts and their size, posts open at once with a fast and a slow receiver, and the screening request size.                                                                                                                                                               |
| `griefing`       | The largest attack a first cycle attests through and its price: dust deposits withdrawn at once, in one log chunk or across the window; lots withdrawn in full; lots kept for screening to report; against the modelled provider, with and without its log limit.                                                                                               |
| `anvil`          | Observe and signal cycles over the pinned contracts with real transactions, ABI decoding and receipts, for a few hundred to a few thousand supplies.                                                                                                                                                                                                            |

Scenario identifiers name the family and every parameter that differs from the family baseline in `scenarios.ts`. Every scenario states checks about its own result, such as the expected outcome, the number of candidate positions or the transaction count `Σ ceil(suspects per market / batch) + Σ ceil(flags per market / batch) + 1`. A run whose checks fail counts as failed, so the suite cannot report numbers for behaviour it did not reproduce.

## Metrics

`results.json` keeps every metric of every run. The main groups are:

- resources: `wallMs`, `cpuMs`, `peakRssMb`, `heapBeforeMb`, `heapAfterMb`, `heapRetainedMb`, `eventLoopMaxMs`, `eventLoopP99Ms`;
- phases: `planMs`, `discoveryMs`, `reconstructionMs`, `screeningMs`, `signalMs`, and `rpcByPhase` with every request label per phase;
- RPC: `rpcCalls`, `getLogsCalls`, `ethCalls`, `blockReads`, `receiptReads`, `logsReturned`, `responseMb`, `rangeSpanBlocks`, `largestSpanBlocks`, `largestLogList`, `largestResponseMb`, `rpcHandlerMs` (synthetic node time, not SDK time);
- provider and transactions: `providerCalls`, `providerAnchors`, `providerDecisions`, `reportTransactions`, `heartbeatTransactions`;
- liveness: `reportBlock`, `headAtPlanning`, `headAtHeartbeat`, `blocksConsumed`, `remainingBudgetBlocks`, `restarts`, `capacityTargets`, `capacityBatches`;
- amplification: `rpcPerSupply`, `rpcPerAnchor`, `logsPerAnchor`, `kilobytesPerAnchor`, `decisionsPerAnchor`, `reportTransactionsPerTarget`, `reprocessedAnchorShare`;
- daemon: `events`, `eventPosts`, `eventKb`, `largestEventKb`, `maxConcurrentPosts`, `postsInFlight`, `screeningRequestKb`;
- griefing: `capacity`, `probes`, `memoryGrowthMb`, `cycleCpuMs`, `attackGasMillions`, `costEthCheapFee` (0.07 gwei), `costEthMedianFee` (0.35 gwei), `lotsLocked`; the cycle metrics are those of the largest attack that attested.

Response bytes are estimates: logs are counted at their serialized size, and every block read is counted as a mainnet header with 150 transaction hashes, as `eth_getBlockByNumber(tag, false)` returns it.

## Limits

- The synthetic client does not model fee estimation, signing, replacement or the delivery RPC calls of `ViemRpcClient`; report and heartbeat delivery is counted in transactions and blocks.
- Registry reads answer current state at any canonical block, which is enough for the cycles measured here.
- A successful but incomplete `eth_getLogs` answer from the only endpoint cannot be detected. The `silent-omission` condition records this trust boundary rather than a failure; `log-quorum-lagging` shows what a quorum of independent endpoints adds.
- The `griefing` family writes the attack into the synthetic history without checking that its operations fit the blocks they occupy, and its two-minute delay cap keeps heavy inflow from delaying later lots as long as it would in production. Its price counts gas only: a discovery flood and a candidate flood recycle one deposit's capital, while a report flood locks one lot per target (`lotsLocked`). The modelled provider gives every request of a kind the same delay; a live provider's delays vary with its load and plan, and large answers take longer.
- The `daemon` family leaves out the daemon's log lines. Its loopback node answers far faster than a live one, so events arrive faster and more posts are open at once than on a live network; the receiver shares the server process with the node.
- The `transport` family measures the SDK transport and viem's fallback, not a public provider's rate limits or caching. A test of a real network, with the runner, the RPC endpoints and the screening service on separate machines, is a separate exercise.
- Timings from a laptop or shared CI are indicative only. For reproducible figures, run the `full` preset on one dedicated Linux machine with a fixed CPU type, vCPU count and memory, the Node and Anvil versions pinned in this repository, and no parallel jobs.
