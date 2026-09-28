---
name: code-quality
description: How code is written and reviewed in this repository - the STYLE_GUIDE.md rules that lint cannot check, the lint and check commands, and the refactoring moves that bring a function back within the limits. Use before writing or reviewing any TypeScript here, and when lint reports complexity, depth or ternary violations.
---

# Code quality

`STYLE_GUIDE.md` is the contract; `npm run lint` enforces its mechanical half. Work in this order.

1. **Before writing.** Read the module you are changing and the guide sections on types, control flow and functions. Decide the shape of the result type first: a discriminated union for outcomes, `undefined` for "not mine", a failure object with a reason code for "mine but not provable". Propagate infrastructure failures to their owning boundary; never turn missing evidence into success.
2. **While writing.** Prefer `const`; use `let` for values the algorithm advances. State-driven loops use `while`, with updates and asynchronous transitions in the body. Conditionless `for` loops are forbidden. Use array methods for short transformations and simple aggregation, not to disguise mutable state. A condition has at most two operands; name its parts or extract a predicate. Return early, use explicit comparisons, avoid nested ternaries and type assertions, and keep each function at one level of abstraction.
3. **Lint.** `npm run lint:fix` applies the automatic fixes (type imports, templates, optional chains); review that diff, then fix the rest by hand. Never add `eslint-disable`; when a rule seems wrong for a case, that is a decision to record in `STYLE_GUIDE.md` and `eslint.config.js`, not a comment in the code.
4. **Bringing a function within the limits.**
   - When a function exceeds ordinary limits, look for meaningful subproblems. Keep behavior with its owning class and its helpers private. Do not split a coherent algorithm just to pass a metric; justify a narrowly scoped exception in the style guide and ESLint if that preserves readability. Review helpers against ordinary limits even when a file-level exception exists.
   - Long condition chains: turn them into a lookup table keyed by the discriminant (a `Record<Kind, Layout>`), or a list of named predicates joined with `every`.
   - Flags that switch behaviour: two functions, or one function taking a named union.
   - Repeated `x ? a : b` on the same discriminant: one `switch` or one table.
   - A loop may carry local state in `let`. Prefer `while (condition)`; use `while (true)` for schedulers, polling and stream reads with explicit completion checks. Do not replace a clear loop with recursion that copies growing state, a complex `reduce` or a mutable wrapper object merely to avoid reassignment.
   - A mock or callback that is `async` without `await`: return `Promise.resolve(value)` from a plain function.
5. **Review checklist** (what lint does not see): domain names and units; clear ownership of state and effects; a visible main algorithm in its public phase method; private helpers for substantive subproblems; no forwarding-only wrappers or unnecessary layers; explicit failure propagation; independently stated test expectations; no secrets in diagnostics. Define interfaces first and justify each new element before implementing it.
6. **Finish.** Run `npm run check`; every configured stage must pass. A skipped or unavailable check is not passing evidence. Test changes preserve existing behavior and assertion strength unless the maintainer explicitly changes the requirement.
