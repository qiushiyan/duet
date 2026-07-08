# Test Quality

What earns a place in the suite, and what to do about what doesn't. [tdd-loop.md](tdd-loop.md) says test behaviour, not implementation; this doc is the operational half — the shapes that violate it, how to spot them in review, how to delete them safely, and how to know a new test is real.

## The bar

- **Coverage is feedback, not the goal.** A test that cannot fail for a real reason is worse than no test: it costs maintenance, and it makes a green suite lie.
- **Deleting a test is a legitimate outcome of a code review.** So is refusing to add one — review's own **additive bias** is what makes that hard.
- **One owner per behaviour.** Before adding a test, find where that behaviour already lives. A second test may assert its own *delta* — never re-prove the original.
- **Assert what a caller depends on.** Bytes of human-facing prose are rarely that; the structure carrying them is.
- **If you can't make a test fail, it isn't testing anything.** Prove it by breaking the code it guards.

## The five shapes of a low-quality test

Names, so a reviewer can point at one instead of describing it.

### 1. Change detector

Asserts an exact string, format, or constant that no caller depends on. Breaks on a wording improvement; passes when the behaviour breaks.

```
✗ expect(err.message).toBe('claude worker turn failed (error_during_execution): crashed')
✗ expect(TICK_MS).toBe(30_000)                     // restates the constant
✗ expect(render(x)).toContain('while you were away — infra auto-retries: 3 (network ×2)')

✓ expect(() => …).toThrow(/error_during_execution/)   // the subtype is the contract
✓ expect(render(x)).toContain('auto-retries: 3')      // the count is the fact
✓ expect(render(x)).toContain('network ×2')           // so is the class breakdown
```

The test to keep asks *does this section appear, with the right facts, at the right time* — not *is this sentence unchanged*. If exact bytes genuinely matter (a wire format, a prompt a model reads, a schema a client parses), pin them **in one dedicated place** — a snapshot/approval harness or an explicit contract test — and never scatter fragments of them across the suite. Then a wording change moves those pins deliberately and breaks nothing else.

### 2. Tautology

The setup mirrors the assertion, or the test restates the implementation. Constructing an object and asserting its fields. Asserting a mapping table equals itself. Checking a type exists.

```
✗ test('config has a timeout', () => { expect(makeConfig().timeout).toBe(DEFAULT_TIMEOUT) })
```

Ask: *what change to the production code would make this red, that a reviewer wouldn't already reject?* If the answer is none, delete it. Type-level guarantees belong to the type-checker, not to a runtime assertion.

### 3. Shadow

Drives an internal helper whose behaviour the public surface already proves. It breaks on a rename, an inlining, a signature change — the honest signal of coupling to structure.

Legitimate exception, and it is narrow: a helper's **negative space** the public surface can't reach — an ordering invariant between composed steps, a side-effect discipline (this branch clears the marker; that one must not), a case only reachable by injecting a dependency directly. Test those and nothing else at that altitude, and say in a comment why the public surface can't reach them.

### 4. Echo

File B re-proves what file A owns, because whoever wrote B didn't know A existed. The tell: two files fail for the same one-line production change.

The fix is not to delete one arbitrarily — it's to **name the owner**, keep the canonical assertions there, and reduce the other file to its own delta (the transport it adds, the CLI framing, the wiring). Write the owner down where the next person will look: a module's doc, or a comment at the top of both files.

### 5. Scaffolding test

Tests the fixtures, fakes, or helpers rather than the system. `expect(fakeWorker.throwsWhenScripted()).toThrow()` proves your fake works. Fakes are proven by the tests that use them; if a fake is complex enough to need its own tests, that is a signal to simplify it.

## Before adding a test

1. **Who owns this behaviour?** Search for it. If it has an owner, add your delta there or nowhere.
2. **What bug would this have caught?** Name it concretely. "Coverage of the error branch" isn't a bug.
3. **Which existing test would already catch it?** If one would, you're about to write an echo.
4. **What will this assert?** If the honest answer is "the current wording," rewrite it around tokens and relations (below) or don't write it.
5. **Can it fail?** Break the production line it guards and watch it go red *before* you trust it (below).

The tests most worth adding are the ones whose absence is **invisible**: a wiring you could delete and leave the suite green. Nobody notices those gaps from a coverage report, because the code is covered incidentally by tests that would still pass without it.

## Assert tokens and relations, not bytes

Two techniques replace almost every prose pin, and both survive refactors:

**Structural tokens** — one token per fact the caller depends on. A refusal must name the next command (`--approve`); a status line must carry the pid; an error must name its class. Assert those, not the sentence around them.

**Relational claims** — assertions about the *relationship between two outputs*, which stay true under any rewording:

