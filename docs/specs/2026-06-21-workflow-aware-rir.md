# Workflow-aware duet — the RIR arc

> **Historical (pre-`finish`).** Dated record from before the 2026-06-26 collapse of the `docs`/`pr`/`open` tail into one `finish` phase (open-then-review, draft-PR-by-default, `overnight` as full's default posture). Its Full-arc diagrams still show the `… → docs → pr → open` tail and `pr` force-attend — the topology of their time; the current arc lives in [`../automation-design.md`](../automation-design.md).

**Status:** Approved direction (Direction gate, 2026-06-21); spec for planning. **Date:** 2026-06-21. Plan: forthcoming. On adoption the surviving design folds, present tense, into `docs/automation-design.md` and `docs/engineering.md`; this stays the dated proposal record.

## Summary

duet today runs exactly one workflow: the **Full** arc — `frame → spec → plan → impl → docs → pr → open` — encoded as the single global phase table in `src/phases.ts`, from which the statechart, driver, lifecycle, CLI, prompts, status, and per-phase snippet sets all derive. That arc is deliberately epic-shaped and it works. It is also too slow and too formal for fast iteration on personal projects, where the spec+plan ceremony costs more than it returns.

**What we're building.** duet becomes **workflow-aware**, and ships a second, lighter arc as a first-class citizen:

1. **A static workflow registry.** `WORKFLOWS = { full, rir }` replaces the single global arc. Each workflow owns its complete spec — ordered phases, entry route, handoff gate, gate presets, force-attended gates. A run carries which workflow it is on; everything arc-shaped resolves through it.
2. **RIR (Research → Implement → Review)** — the second arc: `research → Direction gate → implement → Ship gate → done`. It keeps duet's distinctive two-agent shape (independent cross-framing before building, cross-review after) and drops the rest of the ceremony: no spec, no plan, no docs/PR/open tail, no midpoint checkpoint, one writable review round instead of the read-only reflect gate and round-2 challenge variants.
3. **A per-run selector.** `--workflow full|rir` (plus a `workflow:` framing-frontmatter key, flag wins), default `full`, displayed as "Research → Implement → Review".

**Approach and scope.** RIR is a *generalization of the existing phase-table concept, not a parallel subsystem* (coupling decision below). The single global arc splits into a registry of arcs; the flat lookups everything already uses (`PHASE[name]`, the `Record<PhaseName, …>` run-state maps, the entry-prompt dispatch) are **derived** from the registry and stay flat, enabled by globally-unique phase names. Only the genuinely topology/policy-shaped helpers become workflow-scoped (the machine factory, the lifecycle position probe and handoff rule, gate-state→phase resolution, gate parsing and force-attend, snippet slicing, status rounds) — and a phase *accepted from outside* is validated against the run's workflow, not the global table. The XState model is unchanged — a machine built from data, snapshot-persisted, tags as API; it is now built from *the run's* arc.

**The boundary once this lands.**

- **Covered:** two arcs are first-class and selectable per run; RIR walks `research → implement → done` with two human gates (Direction = walk-away/headless-handoff, Ship = return); a run records its workflow and restores correctly; the snippet menu, status, prompts, gate pre-authorization, and the two shipped skills all reflect whichever arc is active.
- **Stays Full-only (preserved unchanged):** the whole spec/plan loop, the docs/PR/open tail, the midpoint checkpoint, the read-only `respond-review` reflect gate, the `-again` round-2 variants, and `ceo-summary`. The Full arc is behaviorally unchanged.
- **Not changing (preserved across both arcs):** the statechart's two-vocabulary gate guarantee (a phase emits `phase.*`; only `human.*` crosses; no tool emits `human.*`); `state.json` is a hint, transcripts are truth; the orchestrator does triage, never substance; exactly two providers; augment-never-lock-in (standard transcripts, normal branches, manual takeover/resume).
- **Explicitly deferred** (one line each): *the `use-latest-docs` research nudge reaching Full's `frame`* — kept RIR-only this run so Full's verified arc isn't perturbed; promoting it to an anytime helper is a trivial later change. *A third workflow* — the registry makes one cheap, but none is built or scaffolded for. *RIR pre-authorization presets beyond the minimal gate list* — RIR has only two attendable gates; preset naming can wait for run evidence. *`workflow` as a config/role-binding* — it is a per-run property like `gates_at`, never config.

---

## How the arc works today (current → desired)

The single-arc assumption is real and lives in data plus a handful of order-walkers. `src/phases.ts` defines one `PhaseName` union, one `PHASES` array (set *and* order in one structure), one `PHASE` lookup, one `GATE_PHASES` vocabulary, and one snippet classification. `src/harness/machine.ts:buildStates` generates the chart from global `PHASES`, wiring each gate's approve to `PHASES[i+1]`. `src/harness/lifecycle.ts` probes position against the global arc and hardcodes plan-approval as the interactive→headless handoff. `src/framing.ts` holds global gate presets and force-appends `pr`. `src/run-store.ts` persists phase-indexed state but **not** which arc the run is on. `src/harness/orchestrator-prompts.ts` switches on Full phases and bakes the Full review discipline into the entry prompts. The three guard tests (`tests/machine.test.ts`, `tests/snippets.test.ts`, `tests/skill.test.ts`) pin the single-arc shape.

```
Current — one global arc (src/phases.ts PHASES):
  frame → Direction → spec → Commit-spec → plan → Plan-approval
    → impl → Ship → docs → Docs-plan → pr → Open-PR → open → done

Desired — workflow-selected (WORKFLOWS[run.workflow].phases):
  full:  (unchanged — the arc above)
  rir:   research → DIRECTION (walk away / hand off) → implement → SHIP → done
```

The coupling decision is the load-bearing call, so name it plainly:

**Coupling decision — RIR generalizes the phase table; it is not an independent subsystem.** Every field a workflow needs already exists today as a global the two real arcs *demonstrably disagree on*: Full enters via `hasSpec → spec` while RIR enters at `research`; Full hands off to the headless driver at plan-approval while RIR hands off at the Direction gate; Full's presets reference `spec`/`plan`/`impl`/`docs` while RIR's can't; Full force-attends `pr` while RIR has no `pr`; Full ends Open-PR → open while RIR ends Ship → done. Lifting those globals into a per-workflow record is therefore the minimal generalization two real arcs force, not speculative scaffolding — and it is the alternative that doesn't leak Full semantics into RIR (a second arc behind global helpers would silently inherit `pr`-force-attend, Full's gate vocabulary, and the plan-handoff). A third arc later costs one registry entry; that is a consequence of doing two correctly, not machinery built for it.

## What derives from the table (current → desired)

The split that makes the change small: **pure lookups stay flat (derived from the registry); only topology/policy helpers become workflow-scoped.** Globally-unique phase names (`research`/`implement` for RIR; `frame`/`spec`/`plan`/`impl`/… stay Full's) are what let the flat indices be derived unambiguously.

```
                         CURRENT (global PHASES)          DESIRED (registry)
 phase definitions       PHASES array + PHASE lookup       WORKFLOWS[wf].phases; PHASE derived (flat)
 PhaseName               hand-written union                derived union over all workflows
 run-state maps          Record<PhaseName, …>              unchanged — flat, derived names
 entry-prompt dispatch   switch (phase)                    exhaustive Record<PhaseName, builder> (flat)
 ── below: workflow-scoped ──────────────────────────────────────────────────────────────────
 machine states          buildStates() over PHASES         machineFor(wf) over WORKFLOWS[wf].phases
 position / handoff       global arc; plan hardcoded         workflow-scoped; handoffGate per workflow
 gate vocab / presets     GATE_PHASES, presets, pr forced    gatePhasesOf(wf), per-wf presets, forceAttend
 snippet next / done      PHASES.slice(i±)                   slice over WORKFLOWS[wf].phases
 status rounds            PHASES.filter                      over WORKFLOWS[wf].phases
```

**Stay flat — pure lookups, can never select the wrong arc** (`src/phases.ts`, `src/run-store.ts`, `src/harness/orchestrator-prompts.ts`): `PHASE[name]`, the run-state `Record<PhaseName, …>` maps (`rounds`, `phaseStarted`, `sentSnippets`, `phaseSummaries` — telemetry/history, not topology), and the entry-prompt dispatch. They grow by entries/cases as `PhaseName` gains `research`/`implement`; they never take `state.workflow`. The dispatch moves from a `switch` to an exhaustive `Record<PhaseName, builder>` in `orchestrator-prompts.ts` — the builders keep living there (they carry large phase-specific example blocks; folding them into the table would bloat it), the Record stays compiler-total so a new phase without a builder is a type error.

**The flat/scoped line is "read a known-member phase" vs. "accept a phase from outside."** Flat `PHASE[name]` is safe for *reading the spec of a phase already known to belong to the run*. But anywhere a phase is *accepted from outside* and turned into a tool surface, membership must be checked against the run's workflow, not global `PHASE` — otherwise a RIR run could be asked to host Full-only tools. The concrete site is the `duet _mcp <runId> <phase>` server (`src/harness/mcp-server.ts`), which today validates the phase arg against the global phase set *before* it loads the run; it must instead load the run first and require `phase ∈ WORKFLOWS[run.workflow].phases`, using flat `PHASE[phase]` only for budgets after membership is proven.

**Become workflow-scoped — topology/policy that *would* leak Full semantics otherwise** (`src/harness/machine.ts`, `src/harness/lifecycle.ts`, `src/framing.ts`, `src/status.ts`): the machine factory `machineFor(workflow)` (and `interactiveMachineFor(workflow)`, the inert-driver variant) iterating the run's `phases`; the lifecycle position probe and the handoff rule (`handoffGate` per workflow, replacing the hardcoded `=== 'plan'`); **gate-state→phase resolution** (`phaseOfGateState(workflow, stateName)` — mapping a machine-state value back to a phase is arc topology, not a pure lookup, and every caller already holds the run; scoping it is what lets RIR reuse a `directionGate`/`shipGate` name without the flat resolver becoming ambiguous); `gatePhasesOf(workflow)` plus per-workflow presets and `forceAttend` (the hardcoded `pr` special-case in `parseGatesAt` and `gateAttended` reads `forceAttend` instead); snippet next/done slicing; status rounds.

**Registry integrity is validated, not assumed.** The two invariants the flat/scoped split rests on are checked at registry construction (and pinned by test): phase *names* are globally unique across all workflows (so the derived `PHASE`/`PhaseName` are unambiguous), and gate-*state* names are unique *within* a workflow (so the scoped `phaseOfGateState(workflow, …)` is total).

**The registry shape** (`src/phases.ts`):

```
WorkflowName = 'full' | 'rir'
WorkflowSpec = {
  name, displayName,
  phases,        // ordered PhaseSpec[] — the arc
  entry,         // full: hasSpec → spec else frame;  rir: research
  handoffGate,   // full: 'plan';  rir: 'research'  (the walk-away → headless point)
  presets,       // gates_at presets, workflow-scoped
  forceAttend,   // full: ['pr'];  rir: []
}
WORKFLOWS: Record<WorkflowName, WorkflowSpec>
PHASE: Record<PhaseName, PhaseSpec>   // derived from the union of all workflows' phases
```

**Run identity and restore** (`src/run-store.ts`, `src/harness/lifecycle.ts`): `RunState` gains `workflow: WorkflowName`, set at `createRun` — an **additive** field. A **missing or pre-feature `workflow` resolves to `full`** through a read-time helper, and old `state.json`/`machine.json` are never rewritten on read. Hydration moves from today's hardcoded `createActor(duetMachine, { snapshot })` (`lifecycle.ts`, the `continue` paths) to `createActor(machineFor(state.workflow), { snapshot })`; `machineFor('full')` must preserve the existing machine id, state names, tags, route, and topology. The honest claim is therefore **behaviorally unchanged with additive persistence** — not byte-for-byte restore: the persistence *shape* gains one optional field, so the plan must show no other persistence-shape change for Full runs.

## The RIR arc — phases, gates, review discipline

```
research ──▶ DIRECTION gate ──▶ implement ──▶ SHIP gate ──▶ done
              (walk away /                       (return)
               hand off to headless)
```

- **`research`** — a distinct phase (not Full's `frame` reused), because its next step is implementation, not a spec. Both models brainstorm independently → `compare-notes` cross-framing → synthesized product decisions; the orchestrator carries the web-search nudge here. Its gate is **Direction**: the human approves the decisions that *are* the design, and this is the walk-away point and the interactive→headless handoff (RIR's analogue of Full's plan-approval).
- **`implement`** — distinct from Full's `impl`. Claude builds directly from the research decisions, then runs **one writable review round** folded into the phase exactly as Full's `impl` folds its loop: `reviewLoop: true`, `roundCap: 1`. The reviewer critiques once; Claude applies fixes directly. No read-only reflect step, no `-again` second round, no midpoint checkpoint. What the harness *enforces* here is narrow and worth naming so the plan doesn't assume more: at least one reviewer round and no second one — via the review-round counter (`tools.ts`, which counts a reviewer turn whose tag starts with `review`) and the zero-round block on `advance_phase`. Whether `apply-review` actually ran and whether Claude fixed anything is **prompt/packet discipline, not a statechart invariant** (the trust gradient — guarantee in structure, steer in text). One consequence: RIR's review snippet name keeps the `review-*` prefix so the counter recognizes it as a round.
- **Gate posture** (per duet's existing gate model — `forceAttend` is reserved for outward-facing/non-negotiable actions, everything else is attended-by-default but pre-authorizable via `gates_at`). **Direction** is RIR's walk-away point and its `handoffGate` (the interactive→headless boundary). The `handoffGate` follows the same rule Full's plan-approval already does, stated generally: **in an interactive run it is always crossed live regardless of `gates_at`** (the interactive crossing doesn't consult `gates_at` — the human's session ends there and hands off); **in a headless run `gates_at` applies to it like any other gate.** **Ship** is the return point, attended by default and opt-in pre-authorizable, `forceAttend: []` (RIR has no outward-facing action). So a fully-AFK *headless* RIR run pre-authorizes **both** Direction and Ship and runs straight to `done`; an *interactive* RIR run always stops live at Direction to hand off, then the headless tail honors `gates_at` for Ship. None of this is a new product decision — it is the existing handoff-gate + `gates_at` mechanics applied to RIR's Direction.
- **Ship packet (leaner than Full's):** the review summary plus a RIR-specific implementation handoff (`handoff-direct`, below) — **no `ceo-summary`**. RIR is the fast arc; the human reads what shipped and the review outcome, not a CEO-altitude writeup.

`--workflow rir` rejects `--spec` as invalid (RIR has no spec phase), the way `--template` already conflicts with `--spec` in `framing.ts:resolveRunInputs`.

## Snippets — flat library, per-phase sets in the registry

The library stays flat by key in `snippets.toml`; organization is the per-phase `snippets` set on each `PhaseSpec`, now living inside the registry. Shared snippets appear in both workflows' sets. The `tests/snippets.test.ts` completeness guard generalizes from "every snippet classified under some `PHASES` row / anytime / unlisted" to "under some **workflow's** row / anytime / unlisted" — so the Full-only snippets stay classified under Full's phases and the test stays green.

- **Reuse** (RIR references, shared with Full): `think-holistic`, `compare-notes` (research); the `ANYTIME_SNIPPETS` helpers unchanged. (`implementation-handoff` is **not** reused — its body ties back to "the spec" and "deviations from spec/plan", which RIR has none of; RIR gets its own handoff below, keeping Full's verified snippet untouched.)
- **Stays Full-only:** the `*-spec` / `*-plan` families; `compact-for-impl` / `compact-for-review` / `compact-for-cleanup`; `midpoint-status` / `review-midpoint` / `respond-midpoint`; `respond-review`; `review-implementation` / `review-implementation-again` / `respond-review-again`; `ceo-summary`; `pr-description`.
- **Add new** (five, classified under RIR's phases; purpose only — wording is plan/impl-stage):
  - **`use-latest-docs`** (research, **RIR-only this run**) — direct the worker to use web-search / current-doc tools for the latest APIs, libraries, and best practices *when the work depends on external libraries/SDKs*, not for stable facts about the repo.
  - **`implement-direct`** (implement) — the kickoff: refresh the research decisions and cross-review opinions, reread the code the change touches, then build directly, committing and testing as you go.
  - **`review-direct`** (implement) — review the implementation against the research decisions and the actual goal; like `review-implementation` but with no spec/plan references. Its key keeps the `review-` prefix (load-bearing: the review-round counter recognizes a round by that prefix).
  - **`apply-review`** (implement) — the writable single-round response: evaluate each review point, fix valid ones directly, report residual disagreements. Distinct from `respond-review` (read-only) and `respond-review-again` (round-2 convergence) by design.
  - **`handoff-direct`** (implement) — the RIR implementation handoff that orients the reviewer (a RIR-specific `implementation-handoff`): what changed and where to look hardest, tied to the research decisions rather than a spec/plan. Kept separate so Full's verified `implementation-handoff` is untouched, mirroring the RIR-only scoping of `use-latest-docs`.

These encode habits already visible in the human's own prompting (holistic code-grounded research, compare-notes, "use the latest APIs/best practices," prerequisite-then-implement kickoffs, writable review-and-fix) rather than inventing new ceremony.

## Standard for prompt and snippet design (process constraint)

Any prompt, snippet, tool description, or tool result authored or revised in this build is designed against two references, consulted **before** writing and folded in: the global prompt-engineering skill at `~/.claude/skills/prompt-engineering/skill.md` and this repo's prompting guide `docs/prompting-and-tool-design.md` (its five binding conventions — artifacts-first/task-last, thinking-framework-with-motivation over prohibition, descriptions surface the implicit, errors prescribe recovery, results nudge the next step — plus the cold-reader and template-economy rules). This binds the five new RIR snippets and every orchestrator-prompt edit (`orchestrator-prompts.ts`, and the workflow-aware rewrite of `orchestrator-identity.md` below). Snippet and prompt bodies are not written in this spec — their wording is plan/impl-stage.

## Surfaces that travel in lockstep

- **Orchestrator prompts.** `orchestrator-prompts.ts` gains the RIR entry-prompt builders via the exhaustive Record; the system prompt stays largely arc-neutral (it describes the protocol vocabulary; RIR uses a subset). `prompts/orchestrator-identity.md` drops its hardcoded "FRAME → SPEC → PLAN" and "hand off at plan-approval" for "this session covers the attended arc up to the handoff gate; `get_task` tells you the current phase" — a tightening it already invites by telling the session to trust `get_task` over memory.
- **Skills.** `skills/duet-frame/` gains "pick the workflow" (it already settles gate posture) and emits `--workflow`; its gate-posture choices become workflow-scoped. `skills/duet-concierge/` needs no logic change — its channel table keys off `stop.kind` (running/gate/flag/crashed/done), not phase identity, so stop→command stays correct across either phase set; only its *illustrative* arc diagram needs to cover both arcs (or read arc-neutral). Both remain coherence-pinned by `tests/skill.test.ts`.
- **Status, done-summary, and tool copy go workflow-neutral.** Three Full-baked strings the registry refactor would otherwise leave wrong for RIR: `status.ts` reads the *run's last phase* summary for the `done` packet (Full: `open`; RIR: `implement`), not a hardcoded `phaseSummaries.open`; `describeStop`'s completion line stops asserting "the PR is open"; and `advance_phase`'s schema description (today "lead with the CEO summary verbatim … `spec_path`") becomes workflow-neutral (or workflow-aware) so a RIR orchestrator isn't instructed to produce Full-only artifacts. This is the prompt/tool-design process constraint above made concrete for the status and tool surfaces.
- **In-scope doc/ledger amendments** (named as scope; the how-to is post-implementation, not planned here): `CLAUDE.md`'s "epic-shaped" and "Open-PR non-negotiable" product goals become Full-scoped (two first-class workflows; Open-PR non-negotiable *for Full*); `docs/future-directions.md`'s declined "Arc presets" entry is rewritten from "not wanted" to "superseded by RIR — two first-class workflows" (RIR is meaningfully different: it preserves the two-agent cross-framing and cross-review).

## Testing (spec altitude)

The behaviors that matter; specific cases, fixtures, and mocking boundaries are the plan's.

- **Restore defaults the arc.** A run state with no `workflow` (a pre-feature or hand-written `state.json`) restores and runs as `full`.
- **The RIR arc walks correctly.** A `rir` run goes `research → Direction gate → implement → Ship gate → done`, with exactly those two human gates and no spec/plan/docs/pr/open states; its `implement` phase requires one review round (`roundCap: 1`) and exposes none of the Full-only review/midpoint snippets.
- **The Full arc is unchanged.** The existing full-arc walk and quiescent-state set still hold.
- **Selector and validation.** `--workflow full|rir` and `workflow:` frontmatter resolve with flag-over-frontmatter precedence; an unknown value fails loudly; `--workflow rir` with `--spec` is rejected; `gates_at` parses and validates against the *chosen* workflow's gate phases and presets (RIR's Ship is pre-authorizable; Direction is the live handoff).
- **Phase membership and registry integrity.** Accepting a phase for a run validates it against that run's workflow — a RIR run rejects a `plan`/`docs` phase arg rather than hosting Full-only tools; the registry rejects duplicate phase names across workflows and duplicate gate-state names within a workflow.
- **Workflow-neutral completion.** A `rir` run reaches `done` from its `implement`/Ship summary with no PR or `ceo-summary` assumptions in the done copy or the final-summary source.
- **The three guards generalize.** `tests/machine.test.ts` asserts the arc walk and quiescent/tag sets **per workflow**; `tests/snippets.test.ts` asserts snippet completeness across **all workflows' phase sets**; `tests/skill.test.ts` still pins every CLI verb/flag the skills name (now including `--workflow`).
