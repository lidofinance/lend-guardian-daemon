# Guardian reference application

This is the reference application for partners integrating the SDK. It demonstrates the complete scan cycle and the application code needed to run it. Adapt its screening provider and operating policy for your deployment before running it in production. Production operation requires application-specific screening, transaction recovery, monitoring, logging and deployment configuration; the [delivery and recovery limits](#delivery-and-recovery-limits) describe what this example provides and what the integrating application must supply.

[`daemon.ts`](daemon.ts) demonstrates configuration, scheduling and the five Guardian phases. It defaults to `observe`, constructs no wallet in that mode and never submits transactions. The included [`UnconfiguredScreening`](screening-adapter.ts) returns `incomplete` for every requested anchor. There is no provider that automatically clears deposits.

The example runs from the SDK source checkout on Node 24 or newer, after `npm ci` has installed its dependencies. The checkout installs viem as a development dependency, so an installation that omits development dependencies cannot run the example. In a consuming project, copy the example and import Guardian and shared contracts from `guardian-daemon-sdk/core` and `ViemRpcClient` plus `createViemRpcTransport` from `guardian-daemon-sdk/clients`. The package includes this example, its guide and the SDK source used by its relative imports.

## Read and adapt the example

1. Follow `Guardian.cycle` and its use in [`daemon.ts`](daemon.ts) to see one complete iteration and the outcomes that stop it. An observed cycle does not advance coverage; an attested result returns its confirmed report block as the next cycle's optional search hint.
2. Read `createGuardian` in the same file for the reusable viem transport, public/wallet clients, one shared `onEvent` handler and SDK limits. `main` runs one cycle at a time and owns retry timing.
3. Implement your provider in [`screening-adapter.ts`](screening-adapter.ts). Return decisions in the original anchor order; a timeout, missing answer or unknown result must remain incomplete. Keep vendor-specific calls and policy in this adapter.
4. Set the deployment inputs below, start in observe mode and check the reconstructed work and proposed reports. Enable signal mode only with a delegate that belongs to this application alone, because after a failed send the example clears every pending transaction of that address.

From a source checkout:

```bash
npm ci
npm run check
# After supplying the deployment and RPC configuration below:
MODE=observe node example/daemon.ts
```

The shipped provider deliberately returns `incomplete`. Successful compilation or an empty-work cycle does not establish that a provider is configured.

## Configuration

The entry point reads process environment variables through [`env.ts`](env.ts); it does not load `.env` files. Reads happen when a helper is called, not when the module is imported. Supply deployment values through your own launcher or secret manager.

| Variable                                                          | Meaning                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MODE`                                                            | `observe` by default, or explicitly `signal`. Other values are rejected.                                                        |
| `CHAIN_ID`                                                        | `1` (mainnet, default) or `560048` (Hoodi). Other networks are rejected.                                                        |
| `RPC_URLS`                                                        | Comma-separated HTTP(S) endpoints, in fallback order.                                                                           |
| `RPC_LOG_QUORUM`                                                  | Optional: endpoints that must return the same logs, from 2 to the number of `RPC_URLS`. Unset, one endpoint answers a log read. |
| `GUARDIAN`                                                        | Registered Guardian address.                                                                                                    |
| `LIDO_LEND`, `GUARDIAN_SIGNALS`                                   | Deployed lending core and GuardianSignals addresses.                                                                            |
| `LIDO_LEND_DEPLOYMENT_BLOCK`, `GUARDIAN_SIGNALS_DEPLOYMENT_BLOCK` | Positive deployment block numbers used as scan floors.                                                                          |
| `SIGNER_KEY`                                                      | Signal mode only: a 32-byte private key for the registered delegate. Observe never reads this variable.                         |

The example selects viem's `mainnet` or `hoodi` through `env.chain('CHAIN_ID')` and uses that chain for both clients and Guardian. Both networks use 12-second slots, so the SDK derives a 50,400-block lookback; Hoodi's slot timing is documented in its [staking guide](https://hoodi.launchpad.ethereum.org/en/withdrawals). RPC endpoints come from `RPC_URLS` through `createViemRpcTransport`, which is a viem transport used by both `createPublicClient` and `createWalletClient`. Supply the selected network's deployment addresses, deployment blocks and registered Guardian address. Signal mode deliberately requires a delegate distinct from the Guardian; the SDK also supports signing as the Guardian itself.

## Observe

With deployment and RPC configuration supplied, run:

```bash
node example/daemon.ts
```

A plan with work prints the reconstructed anchor count; with the placeholder provider, any anchors requiring screening produce `screening-result-incomplete`. That is an incomplete observation, not a clean decision. An empty request or targets excluded under the existing own-flag rule need no provider answer. No observation advances onchain coverage or sends reports or a heartbeat.

To connect screening, adapt [`screening-adapter.ts`](screening-adapter.ts): replace the `screening` instance with your provider and its configuration. For example, after importing your implementation:

```ts
export const screening: ScreeningProvider = new YourScreeningProvider(/* provider configuration */);
```

`daemon.ts` imports this instance and passes it directly to `Guardian`. `main()` has no arguments and is not exported; the example is meant to be read and adapted, not imported as an application API.

Your provider implements `ScreeningProvider`. Return one positional result for each requested anchor: `judged` with actual suspect/flag decisions, or `incomplete` when a decision cannot be established. Exceptions propagate. An optional `evidenceReference` may be omitted, `undefined`, `null` or a nonempty string.

```bash
MODE=observe node example/daemon.ts
```

To observe a Hoodi deployment, supply its RPC and deployment configuration and run without a signing key:

```bash
CHAIN_ID=560048 MODE=observe node example/daemon.ts
```

A completed observation prints screened and skipped counts and proposed suspect/flag counts. It stops before `signalAndHeartbeat` and retains only the previous onchain heartbeat block. The next observation may screen the same work again until onchain coverage changes.

Providers implement `ScreeningProvider` directly and own transaction deduplication, concurrency limits, caching and risk policy.

## Signal

After replacing the placeholder in `screening-adapter.ts`, supply `SIGNER_KEY` securely and run the same entry point:

```bash
MODE=signal node example/daemon.ts
```

The example passes the provider directly to the SDK without checking its concrete class. Incomplete requested results stop the cycle. When no anchors require screening, the SDK may send a heartbeat without calling the provider, including with the placeholder selected.

`Guardian.cycle` runs `buildScanPlan → discoverCandidatePositions → reconstructWork → screenWork → signalAndHeartbeat` and emits each completed phase through `onEvent`. Signal mode sends required suspect reports, flag reports and finally a heartbeat. Missing, incomplete or malformed results and provider exceptions abort before submission. Existing own-flag exclusions remain unchanged.

## Delivery and recovery limits

These are choices of this example, not additional specification requirements:

- Cycles run serially. Completed or stale attempts wait 60 seconds; failed attempts wait five minutes. There is no immediate replan loop.
- The application may start before the Guardian is added: each cycle then stops with `guardian-not-member`, in signal mode with `delegate-mismatch` until the registry's delegate matches the configuration, and the next attempt follows five minutes later. Leave no gap after the add: the first cycle covers 50,400 blocks before `GuardianAdded` through the report block, every later one everything since the last heartbeat, and each attempt must reach its heartbeat within the budget the [SDK README](../README.md#integration) states. The example records no cycle durations; alert when the time from `cycle.started` to `cycle.finished` nears that budget or an outcome is `stale` with `report-block-aged-out`.
- A failed attempt does not stop the scheduler. An attempt that failed before sending, such as an RPC outage, a screening failure or logs that the quorum did not confirm, has sent nothing and is followed by another attempt. An attempt that reached sending may have left a transaction pending, even when the send was rejected, so the example first calls `Guardian.clearPendingNonces()`: each pending transaction of the signer is awaited or cancelled before the next attempt.
- The signer must have only this writer. When its pending transactions cannot be cleared, the error ends the process with exit code 1; reconcile the signer before restarting, and do not configure an unconditional supervisor restart without that step. The example keeps no journal of what it sent, so a report of a failed attempt that was included may be sent again by the next one. A failure that persists repeats every five minutes and a failing send spends gas each time, so alert on repeated failures.
- The SDK groups at most 20 borrowers per report, waits for at most two confirmations between batches, then verifies every report at the full depth of 12 before heartbeat. The send budget also bounds the shared wait for that depth, once per report kind; when the wait ends first, the cycle stops with `report-confirmation-timeout` and its reports are already included. It reserves eight blocks for heartbeat inclusion. These settings do not establish production throughput or an SLA for large workloads.
- The example asks for logs in ranges of at most 10,000 blocks, the constant `MAX_LOG_BLOCK_RANGE` in `daemon.ts`, whatever the endpoint allows. A range the endpoint refuses is read again in halves, one request lost each time, and a block refused alone fails the cycle, so set the constant to the endpoint's limit: a local node without a range limit can take larger ranges and read the same window with fewer requests. The configured transport has two fallback retries; RPC failures remain failures. The runner owns the completeness and consistency of every selected endpoint's history.
- Without `RPC_LOG_QUORUM` one endpoint answers each request. With it the transport reads logs from every endpoint of `RPC_URLS`, waits until each of them responds or reaches the request timeout, and returns only logs that the quorum returned alike; a read that is not confirmed fails the cycle. Use independent providers, because endpoints of one provider can lag alike. The [SDK README](../README.md#comparing-logs-between-providers) describes what is compared and what cannot be detected.
- The client caps fees at 100 gwei, considers replacement after 36 seconds, raises both fees by more than 10% and allows five preparation attempts within a 264-second send budget. Guardian rejects a send budget shorter than the confirmation depth plus one slot, 156 seconds here; the replacement interval, not the budget, sets how soon a stuck transaction is repriced. Replacements retain the transaction's nonce and call; the SDK manages confirmation within the current send. These settings are examples to review for the target network.
- The example prints errors directly with `console.error('cycle failed:', error)`, preserving the error object and stack without custom viem parsing or a redaction layer, and prints SDK events as they arrive. An RPC error, including one carried in an event's `error` field, names the endpoint URL with its path and query and the request that failed; only credentials given as URL user information are moved to a header. Production logging, credential redaction, persistent records and alerts belong to the integrating application.

The [SDK README](../README.md) describes the package entry points. The [Guardian specification](../docs/guardian-specification.md) defines required behavior; this launcher is one possible application around it.

## Verification

```bash
npm run test:example
npm run check
```

Example tests cover incomplete screening, observation without submission, ordered signal reports and heartbeat, provider failure, mainnet/Hoodi selection, rejection of unsupported networks, default observe mode without reading a signing key, the log quorum setting, and recovery after a failed signal attempt. Child-process checks use an explicit synthetic environment and replace HTTP requests with a scripted node; they never use real credentials or live RPC.
