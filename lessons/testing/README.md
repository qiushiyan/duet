# Testing

Test discipline, mocking strategy, and Vitest reference. The discipline is tool-agnostic; only `vitest.md` is stack-specific.

| Lesson | Role | Read when |
|--------|------|-----------|
| [`tdd-loop.md`](tdd-loop.md) | The red-green-refactor discipline: behaviour over implementation, vertical slices, the horizontal-slice anti-pattern, the workflow. **Start here.** | always |
| [`mocking-and-fixtures.md`](mocking-and-fixtures.md) | Strategy: mock only at boundaries, inject dependencies, SDK-style interfaces, `test.extend` fixtures as DI, composing fixtures like deep modules. | always |
| [`test-quality.md`](test-quality.md) | What earns a place in the suite: the five shapes of a low-quality test, one-owner-per-behaviour, tokens and relations over byte pins, the mutation check, deleting tests safely. | writing, reviewing, or removing tests |
| [`vitest.md`](vitest.md) | Vitest API/CLI reference: the test loop, behavior-test examples, custom matchers, `test.for`/`expect.soft`, `vi.mock` hoisting, fixture scoping, timers, gotchas. | TS-Vitest projects only |

Coverage is feedback, never the target: a test that cannot fail for a real reason costs maintenance and makes a green suite lie. Removing one is a legitimate outcome — see `test-quality.md`.

The design-side counterpart is [`../codebase-design/deep-modules.md`](../codebase-design/deep-modules.md) — it owns the "design for testability" interface principles; this folder owns the test-side mechanics.
