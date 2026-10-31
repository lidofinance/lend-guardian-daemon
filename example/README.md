# Guardian example

This is the example for partners integrating the SDK. It demonstrates the complete scan cycle and the application code needed to run it. Adapt its screening provider and operating policy for your deployment before running it in production. Production operation requires application-specific screening, transaction recovery, monitoring, logging and deployment configuration; the [delivery and recovery limits](#delivery-and-recovery-limits) describe what this example provides and what the integrating application must supply. The [daemon](../daemon/README.md) runs the same Guardian and schedule with screening over HTTP, packaged as a Docker image.

| File                           | Role                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`main.ts`](main.ts)           | The entry point: the Guardian with the placeholder screening on the schedule, and a readable log.                                                                                                                      |
| [`guardian.ts`](guardian.ts)   | The numeric settings with their defaults and ranges; the SDK setup: one viem transport, the public and wallet clients, the SDK client and the Guardian; and the schedule of cycles with the recovery between attempts. |
| [`env.ts`](env.ts)             | The reading and validation of the environment.                                                                                                                                                                         |
| [`screening.ts`](screening.ts) | The placeholder `ScreeningProvider` that answers `incomplete`; connect your provider here.                                                                                                                             |

The [daemon](../daemon/README.md) runs `guardian.ts` and `env.ts` too. The example never imports the daemon, and ESLint checks it.

The example defaults to `observe`, constructs no wallet in that mode and never submits transactions. The included [`UnconfiguredScreening`](screening.ts) returns `incomplete` for every requested anchor. There is no provider that automatically clears deposits.

The example runs from the SDK source checkout on Node 24.22.1 or newer, after `npm ci` has installed its dependencies. The checkout installs viem as a development dependency, so an installation that omits development dependencies cannot run the example. In a consuming project, copy this directory and import Guardian and shared contracts from `guardian-daemon-sdk/core` and `ViemRpcClient` plus `createViemRpcTransport` from `guardian-daemon-sdk/clients`. The package includes this example, its guide and the SDK source used by its relative imports.

## Read and adapt the example

1. Follow `Guardian.cycle` and its use in [`main.ts`](main.ts) and [`guardian.ts`](guardian.ts) to see one complete iteration and the outcomes that stop it. An observed cycle does not advance coverage; an attested result returns its confirmed report block as the next cycle's optional search hint.
2. Read `createGuardian` in [`guardian.ts`](guardian.ts) for the reusable viem transport, public/wallet clients, one shared `onEvent` handler and SDK limits. `runCycles` runs one cycle at a time, and `runCycle` owns the recovery between attempts. The [daemon](../daemon/README.md) runs the same code with screening over HTTP.
3. Implement your provider in [`screening.ts`](screening.ts). Return decisions in the original anchor order; a timeout, missing answer or unknown result must remain incomplete. Keep vendor-specific calls and policy in this adapter.
4. Set the deployment inputs below, start in observe mode and check the reconstructed work and proposed reports. Enable signal mode only with a delegate that belongs to this application alone, because the example clears every pending transaction of that address before each signal cycle.

From a source checkout:

```bash
npm ci
npm run check
# After supplying the deployment and RPC configuration below:
MODE=observe node example/main.ts
```

The shipped provider deliberately returns `incomplete`. Successful compilation or an empty-work cycle does not establish that a provider is configured.

## Configuration

Both entry points read process environment variables through [`env.ts`](env.ts); they do not load `.env` files. Reads happen when a helper is called, not when the module is imported. Supply deployment values through your own launcher or secret manager.

