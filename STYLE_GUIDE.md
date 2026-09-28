# Code style

Rules for all TypeScript in this repository: the library under `src/`, the build checks under `scripts/`, the example and the tests. The mechanical half is enforced by `npm run lint` (`eslint.config.js`: typescript-eslint `strict-type-checked` and `stylistic-type-checked` plus the rules named below); Prettier owns layout; the rest is reviewed against this document. A rule that is not enforced decays, so when a reviewed rule becomes checkable, move it into the lint config. `eslint-disable` comments are not used: a rule that is wrong for a case is wrong in the config.

Sources these rules are drawn from: the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html), the [typescript-eslint strict and stylistic configs](https://typescript-eslint.io/users/configs/), the TypeScript handbook [Do's and Don'ts](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html) and Dan Vanderkam's [Effective TypeScript, 2nd edition](https://github.com/danvk/effective-typescript) (items cited as ET n).

## Types

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` and `erasableSyntaxOnly` are on. `tsc --noEmit` is part of the check; formatting and linting do not replace it.
- Unstructured external data is `unknown` until a validator has turned it into a typed value: viem's decoders for chain data and `Screened.fromAnswers` in `src/core/outcomes.ts` for provider results. No `any`, no type assertion (`as T`, `<T>value`, `value!`): a fact the code has checked is expressed by a type guard or a validator that returns the narrowed type (ET 5, ET 9, ET 46; lint: `consistent-type-assertions`, `no-non-null-assertion`). `as const` is a literal annotation, not an assertion, and is fine.
- Standard JSON-RPC calls use the dependency’s RPC schema to relate method, arguments and result. A configured transport owns conformance to that wire contract; consumers retain necessary quantity conversions and missing/pending checks without erasing known types to `unknown`. Type declarations alone do not validate a network response.
- Model states with discriminated unions so that impossible combinations cannot be represented: `{ status: 'complete'; calls } | { status: 'unavailable'; reason }`, never `{ status; calls?; reason? }` (ET 29, ET 34). `switch` over a discriminant is exhaustive (lint: `switch-exhaustiveness-check`).
- Use `interface` for object shapes and `type` for unions, tuples and mapped types (lint: `consistent-type-definitions`). No enums: a union of string literals is erasable and prints as itself. No `namespace`, no default exports.
- Exported functions declare parameter and return types (lint: `explicit-module-boundary-types`). Inside a function, let obvious types be inferred (ET 18); annotate a local only when the inferred type would be wider than intended.
- Keep `null` and `undefined` at the perimeter (ET 32, ET 33): validate input once, then pass values that are known to exist. Optional properties mean "may legitimately be absent"; do not use them to mean "not filled in yet" (ET 37). A missing value, zero and an empty collection are three different things; never substitute one for another to hide an incomplete response.
- Amounts are `bigint` in raw units in computation and decimal strings in JSON. Units appear in names when the type does not fix them: `amountWei`, `timeoutMs`. `number` is fine for indices and counts after a safe-range check.
- Prefer precise types to strings: a set of known names is a union, an address is validated before it becomes a `string` (ET 35, ET 36). A record with dynamic keys is a `Map`; an object type is for known keys (ET 16).
- Type-only imports use `import type`; a value import of a type breaks the type stripping that runs this code (lint: `consistent-type-imports`, compiler: `verbatimModuleSyntax`).

## Values and state

- A binding is `const` unless the algorithm advances it (`prefer-const`). Use `let` for local counters, cursors and accumulated values when an explicit loop is clearest. Keep asynchronous state transitions in the loop body. Prefer array methods for short transformations and simple aggregation; do not force state into recursion, a complex `reduce` or a mutable wrapper object merely to avoid `let`.
- Booleans may represent binary state, such as an operation being in progress. Use a discriminated union when several lifecycle states have different data; do not add flags solely to carry a decision between otherwise unrelated steps.
- Construct output objects with their complete fields (ET 21). Keep mutation within the local algorithm or the class that owns the state; never wrap a local scalar in an object merely to keep its binding `const`.
- Functions do not mutate caller-owned inputs (lint: `no-param-reassign`). Mutation is allowed on locally created values and on internal state owned by the class performing the operation; a graph patched by unrelated owners is not acceptable. Read-only parameters use `readonly T[]`, `ReadonlyMap` or `ReadonlySet`; class fields set once are `readonly` (ET 14, lint: `prefer-readonly`).
- State that must persist (a cache, a rate limiter) has one explicit owner, such as a class or factory; dependencies are passed explicitly and there is no module-level mutable state.
- Sort before emitting anything that will be compared, hashed or diffed: candidates, references, reasons. Determinism is part of correctness here.
- Template literals over concatenation (lint: `prefer-template`). Only strings and numbers are interpolated; an object or an `unknown` is formatted explicitly first (lint: `restrict-template-expressions`, `no-base-to-string`).

## Control flow

- A condition has one idea. The test of an `if`, `while`, `for` or ternary has at most two operands and no nested logical expression (lint: `no-restricted-syntax`). Name the parts: `const isWrap = event === 'Deposit'; const isPaid = amount > 0n; if (isWrap && isPaid)`. TypeScript narrows through such aliases when the operands are `const` or parameters, so a named guard loses nothing. A predicate used twice is a function whose name reads as a question (`isLocalOrigin`, `hasCompleteChildren`).
- Return early. Handle the failing or trivial case first and leave the main path unindented; no `else` after a `return` (lint: `no-else-return`). Ordinary nesting is at most three blocks deep (lint: `max-depth`); reduce nesting with early exits or meaningful helpers, subject to the documented function exceptions below.
- Use `while (condition)` for state-driven loops. Use `while (true)` for schedulers, polling and stream reads when completion is checked in the body, with visible `break`, `return` or `throw` paths where applicable. Conditionless `for` loops, including `for (;;)`, are forbidden by ESLint. Other statically constant conditions remain errors.
- Braces on every `if`, `else`, `for`, `while`, `do` (lint: `curly`). One statement per line, one declaration per line.
- A ternary chooses between two values in one expression that fits on one line. It never nests (lint: `no-nested-ternary`), never carries side effects, never selects between two multi-line branches, and never replaces `if` on a statement. When a value depends on more than one condition, write `if` with early returns or a small named function; when several values depend on the same discriminant, use a lookup table or a `switch`.
- Do not negate a condition that has an `else` branch; swap the branches (lint: `no-negated-condition`). Prefer `x === null` to `!x` when `x` is a string, number or bigint: `!amount` is true for `0n` and `!name` for `''` (lint: `strict-boolean-expressions`).
- Iterate with `for...of`, `Object.entries` and array methods. `for...in` and index loops that only walk an array are not used. `map` and `filter` are for short pure transformations; several conditions, state changes or error handling get a named function.
- No assignment inside a condition, no comma operator, no `switch` fallthrough into a non-empty case.

## Functions

- Ordinary functions have at most 20 statements, 50 nonblank, noncomment lines and cyclomatic complexity 12 (lint: `max-statements`, `max-lines-per-function`, `complexity`). Extract meaningful subproblems and keep the main algorithm readable in order. Do not fragment a coherent algorithm merely to satisfy a metric: document and justify a narrowly scoped exception in this guide and ESLint when it improves readability.
- ESLint applies a file-level exception to `src/chain/viem-client.ts`: at most 60 statements, 110 nonblank, noncomment lines, complexity 16 and nesting depth 4. This accommodates the delivery algorithm in `send`. Review the other methods against the ordinary limits; ESLint cannot scope these built-in rules to one named method. Preparation and replacement fees, inclusion reconciliation, and confirmation verification belong to substantive private phases. This exception does not relax type rules or justify unrelated work in `send`.
- ESLint applies a file-level exception to `src/core/guardian.ts`: at most 50 statements, 85 nonblank, noncomment lines, complexity 28 and nesting depth 4. This keeps the Appendix C backward walk, previous-coverage checkpoint and checks of paired supply and dust amounts in `#reconstructPosition`, while the absorbed-dust search remains a separate helper. Review every other method against the ordinary limits; the exception does not justify unrelated complexity in `Guardian`.
- At most five parameters (lint: `max-params`). More than that is an options object with named fields. Two parameters of the same type in a row are a bug waiting to happen; use an object or distinct types (ET 38).
- No boolean flag parameters that switch behaviour (`match(event, true)`). Split the function or pass a named union such as `'deposit' | 'withdraw'`.
- Pure by default: the same inputs give the same result, and nothing outside the function changes. Effects (network, files, clock) sit at the edge, in the requester and in the tooling, behind an explicit parameter.
- Named function declarations for anything with logic; arrow functions for short callbacks. Async functions await something; a function that returns a promise without awaiting is not `async` (lint: `require-await`).
- Behaviour with a natural class owner stays on that class. A helper used only to implement that behaviour is a private method; do not move it into a file of free functions merely to shorten the class. Extract another class only when it owns a coherent responsibility or state. Module-level functions are for shared operations or ownerless utilities such as validators, assertions, comparators and encoding helpers.
- Keep a phase's main algorithm visible in its public method. Private methods isolate meaningful subtasks, complex checks or technical mechanisms; a single caller is acceptable when the helper reduces the effort needed to understand the phase. Avoid wrappers that only delegate the entire phase or rename a trivial expression.
- Every promise is awaited or explicitly `void`ed with a reason (lint: `no-floating-promises`).

## Errors and results

- Expected outcomes are values, not exceptions: a parser that finds nothing returns `undefined`, an ambiguous match returns a failure object with a reason code. Exceptions propagate infrastructure failures and represent programming errors or broken invariants; handle them at the owning boundary without turning missing evidence into success.
- Throw `Error` instances, never strings, and keep the context: provider, operation, transaction hash, the value that was wrong. Wrap a caught error with `new Error(message, { cause })` rather than losing it (lint: `preserve-caught-error`).
- Keys, URLs with secrets and full responses never appear in messages, in a value the library returns or in a file a tool writes. A reason a caller may store or display names what failed, never the request that failed.
- `catch (error)` treats `error` as `unknown` and narrows with `instanceof` or a guard. A `catch` that ignores the error has a comment saying why ignoring it is correct; a `catch` never turns an error into an empty success, and expected incompleteness is returned explicitly (`coverage: 'partial'` with reasons).

## Modules

- `src/` is the library a Guardian imports through `src/core/index.ts`. `src/common/` holds the shared value types; `src/chain/` holds generic chain access and transaction delivery; `src/contracts/` holds contract calls and event interpretation. A module under `src/` never imports from `scripts/`, `tests/` or `example/`.
- Named exports only, and export only what another module uses. One module has one responsibility: a cycle phase, a decoder, a validator. Cross-cutting helpers live in one place rather than being copied.
- A caller implements `ScreeningProvider` and supplies a configured RPC/signing client. Transaction deduplication and concurrency belong to each provider implementation. The SDK owns registry submission; contract encoding and generic signing stay in their respective classes. Adding a vendor does not require changing the core.
- No circular imports.
- Relative imports with the `.ts` extension. A path with more than three parent steps means the module is in the wrong place.
- Major phases follow the specification's conceptual flow and are recognizable by name and responsibility. The SDK's public phase boundaries may combine or separate illustrative steps, but the audit map must show that correspondence. The example makes the cycle order and its stop conditions visible; operational setup and transport details must not obscure that flow.

## Names

- A name says what the thing is and which role it plays: `transaction`, `receipt`, `transfer`, `tokenAddress`, `senderAddress`, `recipientAddress`, `positionOwner`. Never `a`, `b`, `t`, `r`, `e`, `x`, not even in a callback or a test. An index is `index`; a log index is `logIndex`.
- No abbreviations of domain words: not `tx`, `amt`, `addr`, `evt`. Established ones are fine: `id`, `url`, `rpc`, `abi`. `data`, `result`, `item`, `value` only where the meaning is obvious without searching the file.
- Distinguish the token sender, the calling contract, the position owner and the transaction initiator in names. None of them is `user`.
- Variables and functions are `camelCase`, types `PascalCase`, module constants `UPPER_SNAKE_CASE`. Booleans read as predicates: `isComplete`, `hasTransfers`. Collections are plural: `transfers`; indexed collections say their key: `transfersByToken`. Functions that return a boolean are predicates (`isMint`), functions that produce something are verbs (`readReceipt`, `matchLoan`).
- Files are `kebab-case.ts`, except contract ABI modules named `abi/<ContractName>.abi.ts`; tests are `kebab-case.test.ts` under `tests/`. Fixture names show roles: `lenderAddress`, `routerAddress`, `poolAddress`.

## Comments

- A comment explains a non-obvious rule, a source limitation, a protocol quirk or the reason for a decision. It does not restate the next line, and it does not narrate history ("previously", "no longer").
- Exported functions carry a one-sentence TSDoc summary when the name alone does not say what the evidence or the contract is. Types are not repeated in prose (ET 31).
- Protocol facts cite where they come from: the ABI, the interface file, the event layout. A magic number has a name or a comment.
- Every major phase entry point links to the relevant specification heading using a relative Markdown link, for example [Scan cycle](docs/guardian-specification.md#scan-cycle) from `src/core/guardian.ts` or [Run one cycle](docs/guardian-specification.md#run-one-cycle) from `example/daemon.ts`. Adjust the relative path in the source comment to the file; cite the behavior section and any useful appendix section, not a source line number. Check that the target explains this phase's actual responsibility.
- A non-obvious invariant, an algorithm that differs from the illustrative pseudocode, or an extra SDK/example guard needs a short explanation near the owning code: the reason, its effect on behavior and how it preserves the required result. Identify implementation or caller policy as such. Comments do not excuse a conflict with a normative requirement; record that as a finding. Do not duplicate whole spec passages or annotate each obvious call.
- No commented-out code, no `TODO` without an owner and a reason.

## Tests

- `node:test` with `node:assert/strict`. A test name states the condition and the expected behaviour. Expected values are written independently of the algorithm under test; a fixture that mirrors the parser proves nothing.
- Fixtures encode the real ABI layout and are checked against `cast`; tests never touch the network.
- One behaviour per test, exact assertions (`deepEqual` on the whole result where practical), and every rejection path of a parser has its own test.
- The same rules apply to test code. Only the size limits are looser, because a test body is a linear list of assertions and a fixture builder is a literal.

## Checks

Manual review accompanies the automated checks. Read the main cycle and example in execution order, then inspect their helpers: domain names and units, module boundaries, state and ownership, async control flow, failure paths, unnecessary indirection, public contracts and the specification references above. Record concrete readability or TypeScript-rule findings and their disposition in the audit review. A local style preference is not a universal TypeScript requirement. If a rule produces less understandable code, record the conflict and propose a targeted rule change rather than hiding it behind a suppression or fragmenting the algorithm.

```bash
npm run check          # typecheck, lint, format check, build, surface check, all tests
npm run lint:fix       # apply the automatic fixes, then review the diff
npm run format         # prettier --write
```

Format and lint only the files you changed while iterating; run the full check before finishing.
