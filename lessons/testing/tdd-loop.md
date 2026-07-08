# The TDD Loop

Test-driven development with a red-green-refactor loop, built one vertical slice at a time. This is the tool-agnostic discipline; Vitest specifics live in [vitest.md](vitest.md), and what-to-mock in [mocking-and-fixtures.md](mocking-and-fixtures.md).

## The bar

- **Test behaviour through public interfaces, not implementation.** Code can change entirely; tests shouldn't. A good test reads like a spec — "user can checkout with valid cart."
- **Vertical slices, not horizontal.** One test → one implementation → repeat. Never "write all the tests, then all the code."
- **One test at a time; only enough code to pass it.** Don't anticipate future tests.
- **Never refactor while RED.** Get to GREEN first.
- **The discipline is one slice per commit, not keystroke order.** Red-green-refactor is a tool — reach for it inside a slice when design is uncertain or behaviour is subtle and a failing test gives real signal; writing test and code together is fine otherwise.

## Philosophy

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

Concrete good/bad examples are in [vitest.md](vitest.md); what may and may not be mocked is in [mocking-and-fixtures.md](mocking-and-fixtures.md). The named shapes bad tests take — change detector, tautology, shadow, echo, scaffolding test — plus how to delete them safely, are in [test-quality.md](test-quality.md).

## Anti-pattern: horizontal slices

Write one test, make it pass, repeat. The failure mode with a name is **horizontal slicing** — all the tests first, then all the implementation, treating RED as "write every test" and GREEN as "write every line."

Horizontal slices produce **crap tests**:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes — they pass when behavior breaks, fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding the implementation

The cure is the **vertical slice**, driven by tracer bullets: one test → one implementation → repeat, each test responding to what the last cycle taught you. Because you just wrote the code, you know which behaviour matters and how to verify it.

## Workflow

### 1. Planning

When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

Settle these before writing code:

- [ ] The interface changes the work needs
- [ ] The behaviours worth testing, in priority order — named as behaviours, not implementation steps
- [ ] Opportunities for [deep modules](../codebase-design/deep-modules.md) (small interface, deep implementation) and [design for testability](../codebase-design/deep-modules.md#designing-for-testability)

**You can't test everything**, which makes the priority order the real decision: critical paths and complex logic earn tests, exhaustive edge cases don't. Make that choice deliberately rather than letting it fall out of whatever was easiest to test.

The choice divides by who owns it. *Which behaviours matter* is the product's call — surface it and wait for an answer rather than assuming one. *How to reach them through the interface* is yours — decide it, and record why.

Stub the planned behaviours as a visible backlog with `test.todo` so each becomes a vertical slice to implement (see [vitest.md](vitest.md#running-tests-in-the-loop)).

### 2. Tracer bullet

Write one test that confirms one thing about the system:

```
RED:   Write test for first behavior → run it → test fails
GREEN: Write minimal code to pass → run it → test passes
```

This is your tracer bullet — it proves the path works end-to-end.

### 3. Incremental loop

For each remaining behavior:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Each cycle earns its next test from what the last one taught you, which is why the loop tolerates no lookahead: code written for a test you haven't reached yet is speculation the loop can't check.

### 4. Refactor

After all tests pass, look for refactor candidates:

- **Duplication** → extract function/class
- **Long methods** → break into private helpers (keep tests on the public interface)
- **Shallow modules** → combine or deepen (see [deep-modules.md](../codebase-design/deep-modules.md))
- **Feature envy** → move logic to where the data lives
- **Primitive obsession** → introduce value objects
- **Existing code** the new code reveals as problematic
- Apply SOLID principles where natural
- Run tests after each refactor step

**Never refactor while RED.** Get to GREEN first, then refactor with confidence. Use watch mode and shuffled test order to keep the refactor safe — see [vitest.md](vitest.md#running-tests-in-the-loop).

## Checklist per cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```

---

> _Lesson · testing. Consolidates `tdd/SKILL.md` + `tdd/refactoring.md` (+ the good/bad-test principles from `tdd/tests.md`). Upstream baseline: `.upstream/tdd/SKILL.md`._