| Variable                                                          | Meaning                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MODE`                                                            | `observe` by default, or explicitly `signal`. Other values are rejected.                                                                                                                                                             |
| `CHAIN_ID`                                                        | `1` (mainnet, default) or `560048` (Hoodi). Other networks are rejected.                                                                                                                                                             |
| `RPC_URLS`                                                        | Comma-separated HTTP(S) endpoints, in fallback order.                                                                                                                                                                                |
| `RPC_LOG_QUORUM`                                                  | Number of endpoints that must return the same logs, from 2 to the number of `RPC_URLS`. Unset, one endpoint answers a log read; an empty value is rejected. Signal mode requires it under the condition in the list below the table. |
| `GUARDIAN`                                                        | Registered Guardian address.                                                                                                                                                                                                         |
| `LIDO_LEND`, `GUARDIAN_SIGNALS`                                   | Deployed lending core and GuardianSignals addresses.                                                                                                                                                                                 |
| `LIDO_LEND_DEPLOYMENT_BLOCK`, `GUARDIAN_SIGNALS_DEPLOYMENT_BLOCK` | Deployment block numbers used as scan floors, decimal integers of at least 1.                                                                                                                                                        |
| `SIGNER_KEY`                                                      | Signal mode only: a 32-byte private key for the registered delegate. Observe never reads this variable.                                                                                                                              |

`RPC_LOG_QUORUM` by mode:

- In signal mode it is required, with a value of at least 2, when at least one endpoint of `RPC_URLS` can answer a log range beyond its head without an error. The SDK's [RPC requirements](../README.md#rpc-requirements) state this rule and say which endpoints can: an endpoint of a hosted provider can, unless the provider guarantees the error for every backend behind it.
- The quorum needs at least two URLs, so in signal mode one URL of such a provider is not enough.
- In observe mode it is optional, because observe sends no heartbeat.
- For production signal mode, configure at least three endpoints from different providers with `RPC_LOG_QUORUM=2`; endpoints of one provider can lag alike.
- The example does not check these rules.

The application selects viem's `mainnet` or `hoodi` through `env.chain('CHAIN_ID')` and uses that chain for both clients and Guardian. Both networks use 12-second slots, so the SDK derives a 50,400-block lookback; Hoodi's slot timing is documented in its [staking guide](https://hoodi.launchpad.ethereum.org/en/withdrawals). RPC endpoints come from `RPC_URLS` through `createViemRpcTransport`, which is a viem transport used by both `createPublicClient` and `createWalletClient`. Supply the selected network's deployment addresses, deployment blocks and registered Guardian address. Signal mode deliberately requires a delegate distinct from the Guardian; the SDK also supports signing as the Guardian itself.

### Settings

Every numeric setting of `GUARDIAN_SETTINGS` in [`guardian.ts`](guardian.ts) is optional and keeps its default while unset. A set value must be a decimal integer in the setting's range; every value is checked before the Guardian is built. Guardian checks the combinations when it starts, for example that `SEND_TIMEOUT_MS` covers `TRANSACTION_CONFIRMATION_BLOCKS` plus one slot. The defaults are this application's policy; the [delivery and recovery limits](#delivery-and-recovery-limits) explain them.

| Variable                          | Default                | Meaning                                                                                                                                                                                   |
| --------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CYCLE_INTERVAL_MS`               | 360000, 30 slots       | Time from the start of one cycle to the start of the next.                                                                                                                                |
| `MAX_RESTARTS_PER_CYCLE`          | 5                      | Times one cycle rebuilds a stale plan at once before it waits for the next cycle.                                                                                                         |
| `REPORT_BLOCK_LAG`                | 2                      | Blocks between the head and the report block.                                                                                                                                             |
| `READ_CONCURRENCY`                | 8                      | Flags, recorded suspects and rereads of sent reports read at once.                                                                                                                        |
| `HISTORY_READ_CONCURRENCY`        | 8                      | Markets, controllers or positions read at once in discovery and reconstruction.                                                                                                           |
| `INTER_BATCH_CONFIRMATION_BLOCKS` | 2                      | Confirmations a report batch waits for before the next batch.                                                                                                                             |
| `CONFIRMATION_POLL_INTERVAL_MS`   | 12000                  | Pause between reads while confirmations are awaited.                                                                                                                                      |
| `MAX_SIGNAL_BATCH_SIZE`           | 50                     | Borrowers in one report transaction; 50 stay under half of the gas one transaction may use.                                                                                               |
| `IDLE_HEARTBEAT_INTERVAL_SECONDS` | 43200, 12 hours        | Time after which a heartbeat is sent though nothing new is due.                                                                                                                           |
| `HEARTBEAT_RESERVE_BLOCKS`        | 8                      | Blocks of the 256-block blockhash window kept for the heartbeat.                                                                                                                          |
| `TRANSACTION_CONFIRMATION_BLOCKS` | 12                     | Confirmations of every report and the heartbeat; deeper than any reorg Ethereum's proof of stake has produced.                                                                            |
| `SCREENING_TIMEOUT_MS`            | 290000                 | The SDK's wait for the provider's answer to the whole screening; the anchors not answered by then are incomplete.                                                                         |
| `RPC_REQUEST_TIMEOUT_MS`          | 30000                  | One HTTP attempt.                                                                                                                                                                         |
| `RPC_RETRY_COUNT`                 | 2                      | Retries of a failed request.                                                                                                                                                              |
| `RPC_RETRY_DELAY_MS`              | 150                    | Pause before a retry.                                                                                                                                                                     |
| `MAX_RPC_RESPONSE_BODY_SIZE`      | 10485760, 10 MB        | Largest response the application reads.                                                                                                                                                   |
| `MAX_LOG_BLOCK_RANGE`             | 10000                  | The most blocks one `eth_getLogs` request spans. Set it to your provider's limit: a range the provider refuses is read again in halves, and each refused read costs at least one request. |
| `SEND_TIMEOUT_MS`                 | 336000                 | Time of one transaction from preparation to confirmation. The default fits every attempt's inclusion wait, then the confirmations and one slot.                                           |
| `REPLACEMENT_FEE_BUMP_BPS`        | 1000, 10%              | Fee increase of a replacement, in basis points.                                                                                                                                           |
| `MAX_FEE_PER_GAS_WEI`             | 100000000000, 100 gwei | Fee cap.                                                                                                                                                                                  |
| `REPLACEMENT_TIMEOUT_MS`          | 36000                  | Wait for inclusion before a transaction is replaced at a higher fee.                                                                                                                      |
| `SEND_ATTEMPTS`                   | 5                      | Preparations of one transaction, replacements included.                                                                                                                                   |
| `GAS_HEADROOM_BPS`                | 2000, a fifth          | Gas added to the node's estimate, in basis points: a report costs more when other guardians report the same accounts first.                                                               |

