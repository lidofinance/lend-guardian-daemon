# guardian-daemon-sdk

TypeScript reference implementation of the Guardian offchain logic for `GuardianSignals`.

A Guardian screens collateral supplies before the collateral activates. In each cycle it selects a recent block, finds the collateral that must be screened by that block, screens its supply transactions, submits the required `suspect` and `flag` reports and sends a heartbeat for that block. The [Guardian specification](docs/guardian-specification.md) defines this behavior.

## Ways to run a Guardian

- **Your own implementation.** You write the whole Guardian from the [specification](docs/guardian-specification.md), in any language.
- **The SDK in your application.** The SDK is a TypeScript library that runs the Guardian cycle. Your application calls it on a schedule and provides RPC endpoints, the signing key and screening. The [example](example/) is a runnable application to start from.
- **The daemon image.** The [daemon](daemon/) is a ready-to-run application built on the SDK and packaged as a Docker image. You configure and run it, and provide RPC endpoints, the signing key and a screening service that the daemon calls over HTTP.

The table shows who does what in each case.

|                                           | Your own implementation | The SDK in your application    | The daemon image                  |
| ----------------------------------------- | ----------------------- | ------------------------------ | --------------------------------- |
| Scan cycle, reports and heartbeat         | you                     | the SDK                        | the daemon                        |
| Screening decisions                       | you                     | your `ScreeningProvider`       | your screening service, over HTTP |
| Schedule and retries between cycles       | you                     | you; the example shows one way | the daemon                        |
| Monitoring and alerts                     | you                     | your `onEvent` handler         | your event receiver               |
| RPC endpoints, signing key and deployment | you                     | you                            | you                               |

### Your own implementation