```
✓ expect(prompt(unbound)).toBe(BASE_PROMPT)              // unbound IS the base, byte-for-byte
✓ expect(render(gateless)).toBe(render(attended))        // this knob must not touch this surface
✓ expect(brief).not.toContain('consultant')              // the absence flip
✓ expect(body.indexOf(commit)).toBeLessThan(body.indexOf(author))   // ordering invariant
```

These are strictly stronger than a snapshot: a snapshot pins *what the output was*, a relational claim pins *what must remain true of it*. A snapshot harness can never state "these two renders are identical" or "this feature is byte-for-byte absent when off." Keep the relations in the behaviour suite and the bytes in the pin harness, and each does the job the other can't.

## The mutation check

**A guard you haven't seen fail is a guess.** Before trusting a test — especially one that claims a wiring exists (`X` is wrapped by `Y`, this handler is registered, this deadline is armed) — delete or invert the production line it guards, run it, watch it go red, then restore. If it stays green, the test is decorative.

Write the guard so it fails *fast and loud* rather than hanging or timing out: assert the observable side effect (the process was killed, the ledger has an entry), not merely that a promise settled. Where a wiring test exists, say so in a comment: *"deleting the wrap in `foo.ts` must fail this test"* — that sentence is the maintenance contract for the next reader.

## Parameterize matrices, keep the distinctions loud

Near-duplicate cases differing only by data are one behaviour, not N. Collapse them into a table (`test.for` / `test.each` — see [vitest.md](vitest.md#parameterized-behavior-tests)), and make each row's name carry the distinction it exists to hold:

```
✓ 'absent ⇒ attend-all (byte-for-byte legacy)'
✓ 'empty [] ⇒ explicit attend-none, never coerced'
✓ 'explicit N ⇒ materialized'
✗ 'case 1' / 'case 2' / 'case 3'
```

Then a new case is a row, and a changed rule touches one table instead of eight bodies. Do **not** use a table to cram unrelated behaviours together — if the rows need different assertions, they were different tests.

## Deleting a test safely

**An audit list is a hypothesis, not a verdict.** When a review (or a tool, or an agent) says "this test is redundant," verify before deleting:

1. **Find the twin.** Name the file and test that covers the behaviour you're about to drop. If you can't name it, the coverage isn't redundant — it's *load-bearing and misfiled*. Move it, don't delete it.
2. **Check the branches, not the topic.** Two tests about the same function may cover disjoint arms. Verify the *specific branches* have twins.
3. **If a deletion turns something red, that's a finding.** Report it. Never patch production code to make a test-removal green — you just deleted the test that was working.
4. **Never delete a test to make a refactor pass.** A red test during a refactor means the refactor changed behaviour. Fix the refactor.

Expect roughly a fifth of any redundancy list to dissolve under this check. That is the check working, not failing.

## Reviewing tests: the additive bias

The five shapes describe what a low-quality test looks like. **Additive bias** explains how one got in — and why review, the thing meant to catch it, is so often what asked for it.

Requesting a test is the cheapest finding a reviewer can make. It is always defensible, it never reads as lazy, and it costs the reviewer nothing: the maintenance lands on whoever meets the suite next. Refusing a test, or asking for one to be removed, takes an argument. The incentives point one way, and a suite reviewed for long enough drifts the way the incentives point — toward *more* tests, not better ones. A missing test is visible today; a superfluous one bills the future.

Hold a test you request to the bar any other finding must clear:

- **Name the bug it would catch.** "Coverage of the error branch" is not a bug. If you can't state the failure the test would have caught, you're asking for reassurance.
- **Find the twin first.** If an existing test already catches that bug, the finding is that the test is misfiled or unclear — not that one is missing.
- **Let deletion be a finding.** A reviewer who can only add is half a reviewer. *"This test cannot fail; remove it"* is as legitimate as *"this branch is unhandled."*

Then the per-test questions:

- Would this test survive renaming an internal function? (No ⇒ shadow.)
- Would it survive rewording a message no caller parses? (No ⇒ change detector.)
- Does another file fail for the same production change? (Yes ⇒ echo; name the owner.)
- Can I state the bug it catches in one sentence?
- Are near-identical tests a table wanting to happen?
- Does a new test for *added* code assert anything the code doesn't literally say?
- Am I asking for this test because it catches a bug, or because asking is cheap?

## Checklist per test

```
[ ] Names a behaviour, not a function or a branch id
[ ] The behaviour has exactly one owner, and this is it (or this is a stated delta)
[ ] Asserts tokens and relations; exact bytes only in the pin harness
[ ] Fails when the guarded production line is broken (mutation-checked)
[ ] Fakes only at boundaries; no scaffolding under test
[ ] A near-duplicate sibling would be a table row, not a copy
```

---

> _Lesson · testing. Distilled from a whole-suite audit and consolidation pass (1400+ tests): every low-quality test that had to be removed, classified by why someone wrote it. The recurring cause was never laziness — it was writing a test without asking who already owns the behaviour, or a reviewer asking for one because asking was cheap._