## Observe

With deployment and RPC configuration supplied, run:

```bash
node example/main.ts
```

A plan with work prints the reconstructed anchor count; with the placeholder provider, any anchors requiring screening leave the cycle `incomplete`, printed as such. That is an incomplete observation, not a clean decision. An empty request or targets excluded under the existing own-flag rule need no provider answer. No observation advances onchain coverage or sends reports or a heartbeat.

To connect screening, adapt [`screening.ts`](screening.ts): replace the `screening` instance with your provider and its configuration. For example, after importing your implementation:

```ts
export const screening: ScreeningProvider = new YourScreeningProvider(/* provider configuration */);
```

`main.ts` imports this instance and passes it to `createGuardian`, which hands it to `Guardian`. `main()` has no arguments and is not exported; the daemon builds on `createGuardian` and `runCycles`, not on `main()`.

Your provider implements `ScreeningProvider`. Return one positional result for each requested anchor: `judged` with actual suspect/flag decisions, or `incomplete` when a decision cannot be established. Exceptions propagate. An optional `evidenceReference` may be omitted, `undefined`, `null` or a nonempty string.

```bash
MODE=observe node example/main.ts
```

To observe a Hoodi deployment, supply its RPC and deployment configuration and run without a signing key:

```bash
CHAIN_ID=560048 MODE=observe node example/main.ts
```

