# Plan — Workflow-aware duet + the RIR arc

> **Historical (pre-`finish`).** Dated record from before the 2026-06-26 collapse of the `docs`/`pr`/`open` tail into one `finish` phase (open-then-review, draft-PR-by-default, `overnight` as full's default posture). Its Full-arc walks still name the `docs`/`pr`/`open` states — the topology of their time; the current arc lives in [`../automation-design.md`](../automation-design.md).

**Spec:** `docs/specs/2026-06-21-workflow-aware-rir.md` (committed). **Date:** 2026-06-21. This plan runs AFK off the plan-approval gate; it must be workable end to end, and a later turn re-anchors on it after a context compaction.

## Orientation

The change splits one overloaded structure — the global `PHASES` array, which today is *both* the set of phase definitions and their order — into a small static **registry of workflows**, then adds **RIR** as the second arc. The spec's coupling decision governs: RIR generalizes the phase table, it is not a parallel subsystem.

**The deep module this introduces** (`src/phases.ts`) — a small interface hiding the derivation:

```
WorkflowName            'full' | 'rir'
WorkflowSpec            { name, displayName, phases, entry, handoffGate, presets, forceAttend }
WORKFLOWS               Record<WorkflowName, WorkflowSpec>          (the source of truth)
PHASE                   Record<PhaseName, PhaseSpec>                (derived, flat — globally-unique names)
PhaseName               derived union over all workflows' phases
phasesOf(workflow)      readonly PhaseSpec[]                        (the run's ordered arc)
gatePhasesOf(workflow)  readonly GatePhase[]                        (replaces global GATE_PHASES)
phaseOfGateState(workflow, stateName)   GatePhase | undefined      (scoped — was flat)
gateOf(phase)           PhaseSpec['gate']                          (stays flat — phase is globally unique)
validateRegistry(workflows)             throws on integrity violation
workflowOf(state)       WorkflowName                               (run-store; missing → 'full')
machineFor(workflow) / interactiveMachineFor(workflow)             (machine factory)
```

**Sequencing logic** (why this order — and why the user-facing selector lands *last*): the data layer and run identity come first (everything resolves through them); the machine factory next (topology consumes the registry); then RIR's arc data + snippets + rendering; then RIR's orchestrator prompts + exhaustive dispatch + the identity/system-prompt cleanup; then the workflow-neutral surface cleanups (`_mcp` membership, status/done, and removing the `PHASES` alias once its last consumer migrates); **only then** the selector (`--workflow`/frontmatter/gate parsing/CLI), so a user-startable RIR run is never exposed before the runtime can drive, render, and status it; finally the skills. Parse helpers can be built earlier, but `duet new --workflow rir` becomes startable only in Slice 6. **The regression guard throughout is the existing Full test suite** — a pure-refactor slice is "green" when today's machine/snippets/lifecycle/status tests still pass with `full` resolving identically; RIR slices add new behavior with new tests.

**Binding conventions** (`docs/engineering.md`): tests are behavior-through-interface; **fake only at the six documented seams, never our own modules** (the relevant ones here: the `phaseDriver` actor seam via `machine.provide` / `tests/helpers/scripted-machine.ts`; the `WorkerProvider` seam / `FakeWorker`; the environment seam — `isTTY`, etc.); erasable-only TS (`as const`/`satisfies` are fine, no enum/namespace); explicit `.ts` import extensions; filesystem/git run real in tmpdirs.

**Prompt/snippet design is rider-bound** (carries hardest in Slices 3 and 4): every new snippet body and orchestrator-prompt edit is authored against `~/.claude/skills/prompt-engineering/skill.md` **and** `docs/prompting-and-tool-design.md`, folded in before writing. Those slices name *how* each is designed; the wording itself is written during the slice's green step, and each key is pinned by a test.

**Out of scope (deferred to the docs phase that follows impl):** the narrative doc/ledger amendments the spec names — `CLAUDE.md` "epic-shaped"/"Open-PR non-negotiable", `docs/future-directions.md` "Arc presets", and the present-tense folds into `automation-design.md`/`engineering.md`. Impl slices touch only code, `snippets.toml`, the two `skills/`, `prompts/orchestrator-identity.md`, and tests.

---

## Slice 1 — The workflow registry + run identity + scoped gate resolution (Full-only, behavior-preserving)

**Goal.** `WORKFLOWS` becomes the source of truth with `full` as its sole member; the flat lookups (`PHASE`, `PhaseName`, `GATE_PHASES`) are *derived* from it; a run records its `workflow`; gate-state→phase resolution and the force-attend policy become workflow-scoped. No behavior changes — `full` resolves exactly as today.

**Changes.**
- `src/phases.ts`:
  - Add `WorkflowName` (start as `'full'`), `WorkflowSpec` (interface above), and `WORKFLOWS` with `full` populated from today's arc: `phases` = the current `PHASES` array (70-196) moved verbatim into `WORKFLOWS.full.phases`; `entry = { firstPhase: 'frame', specSkipsTo: 'spec' }`; `handoffGate = 'plan'`; `presets` = today's `GATES_AT_PRESETS` (moved from `framing.ts:266`); `forceAttend = ['pr']`.
  - Derive `PHASE` (199-201), `PhaseName`, and `GatePhase` from `WORKFLOWS` via `as const satisfies` + indexed-access — erasable-only (`as const`, `satisfies`, and type aliases all erase), no widening to `string`:
```ts
interface PhaseSpecInput<Name extends string = string> { readonly name: Name; readonly gate: GateInput | null; /* other fields, string-typed at input time */ }
interface WorkflowSpecInput { readonly phases: readonly PhaseSpecInput[]; readonly entry: …; readonly handoffGate: string; readonly presets: Record<string, readonly string[]>; readonly forceAttend: readonly string[] }
export const WORKFLOWS = { full: {…} /* rir added in Slice 3 */ } as const satisfies Record<string, WorkflowSpecInput>;
export type WorkflowName = keyof typeof WORKFLOWS;
type AnyPhase = (typeof WORKFLOWS)[WorkflowName]['phases'][number];
export type PhaseName = AnyPhase['name'];
export type GatePhase = Extract<AnyPhase, { gate: object }>['name'];   // gate:null (open) excluded ⇒ non-null gate is the GatePhase discriminator
```
    `PhaseSpec` stays the consumer-facing interface (`name: PhaseName`, …); `PHASE` is the registry iterated into a `Record<PhaseName, PhaseSpec>`. No `as`-cast is the derivation mechanism — `satisfies` is (the dispatch map in Slice 4 uses `satisfies` the same way).
  - Replace `GATE_PHASES` (204-206) with `gatePhasesOf(workflow)`; keep a `GATE_PHASES`-shaped export only if a Full-specific caller remains (prefer none — migrate callers).
  - Make `phaseOfGateState(workflow, stateName)` (209-211) **scoped**: search `phasesOf(workflow)`, not global `PHASES`.
  - Add `phasesOf(workflow)`, `validateRegistry(workflows)` (throws on: a phase name appearing in more than one workflow's phases; two gates with the same `gate.state` *within* one workflow; a `handoffGate`, `forceAttend` entry, or `preset` value that is not a gate phase of its own workflow; an `entry.firstPhase` or `entry.specSkipsTo` that is not a phase of its own workflow), and call it once on `WORKFLOWS` at module load.
  - Keep a temporary `PHASES` alias = `WORKFLOWS.full.phases` so untouched consumers still compile; it is removed in Slice 5 once the last consumer is migrated.
- `src/run-store.ts`:
  - `RunState` gains `workflow?: WorkflowName` (additive; place near `specPath`/`gatesAt`, ~83/96).
  - `createRun` (256-298): accept `workflow?` in opts; persist it (set only when provided — absence is the `full` default via the resolver, so old `state.json` needs no rewrite).
  - Add `workflowOf(state): WorkflowName` = `state.workflow ?? 'full'`.
  - `gateAttended` (215-218): replace the hardcoded `if (phase === 'pr') return true` with `WORKFLOWS[workflowOf(state)].forceAttend.includes(phase)` (full keeps `pr`; behavior identical).
- `src/framing.ts`: `GATES_AT_PRESETS` (266-275) moves into the registry as `WORKFLOWS.full.presets`; `parseGatesAt` (307-326) keeps its current signature but reads presets / gate vocabulary / force-append from the Full workflow (`WORKFLOWS.full.presets`, `gatePhasesOf('full')`, `WORKFLOWS.full.forceAttend`) — so *moving* the const keeps Slice 1 green (the reader migrates with it). The workflow-*parameter* generalization (and the empty-preset rule) is Slice 6.
- Callers of `phaseOfGateState` pass `workflowOf(state)`: `lifecycle.ts:204,312,347`, `status.ts:207`, `cli.ts:514`.

**Tests** (`tests/phases.test.ts` new; extend `tests/run-store.test.ts`):
- `validateRegistry` — `test.for` over fixtures: a good registry passes; a registry with a phase name shared across two workflows throws naming the dup; a workflow with two gates sharing a `gate.state` throws; a `handoffGate`/`forceAttend`/preset value that isn't a gate phase of its workflow throws; **a bad `entry` (an `entry.firstPhase` or `entry.specSkipsTo` not in the workflow's phases) throws**. (Pure function, no seam.)
- derived `PHASE`/`PhaseName`/`gatePhasesOf('full')` equal today's set; plus a **literal** product-shape pin: `phasesOf('full').map(p => p.name)` deep-equals `['frame','spec','plan','impl','docs','pr','open']` (so a self-derived test can't pass a malformed registry — finding #4).
- `workflowOf` — state with no `workflow` → `'full'`; state with `workflow:'full'` → `'full'`.
- `gateAttended` via `forceAttend` — full: `pr` attended regardless of `gatesAt`; a non-force phase honors `gatesAt`.
- Existing `tests/machine.test.ts` / `tests/snippets.test.ts` stay green (PHASES alias intact).

**Verify.** `pnpm typecheck && pnpm test`. Green = registry derives Full identically.

---

## Slice 2 — Machine factory + workflow-scoped position probe & handoff rule (Full-only behavior)

**Goal.** The statechart is built from the run's workflow. `machineFor('full')` is byte-identical in topology to today's `duetMachine`; hydration and the position probe select by `workflowOf(state)`. No behavior change for Full.

**Changes.**
- `src/harness/machine.ts`:
  - `buildStates` (109-129) takes a `WorkflowSpec`: iterate `spec.phases` (not global `PHASES`); `next = spec.phases[i+1]` (120); build the entry `route` (113-116) from `spec.entry` — full keeps the `hasSpec` guard → `specLoop`; a workflow with no `specSkipsTo` wires `initial`/`route` straight to `${entry.firstPhase}Loop`.
  - `machineFor(workflow)` returns `setup(...).createMachine({ ... states: buildStates(WORKFLOWS[workflow]) })`; `interactiveMachineFor(workflow)` is its `.provide` inert-driver variant.
  - `duetMachine`/`interactiveMachine` (131-187) become `machineFor('full')`/`interactiveMachineFor('full')` (keep the names as exports so `LifecycleDeps.machine` typing and any external ref survive).
- `src/harness/lifecycle.ts`:
  - Hydration sites use `machineFor(workflowOf(state))`: `stoppedPosition` (190), `interactiveRestPhase` (231), `driveToQuiescence` (285), and `crossInteractive` uses `interactiveMachineFor(workflowOf(state))` (385).
  - `stoppedPosition` (157-220): `entryPhase` (159) from `WORKFLOWS[workflowOf(state)].entry`; flag-wait/loop/gate resolution (198, 210, 236) iterate `phasesOf(workflowOf(state))`; the `next` after a gate (210) indexes the run's phases.
  - Generalize `interactiveContinuePlan` (416-422) → `interactiveContinueAction(workflow, gatePhase, eventType, headless)`: handoff when `gatePhase === WORKFLOWS[workflow].handoffGate && eventType === 'approve'`, or `headless`. Rename to drop "Plan". Update `cli.ts:462`.
- `src/cli.ts`: the continue probe (505) uses `machineFor(workflowOf(state))`.
- `tests/helpers/scripted-machine.ts`: `scriptedMachine(script, workflow = 'full')` provides the `phaseDriver` on `machineFor(workflow)` (the seam stays the `phaseDriver` actor via `machine.provide`).

**Tests** (extend `tests/machine.test.ts`, `tests/lifecycle.test.ts`):
- Introduce a `walkArc(workflow)` helper in the test that derives the expected loop/flag-wait/gate state set and arc-walk from `phasesOf(workflow)` (replaces the hardcoded `PHASES` iteration at 26-34, 46, and the literal `calls` at 282).
- `machineFor('full')`: phase-table⇄machine coherence and the quiescent/tag set still hold; keep the **literal** full-arc walk too — the calls equal `['frame','frame','frame','spec','plan','impl','impl','docs','pr','pr','open']` (existing assertion at 282) — alongside the derived `walkArc`, so a malformed registry can't self-validate (finding #4).
- entry routing (59/67): full still routes `hasSpec` → spec.
- position probe (lifecycle): a Full gate/flag/crash snapshot resolves as today.
- **Restore default — the actual hydration path, not just the resolver (finding #5):** create a Full run, drive it to a persisted snapshot, *delete* `workflow` from the saved `state.json`, then `probeRunPosition` / continue-hydration resolves through `machineFor('full')` and reports the same position. This pins the old-run migration risk, which `workflowOf`'s unit test (Slice 1) does not reach.
- Seam: the `phaseDriver` actor via `scriptedMachine`; the restore test uses a real tmp run on disk (filesystem real, per conventions). Behavior unchanged.

**Verify.** `pnpm typecheck && pnpm test`. Green = Full's machine + lifecycle behave identically through the factory.

---

## Slice 3 — The RIR arc: registry data + the five snippets + workflow-aware snippet rendering

**Goal.** `WORKFLOWS.rir` exists; `machineFor('rir')` walks `research → Direction → implement → Ship → done`; the five new snippets exist and the completeness guard passes across both workflows; `list_snippets` renders the run's arc.

**Changes.**
- `src/phases.ts`:
  - `WorkflowName` `|= 'rir'`; add `WORKFLOWS.rir`:
    - `phases`: `research` (gate `directionGate` — reused name, legal because resolution is scoped; `reviewLoop: false`; `roundCap` ~2; snippets `['think-holistic','compare-notes','use-latest-docs']`) then `implement` (gate `shipGate`; `reviewLoop: true`; **`roundCap: 1`**; snippets in spine order `['implement-direct','handoff-direct','review-direct','apply-review']` — handoff precedes review because it orients the reviewer, mirroring Full's `impl` spine (finding #3); budgets/timeouts mirror Full's `impl` row 149-151).
    - `entry = { firstPhase: 'research' }` (no `specSkipsTo`); `handoffGate = 'research'`; `forceAttend = []`; `presets = { afk: [] }` — `afk` attends no gates, so a headless RIR run auto-crosses Direction and Ship straight to `done` (`forceAttend: []` pins nothing). Settled now, not deferred (finding #6), since Slice 6 tests it; the empty-attended-list-from-a-preset rule is pinned in Slice 6.
  - Confirm `validateRegistry` passes: `research`/`implement` are globally unique; within `rir`, `directionGate`/`shipGate` are unique.
- `snippets.toml`: add the five entries (bodies authored in the green step — see **design notes** below). Keep `review-direct` on the `review-` prefix (load-bearing: `tools.ts:281` counts a reviewer round by `tag.startsWith('review')`).
- `src/snippets.ts`: `renderForPhase` (100-136) becomes workflow-aware — `SnippetRenderOpts` (54-65) gains `workflow`; the `next`/`done` slices (116, 125) iterate `phasesOf(workflow)` instead of global `PHASES`. `list_snippets` (in `tools.ts`) passes `workflowOf(state)`.

**Prompt/snippet design notes (rider).** Each snippet is written against the two references; what each owes the cold reader and which conventions apply:
- `use-latest-docs` — *thinking-framework-with-motivation* (convention 2): say *why* (stale APIs cost a wrong build), scope it to external-library/SDK work, not repo facts; no aggressive emphasis. Cold reader: name that the worker has web/doc tools available.
- `implement-direct` — *artifacts-first/task-last* shape; the "[refresh decisions → reread touched code] → build, commit, test" sequence as positive instruction. Cold reader: it has no spec/plan, so it must point at the research decisions as the source of truth.
- `review-direct` — mirror `review-implementation`'s altitude lens (correctness/structure/tests) but reference *the research decisions and the goal*, never a spec/plan. Keep the `review-` prefix.
- `apply-review` — *writable single round*: evaluate each point, fix valid ones directly, and **report the post-review fixes** (so the Ship packet = the original handoff + this review/fix summary, never a stale handoff — finding #3); report residual disagreements; distinct from `respond-review` (read-only) and `respond-review-again` (round-2). Cold reader: there is no second review round, so it converges here.
- `handoff-direct` — orient the reviewer (what changed, where to look hardest) tied to research decisions, not spec/plan deviations; the RIR analogue of `implementation-handoff`. **Sent before `review-direct`** — it is the reviewer's map.

**Tests** (extend `tests/machine.test.ts`, `tests/snippets.test.ts`):
- `walkArc('rir')`: machine walks `research → directionGate → implement → shipGate → done`; exactly two gates; no `spec/plan/docs/pr/open` states; `implement` is `reviewLoop:true, roundCap:1`. (Seam: `scriptedMachine(script,'rir')`.) Plus **literal** pins (finding #4): `phasesOf('rir').map(p => p.name)` deep-equals `['research','implement']`, and the RIR walk literally reaches `directionGate`, `shipGate`, `done`.
- snippet completeness (62-72) is **redesigned for cross-workflow sharing** (finding #7 — the current `exactly-one-bucket` check breaks once `think-holistic`/`compare-notes` live in both Full's `frame` and RIR's `research`). New invariants: (a) every library snippet is classified — it appears in ≥1 workflow phase set, or `ANYTIME`, or `UNLISTED` (no invisible snippets); (b) `ANYTIME`, `UNLISTED`, and the union of all phase sets are pairwise disjoint (a snippet is phase-bound *or* a helper *or* archived, never two); (c) no snippet appears twice within one workflow's phase lists; (d) cross-workflow phase-set sharing *is* allowed. The five new keys resolve; the Full-only families stay under Full's phases.
- the five snippet keys exist with non-empty bodies; `review-direct` starts with `review-`.
- `renderForPhase` for a `rir` phase shows RIR's templates + anytime helpers; `coming_next`/`already_done` slice RIR's arc.

**Verify.** `pnpm typecheck && pnpm test`. Green = RIR walks and its snippets are complete.

---

## Slice 4 — RIR orchestrator prompts + exhaustive dispatch + identity & system-prompt cleanup

**Goal.** The orchestrator receives correct, arc-appropriate briefs for `research` and `implement`; the phase→builder dispatch is exhaustive and compile-checked; the interactive identity *and* the system prompt are workflow-neutral so neither contradicts a RIR brief under AFK.

**Changes.**
- `src/harness/orchestrator-prompts.ts`:
  - Add `researchPhaseEntryPrompt(state, cap)` and `implementPhaseEntryPrompt(state, cap)`. `research` mirrors `framePhaseEntryPrompt` (164-181) — two independent `think-holistic` analyses → `compare-notes` synthesis → Direction gate — but frames the gate as "the decisions that *are* the design" and folds in the `use-latest-docs` nudge; no spec follows. `implement` mirrors the spine of `implPhaseEntryPrompt` (256-300) **minus** the compaction steps (2,5), the midpoint (4), and `ceo-summary` (7), in this order (finding #3): `implement-direct` kickoff (build, commit, test) → `handoff-direct` (orient the reviewer) → one writable review round (`review-direct` → `apply-review`, which reports its fixes) → `advance_phase` with a lean Ship packet = the handoff **plus** the review/fix summary (no CEO summary). Handoff-before-review matches Full's `impl` spine.
  - Convert `buildPhaseBrief`'s `switch` (358-376) to `const builders = { … } satisfies Record<PhaseName, (state: RunState, cap: number) => string>` (the spec's flat-dispatch decision) — gains `research`/`implement`. `satisfies`, **never a cast** (finding #8): a missing phase is then a compile error — the real guard, with the runtime totality test below as belt-and-braces.
  - **Neutralize `ORCHESTRATOR_SYSTEM_PROMPT` (15-63).** Its `<protocol>` block (24-32) still encodes Full-ish review-loop assumptions — `update-*`/`respond-*`, the `-again` round-2 variants, round-2 discipline — as if every arc has them. Make it arc-neutral: the review-loop *shape* comes from the phase's snippets and brief; `-again`/round-2 variants apply only when the active phase exposes them. The RIR brief already steers against the Full assumptions, but for AFK robustness the system prompt must not contradict it.
- `prompts/orchestrator-identity.md`: rewrite the hardcoded "FRAME → SPEC → PLAN" (line 3) and "hand off at plan-approval" (line 25) to workflow-neutral language: "this session covers the attended arc up to the handoff gate; `get_task` tells you the current phase." (Authored against the two prompt refs; the cold-reader anchor — what duet is — stays.)

**Prompt design notes (rider).** The two new entry builders, the system-prompt neutralization, and the identity rewrite follow the five binding conventions (artifacts-first/task-last; thinking-framework-with-motivation; surface the implicit; errors prescribe recovery; results nudge next step) and the cold-reader rule. `research`/`implement` reuse Full's `*_EXAMPLES` few-shot style (74-115) with RIR-appropriate cases (synthesize-don't-average for research; single-pass-then-one-review for implement — no midpoint example).

**Tests** (extend `tests/orchestrator-prompts.test.ts` or equivalent):
- `buildPhaseBrief` is total over `PhaseName` (a `test.for` over every phase returns a non-empty brief).
- `research` brief names the Direction gate and the cross-framing pair; does not mention a spec.
- `implement` brief sequences kickoff → handoff → review → apply (handoff *before* review) and names the lean packet; does not mention midpoint, compaction, `ceo-summary`, or `respond-review`.
- system prompt: a light string assertion that the review-loop language defers to the phase's snippets/brief rather than naming `-again`/round-2 as universal (prose neutrality is mainly a review judgment; the assertion is the floor).
- identity.md contains no literal "SPEC"/"PLAN" arc and refers to `get_task` (string assertion, mirroring how `tests/skill.test.ts` reads the file).

**Verify.** `pnpm typecheck && pnpm test`.

---

## Slice 5 — Workflow-neutral surfaces: status, done-summary, `advance_phase` copy, `_mcp` membership

**Goal.** Remove the Full-baked strings/lookups the refactor would otherwise leave wrong for RIR, and close the `_mcp` membership leak. Retire the temporary `PHASES` alias (its last consumer — status rounds — migrates here).

**Changes.**
- `src/status.ts`:
  - `buildStatusModel` rounds (141) iterate `phasesOf(workflowOf(state))` instead of global `PHASES`.
  - done summary (201): read the *run's last phase* summary (`phasesOf(workflow).at(-1)`), not the hardcoded `phaseSummaries.open` — Full's last phase is `open`, RIR's is `implement`.
  - `describeStop` (24-33): the `done` line (25) stops asserting "the PR is open" — derive from the run (e.g. a neutral "run complete" with the PR line only when the arc has a `pr`/`open` phase).
- `src/harness/tools.ts`: `advance_phase`'s schema description (531) drops the Full-specific "lead with the CEO summary verbatim … `spec_path`" → workflow-neutral wording (the per-phase brief already carries arc-specific packet guidance). `spec_path` stays an optional field (only Full's spec phase sets it).
- `src/harness/mcp-server.ts`: `buildKernelTools` (36-55) — **load the run before validating the phase** (44 before 37), then require `phase ∈ phasesOf(workflowOf(state))`; the error names the run's workflow and its legal phases. `VALID_PHASES` (28) global is removed.
- `src/phases.ts`: remove the temporary `PHASES` alias and the flat `phaseOfGateState` overload now that every consumer is migrated. Grep `src/` and `tests/` for `PHASES`/flat `phaseOfGateState` as a refactor check.

**Tests** (extend `tests/status.test.ts`, `tests/mcp-server.test.ts`):
- RIR `done`: summary reads from `implement`; `describeStop(done)` makes no PR claim. Full `done` unchanged (reads `open`, PR line present).
- status rounds for a RIR run list only RIR's phases.
- `_mcp` membership: building tools for a `rir` run with phase `plan` throws a prescribed-recovery error; with `research`/`implement` it builds. (Real tmp run on disk — filesystem real, per conventions; no module mock.)

**Verify.** `pnpm typecheck && pnpm test`; grep confirms no `PHASES`/flat-`phaseOfGateState` references remain.

---

## Slice 6 — The selector: `--workflow` + `workflow:` frontmatter + workflow-scoped gate parsing

**Goal.** A run can be created as `full` or `rir` (flag wins over frontmatter, default `full`); `--workflow rir` + `--spec` is rejected; `gates_at` parses/validates against the chosen workflow. Lands *after* the runtime can drive/render/status RIR — this is the slice that makes `duet new --workflow rir` user-startable.

**Changes.**
- `src/framing.ts`:
  - `FramingFrontmatter` (277-281) + `frontmatterSchema` (283-287) gain `workflow?: string`; validate it ∈ `WorkflowName` (reuse the registry).
  - `parseGatesAt` (307-326) takes the workflow: validate names against `gatePhasesOf(workflow)` (312); resolve presets from `WORKFLOWS[workflow].presets`; force-append from `WORKFLOWS[workflow].forceAttend` instead of the hardcoded `pr` (324) — so RIR force-appends nothing. **A matched preset may resolve to an empty attended-gates list** (RIR's `afk` = `[]` ⇒ attend nothing): the empty-list rejection (319-323) applies *only* to the user-typed-list path, not to a matched preset — so `--gates-at afk` is legal while a literal empty `gates_at:` stays invalid (finding #6).
  - **`gates_at` key-present semantics** (finding #3a): `parseFramingFile` (334-377) currently calls `parseGatesAt` only when the value is *truthy* (373), so a literal empty `gates_at:` is silently ignored. Change the guard to **key-present** (`parsed.data.gates_at !== undefined`) so an empty value reaches `parseGatesAt` and is rejected — making "a literal empty `gates_at:` is invalid" actually hold.
  - `RunInputs` (380-392) gains `workflow`; `resolveRunInputs` (401-449) resolves `workflow` (flag > frontmatter > `'full'`), then parses `gatesAt` against it; reject `workflow === 'rir' && specInput` with an actionable message (mirror the `--template`+`--spec` guard at 405-409).
- `src/cli.ts`: `new` (116-197) gains `--workflow <full|rir>` (134-area), passes it into `resolveRunInputs` (143-149) and `createRun` (168-173); the roles/gates log line (180-182) can note the workflow.

**Tests** (extend `tests/framing.test.ts`, `tests/cli.test.ts`):
- precedence: flag `rir` beats frontmatter `full`; frontmatter `rir` with no flag → `rir`; neither → `full`.
- unknown `--workflow xyz` / `workflow: xyz` fails loudly with the valid set.
- `--workflow rir` + `--spec` rejected with the actionable message.
- `parseGatesAt('rir', …)`: a Full-only phase (`plan`) is rejected for `rir`; the `afk` preset resolves to `[]` (attend nothing); `pr` is *not* force-appended for `rir` (it is for `full`); a literal empty `gates_at:` is still rejected for both workflows.
- **key-present**: a frontmatter block with `gates_at:` and an empty value is rejected (reaches `parseGatesAt`), not silently ignored.
- (Pure parse functions — no seam; CLI option wiring tested through `program` like `tests/skill.test.ts` reads it.)

**Verify.** `pnpm typecheck && pnpm test`.

---

## Slice 7 — Skills: duet-frame emits `--workflow`; concierge arc diagram; skill-test coherence

**Goal.** The framing-author skill chooses and emits the workflow; the concierge text reflects both arcs; `tests/skill.test.ts` stays green and now sees `--workflow`.

**Changes.**
- `skills/duet-frame/SKILL.md`: add a "pick the workflow" step alongside gate posture (47-54) — full vs RIR, with the one-line meaning of each — and emit `duet new --interactive --workflow <full|rir> --framing …` (112). Gate-posture guidance becomes workflow-aware (RIR has only Direction + Ship). Authored against the prompt refs; cold-reader anchor intact.
- `skills/duet-concierge/SKILL.md`: the arc diagram (14-18) covers both arcs (or reads arc-neutral); the stop→command channel table (69-77) is unchanged (it keys off `stop.kind`, already workflow-agnostic). Note RIR has no PR/docs stops.
- `tests/skill.test.ts`: the verb/flag extraction (66-79) already pins flags against the CLI — it now sees `--workflow` on `new`; add an assertion that `duet-frame` names `--workflow` if we want it pinned. No phase-name hardcoding exists to change.

**Tests.**
- `tests/skill.test.ts` green: every verb/flag the skills name exists on the CLI (now incl. `--workflow`); frontmatter pre-approvals unchanged.

**Verify.** `pnpm typecheck && pnpm test`.

---

## Final verification

- `pnpm typecheck && pnpm test` — full suite green.
- The three guards are workflow-parameterized: `machine.test.ts` (arc walk + quiescent/tag set per workflow), `snippets.test.ts` (completeness across all workflows), `skill.test.ts` (verbs/flags incl. `--workflow`).
- The spec's named behaviors are covered: restore-defaults-arc (S1 resolver, S2 hydration path), RIR arc walk (S3), selector/validation + rir+spec rejection (S6), phase-membership + registry integrity (S1, S5), workflow-neutral completion (S5).
- Grep: no surviving global `PHASES` or flat `phaseOfGateState`; `gateAttended`/`parseGatesAt` read `forceAttend`/`gatePhasesOf`.
- The Full arc's existing tests pass unchanged throughout — the regression guard.

**Forward pointer (docs phase, not impl):** amend `CLAUDE.md` ("epic-shaped"/"Open-PR non-negotiable" → Full-scoped), `docs/future-directions.md` ("Arc presets" → superseded by RIR), and fold the surviving design present-tense into `automation-design.md`/`engineering.md`.
