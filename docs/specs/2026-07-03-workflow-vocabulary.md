# The workflow vocabulary — arcs as expressions

**Status: direction settled 2026-07-03; code not started.** The stage-0 document for duet's repositioning: the shipped arcs become *expressions in a small composition vocabulary*, and a fourth arc (working name **relay**) ships as the vocabulary's first proof. Cross-checked 2026-07-03 by an independent GPT-5.5 design pass over the same problem (blind to this doc, compare-notes after); its valid deltas are folded in below — notably the two-owner tail split, the write-authority resolver, provider-qualified session ids, and the action catalog. Written deliberately ahead of the comprehensive doc pass — the doc-debt ledger at the bottom is the explicit IOU (docs-lead requires the divergence be recorded, never silent). Scope is the big picture: the repositioning, the grammar/vocabulary split, the block inventory, the relay arc, and the one-PR plan. Per-module detail stays in the code and lands in `docs/engineering.md` at the doc pass.

## The repositioning

duet today positions as three opinionated workflows distilled from one developer's practice. The expanded view: duet is a **workflow composition vocabulary with an opinionated standard library**. The primitives are phase blocks with named knobs; the shipped arcs are pre-built expressions served as defaults; as the project grows, the default family grows — and eventually users compose their own.

Deliberately **not** "an orchestration engine": a neutral engine is a commodity. What differentiates duet is the opinions — snippets distilled from an observed corpus, altitude lenses, the gate discipline, the trust gradient. The vocabulary exposes those opinions as composable units; it never commoditizes them into free-form prompt config.

What this amends in the product goals: "personal tool first" softens toward "opinionated defaults, built for publication" — the `future-directions.md` "OSS-ification: not pursued" entry is superseded. What does **not** change: augment-never-lock-in, the human owns substance, semi-AFK, no daemon, framing as the single project-knowledge seam, exactly two providers.

## Grammar vs. vocabulary

The split that keeps composition safe. duet's safety story lives in structure that no composition can reach.

**Grammar — fixed rules of the language, never composable:**

- Every phase exits through a human gate; only `human.*` crosses; `advance_phase` parks, never crosses.
- Cooperative pause; the terminal-marker discipline; state-file-is-a-hint.
- One branch per run, fixed before the first worker prompt.
- Framing is the single seam for project knowledge.
- The orchestrator does triage, never substance; it is read-only by tool surface.
- Prompts are duet-authored. The per-key snippet override layers remain the one sanctioned prompt-customization channel; composition selects and arranges blocks, it does not author prose.

`machineFor` already builds any phase list into the same loop/flag/gate idiom, so the grammar is composition-independent by construction — a composed arc cannot compose its way past a gate.

**Vocabulary — the composable inventory, closed by rule:** a knob value exists only when duet ships hand-written prompt support for it (brief fragments + snippets) *and* a shipped arc exercises it. Load-time validation (the `validateRegistry` pattern, extended) rejects a composition that uses an unsupported combination. Speculative knobs — parameterizing anything that doesn't vary across the shipped arcs — are refused on sight; every vocabulary entry is earned by an arc that ships.

## The vocabulary, derived from the four instances

Blocks and knobs, exactly as the four arcs need them — no more:

```
blocks:    frame · doc-loop · build · finish

frame:     (fixed machinery: think-holistic to both workers → compare-notes
            synthesis; consultant joins as anonymized third peer when bound)

doc-loop:  artifact kind (spec | plan | design) — sets lens + snippets
           round cap
           contract-author placement (early | late | none)

build:     entry seed (compact-for-impl | implement-design | implement-direct | fresh-seed)
           review posture (critique | writable | fixer)
           round cap · midpoint (judgment | none) · verify checkpoint (on | off)
           build-tail owner (reconcile-docs + ceo-summary — inside implement,
           always strictly before verify) (implementer | reviewer)

finish:    finish owner (pr-description + PR open) (implementer | reviewer)

run tier:  per-stage bindings (a post-handoff override per worker role,
           provider switch allowed) · gate posture (gates_at / gateless) ·
           consultant binding
```