A completed observation prints screened and skipped counts and proposed suspect/flag counts. It stops before `signalAndHeartbeat` and retains only the previous onchain heartbeat block. The next observation may screen the same work again until onchain coverage changes.

Providers implement `ScreeningProvider` directly and own transaction deduplication, concurrency limits, caching and risk policy.

## Signal

After replacing the placeholder in `screening.ts`, supply `SIGNER_KEY` securely and run the same entry point:

```bash
MODE=signal node example/main.ts
```

The example passes the provider directly to the SDK without checking its concrete class. An incomplete result withholds the heartbeat; in signal mode the reports the complete results require are still sent. The next cycle asks the provider about every anchor again; the [daemon](../daemon/README.md)'s adapter answers from the judged results it keeps. When no anchors require screening, the SDK may send a heartbeat without calling the provider, including with the placeholder selected.

`Guardian.cycle` runs `buildScanPlan → discoverCandidatePositions → reconstructWork → screenWork → signalAndHeartbeat` and emits each completed phase through `onEvent`. Signal mode sends required suspect reports, flag reports and finally a heartbeat; a suspect this Guardian recorded since the previous heartbeat, confirmed and still inside `suspectWindow`, is kept, not sent again, and appears as `report.skipped`. Missing or malformed results and provider exceptions abort before submission; an incomplete result ends the cycle without a heartbeat after the reports the complete results require. Existing own-flag exclusions remain unchanged.

## Delivery and recovery limits

These are choices of this application, not additional specification requirements:

