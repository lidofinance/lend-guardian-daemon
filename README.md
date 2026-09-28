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

The package exposes two entry points:

- `guardian-daemon-sdk/core` contains `Guardian`, the screening interface, phase outcomes, shared types and the generic RPC interfaces.
- `guardian-daemon-sdk/clients` contains `ViemRpcClient` and `createViemRpcTransport` for applications using viem.

## Integration

An application supplies:

- deployment and Guardian configuration;
- a read-only `RpcProvider` for observe mode or an `RpcClient` with a signer for signal mode;
- a `ScreeningProvider` that returns one decision for each requested anchor, in the same order;
- a serial cycle loop and recovery policy.

Run one iteration and retain the returned cursor only when the result carries one:

```ts
const outcome = await guardian.cycle(cursor);
```

`cycle` emits typed phase and terminal events through the same `onEvent` handler as RPC, transaction and report events. Missing, malformed or incomplete screening results stop the attempt before submission. In signal mode the SDK submits required suspect reports, then flag reports, verifies their canonical confirmations and finally submits and confirms the heartbeat. RPC and provider failures propagate to the application.

For viem, create one reusable transport, use it to configure the public and wallet clients, and pass those clients to `ViemRpcClient`. Applications using another library may implement the exported RPC interfaces directly. The reference implementation for both modes is in [`example/daemon.ts`](example/daemon.ts).

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
- [`docs/guardian-specification.md`](docs/guardian-specification.md): Guardian specification 0.2.0.

## License

GPL-2.0, see [LICENSE](LICENSE).
