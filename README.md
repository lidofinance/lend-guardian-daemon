# guardian-daemon-sdk

TypeScript reference implementation of the Guardian offchain logic for `GuardianSignals`.

The SDK reconstructs collateral supplies that require screening, passes them to an application-provided screening service, derives the required suspect and flag reports, and submits those reports before a confirmed heartbeat. It is designed to be embedded in a Guardian application; scheduling, provider integration and production operations remain with that application.

The normative behavior is defined by the [Guardian specification](docs/guardian-specification.md). A runnable integration is provided under [`example/`](example/README.md).

## Start here

- Read the [Guardian specification](docs/guardian-specification.md) for protocol requirements and the reference algorithms.
- Read the [example guide](example/README.md) for configuration, observe mode, signal mode and provider integration.
- Follow `Guardian.cycle` for one complete iteration and [`createGuardian`](example/daemon.ts) for viem client and transport setup.
- Replace the placeholder in [`example/screening-adapter.ts`](example/screening-adapter.ts) with your screening provider.

The example starts in observe mode, creates no signer and submits no transactions. Its bundled screening provider deliberately returns `incomplete` for every requested anchor.

## Package

Install a pinned commit from the public repository:

```bash
npm install git+https://github.com/lidofinance/lido-lend-guardian-daemon-sdk.git#<commit>
```

Node.js 24 or newer is required. The package currently uses `private: true` to disable npm registry publication; installation from Git is supported.

Both entry points need viem at run time. The package declares it as a peer dependency, `^2.55.19`, so the application and the SDK share one viem installation; the SDK is tested with viem 2.55.19. npm installs a missing peer automatically. With a package manager that does not, add viem to the application.

The package exposes two entry points:

- `guardian-daemon-sdk/core` contains `Guardian`, the screening interface, phase outcomes, shared types and the generic RPC interfaces.
- `guardian-daemon-sdk/clients` contains `ViemRpcClient` and `createViemRpcTransport` for applications using viem.

## Integration

An application supplies:

- deployment and Guardian configuration;
- a read-only `RpcProvider` for observe mode or an `RpcClient` with a signer for signal mode;
- a `ScreeningProvider` that returns one decision for each requested anchor, in the same order;
- a serial cycle loop and recovery policy.

Run one iteration with the last confirmed heartbeat block as an optional search hint. The SDK
revalidates it against current chain evidence before using it:

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

For viem, create one reusable transport, use it to configure the public and wallet clients, and pass those clients to `ViemRpcClient`. Applications using another library may implement the exported `RpcProvider` reads and `RpcClient` preparation, broadcast and bounded-delivery methods directly. In signal mode `Guardian` requires the client's `transactionPolicy.sendTimeoutMs` to be an integer number of milliseconds that covers at least `txConfirmationBlocks + 1` slots and does not exceed 2,147,483,647, rejects any other value at construction and applies the same budget to its shared report-confirmation wait. Before the heartbeat it reads every report's receipt and transaction again through the client's plain reads and requires the transaction to be its signer calling the registry with that report's calldata in a block after the report block; a client that confirms the wrong transaction, such as an identical earlier call, stops the attempt with `report-receipt-foreign`. `Guardian.clearPendingNonces()` is an explicit signal-mode recovery operation for a reconciled dedicated signer; it is not run automatically by `cycle`. The reference implementation for both modes is in [`example/daemon.ts`](example/daemon.ts).

### Comparing logs between providers

`createViemRpcTransport` sends each request to the first endpoint that answers and falls back to the next one. A load balancer or a lagging endpoint can then answer a log range without its latest blocks, and the SDK cannot see that.

With the `logQuorum` option the transport asks every provider for logs and compares their answers. Every other request is sent to the endpoints in turn as without the option.

```ts
createViemRpcTransport({
  urls: [firstProviderUrl, secondProviderUrl, thirdProviderUrl],
  logQuorum: 2,
  // the other options are unchanged
});
```

- `logQuorum` is at least two and at most the number of URLs. Two providers give comparison without tolerance of an outage; three keep working while one is unavailable. A quorum below the majority of the URLs lets that many providers decide which logs are returned.
- Logs are returned when a quorum returned them alike and they include every log that any other provider returned. The order of the logs in an answer is not compared. A provider that only lacks logs is lagging and does not stop the read; a log that the quorum lacks rejects it.
- A provider that fails or sends an invalid list takes no part in the comparison.
- Log reads wait until every configured provider responds or reaches `timeoutMs`.
- A rejected read fails with `LogsNotConfirmedError` as the cause of the error viem reports, after the configured retries.
- Every difference is reported as an `rpc.answersDiffer` event, including the ones that did not reject the read.
- With `logQuorum` the transport is a viem custom transport around the fallback, so viem does not keep the requests of a filter on the endpoint that created it.

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