The two tail owners are deliberately **separate knobs** (`buildTailOwner`, `finishOwner`) even though relay sets both to the reviewer: "the finishing tail" as one concept would blur the phase boundary — reconcile-docs and ceo-summary are the tail of *implement* (before Ship, before verify), pr-description and the PR open are *finish* — and collapsing them risks moving verify ahead of a later mutating turn.

The arcs as expressions:

```
full   = frame · doc(spec, cap 3) · doc(plan, cap 3, contract-early) · build(critique, cap 3, verify) · finish
design = frame · doc(design, cap 2, contract-late) · build(critique, cap 3, verify) · finish
rir    = frame · build(writable, cap 1, no doc) · finish
relay  = frame · doc(design, cap 2, contract-late) · build(fixer, verify, codex impl) · finish(reviewer)
```

**Review posture** is the vocabulary's load-bearing new axis, naming what today is implicit in snippet lists and briefs: `critique` (reviewer critiques, implementer fixes — full/design), `writable` (one round, implementer applies in place — rir's `apply-review`), `fixer` (new: the reviewer applies fixes directly and owns the finishing tail).

## The relay arc

The fourth default arc, for the plan-smart / build-cheap / judge-strong economy (per the 2026-07-03 discussion; the motivating pattern is stage-scoped model cost — expensive judgment at the ends, fast labor in the middle, and a judge that acts rather than filing critiques back).

