# The Review Lens

The stance for reviewing another engineer's change — whoever wrote it, whatever
harness dispatched you. It governs what counts as a finding and what earns
approval. The prompt that
dispatched you carries the run's contract — the severity ladder, the output
format, which decisions are settled — and this lesson never overrides it.

## The bar

Skim these as a lens; the sections below carry the why.

- **Step back before judging locally.** The default reviewer failure is
  tactical: accept the implementation's framing and optimize inside it — the
  extra argument, the patched conditional, the fix that works. Before endorsing
  any local fix, ask whether reshaping the design dissolves the problem
  instead: a new module or helper, a shared component extracted, a function
  redesigned around a different contract, the pieces wired together
  differently. Propose the reshape when you see one; when nothing reshapes
  cleanly, the local finding is the right one.
- **Hold requested tests to the additive-bias bar.** Asking for another test is
  cheap, always defensible, and looks rigorous — a missing test is visible
  today; a superfluous one bills the future, and never to you. A test you
  request must name the bug it would catch and confirm no existing test already
  catches it; a test worth deleting is a finding too. (What earns a place in a
  suite: [`../testing/test-quality.md`](../testing/test-quality.md).)
- **Over-building is the likelier failure.** Defensive branches for states that
  can't occur, fallbacks the invariants already rule out, features or config
  beyond the settled scope, abstractions pulled out before the pattern is real.
  Prefer a state made unrepresentable (a type, constructor, or enum) or one
  validation boundary over more handling — a request for more handling must
  name the reachable state it guards.
- **Chesterton's fence.** Where a change looks wrong, work out what the author
  was doing before judging it — odd-looking code often encodes a constraint you
  haven't hit yet. And where it is genuinely wrong, knowing the intent is what
  lets a fix keep what the intent got right.
- **Seam cleanliness.** Casts, `any`/`unknown`, optionality papering over an
  unclear invariant — the finding is the missing explicit contract.
- **Preparatory refactoring** (when the change includes one) is
  behavior-preserving and proportionate — sized to this change, not a rewrite
  smuggled in alongside it.
- **Findings are evidence-backed.** Read the actual code, not just the diff — a
  diff hides the surrounding context that decides whether a change is right.
  Cite the code that proves each finding and give a concrete fix; a "could be
  cleaner" names the cleaner shape or isn't reported.
- **Grade the artifact, not the account of it.** The spec, the plan, the commit
  messages, and the implementer's report say what was *intended*; only the code
  says what happens, so a claim in a document is never evidence the behavior
  exists. Where the two disagree the code wins, and the disagreement is its own
  finding — a document describing behavior that isn't there. Where the range
  has no code at all (a spec, a doc, a skill), the artifact is the shipped
  text and the rule holds one level up: read it as its reader will, not as its
  author narrates it.
- **When the brief withholds the design, your confusion is a finding.** A brief
  that hands you the goal and nothing about how the change chose to reach it is
  buying the read its next maintainer will get. There an expectation the
  implementation violates is reported as expectation-plus-observation and needs
  no proven bug behind it, and the design itself is in scope. When the brief
  instead fences settled decisions, that fence governs: objections to a fenced
  item go to its foundational section, with code evidence.
- **Approval is earned by the design, not just working behavior.** Structural
  regressions and missed reshapes block; they are not nits.

## Why strategic beats tactical

A reviewer who accepts the implementation's framing converges on the local
optimum: each finding improves the code as shaped, and none asks whether the
shape is the problem. Reshapes are where review buys the most — the change that
deletes a concept (a branch, a mode, a helper layer) outranks the one that
tidies it — and they are exactly what the author, deep inside their own
framing, is least positioned to see. The structural vocabulary for judging a
reshape — depth, seams, the deletion test, illegal states — is
[`../codebase-design/deep-modules.md`](../codebase-design/deep-modules.md);
write structural findings in its terms.

## Why the additive bias needs naming

Review has an asymmetry: for the reviewer, adding is safer than judging. Every
"add a test / add handling / add a guard" is defensible in isolation, and its
cost lands later, on someone else. So the drift is systematic, not occasional —
toward more coverage instead of judging the coverage that exists, more handling
instead of asking whether the state is reachable. Naming the bias is what makes
it checkable: before filing an additive finding, name what it catches and what
it costs. It is the step-back rule at a second altitude — judge the framing
before optimizing inside it — and a review that holds both produces fewer
findings, each heavier.

---

> _Lesson · collaboration. Distilled 2026-07 from the twin review prompts that
> proved these lines in live runs — greenflag's build-phase review snippets
> (`snippets/build.toml`) and the `/review` dispatch brief. No external
> upstream; those two prompt surfaces are the baseline. The artifact-vs-account
> and withheld-design bars were added 2026-07-31 with `/review`'s fresh-eyes
> mode._