- The main body of the specification states the requirements. Its appendix describes one possible implementation in pseudocode; your algorithm may differ as long as it meets the requirements.
- Implement the five phases of the [scan cycle](docs/guardian-specification.md#scan-cycle) and the coverage digest of [Appendix D](docs/guardian-specification.md#d-submit-signals-and-send-the-heartbeat), and meet the [heartbeat requirements](docs/guardian-specification.md#heartbeat-requirements).
- Check your coverage digest against [`digest-vectors.json`](tests/conformance/fixtures/digest-vectors.json): example inputs with digests computed by Foundry's `cast`, independently of the SDK. Monitoring can recompute the digest of every heartbeat, so yours must match byte for byte.

### The SDK in your application

- Install the [SDK package](#sdk-package) and follow [SDK integration](#sdk-integration).
- Start from the [example](example/). In [`example/daemon.ts`](example/daemon.ts), `createGuardian` sets up the viem clients and transport, and `main` runs the cycles and recovers from failed ones.
- Replace the placeholder screening provider in [`example/screening-adapter.ts`](example/screening-adapter.ts) with yours. The placeholder answers `incomplete` for every anchor, so a cycle with work stops at screening.
- The example starts in observe mode: it creates no signer and sends no transactions.

### The daemon image

- Build the image and run it as the [daemon guide](daemon/README.md#run) describes, in observe mode first.
- Provide the [configuration](daemon/README.md#configuration) and a screening service that answers the [screening request](daemon/README.md#screening-service). RPC endpoints and the container must meet the [requirements](daemon/README.md#requirements). For monitoring, run an event receiver as [Events and liveness](daemon/README.md#events-and-liveness) describes.
- Run one instance per delegate key. The daemon sends no credentials to the screening service or the receiver, so keep both on a private network with the daemon.

## SDK package

Install a pinned commit from the public repository:

```bash
npm install git+https://github.com/lidofinance/lido-lend-guardian-daemon-sdk.git#<commit>
```

Node.js 24 or newer is required. The package is not published to the npm registry yet; install it from Git.

Both entry points need viem at run time. The package declares it as a peer dependency, `^2.55.19`, so the application and the SDK share one viem installation; the SDK is tested with viem 2.55.19. npm installs a missing peer automatically. With a package manager that does not, add viem to the application.

The package exposes two entry points:

- `guardian-daemon-sdk/core` contains `Guardian`, the screening interface, phase outcomes, shared types and the generic RPC interfaces.
- `guardian-daemon-sdk/clients` contains `ViemRpcClient` and `createViemRpcTransport` for applications using viem.

## SDK integration

An application supplies:

- deployment and Guardian configuration;
- a read-only `RpcProvider` for observe mode or an `RpcClient` with a signer for signal mode;
- a `ScreeningProvider` that returns one decision for each requested anchor, in the same order;
- a loop that runs one cycle at a time, and a recovery policy for failed cycles.

The SDK does not read or check a market's `maxGuardiansQuorumDelay`; the [specification](docs/guardian-specification.md) states what a zero value means.

Run one cycle with the last confirmed heartbeat block as an optional search hint. The SDK checks it against the chain before using it:

```ts
let previousHeartbeatBlock: BlockRef | null = null;
const outcome = await guardian.cycle(previousHeartbeatBlock);
if ('previousHeartbeatBlock' in outcome) {
  previousHeartbeatBlock = outcome.previousHeartbeatBlock;
}
```

An attempt has a fixed budget: its heartbeat must be sent while the report block is at most `256 - heartbeatReserveBlocks` blocks behind the head, 248 blocks or just under 50 minutes with the example's reserve of eight blocks and 12-second slots. Discovery starts 50,400 blocks, at least seven days, before the previous heartbeat block, or before the `GuardianAdded` block when no heartbeat can be reused, and reads through the report block, so the first cycle, and the first cycle after downtime, covers everything since. Run the application without gaps from the moment the Guardian is added, and watch the time from `cycle.started` to `cycle.finished` against the budget; a stale outcome with `report-block-aged-out` is an attempt that did not fit.

After reconstruction the SDK checks the plan again. A plan that can no longer be attested ends the attempt as stale before screening, so a slow attempt costs no screening.

A stale outcome carries the attempt's `work`. Pass it to the next attempt as the second argument of `cycle`: a position whose controller logged nothing for it since keeps the anchors that attempt reconstructed, so a retry walks only what changed.

`cycle` emits typed phase and terminal events through the same `onEvent` handler as RPC, transaction and report events. Missing, malformed or incomplete screening results stop the attempt before submission. In signal mode the SDK submits required suspect reports, then flag reports, verifies their canonical confirmations and finally submits and confirms the heartbeat. A suspect this Guardian recorded since the previous heartbeat, with at least `txConfirmationBlocks` confirmations and inside `suspectWindow`, is kept instead of sent again, reported as `report.skipped` and reread before the heartbeat. RPC and provider failures propagate to the application.

For viem, create one reusable transport, use it to configure the public and wallet clients, and pass those clients to `ViemRpcClient`. Applications using another library may implement the exported `RpcProvider` reads and `RpcClient` preparation, broadcast and bounded-delivery methods directly. A registry report costs more gas when another guardian reports the same account between the estimate and inclusion, so preparation should add headroom to the node's gas estimate; `ViemRpcClient` adds `transactionPolicy.gasHeadroomBps`, a fifth by default. The reference implementation for both modes is in [`example/daemon.ts`](example/daemon.ts).

In signal mode `Guardian` requires the client's `transactionPolicy.sendTimeoutMs` to be an integer number of milliseconds that covers at least `txConfirmationBlocks + 1` slots and does not exceed 2,147,483,647, rejects any other value at construction and applies the same budget to its shared report-confirmation wait. It accepts a `txConfirmationBlocks` of at most 64, two epochs: a deeper wait adds nothing before finality, and every report kind waits for that depth before the heartbeat, which must still fall inside the 256-block `blockhash` window of the report block.

Before the heartbeat it reads every report's receipt and transaction again through the client's plain reads and requires the transaction to be its signer calling the registry with that report's calldata; a client that confirms the wrong transaction stops the attempt with `report-receipt-foreign`.

Three waits are bounded. The client waits for a signature no longer than the remaining budget, in `send` and in `broadcastTransaction`, and stops with `signing-timeout`, so a key service that never answers does not hold a cycle. `screeningTimeoutMs` bounds the wait for the provider's answer in `screenWork` the same way: when it ends first the attempt stops with `screening-result-incomplete`, and a later answer is dropped. The transport passes a numeric `Retry-After` on to viem bounded by its `timeoutMs`, in whole seconds as viem reads it, and drops a date form or a bound below one second, so each pause a provider's `Retry-After` causes lasts at most `timeoutMs`; the finished-request event reports the bounded value as `retryAfterMs`.

`Guardian.clearPendingNonces()` is an explicit signal-mode recovery operation for a reconciled dedicated signer; it is not run automatically by `cycle`. A cancellation the node does not accept is repriced at once by `replacementFeeBumpBps`, until the node accepts one or the fee would exceed `maxFeePerGas`; `sendAttempts` bounds only `send`. Each clearing decision reports the signer's `latest` and `pending` transaction counts as `nonce.checked`; equal counts mean the answering node reports no pending transaction, which the SDK cannot verify, since a provider that ignores the `pending` tag always answers equal.

### Comparing logs between providers

`createViemRpcTransport` sends each request to the first endpoint that answers and falls back to the next one. A node of a current client whose head is behind the requested range rejects the read as an error, which the transport reports and viem retries on the next endpoint. A provider's endpoint can answer the same range without an error, with the logs up to the head it has. Guardian stops an attempt whose node does not know the report block, but a load balancer can answer that check from one backend and the log read from another. The option below exists for that case; signal mode in production should use it with at least three independent providers and a quorum of two, so that one may be down while another lags.

Reconstruction also compares the first event of each position's history walk with the newest event discovery read for it, checks that this event sits in the canonical block at its number, and checks the report block before and after the walks as discovery does; a difference stops the attempt, so one lagging or forked answer cannot drop a position from the work or rebuild it from another history. Two answers that lag alike still can.

With the `logQuorum` option the transport asks every provider for logs and compares their answers. All other requests go to the endpoints in turn, as without the option.

```ts
createViemRpcTransport({
  urls: [firstProviderUrl, secondProviderUrl, thirdProviderUrl],
  logQuorum: 2,
  // the other options are unchanged
});
```

- `logQuorum` is at least two and at most the number of URLs. With two providers, log reads fail while one of them is unavailable; with three, they continue. A quorum smaller than a majority of the URLs lets that many providers decide which logs are returned.
- A read succeeds when a quorum of providers returned the same logs, in any order, and no other provider returned a log that the quorum lacks. A provider that only lacks logs is lagging: it is reported but does not stop the read.
- A provider that fails or sends an invalid list takes no part in the comparison.
- Log reads wait until every configured provider responds or reaches `timeoutMs`.
- After the configured retries, a rejected read fails with a viem error whose cause is `LogsNotConfirmedError`.
- Every difference is reported as an `rpc.answersDiffer` event, including the ones that did not reject the read.
- With `logQuorum` the transport is a viem custom transport around the fallback, so viem no longer sends all requests of a filter to the endpoint that created it. The SDK uses no filters; this matters only if your application does.

Only `eth_getLogs` is compared: calls, block headers, receipts and filters are not. The comparison cannot detect a log that every answering provider omits: while one of three providers does not answer, two providers that lack the same log form a quorum.

## Development

Install dependencies and run the complete check:

```bash
npm ci
npm run check
npm run check:package
```

Contract conformance tests require Anvil 1.7.1 on `PATH` or selected through `ANVIL_BIN`.

Useful targeted commands:

```bash
npm run test:core
npm run test:example
npm run test:daemon
npm run test:conformance
npm run benchmark:smoke
node example/daemon.ts
```

Tests use scripted nodes and isolated local Anvil processes; they make no external RPC requests.

## Repository layout

- [`src/core/`](src/core/): Guardian cycle, public outcomes and screening interface.
- [`src/contracts/`](src/contracts/): core, market-controller and `GuardianSignals` access.
- [`src/chain/`](src/chain/): generic RPC reads, viem transport and transaction delivery.
- [`abi/`](abi/): minimal ABI fragments used by the SDK.
- [`example/`](example/): example Guardian application built on the SDK.
- [`daemon/`](daemon/): deployable daemon with HTTP screening, event forwarding and a Docker image.
- [`tests/`](tests/): core, example, daemon and contract-conformance tests.
- [`benchmarks/`](benchmarks/): SDK cost, amplification, liveness and daemon overhead benchmarks, with [their latest results](benchmarks/RESULTS.md).
- [`docs/guardian-specification.md`](docs/guardian-specification.md): Guardian specification 0.3.0.

## License

GPL-2.0, see [LICENSE](LICENSE).