- Cycles run serially. A cycle starts every `CYCLE_INTERVAL_MS` from the start of the previous one, whatever its outcome, 30 blocks by default, the specification's reference interval; a longer cycle is followed at once. A stale plan is rebuilt at once, up to `MAX_RESTARTS_PER_CYCLE` times, and the new attempt reuses the work the stale one reconstructed for the positions nothing changed since; then the cycle waits for the next one. A cycle whose screening is incomplete hands its work to the next one.
- The application may start before the Guardian is added: each cycle then stops with `guardian-not-member`, in signal mode with `delegate-mismatch` until the registry's delegate matches the configuration, and the next cycle follows on the schedule. Leave no gap after the add: the first cycle covers 50,400 blocks before `GuardianAdded` through the report block, every later one everything since the last heartbeat, and each attempt must reach its heartbeat within the budget the [SDK README](../README.md#running-cycles) states. The application records no cycle durations; alert when the time from `cycle.started` to `cycle.finished` nears that budget or an outcome is `stale` with `report-block-aged-out`.
- A failed attempt does not stop the scheduler: the next cycle starts from the same heartbeat hint and work. An attempt that reached sending may have left a transaction pending, even when the send was rejected, so in signal mode every cycle first calls `Guardian.clearPendingNonces()`: each pending transaction of the signer is awaited or cancelled, so no transaction of an earlier cycle or process blocks this one. The event `nonce.checked` shows the counts that decision was made by; an endpoint that does not report pending transactions makes the recovery find nothing, and the next send then collides with the stuck transaction.
- The signer must have only this writer. A cancellation the node rejects is repriced at once, so a transaction stuck above the fee cap cannot be cleared. When its pending transactions cannot be cleared, the cycle does not start, reported as `schedule.cycleNotStarted`, which the example prints as `cycle not started:` with the error, and the next scheduled cycle tries again; reconcile the signer. The application keeps no journal of what it sent, so a report of a failed attempt that was included may be sent again by the next one. A failure that persists repeats every cycle and a failing send spends gas each time, so alert on repeated failures.
- The SDK groups at most 50 borrowers per report, waits for at most two confirmations between batches, then verifies every report at the full depth of 12 before heartbeat; Guardian accepts a depth of at most 64. The send budget also bounds the shared wait for that depth, once per report kind; when the wait ends first, the cycle stops with `report-confirmation-timeout` and its reports are already included. It reserves eight blocks for heartbeat inclusion. These settings do not establish production throughput or an SLA for large workloads.
- The SDK waits for the provider's answer at most `SCREENING_TIMEOUT_MS`, 290 seconds by default and 20 minutes and ten seconds in the daemon. A slower provider leaves the anchors it has not answered incomplete, and the next attempt asks again.
- Log requests span at most `MAX_LOG_BLOCK_RANGE` blocks, 10,000 by default. A range the endpoint refuses is read again in halves; each refused read costs at least one request, and more when the transport retries it or asks another endpoint. A block refused alone fails the cycle, so set the variable to the endpoint's limit: a local node without a range limit can take larger ranges and read the same window with fewer requests. The configured transport has two retries, and a provider's `Retry-After` longer than the request timeout is shortened to it; RPC failures remain failures. The runner owns the completeness and consistency of every selected endpoint's history.
- Log reads and `RPC_LOG_QUORUM`:
  - Without `RPC_LOG_QUORUM` one endpoint answers each request. A log read that the first endpoint refuses goes to the next one, which may lag or follow another branch and answer without the newest logs; one URL of a provider can also answer from a lagging backend. Reconstruction compares the first event of each walk with the newest event discovery read for the position, and checks its block. That catches one such answer about the newest event of a position the attempt walks, when the two reads got different answers, as from two different endpoints. It catches no older event that a walk's answer lacks, no supply read that lacks the newest supplies, whose positions are left out of the work, and no answer about a position reused from earlier work, which is not walked.
  - With it the transport reads logs from every endpoint of `RPC_URLS` and waits until each of them responds or reaches the request timeout. It returns the logs that the quorum returned alike, when no other endpoint returned a log they lack. Any other read is not confirmed: it is retried and read again in smaller ranges, and if it still fails, the cycle fails. With two endpoints and `RPC_LOG_QUORUM=2`, every log read fails while one of them is down.
  - The SDK README's [RPC requirements](../README.md#rpc-requirements) list what the SDK's checks cannot see, and [Comparing logs between providers](../README.md#comparing-logs-between-providers) describes what is compared.
- The client caps fees at 100 gwei, adds a fifth to the node's gas estimate, considers replacement after 36 seconds, raises both fees by more than 10% and allows five preparation attempts within a 336-second send budget, which fits every attempt's inclusion wait, then the confirmations and one slot. Guardian rejects a send budget shorter than the confirmation depth plus one slot, 156 seconds here; the replacement interval, not the budget, sets how soon a stuck transaction is repriced. Replacements retain the transaction's nonce and call; the SDK manages confirmation within the current send. These settings are examples to review for the target network.
- The example prints errors directly with `console.error('cycle failed:', error)`, preserving the error object and stack without custom viem parsing or a redaction layer, and prints SDK events as they arrive. An RPC error, including one carried in an event's `error` field, names the endpoint URL with its path and query and the request that failed; only credentials given as URL user information are moved to a header. Production logging, credential redaction, persistent records and alerts belong to the integrating application.

The [SDK README](../README.md) describes the package entry points. The [Guardian specification](../docs/guardian-specification.md) defines required behavior; this launcher is one possible application around it.

## Verification

```bash
npm run test:example
npm run check
```

The tests cover incomplete screening, observation without submission, ordered signal reports and heartbeat, provider failure, mainnet/Hoodi selection, rejection of unsupported networks, default observe mode without reading a signing key, the log quorum setting, the settings table and the integers the environment accepts, recovery after a failed signal attempt, nonce clearing before every signal cycle, the replan of a stale plan within its budget from the stale attempt's work, and the work an incomplete or failed cycle hands to the next one. Child-process checks use an explicit synthetic environment and replace HTTP requests with a scripted node; they never use real credentials or live RPC.
