# Phase-scoped bindings — the binding vocabulary's altitude debt

**Status:** analysis + proposal, not yet built. Forward-looking; nothing here is live.
**Motivating run:** the PR6 relay run `20260703-1500-e035` (worktree `~/dev/.worktrees/main/feat/loopy-infra-pr6`) — the first hand-configured relay criss-cross, and the run that exposed the friction below **(observed)**.
**Touches:** `src/config.ts` (the binding resolver + parse paths), `src/phases.ts` (the composition vocabulary it's measured against), `src/roles.ts` / `src/providers/` (the worker roster). **Does not touch the statechart** — see §"What is already right".

---

## The claim

The `645fb9e` "Workflow vocabulary" refactor lifted **phase composition** to a per-phase vocabulary — each phase names its own block and knob values, and its snippets are *derived* from them (`src/phases.ts:111-233`). In the same commit, **bindings** stayed role-scoped with a single binary band: a role runs its base binding, or — for phases strictly after the arc's one handoff gate — its `build` override (`src/config.ts:119-126`).

So two configuration vocabularies now sit at different altitudes inside one system:

| | Resolution along the phase axis | Where it lives | Who chooses the split |
|---|---|---|---|
| **Arc composition** (`block`, `artifactKind`, `entrySeed`, `reviewPosture`, `buildTailOwner`, `finishOwner`, `consultantCheckpoint`, …) | **per-phase** — a distinct value at every phase | registry (`src/phases.ts`) | the phase row |
| **Provider/model binding** | **2 bands** — base, then post-handoff `build` | config tier (`src/config.ts` / `~/.config/duet/config.toml`) | nobody — the split is `handoffGate`, an arc constant |

The two axes meet at exactly one point: `handoffGate`. That single shared seam is the debt. The binding vocabulary is not wrong for being *role*-keyed — a role is a sound protocol concept. It lags because its **phase resolution is 2 and its split point is not selectable**, while everything adjacent to it resolves to N and is chosen per phase.

This tension is **not** currently tracked in `docs/open-questions.md` or `docs/future-directions.md`. The nearest neighbor, "External arc definitions" (`docs/future-directions.md:36`), proposes user-authored *composition* and explicitly keeps bindings in the config tier; it does not raise per-phase bindings. This document is the missing analysis.

---

## The motivating run (observed)

To make relay do the thing relay exists to do — plan/design on one provider, build on another, criss-crossed between the two workers — we hand-assembled this into the global `~/.config/duet/config.toml` and froze it into `20260703-1500-e035`'s `state.json` **(observed)**:

```toml
[roles.implementer]
provider = "claude"
model    = "claude-fable-5"          # frame + design
build    = "claude:claude-opus-4-8"  # implement (post-handoff)

[roles.reviewer]
provider = "codex"                   # frame + design
build    = "claude:claude-fable-5"   # post-handoff fixes + docs/PR
```

Three frictions surfaced, and each traces to the altitude mismatch, not to a local bug:

1. **The mental model is phase-first; the config forces a role-first translation.** The natural sentence is "codex frames and designs, then GPT builds, with the reviewer switching to Fable to fix." Expressing it means splitting that per-phase intent across two `[roles.*]` tables and reasoning about which side of `handoffGate` each line lands on.
2. **The CLI surface is asymmetric.** `--impl-model` sets the implementer's post-handoff binding; there is **no equivalent flag for the reviewer** — its `build` override is config-file-only (`src/config.ts` parses `[roles.reviewer].build`; no CLI path writes it). A user who set everything else by flag still has to drop to a config file for that one line.
3. **The consultant's binding couldn't ride the same grammar.** The framing's `consultant: on` binds only the *default* claude consultant (`src/config.ts:423-427`); choosing its model needs yet another surface (`--consultant` / `[roles.consultant]`). The run's consultant ran on Opus 4.8 not by choice but because the toggle can't express a choice.

None of these is fatal — the run is correctly configured and live. But they are the felt shape of a vocabulary that is one notch coarser than the intent it's asked to carry.

---

## Decomposing the ask (the trap)

The instinct "make it phase-based instead of role-based" is right in direction but hides **three asks at three very different costs**. A worked example — "codex frames/designs, GPT implements, and a Fable worker runs a parallel implementation-design pass" — separates them:

| Ask | What it actually is | Expressible today? | Cost |
|---|---|---|---|
| Codex frames/designs, GPT builds | **Temporal rebind** of one existing worker voice across the handoff | *Almost* — this is what `build` does; blocked only by coarseness (one fixed split) and the codex-has-no-model-key wrinkle | Low–moderate — an axis that exists, under-expressive |
| Reviewer switches provider for the fix tail | Same, on the other worker | Yes (config-file `build`), but no flag | Low (ergonomic) |
| A **parallel** Fable worker during design | **A new concurrent worker scoped to one phase** | **No — structurally impossible, deliberately foreclosed** | High + contested |

The first two are expressiveness gaps in an axis that already exists. The third is categorically different: it is not rebinding a role, it is *adding a worker that exists only in one phase*. The vocabulary cannot express it because the roster is closed and phase-independent:

- `Role` / `WorkerRole` are closed unions (`src/config.ts:21`, `src/providers/types.ts:13`); widening them is a source edit.
- The per-phase worker *set* is enumerated from **bound roles, never from phase composition** — `workerRolesFor(state)` takes no phase argument (`src/roles.ts:216-220`), and `createWorkers` builds a fixed `{implementer, reviewer, consultant?}` literal (`src/providers/index.ts:32-52`).
- `effectiveBindingFor` only ever **replaces** one role's binding for later phases; it never yields two concurrent bindings for one voice (`src/config.ts:119-126`).

And it is a **recorded product decision**, not an oversight: `docs/future-directions.md:49` ("Third *specialist* worker role — considered, not pursued… specialization belongs in snippets, not roles"). So the third ask is not vocabulary debt; it is the two-role-legibility stance, and it belongs to a different conversation. **Collapsing all three under "phase-based bindings" would over-scope the refactor into a product reversal.** This document scopes to the first two.

---

## Code smells (grounded)

1. **`build` / `impl` / `--impl-model` is a point-solution name, generalized halfway.** The mechanism generalized — any worker role can carry `build`, a provider switch is allowed (`src/config.ts:44-58`) — but the *name* stays fused to the one use case (the build phase), and comments concede the history: `impl` is "the pre-generalization spelling" (`src/config.ts:53-56`). The CLI generalized even less: only the implementer got a flag (`--impl-model`, `src/config.ts:374-383`; `src/cli.ts:305-308`). The reviewer asymmetry in the motivating run is the direct symptom.

2. **The binding phase-axis is one branch — `isPostHandoffPhase ? override : base`** (`src/config.ts:122`). This single expression *is* the altitude mismatch. There is one seam and its position is not a free variable.

3. **`handoffGate` is overloaded across three responsibilities**, coupling the binding split to unrelated concerns:
   - (a) interactive→headless orchestration handoff (`src/harness/lifecycle.ts:788`),
   - (b) the binding-band split (`src/config.ts:122`, via `isPostHandoffPhase` at `src/phases.ts:1065`),
   - (c) the AFK watch-hint label (`handoffWatchLabel`, `src/phases.ts:1031`).
   The aliasing is deliberate (`src/phases.ts:1058-1064`), but it is exactly what prevents a model change at any phase that is *not* the handoff. Notably, contract timing was **not** left on this seam — it rides its own knob, `consultantCheckpoint: 'contract'` → `contractAuthorPhaseOf` (`src/phases.ts:1311-1313`). That is the template smell #3 should copy.

4. **Four parse paths for one concept.** `parseProviderModel`, `parseBuildField`, `parseRoleOverride`, `parseImplOverride` (`src/config.ts:163-282`) plus `impl`/`build` alias reconciliation — all parsing "a binding spec," accreted around the override's growth.

---

## What is already right (do not break these)

The refactor should be smaller and lower-risk than "make it phase-based" implies, because the load-bearing machinery already leans the right way:

- **`effectiveBindingFor` is the single "who runs this turn" resolver, and its signature is already `(bindings, role, workflow, phase)`** (`src/config.ts:119`). Phase is *already threaded* to every caller — stats, session identity, provider construction, and the tool surface all resolve through it. The change is to the resolver's **body** (`? a : b` → a phase-keyed lookup) and its **data model**, not the plumbing.
- **Absent override ⇒ byte-for-byte identical to today.** The whole design keys "unconfigured" off *absence*, not a sentinel (`src/config.ts:111`). Any phase-scoped model must preserve this: an absent phase map resolves exactly as today.
- **The precedent for de-aliasing already exists.** Contract timing on its own `consultantCheckpoint` knob (not `handoffGate`) proves duet's pattern for "give a concern its own per-phase axis."
- **The statechart is not the debt.** Bindings are resolved at turn-dispatch, orthogonal to the xstate machine, which only knows phases/gates/rounds. A binding-vocabulary generalization needs **no statechart change** — a correction to the original framing's instinct to refactor the state machine.

---

## Proposal

Three tiers, deliberately unbundled so the cheap wins don't wait on the contested one.

### Tier 1 — close the ergonomic gaps (no resolver or registry change)

- Give the reviewer a flag symmetric with `--impl-model` (e.g. `--reviewer-build`), or replace both with one `--<role>-build provider[:model]` grammar. Removes the motivating run's asymmetry.
- Resolve or document the codex-has-no-model wrinkle so "GPT builds" versus "codex default builds" is expressible, not accidental.
- Surface a run's frozen bindings (`duet stats` or a `duet config show`), so "which binding did this run freeze?" is legible — the exact question the `e035`-vs-`717d` confusion raised **(observed)**.

This closes most of the *felt* awkwardness without touching the 2-band model.

### Tier 2 — lift bindings to per-phase resolution (the real fix)

Replace the binary band with a sparse per-phase override map layered over the per-role base. The resolver becomes a lookup:

```
effectiveBindingFor(bindings, role, workflow, phase):
    base ← bindings[role]
    override ← bindings[role].phaseOverrides?[phase]   # sparse; absent ⇒ base
    return override ?? base
```

Config stays pure role→provider binding — no workflow semantics leak in, so the config-scoping rule (`src/config.ts:8-14`: "role→provider/model bindings AND billing posture — and nothing else") still holds. A sketch:

```toml
[roles.implementer]
provider = "codex"                    # base: frame + design

[roles.implementer.phases.implement]
provider = "codex"
model    = "gpt-5"                     # or however codex names it
```

`build` becomes the special case it always was — sugar for "override at every post-handoff phase" — and can remain as a compatibility alias. This lifts the binding vocabulary to the composition vocabulary's altitude and **dissolves the `handoffGate` overload for bindings**: the band split stops being implied by an unrelated seam and becomes explicit per-phase data (the `consultantCheckpoint` pattern).

### Tier 3 — phase-scoped concurrent workers — out of scope

The parallel-Fable-worker ask. It breaks two-role legibility, touches ~6 roster sites (`WorkerRole`, `WorkerProviders`, `createWorkers`, `workerRolesFor`, `POLICY`, `DEFAULT_CLAUDE_MODEL`), and reverses a recorded product decision (`docs/future-directions.md:49`). It is a *product* question, not a syntax one, and must not ride the binding refactor.

---

## The one real decision

Tier 2's only genuine design question is **where the phase axis physically lives**:

- **Config tier grows a phase axis** (`[roles.<role>.phases.<phase>]`, as sketched). Keeps bindings out of the registry, honors "criss-cross is config-tier, not registry" (`docs/automation-design.md:261`), and preserves the config-vs-registry separation. Cost: the config surface gains a nesting level.
- **Registry carries a per-phase default binding**, config overrides it. Puts phase-keyed intent next to the phases it describes, but pulls compute/billing posture into the workflow registry — against the current scoping rule.

The config-tier option is the cleaner default: a per-phase binding is still *only* a role→provider binding, just at finer granularity, so it stays within the config's remit while the registry stays about workflow semantics.

---

## What would settle it / next steps

- **More criss-cross runs.** Tier 2 earns its complexity only if real runs want a split that the 2-band model can't express — e.g. a distinct model at `design` versus `frame`, not just pre/post-handoff. If every real configuration is still a clean pre/post split, Tier 1 is the whole fix and Tier 2 stays a sketch. The relay arc's first live runs (`docs/open-questions.md` §"Settled, still watched" → the relay entry) are the evidence stream to watch.
- **A one-line pointer in `docs/open-questions.md`** so the tension is tracked, not just captured here. Proposed section name: "Phase-scoped bindings" — belief now: the 2-band model covers today's criss-cross; open until a run wants a split it can't express.
- **Tier 1 is safe to land opportunistically** ahead of any decision — it's additive CLI + read surface, no behavior change to existing runs.
