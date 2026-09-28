# guardian-daemon-sdk

A reference implementation of the [Guardian specification 0.2.0](docs/guardian-specification.md), provided as a reusable SDK and a runnable example application. It discovers collateral supplies, reconstructs the work that needs screening, obtains provider decisions and submits confirmed reports followed by a heartbeat. Partners supply their screening policy, deployment configuration and operating environment.

## Start with the reference application

Read [example/README.md](example/README.md), then follow `cycle` in [example/daemon.ts](example/daemon.ts): `buildScanPlan → discoverCandidatePositions → reconstructWork → screenWork → signalAndHeartbeat`. The same file shows client configuration, one reusable viem transport, a shared `onEvent` handler and serial scheduling.

The example starts in observe mode without a signer. Replace the incomplete placeholder in [example/screening-adapter.ts](example/screening-adapter.ts) with your provider, validate its results in observe mode, then configure a delegate for signal mode. The example guide states the deployment inputs, expected output and transaction-recovery responsibilities.

## Public API

- `guardian-daemon-sdk/core`: `Guardian` runs a cycle through `buildScanPlan`, `discoverCandidatePositions`, `reconstructWork`, `screenWork` and `signalAndHeartbeat`. It reads the chain through the supplied client and returns outcomes the caller handles. The SDK signs reports and heartbeats through that client and confirms their canonical inclusion.

A screening provider implements `ScreeningProvider.screen(request)` from `/core`. Provider integrations own their risk policy, upstream data access, deduplication and concurrency. Applications own configuration, scheduling, monitoring and recovery across restarts.

```ts
import { Guardian } from 'guardian-daemon-sdk/core';
import { ViemRpcClient } from 'guardian-daemon-sdk/clients';
import type { ScreeningProvider } from 'guardian-daemon-sdk/core';

// Safe placeholder: replace with your provider's actual screening decisions.
const screening: ScreeningProvider = {
  screen: (request) => Promise.resolve(request.anchors.map(() => ({ status: 'incomplete' }))),
};

const guardian = new Guardian({
  deployment,
  guardian: address,
  client: new ViemRpcClient({
    publicClient,
    walletClient,
    maxLogBlockRange: 5_000,
    transactionPolicy: {
      maxFeePerGas: 100_000_000_000n,
      sendTimeoutMs: 264_000,
      replacementFeeBumpBps: 1_000,
      replacementTimeoutMs: 72_000,
      sendAttempts: 10,
    },
  }),
  expectedDelegate,
  screening,
  ...limits,
});

const plan = await guardian.buildScanPlan(cursor);
if (plan.kind === 'plan') {
  const discovered = await guardian.discoverCandidatePositions(plan);
  const work = await guardian.reconstructWork(discovered);
  const screened = await guardian.screenWork(work);
  const outcome = await guardian.signalAndHeartbeat(screened);
}
```

## Integration

`GuardianSetup` defaults to signal mode, which requires `client: RpcClient` and `expectedDelegate`. Pass configured viem public and wallet clients directly to `ViemRpcClient`; configure the wallet's `account` and `chain` when creating it. The adapter preserves their request, signing and transport policies without requiring method overrides. `/core` exports SDK types and a standard JSON-RPC request contract derived from viem’s RPC schema; it does not require a viem client. `/clients` exports ready-made client implementations; `ViemRpcClientOptions` uses native viem `PublicClient` and `WalletClient` types. Planning checks the chain, Guardian membership, the expected delegate and the client's signer. Set `expectedDelegate` to the address the registry must name, or the zero address when no delegate is expected. The signer may be the Guardian itself or that delegate.

Observe mode takes `mode: 'observe'` and `client: RpcProvider`, with no wallet or expected delegate. `BaseRpcProvider({ request, maxLogBlockRange })` provides these reads over a caller-supplied JSON-RPC function. Planning still checks the chain and membership; `signalAndHeartbeat` is disabled.

The caller chooses `deployment.chainId` and `deployment.slotSeconds`. Guardian derives its fixed seven-day discovery lookback as `ceil(604800 / slotSeconds)` blocks; a custom activation lookback is rejected. Ethereum's 12-second profile gives 50,400 blocks. Other networks require the operator to establish compatible deployment behavior and slot assumptions.

