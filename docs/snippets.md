# Snippet reference

Snippets are the prompt templates the orchestrator sends the workers — they *are* the workflow. This doc is the **map**: which families exist, which ones repay an override, and the design principles a rewrite must not break.

**The bodies live in two places, and neither is here.** `snippets/` at the repo root is the source of truth — block-named TOML files mirroring the workflow vocabulary. To read a body as *your install* serves it, with any override already applied:

```console
$ duet snippets              # every key, and the layer it resolves from
$ duet snippets show <key>   # one full body
```

Reproducing the bodies here would make a second source of truth that drifts from the first the next time a snippet is tuned — so it doesn't. For *how* overriding works — the two override files, precedence, fail-closed — see the README's [Customizing the snippets](../README.md#customizing-the-snippets).

Two conventions you'll meet in any body: a `{{lessons_dir}}` token resolves to duet's vendored methodology lessons at serve time (the worker sees a real path, never the token), and a trailing `---` / `$0` marks the paste point where accompanying material — a handoff report, review feedback — lands.

## Families

Blocks own their snippet families, so the library's shape is the workflow vocabulary's shape:

```
snippets/
  frame.toml       the divergent opening — parallel analysis, then synthesis
  doc-spec.toml    the spec loop: draft, review, update (+ the round-2 -again pair)
  doc-plan.toml    the plan loop: the same shape, one altitude finer
  build.toml       entry seeds, the midpoint checkpoint, each review posture's loop, the tails
  finish.toml      the PR description, and the run's closing compaction
  anytime.toml     cross-cutting helpers reachable in any phase
  consultant.toml  the optional advisor's checkpoint prompts
```

A phase's snippet list is **derived** from its block and knobs, never hand-listed — so a workflow that composes `doc('spec')` gets the spec family automatically. `list_snippets` shows the orchestrator only the current phase's set plus the anytime helpers; `duet snippets` prints the whole inventory.

## The snippets worth overriding

Two kinds carry the most leverage. The **generative drafts** write the first artifact of a phase, so an override reshapes everything downstream. The **review lenses** set each critique's altitude — the discipline that stops a loop re-litigating what its artifact deliberately defers.

| Snippet | Phase | Duty | What it produces |
|---|---|---|---|
| `write-spec` | spec (every document-bearing workflow) | architect | the spec draft — product tier on top; module shape, target shape, and test standards below |
| `start-plan` | plan (full) | architect | the implementation plan: vertical slices, cases, fixtures, line anchors |
| `implement-spec` | implement (blueprint, relay) | builder | code built from the committed spec, sliced by the builder |
| `implement-direct` | implement (short) | builder | code built straight from the research decisions |
| `reconcile-docs` | implement (every workflow) | builder · relay's judge | docs reconciled with what shipped, then committed |
| `review-spec` | spec | analyst | spec critique, section-scoped: product tier at product altitude, technical tier at design altitude |
| `review-plan` | plan | analyst | plan critique — cases, fixtures, and line anchors are fair game |
| `review-implementation` | implement (full, blueprint) | critic | code review, then a reflect-and-respond round |
| `review-direct` | implement (short) | critic | one writable round; the builder applies the fixes in place |
| `review-and-fix` | implement (relay) | judge | the same lens, plus the authority to fix what it finds |

full has no draft snippet for its build phase: the plan *is* the script, so the orchestrator composes the build prompt from it. Every other workflow seeds the build from a template, because no plan exists there.

Each review snippet also ends with an **"Optional polish"** output contract — wording-level fixes batched as exact before → after replacements, or skipped when none qualify — so the author applies them without re-analyzing the document, and substantive findings stay findings.

**An override changes prose, never behavior.** Round counting and write authority key on a snippet's *tag* through `ACTION_CATALOG` (a code map beside the registry), not on anything in the body — so rewriting `review-and-fix` cannot grant or revoke a duty's write access, and rewriting `review-spec` cannot change what counts as a review round.

## The mindset gradient — a design principle to preserve

The library deliberately trades efficiency for the *mindset each phase needs*, and the gradient across a run is the architecture:

```
frame diverges  →  doc loops converge  →  the build executes
```

- **Frame diverges.** `think-holistic` demands two or three genuinely different bets so they stress-test each other; `compare-notes` synthesizes two independent, anonymized analyses — Delphi-shaped, so neither author anchors the other.
- **Doc loops converge.** Round 2 is explicitly "about converging", and the altitude lenses stop a loop re-diverging below its artifact's tier. The one divergent move inside a converging stage is deliberate and confined to a *drafting* turn: `write-spec` sketches three interfaces before committing to one, and the document records the winner, not the menu.
- **The build executes** — "execute the design; don't re-decide it."

Several snippets carry named elicitation frameworks tuned to their task: the rabbit-holes hunt and design-it-twice in `write-spec` (find what could quietly eat the build; arrive at an interface rather than settling for the first one), the pre-mortem in `review-spec` / `review-plan` / `consultant-contract` (prospective hindsight surfaces risks that reading forward misses), red-team-the-tests and definition-of-wrong in `consultant-contract`, answer-first (BLUF) structure in `ceo-summary`, the strategic step-back opening every code-review lens in `review-implementation` / `review-direct` / `review-and-fix` (the reviewer's local-optimum bias: ask whether a reshape dissolves the problem before endorsing the local patch), and Chesterton's fence in `review-and-fix`.

When revising a snippet, match its phase's mindset. An "optimization" that collapses frame's exploration into one recommended answer, or re-opens divergence inside a converging round, is a regression even when it reads tighter.

### What the reading list encodes

The methodology snippets cite duet's vendored lessons, and **read depth is a decision, not a union**: read a lesson deeply where its decisions get made, skim its `## The bar` where they are only constrained. `write-spec` reads the design lessons closely — it commits the module structure, the interfaces, and the seams — and skims the testing bars, because it names *which* behaviors matter and what gets faked where, not how to write the tests. `start-plan` and the build seeds invert that. A snippet that cites everything has stopped deciding.

## Beyond the phase snippets

**Anytime helpers** (`snippets/anytime.toml`) are reachable in any phase and shown in full by `list_snippets` — `reread-context` (reread the touched code before continuing), `recover-context` (the post-compact fresh-session re-anchor, prescribed when a `/compact` is killed and the worker's session resets — `automation-design.md` §"Resilience for the AFK window"), `compact-inflight` (the mid-work compaction: where the boundary compacts keep what the *next* stage consumes, this one keeps the in-flight state), and a handful of investigation aids. They aren't customization targets.

**Consultant prompts** (`snippets/consultant.toml`) are enabled only when a consultant is bound, and a run sees only the checkpoints its own workflow fires (`automation-design.md` §"Consultant checkpoints"). An unbound run's snippet surface reads byte-for-byte as if they didn't ship.

## Worked example: overriding `start-plan` to a non-TDD methodology

duet's shipped `start-plan` plans the work as **test-first vertical slices** and cites duet's vendored design and testing lessons (`duet snippets show start-plan` to read it). Suppose you don't work that way — you'd rather build a **walking skeleton** first (a thin end-to-end path through every layer, stubs allowed), then flesh it out slice by slice, verifying by *running the system* rather than test-first. That's a whole-snippet override.

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

If you mistype the key (say `start_plan`), the next `list_snippets` / `duet snippets` fails closed, naming the file and the bad key — an override can only *replace* an existing snippet, never add one.

## Before you override: the safety-coupled snippets

The override surface is unrestricted on purpose — every key is overridable. But a few snippets are load-bearing for duet's safety machinery, and a weaker version quietly weakens the guardrail: `consultant-contract` / `consultant-verify` (the acceptance-contract pair a fresh session checks before the Ship gate) and the gate-adjacent prompts (the severity wording the consultant assigns, the `implementation-handoff` that frames the final review). The *structural* gates are code and can't be forged from a prompt — an override can't make an agent cross a human gate — but it can erode the **quality of the signal** that feeds a gate decision. Override those knowingly. The README's [Customizing the snippets](../README.md#customizing-the-snippets) carries the full guidance and the framing-seam boundary (a snippet override customizes the *tool*, never tells duet about your *project* — that's the framing's job).