- **Shape**: design's arc with two substitutions — the build's review posture is `fixer`, and both tail owners move to the reviewer: the build tail (reconcile-docs, ceo-summary — inside implement, still strictly before verify) and the finish phase (pr-description, PR open). Same handoff gate (design), same default posture (attend the Design gate only), same contract-late + verify checkpoints.
- **Bindings criss-cross at the handoff** (config-tier, not registry): planning runs implementer=claude (e.g. Fable) vs reviewer=codex (the cross-family alt-planner voice at frame and the design loop); post-handoff the implementer's override switches it to codex (the fast builder) and the reviewer's override switches it to claude (the strong judge-fixer).
- **Session reset at the handoff**: a provider-switched role drops its session id and its first post-handoff prompt seeds a fresh session — the committed design doc is the re-anchor (already the design's compaction rule). For a fresh builder the entry seed replaces `compact-for-impl`. Accepted cost: the judge never saw the planning loop; the committed doc is its authority.
- **The fixer's discipline** is a new snippet (working name `review-and-fix`): `review-direct`'s full lens plus `apply-review`'s assess-validity/fix-in-place/push-back-with-reasons discipline, addressed to the reviewer, with four guardrails — don't dismiss code because it looks wrong (understand what the implementer was doing first), review against the settled design's intent, report fixes + push-backs grounded in commits, and the **escalation valve**: fix ordinary valid issues directly, but a product/design disagreement, unclear intent, or broad directional drift in the build escalates (via the orchestrator, `ask_human`) rather than being patched over — direct fixing must never hide a pivot. Self-fix is the default, not an absolute. `implementation-handoff` **stays with the builder** — whoever wrote the code authors the map.
- **Verify still runs, and matters more here**: under `fixer` the maker-vs-critic adversariality collapses into a sequential build-then-judge, and the reviewer grades work it then edits. The consultant's contract verify (fresh session, neither builder nor fixer) becomes the one fully independent pass — relay's CLI/status copy should strongly recommend a consultant binding (recommend, not force). The verify self-heal routes failures to the **fixer**, not the implementer; the independent re-verify chain is unchanged. The escalation valve lives in the snippet and the phase brief; rails stay structural only (may-write, `verifiedAt` invalidation, verify-freshness) — a rail never classifies whether a finding was "too substantive to fix."

## Structural changes the code needs (the earned-refactor ledger)

Each is a real block found in the 2026-07-03 code read; nothing here is speculative.

1. **Write authority as one resolver.** `POLICY` in `src/roles.ts` is static; the relay reviewer is critique-only in the design loop and writable only post-handoff, so run-awareness alone isn't enough — the resolver is `writeAuthorityFor(state, phase, role, action)`, with the static table remaining the default policy beneath it. Every harness path that mutates correctness state reads the effective answer. Not cosmetic: `tools.ts` clears the contract's `verifiedAt` only on non-read-only turns, so a writing reviewer under the static table would leave a **stale verification certifying pre-fix code**.
2. **Effective binding per stage.** `implementerModelFor` (returns a model string, claude-only by v1 design) generalizes to `effectiveBindingFor(bindings, role, workflow, phase) → RoleBinding`, consumed by `createWorkers` *before* its provider branch. `parseImplOverride` drops the claude-only guard; the override key generalizes from `impl` to `build` on any worker binding (`impl` accepted as an alias on the implementer — judgment call, no compat burden yet). The replace-don't-mutate discipline on `DEFAULT_BINDINGS` carries over.
3. **Session reset + seed at the handoff** for provider-switched roles. `workerSessions[role]` values become provider-qualified (an absent provider ⇒ the base binding's — legacy state reads byte-compatibly), and a cross-provider resume is **unrepresentable**: the one resume-site read derives a fresh session on provider mismatch rather than any code path attempting the resume (decision T1 below). Each reset lands in a `sessionResets` ledger entry (`{role, phase, fromProvider, toProvider, at}`) — the house ledger pattern (`autoApprovals`, `autoRetries`, `contextEvents`) — so status and `takeover` can explain why a role's old session is gone. Full (slot, stage) session lineage is deferred: v1 has exactly one switch boundary.
4. **Tail owners as resolvers** (`buildTailOwner`, `finishOwner`), read by the briefs, the self-heal routing, and the snippet routing — one data home, never scattered role names in prose.
5. **A grouped `semantics` sub-object per registry row** in `src/phases.ts` — `{block, artifactKind, reviewPosture, entrySeed, buildTailOwner, finishOwner, midpoint, examplesKey}` — never scattered booleans, knob combinations validated at load (`validateRegistry` extended). The grouping is the clean compile target for the deferred stage-4 compiler; values set to reproduce the current arcs exactly.
6. **A narrow action catalog.** Snippet-tag string conventions that encode behavior become metadata: `countsReviewRound` (today `tag.startsWith('review')` plus the `review-midpoint` carve-out in `roles.ts`), may-write (the fixer's authority input), the contract/verify action markers, and a `kind: compact` annotation for guidance/list surfaces only — the emergency-band rail keeps trusting the literal `/compact` body, never the tag. Scope rule: catalog only the strings that encode behavior in code today or that relay would break; the full snippet taxonomy waits.
7. **Brief composers fold into registry-driven rendering.** `orchestrator-prompts.ts` is already half-factored (shared step builders; per-(workflow,phase) composer functions; the `phaseBriefBuilders` dispatch). The composers become one renderer over the registry row + fragment library. **Worked-example blocks stay per-arc data** — examples are the most arc-specific, least composable prose; only the *steps* become knob-conditional fragments.

Known-compatible by existing design (verify during implementation, no redesign expected): context metering keys on claude-persistent-headless regardless of role, so the post-handoff claude fixer is metered and the codex builder auto-compacts natively; budget caps are claude-only; the interactive transport is irrelevant to relay (builder is codex; overrides carry no transport).

## Technical foundation — the decisions

The high-level commitments under the ledger above, from tracing the critical paths (`settleTurn` and the rails in `src/harness/tools.ts`, `sessionIdFor`/`POLICY` in `src/roles.ts`, `RunState` in `src/run-store.ts`, `RunTurnOptions` in `src/providers/types.ts`, the composer structure of `src/harness/orchestrator-prompts.ts`). Shapes, seams, and placement — not code.

**T1 — Session identity: derive the reset, don't event it.** The handoff session reset is *not* a lifecycle step. `sessionIdFor(state, role)` (`src/roles.ts`) is already the single resume-site read on both hosts (the blocking path and the turn-dispatcher); it grows the phase and compares the stored record's provider against the effective binding's provider for that phase — mismatch ⇒ `undefined` ⇒ the next send mints fresh, exactly the existing ephemeral-consultant mechanism. No hook in `lifecycle.ts`, no crash window (a crash before/after the "reset" changes nothing — the answer re-derives), idempotent, and correct even if a run is resumed mid-arc by an older flow. The `sessionResets` ledger entry lands in `settleTurn` (which already loads-fresh and writes the session): when the settling turn's provider differs from the prior record's, record the reset. Legacy compatibility is a **parse-don't-validate** boundary: `loadRunState` normalizes a legacy bare-string session to `{provider: bindings[role].provider, id}` once at load, so every downstream reader sees one shape and the two-maps-drifting failure mode (a sibling `sessionProviders` map) is never representable.

**T2 — Write authority: one resolver, three consumers.** `writeAuthorityFor(state, phase, role, action)` — the static `POLICY` table remains the default beneath it; the fixer posture (from the phase's semantics + the run's arc) is the only thing that widens it, and only for the reviewer, post-handoff. Its consumers: (1) `settleTurn`'s `verifiedAt`-staleness key (`tools.ts:544` — today `readOnlyFor(role)`; `state` and `phase` are already in `settleTurn`'s signature, so this is a call-site change, not a restructuring); (2) the two `runTurn` dispatch sites that pass the `readOnly` role-intent hint (`tools.ts:1419`, `turn-dispatcher.ts:224`); (3) the fixer-mode rails (may-write). The consultant's contract/verify write relaxation stays **prompt-scoped** as today — it never flips this flag — so the author-never-commits premise is untouched.

**T3 — Placement rule for the new data: semantics in the registry, behavior metadata in code, prose in TOML.** The trust gradient applied to the vocabulary. The `semantics` sub-object is registry data (`phases.ts`, load-validated). The action catalog is a **code map keyed by snippet key** (beside the registry, pinned by `tests/snippets.test.ts`: every catalog key exists in the library, every behavior-bearing key is cataloged) — deliberately *not* fields in `snippets.toml`, because the override layers replace bodies per-key and a user override must never be able to change behavior (`countsReviewRound`, may-write). `snippets.toml` stays prose-only. `countsReviewRound(role, tag)`'s call sites don't move; its implementation reads the catalog instead of the tag prefix.

**T4 — Effective binding: absorb, don't parallel.** `effectiveBindingFor(bindings, role, workflow, phase) → RoleBinding` **replaces** `implementerModelFor` (its one non-view caller is `createWorkers`; the stats view adapts) rather than sitting beside it — two resolvers answering "who runs this turn" is the drift the deletion test exists to catch. `createWorkers` consumes it *before* the provider branch, so the codex-vs-claude construction falls out per phase. All rejection guards stay at the config boundary (`loadRunConfig`): override-on-interactive-transport rejected, orchestrator claude-only unchanged; past the boundary the binding is trustworthy and no downstream site re-checks.

**T5 — Brief rendering: delete the builder table.** The per-arc composer functions and the `phaseBriefBuilders` dispatch map (`Record<WorkflowName, Partial<Record<PhaseName, builder>>>`) are replaced by **one renderer** over (registry row semantics × the fragment library × per-arc examples data). The deletion test is the acceptance check: the per-arc builder concept disappears entirely; a new arc adds zero functions in `orchestrator-prompts.ts`. The parity harness pins this through the existing public interface (`buildPhaseBrief(state, phase)`), so the refactor is tested at the seam callers already cross, never against fragment internals.

**T6 — What falls out for free (build nothing here).** Verify-last under fixer: once T2 makes write authority role-accurate, the existing `settleTurn` clearing plus the existing advance rail already force a fresh independent re-verify after any mutating reviewer turn — no new rail. Round counting under fixer: the `review-and-fix` turn is the reviewer on a review-tagged action, so it counts as the phase's round through the same catalog entry — no rail change. Contract machinery: `freezeContractAt` and `contractAuthorPhaseOf` are registry-keyed already; relay inherits design's late-author shape with zero contract-code change. Testing needs **no new seams**: `FakeWorker` at the `WorkerProvider` seam covers provider-switch behavior, the resolvers and catalog are pure functions, and the parity harness sits at the rendered-prompt interface.

## The one-PR plan (Option B with commit discipline)

One ambitious PR; safety comes from strictly staged commits with a hard parity gate between refactor and feature:

1. **This document.**
2. **Parity harness first**: snapshot-pin rendered briefs, effective snippet lists, and machine shapes for full/design/rir — *before any refactor commit*. The run-state matrix covers consultant on/off, gateless, spec-entry, attended vs pre-authorized gate copy, prior gate auto-crossed vs explicitly approved, acceptance contract absent/draft/frozen/verified, and claude vs codex implementer (the compaction prose differs). Not the full Cartesian product — the rule is **every conditional branch in `orchestrator-prompts.ts` has at least one pinned fixture** before the renderer refactor. The bar is **byte-identical**, stricter than green tests. Wording improvements discovered mid-refactor are deferred, never folded in.
3. **Vocabulary fields in the registry** (no consumer changes — a no-op commit, load-validated).
4. **Fold the brief composers** into registry-driven rendering; parity stays green.
5. **Run-aware role policy** + the `verifiedAt` keying fix.
6. **Stage-scoped bindings**: `effectiveBindingFor`, provider switch, session reset at handoff.
7. **The relay arc as pure data** + its snippets (`review-and-fix`, the fixer-tail variants, the fresh-seed entry) + tests. This commit is the proof: a new workflow lands as one `WORKFLOWS` entry plus snippets, no new composer function.
8. **README status line** (relay: built, test-verified, not live-run) + a one-line CLAUDE.md pointer to this doc. The comprehensive pass waits.

Bisection story: if a live relay run misbehaves, refactor commits (parity-clean) are separable from feature commits by construction.

## Doc-debt ledger — owed a comprehensive pass after relay lands

Explicitly diverging until then: `CLAUDE.md` (product goals, invariants for the new knobs), `docs/automation-design.md` (roles/phases/arc sections, the vocabulary as a first-class concept), `docs/engineering.md` (module map: roles policy, config resolvers, prompt rendering), `docs/snippets.md` (+new snippets), `docs/future-directions.md` (supersede the OSS-ification entry; record this repositioning), `README.md` (positioning + status), `skills/onboarding` (if the prompts anchor moves). One pass, after the first relay smoke test.

## Watch items and open questions

- **Vocabulary revision is cheap until stage 4.** External arc definitions (`.duet/workflows/*.toml`) stay trigger-gated: a real wanted composition the shipped set doesn't cover. Until then every knob is renameable — which is what makes the ambitious PR's bet bounded.
- **Fixer-mode adversariality** — the first relay runs watch whether judge-fixes hold quality without the respond-review dialectic, and whether the fixer over-rewrites (the "don't dismiss" guardrail's real test).
- **Criss-cross context loss** — does the judge reviewing from the doc alone miss nuance the planning loop settled? If so, the fix is a richer handoff/seed, not a posture change.
- **Codex reasoning effort stays out of duet** — xhigh lives in `~/.codex/config.toml` (profiles), per the no-model-key design.
- **Relay's name** is provisional.