All numeric setup fields must be safe integers. Deployment block numbers may be zero; `idleHeartbeatInterval` (seconds), `maxSignalBatchSize` and `txConfirmationBlocks` must be positive. `reportBlockLag` defaults to 2 and must be at least 1. `heartbeatReserveBlocks` must be positive, and their sum must not exceed the 256-block `blockhash` window. The constructor copies setup and deployment values. Numeric validity does not establish correct deployment floors or feasible operating settings; address/hash aliases do not validate deployment identity.

`maxLogBlockRange` belongs to the RPC client. It limits each inclusive `eth_getLogs` range and must be accepted by every configured endpoint. Range, result-count and response-size failures propagate without adaptive splitting. Neither Guardian nor `BaseRpcProvider` constructs a second library client.

`createViemRpcTransport` from `/clients` is the SDK's viem transport factory. It returns a normal viem fallback transport for `createPublicClient` and `createWalletClient`; configure it once and give both clients the same instance. viem owns endpoint selection, request deduplication and retries. The SDK adds a timeout that covers response-body reading, a response-size limit, `User-Agent`, and optional `rpc.requestStarted`/`rpc.requestFinished` events for each physical HTTP attempt. Those events include the method, endpoint index, timestamps, HTTP status and byte counts. The transport keeps mutable measurements per request, so parallel calls do not share attempt state.

Custom clients can inherit `BaseRpcProvider` and add `signer`, `transactionPolicy`, `prepareTransaction`, `broadcastTransaction` and `send`, or implement `RpcClient` directly. The base class supplies `call`, `getChainId`, `getTransactionCount`, `getBlock`, `getReceipt`, `getLogs`, `logBatches`, `getLastLog` and `isConfirmed`, with normalized results in SDK-owned types. Pass `publicClient.request` directly for viem. An ethers read boundary is `request: ({ method, params }) => provider.send(method, params ?? [])`. `RpcRequest` accepts `{ method, params }` and derives the response type from `PublicRpcSchema`; invalid method names, arguments and result assignments fail compilation. The request function promises standard RPC response shapes; TypeScript does not validate network JSON. The base provider normalizes quantities with viem and rejects missing or pending evidence where mined data is required. Contract classes own calldata, event filters and ABI interpretation using standalone encoding/decoding functions. `GuardianSignals` receives its client at construction and sends encoded calls with per-operation `SendOptions`; Guardian binds delivery events to report or heartbeat context. `getLastLog` applies the caller's decoder to every log in the fetched range before selecting the newest, preserving complete decoding while avoiding older ranges. The conformance suite exercises all five Guardian phases and real local contract writes through both viem and ethers clients.

Within each `screen` call, the SDK reads flaggers in batches of at most `flaggerReadConcurrency` (default 8), pinned to the report block. It preserves target order and retains every target; an exhausted read failure rejects screening and starts no later batch. Reads already in flight may finish. This is SDK resource policy, not a protocol limit or a bound across concurrent calls or instances.

The screening provider receives frozen copies of the request, anchors and report block. It returns one positional `ScreeningResult` per anchor: `incomplete`, or `judged` with `requiresSuspect` and `requiresFlag`. Evidence is optional: an omitted, `undefined` or `null` `evidenceReference` means no evidence. A supplied identifier must be a nonempty string. The SDK reads the defined decision fields once into a snapshot, validates that snapshot and uses it for both the recorded result and report targets. Later provider edits cannot change either. Missing, malformed or incomplete results stop the attempt before submission.

`Guardian.signalAndHeartbeat` sends suspects before flags and groups each kind by market. Between batches it waits for `min(interBatchConfirmationBlocks, txConfirmationBlocks)` confirmations; `interBatchConfirmationBlocks` defaults to 2. It then waits once for every transaction of that kind to reach `txConfirmationBlocks`, checking at `confirmationPollIntervalMs` intervals (default: `deployment.slotSeconds * 1000`). Both settings must be positive safe integers; the polling interval cannot exceed 2147483647 ms. It rechecks the plan before each batch, during the shared wait and before heartbeat. Every report receipt must still identify the successful canonical inclusion at the configured depth. The heartbeat is signed only after these checks, and `Attested` is returned only after its own canonical confirmation. In [`example/daemon.ts`](example/daemon.ts), `main` configures, schedules and handles failed attempts, and `cycle` presents the five phases in specification order. The [example guide](example/README.md) covers default observe mode and explicit provider wiring for signal mode.

