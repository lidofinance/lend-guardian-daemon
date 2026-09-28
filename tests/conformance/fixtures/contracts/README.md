# Contract conformance fixtures

These artifacts let the full SDK test suite deploy the approved registry, lending core, market controller and proxy to an isolated local Anvil chain. They require no access to a contract repository. The [manifest](upstream-manifest.json) records the source revision, compiler settings, production/mock classification and hashes.

The fixture ABI is a subset: only constructors, functions, events and errors used by the tests or the SDK are retained. Parameter names, tuple-field names and Solidity `internalType` metadata are removed. Tests encode tuple arguments and interpret decoded values positionally. The SDK's named ABI fragments are checked against the same signatures, types, tuple order, indexed fields and mutability.

Creation bytecode is unchanged from the approved baseline. `upstreamSha256` identifies the original full artifact, `sha256` identifies the trimmed JSON file, and `bytecodeSha256` hashes the decoded creation-bytecode bytes. Artifact and bytecode hashes are pinned independently in the provenance tests. The fixtures are not rebuilt from the reduced ABI.

| Artifact                | Role                                       |
| ----------------------- | ------------------------------------------ |
| `GuardianSignals.json`  | Production registry                        |
| `Core.json`             | Production lending core                    |
| `MarketController.json` | Production market controller               |
| `OssifiableProxy.json`  | Production proxy                           |
| `MockERC20.json`        | Synthetic token used for local deployment  |
| `MockPriceOracle.json`  | Synthetic oracle used for local deployment |

Tests run entirely against local Anvil processes. Install Anvil 1.7.1 on `PATH`, or select its executable with `ANVIL_BIN`, and run `npm run test:conformance` or the complete `npm run check` from the repository root. No separate fixture download or private test configuration is needed.

Passing these tests establishes behavior of the pinned bytecode under the stated local setup. It does not establish the source or bytecode identity of a live deployment. The local fixture uses chain ID 1 to exercise the mainnet profile; it does not connect to mainnet.
