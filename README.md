# Lido Lend Guardian Daemon

TypeScript reference implementation of the Guardian offchain logic for `GuardianSignals`.

The SDK reconstructs collateral supplies that require screening, passes them to an application-provided screening service, derives the required suspect and flag reports, and submits those reports before a confirmed heartbeat. It is designed to be embedded in a Guardian application; scheduling, provider integration and production operations remain with that application.

The [Guardian specification](docs/guardian-specification.md) defines the required behavior. A runnable integration is provided under [`example/`](example/README.md).

## Start here

- Read the [Guardian specification](docs/guardian-specification.md) for protocol requirements and illustrative pseudocode.
- Read the [example guide](example/README.md) for configuration, observe mode, signal mode and provider integration.
- Follow `Guardian.cycle` for one complete iteration and [`createGuardian`](example/daemon.ts) for viem client and transport setup.
- Replace the placeholder in [`example/screening-adapter.ts`](example/screening-adapter.ts) with your screening provider.

The example starts in observe mode, creates no signer and submits no transactions. Its bundled screening provider deliberately returns `incomplete` for every requested anchor.

## Package

Install a pinned commit from the public repository:

```bash
npm install git+https://github.com/lidofinance/lend-guardian-daemon.git#<commit>
```

Node.js 24 or newer is required. The package currently uses `private: true` to disable npm registry publication; installation from Git is supported.

Both entry points need viem at run time. The package declares it as a peer dependency, `^2.55.19`, so the application and the SDK share one viem installation; the SDK is tested with viem 2.55.19. npm installs a missing peer automatically. With a package manager that does not, add viem to the application.

The package is named `guardian-daemon-sdk` and exposes two entry points:

- `guardian-daemon-sdk/core` contains `Guardian`, the screening interface, phase outcomes, shared types and the generic RPC interfaces.
- `guardian-daemon-sdk/clients` contains `ViemRpcClient`, `createViemRpcTransport` and `LogsNotConfirmedError` for applications using viem.

## Integration

An application supplies:

- deployment and Guardian configuration;
- a read-only `RpcProvider` for observe mode or an `RpcClient` with a signer for signal mode;
- RPC endpoints that meet the [RPC requirements](#rpc-requirements);
- a `ScreeningProvider` that returns one decision for each requested anchor, in the same order;
- a serial cycle loop and recovery policy.

The SDK does not read or check a market's `maxGuardiansQuorumDelay`; the [specification](docs/guardian-specification.md) states what a zero value means.

The reference implementation for both modes is in [`example/daemon.ts`](example/daemon.ts).

### Running cycles

Run one iteration with the last confirmed heartbeat block as an optional search hint. The SDK checks the block against the chain before using it:

```ts
let previousHeartbeatBlock: BlockRef | null = null;
const outcome = await guardian.cycle(previousHeartbeatBlock);
if ('previousHeartbeatBlock' in outcome) {
  previousHeartbeatBlock = outcome.previousHeartbeatBlock;
}
```

- **Report block.** Each attempt covers the chain through its report block, `reportBlockLag` blocks behind the head it reads first; the default and the example use 2.
- **Time budget.** An attempt must send its heartbeat while the report block is at most `256 - heartbeatReserveBlocks` blocks behind the head. With the example's reserve of eight blocks and 12-second slots, that is 248 blocks, just under 50 minutes. Watch the time from `cycle.started` to `cycle.finished` against this budget. A stale outcome with `report-block-aged-out` is an attempt that did not fit.
- **Coverage.** Discovery starts 50,400 blocks, at least seven days, before the previous heartbeat block, or before the `GuardianAdded` block when no heartbeat can be reused. It reads through the report block, so the first cycle, and the first cycle after downtime, covers everything since. Run the application without gaps from the moment the Guardian is added.
- **Plan check.** After reconstruction the SDK checks the plan again. A plan that can no longer be attested ends the attempt as stale before screening, so a slow attempt costs no screening.
- **Retries.** A stale or incomplete outcome carries the attempt's `work`. Pass it to the next attempt as the second argument of `cycle`, so a retry walks only what changed. A position keeps the anchors that attempt reconstructed, without a new walk, when all of these hold:
  - the previous heartbeat is the same as in that attempt;
  - that attempt's report block is not after this attempt's and is still canonical;
  - the position's newest lifecycle event is still the one that attempt's reconstruction started from.

### Screening, reports and events

- In signal mode the SDK submits the required suspect reports, then the flag reports, verifies their canonical confirmations, and then submits and confirms the heartbeat.
- A suspect this Guardian recorded after the block that included the previous heartbeat, or after `GuardianAdded` without one, with at least `txConfirmationBlocks` confirmations and inside `suspectWindow`, is kept instead of sent again. It is reported as `report.skipped` and read again before the heartbeat. A stored heartbeat whose block cannot be recovered keeps no suspect.
- Missing or malformed screening results stop the attempt before submission.
- An incomplete result withholds the heartbeat, not the reports: the attempt sends and confirms the reports its complete results require, then ends as `incomplete`, with the work for the next attempt.
- RPC and provider failures propagate to the application.
- `cycle` emits typed phase and terminal events through the same `onEvent` handler as RPC, transaction and report events.

### Clients and transactions

- For viem, create one reusable transport, use it to configure the public and wallet clients, and pass those clients to `ViemRpcClient`.
- Applications using another library may implement the exported `RpcProvider` reads and `RpcClient` preparation, broadcast and bounded-delivery methods directly.
- A registry report costs more gas when another guardian reports the same account between the estimate and inclusion, so preparation should add headroom to the node's gas estimate. `ViemRpcClient` adds `transactionPolicy.gasHeadroomBps`, none when it is omitted.
- Before the heartbeat, `Guardian` reads every report's receipt and transaction again through the client's plain reads. It requires the transaction to be its signer calling the registry with that report's calldata, in a block after the report block. A client that confirms the wrong transaction, such as an identical earlier call, stops the attempt with `report-receipt-foreign`.

Two of the settings that `Guardian` checks when it is constructed bound the confirmation waits:

- In every mode, `txConfirmationBlocks` must be from 1 to 64. Under normal network conditions 64 confirmations are more than enough, so the SDK allows no more. Every report kind waits for `txConfirmationBlocks` confirmations before the heartbeat, and the heartbeat must still fall inside the 256-block `blockhash` window of the report block.
- In signal mode, the client's `transactionPolicy.sendTimeoutMs` must be an integer number of milliseconds that covers at least `txConfirmationBlocks + 1` slots and does not exceed 2,147,483,647. `Guardian` applies the same budget to its shared wait for report confirmations.

### Time limits

- **Signing.** The client waits for a signature no longer than the remaining send budget; `broadcastTransaction` starts a full budget of its own. A key service that never answers therefore does not hold a cycle: the wait fails with an error named `DeliveryLimit` whose `reason` is `signing-timeout`, and `send` also reports it in `transaction.failed`.
- **Screening.** `screeningTimeoutMs` bounds the wait for the provider's answer in `screenWork`. When it ends first, the anchors asked about are incomplete, and a later answer is dropped.
- **`Retry-After`.** The transport passes a numeric `Retry-After` on to viem bounded by its `timeoutMs`, in whole seconds as viem reads it, and drops a date form or a bound below one second. Each pause that a provider's `Retry-After` causes therefore lasts at most `timeoutMs`. The finished-request event reports the bounded value as `retryAfterMs`.

### Clearing pending nonces

- `Guardian.clearPendingNonces()` is an explicit signal-mode recovery operation; `cycle` does not run it. Call it before the next cycle when an attempt may have left a transaction pending, as [`example/daemon.ts`](example/daemon.ts) does after a failed attempt that reached sending. Use it only for a dedicated signer: one that no other application uses.
- A cancellation the node does not accept is repriced at once by `replacementFeeBumpBps`, until the node accepts one, the fee would exceed `maxFeePerGas`, or `sendTimeoutMs` runs out. `sendAttempts` bounds only `send`.
- Each clearing decision reports the signer's `latest` and `pending` transaction counts as `nonce.checked`. Equal counts mean that the answering node reports no pending transaction. The SDK cannot verify this: a provider that ignores the `pending` tag always answers with equal counts.

### RPC requirements

The SDK cannot tell an empty `eth_getLogs` answer from an answer that left logs out. A missing log can leave a supply unscreened while the heartbeat attests its coverage. The specification's [RPC requirements](docs/guardian-specification.md#rpc-requirements) leave the completeness of logs to the application that runs the cycle.

In signal mode the RPC endpoints must meet both requirements below. With viem, the endpoints are the `urls` of `createViemRpcTransport`.

1. Every endpoint must return every log that matches a request, in every block up to its head.
2. Some endpoints answer a request for blocks after their head without an error, with only the logs they have. If at least one endpoint can do this, set [`logQuorum`](#comparing-logs-between-providers) to 2 or more. An application that does not use viem must compare the log answers of its endpoints in the same way.

To decide whether an endpoint falls under requirement 2:

| Endpoint                              | Falls under requirement 2                                                            |
| :------------------------------------ | :----------------------------------------------------------------------------------- |
| One node of a current Ethereum client | No: it answers such a request with an error.                                         |
| A provider's endpoint                 | Yes, unless the provider guarantees the error for every backend behind the endpoint. |

Behind a provider's endpoint, a load balancer can answer one request from one backend and the next request from another.

The transport needs at least two URLs for `logQuorum`, so an endpoint that falls under requirement 2 cannot be the only URL.

In observe mode the SDK sends no heartbeat, so a missing log changes only what the SDK reports.

Recommended for production signal mode: at least three endpoints, each from a different provider, with `logQuorum: 2`, so that reads continue while one provider is down or lags. Use different providers because the endpoints of one provider can lag alike.

The SDK checks some answers itself and stops the attempt when they disagree. The checks are a defense against a node that answers wrongly or leaves logs out; correct answers always pass them.

- Before and after discovery, and before and after reconstruction, the node must return the report block with the plan's hash. A different hash stops the attempt with `node-behind-the-plan`; a node that does not have the block fails the attempt with the error `RPC block is missing or pending`. With `createViemRpcTransport` this block is read from one endpoint, the first in `urls` that answers, and `logQuorum` does not compare it, so the check says nothing about the heads of the other endpoints. A load balancer can also answer this check from one backend and a log read from another.
- A walk that finds no lifecycle event for a position stops the attempt with `position-without-history`.
- The first event of each position's history walk must be the newest event that discovery read for that position; otherwise the attempt stops with `position-history-broken`.
- That event must be in the canonical block at its number; otherwise the attempt stops with `log-not-canonical`.
- A node that leaves lifecycle logs out of a position's history breaks the chain of events the walk reads. Each lifecycle event records the position after its change, so going back the walk checks that each event's change, applied to the position that the next older event records, can give the position the event records, compared on `dust` and `activating`. When it cannot, a log is missing between the two events, and the attempt stops with `position-history-broken`.

Against a node that answers wrongly or leaves logs out, these checks catch a first answer of the walk that differs from the newest event discovery read or sits on another branch, and logs left out between two events of the walk whose positions then do not match. They miss these faults of such a node:

- a supply that a lagging answer left out: discovery never finds its position, and the heartbeat then attests it unscreened;
- a position reused from an earlier attempt's `work`, which is not walked: if a lagging answer hides the position's newest event from discovery, the position keeps the anchors of a lot that has since activated or drained;
- a log that an answer omitted below a position's newest event while the positions still match without it, in this attempt's walk or, for a reused position, in the earlier attempt's walk. Examples are the dust supply right before the top-up that absorbed it, a top-up together with a seizure of the same amount, and a maturity together with a new lot of the same size. Such a log stays omitted.

Only `logQuorum` guards against these cases, and only while the answers of a quorum do not lack the same log.

### Comparing logs between providers

Without `logQuorum`, `createViemRpcTransport` sends each request to the first endpoint that answers and falls back to the next one. A read that a node rejects with an error is reported by the transport and retried by viem on the next endpoint.

With `logQuorum`, the transport asks every provider for logs and compares their answers. Requests other than `eth_getLogs` go to the first endpoint that answers, as without the option.

```ts
createViemRpcTransport({
  urls: [firstProviderUrl, secondProviderUrl, thirdProviderUrl],
  logQuorum: 2,
  // the other options are unchanged
});
```

- The transport accepts a `logQuorum` from two to the number of URLs and rejects other values. The [RPC requirements](#rpc-requirements) state when the option is required.
- Two providers give comparison without tolerance of an outage; three keep working while one is unavailable.
- A read returns the logs that a quorum of providers returned alike, when they include every log that any other provider returned. The order of the logs in an answer is not compared.
- A provider that only lacks logs is lagging. It does not stop the read while the other providers still return a quorum of complete answers; with two URLs and `logQuorum: 2` it does. A log that the quorum lacks rejects the read.
- A provider that fails or sends an invalid list takes no part in the comparison.
- Log reads wait until every configured provider responds or reaches `timeoutMs`.
- A rejected read fails with `LogsNotConfirmedError` as the cause of the error viem reports, after the configured retries.
- Every difference is reported as an `rpc.answersDiffer` event, including the ones that did not reject the read.
- With `logQuorum` the transport is a viem custom transport around the fallback, so viem does not keep the requests of a filter on the endpoint that created it.

Only `eth_getLogs` is compared: calls, block headers, receipts and filters are not. The comparison cannot detect a log that every answering provider omits: while one of three providers does not answer, two providers that lack the same log form a quorum. A higher `logQuorum` requires more providers to answer, so more of them must lack the same log.

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
npm run test:conformance
node example/daemon.ts
```

Tests use scripted nodes and isolated local Anvil processes; they make no external RPC requests.

## Repository layout

- [`src/core/`](src/core/): Guardian cycle, public outcomes and screening interface.
- [`src/contracts/`](src/contracts/): core, market-controller and `GuardianSignals` access.
- [`src/chain/`](src/chain/): generic RPC reads, viem transport and transaction delivery.
- [`abi/`](abi/): minimal ABI fragments used by the SDK.
- [`example/`](example/README.md): reference Guardian application.
- [`tests/`](tests/): core, example and contract-conformance tests.
- [`docs/guardian-specification.md`](docs/guardian-specification.md): Guardian specification 0.3.0.

## License

GPL-2.0, see [LICENSE](LICENSE).
