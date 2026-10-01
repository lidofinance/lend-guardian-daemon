# guardian-daemon-sdk

TypeScript reference implementation of the Guardian offchain logic for `GuardianSignals`.

A Guardian screens collateral supplies before the collateral activates. In each cycle it selects a recent block, finds the collateral that must be screened by that block, screens its supply transactions, submits the required `suspect` and `flag` reports and sends a heartbeat for that block. The [Guardian specification](docs/guardian-specification.md) defines this behavior.

## Ways to run a Guardian

- **Your own implementation.** You write the whole Guardian from the [specification](docs/guardian-specification.md), in any language.
- **The SDK in your application.** The SDK is a TypeScript library that runs the Guardian cycle. Your application calls it on a schedule and provides RPC endpoints, the signing key and screening. The [example](example/README.md) is a runnable application to start from.
- **The daemon image.** The [daemon](daemon/README.md) is a ready-to-run application built on the SDK and packaged as a Docker image. You configure and run it, and provide RPC endpoints, the signing key and a screening service that the daemon calls over HTTP.

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
- Start from the [example](example/README.md). In [`example/daemon.ts`](example/daemon.ts), `createGuardian` sets up the viem clients and transport, and `main` runs the cycles and recovers from failed ones.
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

Run one cycle with the last confirmed heartbeat block as an optional search hint. The SDK checks it against the chain before using it:

```ts
let previousHeartbeatBlock: BlockRef | null = null;
const outcome = await guardian.cycle(previousHeartbeatBlock);
if ('previousHeartbeatBlock' in outcome) {
  previousHeartbeatBlock = outcome.previousHeartbeatBlock;
}
```

`cycle` reports each phase and its result as events to the `onEvent` handler, which also receives RPC, transaction and report events. Missing, malformed or incomplete screening results stop the cycle before any transaction. In signal mode the SDK sends the required suspect reports, then the flag reports, waits until they are confirmed on the canonical chain, and then sends the heartbeat and waits for its confirmation. RPC and screening provider errors are passed on to the application.

For viem, create one transport, use it for the public and wallet clients, and pass both clients to `ViemRpcClient`. With another library, implement the `RpcProvider` reads and the `RpcClient` preparation, broadcast and delivery methods yourself. [`example/daemon.ts`](example/daemon.ts) sets up observe and signal mode with viem.

- An `RpcClient` should add headroom to the node's gas estimate: a report costs more gas when another guardian reports the same account before this report is included. `ViemRpcClient` adds `transactionPolicy.gasHeadroomBps`, a fifth by default.
- In signal mode the client's `transactionPolicy.sendTimeoutMs` must be an integer number of milliseconds, cover at least `txConfirmationBlocks + 1` slots and not exceed 2,147,483,647. `Guardian` rejects any other value at construction and uses the same budget for its wait for report confirmations.
- `Guardian.clearPendingNonces()` is a recovery step for signal mode: it waits for or cancels every pending transaction of the signer, so use it only for a signer that nothing else uses. `cycle` never calls it.

### Comparing logs between providers

`createViemRpcTransport` sends each request to the first endpoint that answers and falls back to the next one. A load balancer or a lagging endpoint can answer a log range without its latest blocks, and the SDK cannot see that.

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
- [`example/`](example/README.md): example Guardian application built on the SDK.
- [`daemon/`](daemon/README.md): deployable daemon with HTTP screening, event forwarding and a Docker image.
- [`tests/`](tests/): core, example, daemon and contract-conformance tests.
- [`benchmarks/`](benchmarks/README.md): SDK cost, amplification, liveness and daemon overhead benchmarks, with [their latest results](benchmarks/RESULTS.md).
- [`docs/guardian-specification.md`](docs/guardian-specification.md): Guardian specification 0.2.0.

## License

GPL-2.0, see [LICENSE](LICENSE).
