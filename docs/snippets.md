# Snippet reference

Snippets are the prompt templates the orchestrator sends the workers — they *are* the workflow. This doc catalogs the ones you're most likely to override, **with their full bodies**, so you can see exactly what you're changing before you change it. For *how* overriding works — the two override files, precedence, fail-closed, the `duet snippets` inspector — see the README's [Customizing the snippets](../README.md#customizing-the-snippets).

`snippets.toml` at the repo root is the source of truth; the bodies below are reproduced for reading. For the **live** body on your install — with any user/project overrides already applied — run `duet snippets show <key>`. A `{{skills_dir}}` token in a body is resolved to duet's vendored methodology skills at serve time (the worker sees a real path, not the token). The trailing `---` / `$0` in the review snippets is the paste-point convention from the source schema: `$0` is where the human's reviewer feedback lands.

## How snippets map to the arc

Each phase pulls a few snippets in the order the orchestrator reaches for them; the full protocol table (every snippet, both arcs, the direction of each hand-off) is in [`workflow-model.md`](workflow-model.md). The ones that matter most when customizing are the **generative drafts** — they write the *first* artifact of a phase, so an override reshapes everything downstream — and the **review** snippets that set each critique's altitude:

| Snippet | Arc · phase | Role it goes to | What it produces |
|---|---|---|---|
| [`write-spec`](#write-spec) | full · spec | implementer | the first spec draft |
| [`start-plan`](#start-plan) | full · plan | implementer | the implementation plan (vertical slices) |
| [`implement-direct`](#implement-direct) | rir · implement | implementer | code built straight from the research decisions |
| [`review-spec`](#review-spec) | full · spec | reviewer | spec critique (at spec altitude) |
| [`review-plan`](#review-plan) | full · plan | reviewer | plan critique |
| [`review-implementation`](#review-implementation) | full · impl | reviewer | code review |
| [`review-direct`](#review-direct) | rir · implement | reviewer | code review (no spec/plan to measure against) |

The full arc has no draft snippet for the implementation phase by design — the plan is the script, so the orchestrator composes the build prompt from it rather than from a template.

---

## The generative drafts

These three write the opening artifact of a phase. They carry duet's strongest opinions (a leader-facing spec summary; TDD-shaped, vertical-slice planning), so they're where customization pays off most. The [worked example](#worked-example-overriding-start-plan-to-a-non-tdd-methodology) below overrides `start-plan`.

### `write-spec`

```text
Now, write the spec to the location the framing's conventions name (where specs live is the project's call, not this template's). Ground problem and approach in actual code — read the relevant modules first if you haven't. **Tight prose beats exhaustive sections.**

**Open with a leader-facing summary.** The spec's first section reports the change the way you'd report it to your leader:
- What we're adding or fixing, in product terms — the feature, the bug, the problem it solves.
- The approach we're taking, and the scope of the change.
- The boundary once it lands: what's fixed, what isn't, and what's explicitly deferred (one-line why each).

Technical detail belongs in this section only when it makes the solution easier to digest or the problem easier to understand — context, not elaboration. Someone who reads nothing else should still know what they're getting and not getting.

**Structure the body around the flow of the change:**
- **Distinguish current vs. desired** — what's preserved vs. what's changing.
- **Name the coupling decision** — extension of an existing concept, or intentionally independent?
- **Name the foundation decision (preparatory refactoring).** Decide whether the existing code is a base the feature extends cleanly, or a structure that blocks the design you actually want. If it blocks, scope a *bounded* preparatory refactoring — reshape the foundation first so the feature becomes an easy add — as the opening move, sized to this feature, not a rewrite of the module, and name what you're deliberately leaving alone.
- **Use implementation anchors** (modules, functions, files) attached to the flow — not the main narrative.

A tree-style before/after often makes the change crisp — adapt the format (tree, prose, diagram) to what fits:

  Current:
    User submits form
    └─ Validation runs
       └─ Record saved
          └─ Confirmation shown

  Desired:
    User submits form
    └─ Validation runs
       └─ Record saved
          └─ Webhook fired
          └─ Confirmation shown

**Be concrete, not vague.** Vague verbs — "improve", "enhance", "polish", "better", "optimize", "streamline" and friends — name a *direction*, not a *decision*; they quietly defer the real choice to implementation, which defeats the point of writing a spec. Say **what** changes: the specific behavior, state, or outcome that differs, and the rule or shape that produces it. Concrete ≠ exhaustive, though — pin the decision, not the mechanics (no line-level edits or code). E.g. "improve error handling" → "on a failed webhook, retry with backoff, then surface a dismissible banner instead of failing silently."

The spec is a high-level implementation plan — technical content is fine, but stay at that level. **Don't smuggle in later-stage details:**
- **Skip** line-by-line edits, function renames, exact call-site changes — designed later.
- **No** doc update plans — later.
- **Testing:** name behaviors that matter at a high level; leave specific test cases, fixtures, and mocking boundaries for later.
- Phases are fine; **no precise commit order** — sequencing later.

**Do not include any time/effort estimates** ("2 days", "~3 hours"), describe the work itself.

If you have remaining product questions or major technical uncertainty, interview me before you write.
```

### `start-plan`

```text
Plan the implementation as vertical slices based on the latest spec. Reread the spec first.

Write this plan so that it is complementary to the spec, not overlapping. Don't re-summarize the spec's goals or re-argue its approach — point to it, and spend the tokens on the tactics it deferred (answer its open questions here). The relay that earns its tokens is a load-bearing gotcha, invariant, or constraint **bolded in the exact slice that must honor it** — surfaced at the point of action, where rereading the spec wouldn't put it in front of you.

Go detailed — name each slice, list specific test cases, sketch helpers and fixtures, cite line numbers for changes in existing code. **Don't pre-write full code bodies** — describe tests and helpers; actual code happens during red-green-refactor.

Read these as a lens, not a checklist (adapt; drop what doesn't fit):
- `{{skills_dir}}/tdd/SKILL.md` — vertical slices, what to test, anti-patterns
- `{{skills_dir}}/tdd/tests.md` — behavior-focused tests; `test.for`, `expect.soft`, custom matchers
- `{{skills_dir}}/tdd/mocking.md` — mock only at boundaries, never your own modules
- `{{skills_dir}}/tdd/interface-design.md` — testability via `test.extend` fixtures
- `{{skills_dir}}/tdd/deep-modules.md` — small interface, deep implementation; keeps the test surface small and tests stable across refactors
- `{{skills_dir}}/tdd/vitest-patterns.md` — Vitest APIs *(TS-Vitest projects only)*
- `{{skills_dir}}/improve-codebase-architecture/SKILL.md` — also informs designing well from the start

**What to test:** observable behavior through public interfaces and critical paths — not implementation details or every edge case. Skip UI tests unless requested; focus on pure business logic. Confirm with me if unclear.

**Slice = one meaningful unit — a subsystem or a cluster of related behaviors.** Be ambitious: group a behavior with the behaviors and wiring that belong with it into one slice a reviewer can grasp as a single idea — the mechanical steps that serve it (an import, mounting a component, wiring) ride in that slice, not slices of their own. Lean larger; split only when two parts are genuinely unrelated or a slice grows too big to hold in your head. Aim for deep modules (small interface, hidden implementation) — shrinks the test surface, keeps slices independently committable. **Prefer slicings that delete concepts** (branches, modes, helper layers disappear) over ones that just spread them. Commits follow slices — that's implied; don't engineer commit boundaries.

**Preparatory refactoring first, when the foundation blocks the design** (Kent Beck: *make the change easy, then make the easy change*). If the spec named a blocking foundation — or you find one now — make the first slice or two a behavior-preserving reshaping — kept green by existing tests, or, if that code isn't covered, pinned with a characterization test first — that lays the groundwork before the feature slices land on it. Refactor only what the feature actually rests on; a prep slice that balloons into a module rewrite is the failure mode, not the goal.

Strict red-green-refactor isn't required throughout — apply it inside a slice when design is uncertain or behavior is subtle and a failing test gives real signal. For straightforward slices, writing test + code together is fine. **The discipline is "one slice per commit", not keystroke order.**

Constraints:
- Follow the settled spec and the project's conventions. Tweak small details if exploration warrants; pause before challenging major direction.
- Skip doc updates — we'll do those after implementation.
- Commit per slice, not all at the end.
```

### `implement-direct`

The rir arc's only draft — it builds straight from the settled research decisions, since rir has no spec or plan.

```text
Build the change directly from the research decisions we settled — those decisions are the spec here; there is no separate spec or plan document.

Before writing code:
- **Re-read the research decisions and the cross-review notes**, so you build the agreed direction rather than a half-remembered version of it.
- **Re-read the code you're about to touch** — trace the real data/control flow and the existing patterns, so the change fits what's already there.

Then implement: work in small, coherent commits, and build the tests alongside the code — behavior through the public interface, at the right altitude, not internals. Run them as you go and keep them green. If a decision turns out wrong or underspecified once you're in the code, stop and flag it rather than guessing your way past it.
```

---

## The review snippets

Each review snippet gives the reviewer a deliberate **altitude lens** — what to critique and what to leave alone for that artifact's stage. Overriding one changes how hard, and at what level of detail, your reviewer pushes.

### `review-spec`

```text
I've drafted a spec. Review critically — verify problem statements and intended solutions against the actual code.

The spec is intentionally high-level: problem, UX goal, conceptual approach, non-goals, open questions. It IS moderately technical (can name modules, functions, composition patterns) but **defers line-level details, test design, doc plans, and commit order** — those come later.

**Altitude lens:**
- Vagueness on implementation details (signatures, helper internals, specific test cases) → **intentional, don't ask for more**.
- Vagueness on concepts the spec should answer (data flow, ordering, failure modes, scope, edge cases, current vs. desired distinction, coupling to existing concepts) → **bug, flag it**.
- Technical content the spec DOES propose (names, placement, composition, boundaries) → **fair game; propose better if awkward**.

**Push hard on:**
- Are we solving the right problem? Is the UX goal right?
- Does the conceptual approach hold up: data flow, state, ordering, failure modes, performance, backward compat, migrations?
- Spec ↔ code mismatches.
- Cleaner alternative approaches.
- **Foundation & preparatory refactoring:** is the feature being bolted onto a structure that can't hold it (a missing prep step), or is a proposed cleanup disproportionate to the feature (scope creep)? Flag either.
- Non-goals + open questions: anything in-scope that should defer? Anything missing from the uncertainty list?

**Per point:**
- Agree → add technical suggestions, caveats, or risks worth flagging.
- Disagree → give reasons and a concrete alternative. If architectural, say so and propose the structural fix.

Weigh technical merit and UX goals together. **Challenge assumptions and propose alternatives** — don't default to politeness. Don't say "not specific enough" without naming the unanswered concept.

---

$0
```

### `review-plan`

```text
I've drafted an implementation plan. Review with the same rigor as the spec.

Background (skim as a lens, don't recite):
- `{{skills_dir}}/tdd/SKILL.md` — vertical slices, behavior-focused tests, when to mock
- `{{skills_dir}}/improve-codebase-architecture/SKILL.md` — deep modules, seams, the deletion test

**Adapt; drop what doesn't fit our use case.**

**Altitude lens:**
- Vagueness on full code bodies (test implementations, function bodies) → **intentional, don't ask for them**.
- Vagueness on anything else — slice boundaries, sequencing, specific test cases, helper internals, fixture shape, line-level placement, module shape, integration seams, what the spec left open → **bug, flag it**.
- Technical content the plan DOES propose — slice choice, test cases, helper design, names, composition, deep-module shape → **fair game; propose better if a slice is wrong, a test case missing, a helper awkward, sequencing off, or a module shallow**.

**Per point:**
- Agree → add technical suggestions, caveats, or risks worth flagging.
- Disagree → give reasons and a concrete alternative. If architectural, say so and propose the structural fix.

Challenge sequencing, scope, choice of vertical slices, **whether the plan deletes complexity or just rearranges it**, **whether the resulting modules are deep or shallow**, and **whether any preparatory-refactoring slice is proportionate to the feature, not quietly a rewrite** — not just surface details. The right plan should feel inevitable. Don't default to politeness.

---

$0
```

### `review-implementation`

```text
Code-review my implementation. **Read the actual code, not just commit messages.**

**Lens:**
- Implementation is fair game across the board — correctness, structure, test quality, performance, readability, edge cases, pattern consistency.
- Plan ↔ code mismatches → flag silent deviations (missing planned tests, missing helpers, scope creep).
- Spec/plan are settled — **don't relitigate approved decisions**. If a fundamental issue only surfaces from the code, say so explicitly; don't smuggle it in as a "small fix."

**Evaluate:**

- **Correctness** — bugs, edge cases, failure modes.
- **Solves the problem** — does the implementation actually solve the spec's problem, not just pass its own tests?
- **Test quality** — right altitude (behavior, not internals), covers planned cases + obvious additions, survives plausible refactors, uses project patterns.
- **UX & performance** — user-facing impact, performance characteristics.
- **Structural quality — be ambitious, not just local:**
    - **Code-judo:** is there a reframing that makes whole branches, helpers, modes, conditionals, or layers disappear entirely — not just rearranges them? Don't stop at "this could be a bit cleaner."
    - **Spaghetti growth:** ad-hoc conditionals or special cases bolted into unrelated flows = design problem, not a stylistic nit. Push the logic behind its own abstraction.
    - **Thin abstractions:** pass-through wrappers, identity helpers, abstractions that add indirection without buying clarity — flag them.
    - **Boundary cleanliness:** casts, `any`, `unknown`, optionality papering over unclear invariants — push for an explicit contract.
    - **Canonical layer:** is the logic in the right module/package, or leaking across boundaries? Prefer existing canonical helpers over near-duplicates.

**Per issue:**
- Severity: **critical** (blocks merge) / **moderate** (fix before merge) / **minor** (nice-to-have).
- Concrete fix with file/function references and enough detail to act on.
- No "this could be cleaner" without a concrete alternative.

**Approval bar:** don't pass because it works. Structural regressions and missed code-judo opportunities are presumptive blockers — flag as **critical**, not minor.

Implementation report below — treat it as a starting point: the implementer's pointers to reduce your overhead, not the boundary of your review. Review the whole feature against its actual goal, and actively look for what the report leaves out; if you only check what the implementer surfaced, it isn't an independent review.

---

$0
```

### `review-direct`

The rir counterpart to `review-implementation` — the bar is the settled research decisions, not a spec or plan document.

```text
Code-review this implementation. **Read the actual code, not just commit messages.**

There's no spec or plan for this arc — the bar is the **research decisions we settled and the actual goal behind them.** Review against those, not a document.

**Lens:**
- Everything is fair game — correctness, structure, test quality, performance, readability, edge cases, pattern consistency.
- Decisions ↔ code mismatches → flag where the build drifted from what we agreed. If a decision turns out wrong now that it's real code, say so explicitly; don't smuggle it in as a "small fix."

**Evaluate:**
- **Correctness** — bugs, edge cases, failure modes.
- **Solves the problem** — does this achieve the goal behind the decisions, not just run?
- **Test quality** — right altitude (behavior, not internals), covers the real cases, survives plausible refactors, uses project patterns.
- **UX & performance** — user-facing impact, performance characteristics.
- **Structural quality — be ambitious, not just local:** look for a reframing that deletes whole branches/helpers/modes, not just rearranges them; push ad-hoc conditionals and special cases behind their own abstraction; flag thin pass-through wrappers and casts/`any`/`unknown` papering over unclear invariants; keep logic in its canonical module rather than leaking across boundaries.

**Per issue:** severity — **critical** (blocks ship) / **moderate** (fix before ship) / **minor** (nice-to-have); a concrete fix with file/function references; no "this could be cleaner" without a concrete alternative.

**Approval bar:** don't pass because it works — structural regressions and missed reframings are presumptive blockers, flag them **critical**.

Implementation handoff below — a starting map, not the boundary of your review. Review the whole change against its actual goal, and actively look for what the handoff leaves out; if you only check what was surfaced, it isn't an independent review.

---

$0
```

---

## Worked example: overriding `start-plan` to a non-TDD methodology

duet's shipped `start-plan` ([above](#start-plan)) plans the work as **test-first vertical slices** and cites duet's vendored TDD skills. Suppose you don't work that way — you'd rather build a **walking skeleton** first (a thin end-to-end path through every layer, stubs allowed), then flesh it out slice by slice, verifying by *running the system* rather than test-first. That's a whole-snippet override.

Drop this into your **user** override file, `~/.config/duet/snippets.toml` — a personal methodology preference applies across every project. (Put the identical block in a repo's `.duet/snippets.toml` instead to scope it to that one project — e.g. a repo that genuinely isn't test-first.)

```toml
# ~/.config/duet/snippets.toml
[[snippets]]
key = "start-plan"
expand = '''
Plan the implementation as a **walking skeleton, then incremental slices**. Reread the spec first.

Start with the thinnest end-to-end path that exercises the whole architecture — the smallest version that runs from entry point to output through every layer the feature touches, even if each layer is a stub. That skeleton is slice 1: it proves the seams connect before any layer is filled in.

Then plan the remaining work as incremental slices that flesh out the skeleton one capability at a time, each leaving the system runnable. For each slice name:
- the capability it adds,
- the files/functions it touches (cite line numbers for existing code),
- **how you'll verify it by running the system** — the command, the input, and the observable output — not a unit test.

Manual/integration verification is the default here; reach for an automated test only where a behavior is subtle enough that running it by hand won't catch a regression.

Constraints:
- Follow the settled spec and the project's conventions.
- Skip doc updates — we'll do those after implementation.
- Commit per slice, keeping the skeleton runnable at every commit — not all at the end.'''
```

The override replaces `start-plan`'s **entire** body — there's no partial merge — so the TDD citations and red-green-refactor language are gone, and the plan phase now reasons in walking-skeleton terms while keeping the slice-and-commit discipline. Every other snippet is untouched.

Confirm it landed:

```console
$ duet snippets | grep start-plan
start-plan        user

$ duet snippets show start-plan      # prints the effective (overridden) body
```

If you mistype the key (say `start_plan`), the next `list_snippets`/`duet snippets` fails closed, naming the file and the bad key — an override can only *replace* an existing snippet, never add one.

## Before you override: the safety-coupled snippets

The override surface is unrestricted on purpose — every key is overridable. But a few snippets are load-bearing for duet's safety machinery, and a weaker version quietly weakens the guardrail: `consultant-contract` / `consultant-verify` (the acceptance-contract pair a fresh session checks before the Ship gate) and the gate-adjacent prompts (the severity wording the consultant assigns, the `implementation-handoff` that frames the final review). The *structural* gates are code and can't be forged from a prompt — an override can't make an agent cross a human gate — but it can erode the **quality of the signal** that feeds a gate decision. Override those knowingly. The README's [Customizing the snippets](../README.md#customizing-the-snippets) carries the full guidance and the framing-seam boundary (a snippet override customizes the *tool*, never tells duet about your *project* — that's the framing's job).