Send failures propagate unchanged. There is no SDK revert-name parser or special retry policy for contract errors. `GuardianStop` still names failed Guardian preconditions, and `Stale` identifies a plan that must be rebuilt. A rejected send can leave a pending or successful transaction onchain; before another cycle, resolve pending writes and repeat authorization and plan checks. The example retries failed observe attempts on its schedule, but stops signal mode after an exception so the operator can reconcile pending transactions before restarting.

`ViemRpcClient.send` prepares, signs, broadcasts and waits for a canonical receipt at the requested depth. It rejects an orphaned inclusion before the caller can send another batch. Preparation uses the configured wallet client; network retry/fallback policy belongs to its transport. `transactionPolicy.sendAttempts` counts preparation attempts, including the initial attempt and estimates above the fee cap. Replacements preserve chain, recipient, calldata, value and nonce, and raise both EIP-1559 fee fields above the previous value plus `replacementFeeBumpBps / 10000` of that value, rounded down and incremented by one wei, while enforcing `maxFeePerGas`. `replacementFeeBumpBps` is a required positive safe integer; 1000 means 10%. `replacementTimeoutMs` is the inclusion wait after broadcast, excluding preparation and signing time. viem owns receipt polling; after inclusion the SDK waits for the requested depth without submitting replacements, then rereads the receipt and verifies its canonical block and depth. A canonical reverted receipt fails delivery; an absent receipt keeps it pending. Errors surfaced by library actions propagate. `transactionPolicy.sendTimeoutMs` is the required total budget for one send, from preparation through full confirmation (1–2147483647 ms). Per-call `SendOptions` contains the confirmation depth and optional operation context. The deadline is checked again after signing, before starting a new broadcast; it does not cancel an in-flight RPC call. Serialize cycles and use one writer per signing account; the SDK does not persist pending transactions across process restarts.

An estimate above the fee cap consumes a preparation attempt and delays the next estimate by at most `replacementTimeoutMs`. While an earlier broadcast is pending, viem still waits for its receipt. Before replacing, the SDK checks all submitted hashes: an original transaction can win after its replacement, and a receipt can become readable at the same head. viem polls on new heads; a receipt published later at the same head may be recovered at the inclusion timeout. Because viem suppresses its initial receipt-read error and some block-poll errors, the SDK reads receipts before waiting and probes a fresh head after an inclusion timeout before considering another attempt. Exhausting attempts or timing out does not establish that an earlier broadcast failed.

Every event-producing SDK component accepts the same optional `onEvent: EventHandler` at construction. Pass one handler to `createViemRpcTransport`, `ViemRpcClient` and `Guardian` to receive RPC-attempt, transaction-delivery and report-lifecycle events through one event union. Preparation, signing and broadcast events carry start and finish timestamps. `transaction.included` records the first observed receipt and its duration since the first successful broadcast; `report.confirmed` records the later canonical report confirmation. Inclusion is provisional and can later be reverted or orphaned. The SDK has no logger; an application can route these events to records or metrics. Error events retain the original error, so redact request credentials before recording it.

`Guardian.clearPendingNonces()` is an explicit recovery operation for a dedicated signal signer. Before a fresh signal cycle, it compares latest and pending nonces and, when needed, prepares zero-value self-transfers at each blocked nonce. It uses the client's fee and attempt policy, replaces underpriced cancellations at the same nonce and waits for canonical nonce consumption. Observe mode refuses the operation. Recovery state is in memory, so the application must call it again after a restart when reconciliation is required.

`BaseRpcProvider` is exported from `/core` and `ViemRpcClient` from `/clients`; `Markets` and `GuardianSignals` remain internal contract access classes. `ChainReader`, `RegistryReverted`, `TransactionReverted` and `TransactionUnresolved` are not exported.

Returned plans, discovered positions, work and screening decisions are immutable snapshots; their declared fields and nested blocks, positions, anchors and report targets cannot be edited. `Discovered.all()` and `Work.all()` return separate arrays, while `Work.entries()` returns a separate map. Mutating these containers cannot change the internal candidate or work sets. The SDK copies inputs rather than freezing caller/provider-owned objects.

Pass the original phase values through the same Guardian's attempt in order. The API does not authenticate instance/attempt origin, prevent reuse or coordinate concurrent cycles; type-only exports do not establish these guarantees. RPC and provider exceptions propagate to the caller and can contain request details, so use explicit safe diagnostics rather than logging raw errors.

## Installation

A Guardian's repository depends on a maintainer-published SDK commit. `prepare` builds `dist/` on install, so the installing machine needs Node 24 or newer. Use the public repository over HTTPS:

```bash
npm install git+https://github.com/lidofinance/lido-lend-guardian-providers.git#<commit>
```

The package includes compiled output, source, ABI fragments, the specification and example, plus npm's standard package metadata, README and license. The `private` flag remains set until registry publication is arranged. A local link can be used while SDK and daemon changes are developed together; a clean installation must still be checked against the published commit.

## Development

Requires Node 24 or newer (`.node-version`). TypeScript runs natively with type stripping. Contract conformance also requires Anvil 1.7.1 on `PATH` or selected through `ANVIL_BIN`.

```bash
npm ci
npm run check          # typecheck, lint, format, build, public surface and coverage-gated tests
npm run test:core
npm run test:example
ANVIL_BIN=/path/to/anvil npm run test:conformance
npm run test:coverage
npm run check:package  # pack, clean install and import both public entry points
node example/daemon.ts # defaults to observe; see example/README.md
```

Tests use scripted nodes and isolated local Anvil processes and make no external requests. The example's placeholder leaves screening incomplete. Adapt the example's screening instance to connect your provider; observe constructs no wallet and stops before submission. See [running the example](example/README.md).

## Layout

- `abi/`: minimal ABI fragments used by the SDK, one module for the registry, lending core and market controller. Human-readable signatures retain contract parameter, event field and tuple component names. Conformance tests compare their wire layout with the pinned, trimmed fixture ABIs, whose parameters are unnamed. The build emits these modules into `dist/abi/` and library code into `dist/src/`; consumers import `/core` and, for the supplied viem adapter, `/clients`.
- `src/core/guardian.ts`: the five public cycle phases and their private algorithmic helpers.
- `src/contracts/`: contract access. `Markets` returns typed core/controller supply and position evidence; `GuardianSignals` reads Guardian identity, flags and heartbeats and encodes writes.
- `src/chain/`: generic chain access and delivery. `BaseRpcProvider` handles blocks, receipts and log ranges; `ViemRpcClient` signs and delivers transactions; `createViemRpcTransport` supplies the reusable viem HTTP/fallback transport.
- `src/core/types.ts`: shared position identities, report targets and supply anchors; `outcomes.ts` contains the phase results. Contract read result types live with `Markets` in `src/contracts/markets.ts`.
- `src/core/screening-provider.ts`: the caller-supplied screening interface.
- `src/common/`: shared public value types, independent of viem's types, and internal validation helpers.
- `example/daemon.ts`: configuration, scheduling and failure handling in `main`, and the five phases with specification links and no-change/stale outcomes in `cycle`.
- `example/env.ts`: on-demand environment reads and validation, imported by the launcher as `env`.
- `example/screening-adapter.ts`: the screening instance passed directly to Guardian. Replace its `UnconfiguredScreening` placeholder with your provider when adapting the example; it is outside the published SDK API.
- `scripts/check-surface.ts`: checks that public declarations expose only the standard RPC schema types, keeping concrete client types under `/clients`.
- `scripts/check-package.ts`: packs and installs the SDK in a temporary clean consumer, then imports both public entry points.
- `tests/core/`: acceptance checks for SDK behavior; `tests/example/` checks the launcher modes and incomplete screening placeholder.
- `tests/conformance/`: standalone approved contract fixtures, provenance checks, independent digest vectors and lifecycle/submission scenarios.
- `docs/guardian-specification.md`: canonical Guardian specification 0.2.0, including its illustrative pseudocode appendix.

## For agents

Read `AGENTS.md` and `STYLE_GUIDE.md` before changing the repository. The code-quality checklist is under `.claude/skills/code-quality/`.

## License

GPL-2.0, see `LICENSE`.
