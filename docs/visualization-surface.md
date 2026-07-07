# The visualization surface — `duet graph`

A read-only, render-on-demand CLI surface that draws duet's workflow shape and a run's live
trajectory. One command, two views, over one shared **workflow-spine** model — plus two
state-and-log deliverables that carry the run's execution history where its data actually lives.

Status: design, ratified at the gate (2026-07-07). The build executes from this document.

---

## Summary (what we're adding, and its edges)

Today the compiled workflow — stages, phases, gates and their default postures, duty bindings,
round caps, continuity edges, consultant checkpoints — is legible only by reading JSON or source,
and `duet status` shows a run's *stop* but never its *arc*. This adds a spatial, on-demand way to
see both.

**What ships:**

- **`duet graph --workflow <name>`** — the **blueprint**: the compiled workflow before any run,
  every materialized default visible at a glance, including the two things `duet workflows check`
  omits today (per-phase consultant checkpoints; the duty bindings). Renders the pipeline in the
  terminal, `--json`, or `--mermaid` (a static diagram for docs/PRs).
- **`duet graph [runId]`** — the **run view**: the frozen workflow with live position overlaid —
  done phases marked, current highlighted, future dimmed; each gate showing its posture and how it
  was (or will be) crossed; loop rounds as used/cap; a parked question or pending gate called out
  with its next command. Plus **drift flags** on any phase whose execution diverged from the
  expected shape (an unexpected snippet tag, rounds past cap, or a phase-attributed auto-retry/staged steer).
- **`duet stats [runId] --trace`** — the **interleaved execution timeline**: per phase, the actual
  turn sequence (duty, snippet tag, duration), with compactions, retries, and steers overlaid, and
  conservative ordering-drift detection. This lives in `stats` because that surface already owns the
  log format and is the per-run, log-reading command.
- **`duet workflows check <name>`** — enriched to render the blueprint spine's two new fields
  (consultant checkpoints, bindings) over the *same* model `duet graph --workflow` uses.

The former "trace view" is **relocated, not deferred**: its value splits into the run-view drift
flags (a) and the `stats --trace` timeline (b). Both are committed v1 deliverables of this run. If
either slips during the build, that is a new, explicit descope to raise — never a silent drop.

**In scope:** the two `duet graph` views over one shared spine composer; the `workflows check`
enrichment over that same composer; the run-view drift flags; `stats --trace`; a bounded
read-only workflow-source resolver; ANSI + `--json` + Mermaid render targets; tests; this doc.

**Explicitly out:** any interactivity or editing (view-only); any server, watcher, or auto-refresh
(render-on-demand only — the declined local-dashboard direction); cross-run or corpus-wide views
(author-side analytics stay in `scripts/corpus/`); any change to how runs execute; a Mermaid
emit for the run/trace views (blueprint only — see Non-goals).

**Deferred (one-line why each):** `status`/`stats` `--json` schema *changes* — the run view renders
*over* the pinned `StatusModel`, so no schema break is needed now; a general "snippet choreography
validator" — the registry lacks a full expected-partial-order metadata model, and building one is a
protocol remodel, not a visualization feature (ordering drift stays a conservative heuristic).

---

## Goals

1. **Every workflow default visible at a glance**, for shipped and project-composed workflows alike,
   resolved the way a run would actually resolve them on this machine.
2. **A run's whole arc legible with its cursor** — where it is, what's behind, what's ahead, what
   each gate did — in one on-demand snapshot, safely readable while a driver holds the run.
3. **Divergence from the expected shape surfaced mechanically**, not by hand-reading transcripts —
   the class of bug (a planning-stage snippet flow arriving out of order) that was once found only
   by eye.
4. **One shared structural model** behind the views, so blueprint and run don't re-derive the
   pipeline independently, and the surface can't drift from the resolvers it reads.
5. **View-time color only** — every file/JSON/Mermaid artifact stays plain text and raw UTC; color
   and local time are applied only where a human is watching (the standing `colorize.ts` rule).

## User-facing behaviors

### The command surface

```
duet graph --workflow <name>            blueprint (compiled workflow, no run)
        [--mermaid] [--json]
duet graph [runId]                       run view (defaults to latest run in this project)
        [--json]
duet stats [runId] --trace [--json]      interleaved execution timeline + ordering drift
duet workflows check <name>              enriched: now shows consultant checkpoints + bindings
```

`runId` defaults to the latest run exactly as `duet status`/`duet stats` do (`resolveRun`,
`surfaces/cli.ts:127`). With no runs and no `--workflow`, `duet graph` fails with the same
prescriptive "start one with duet new" message `resolveRun` already emits.

### View 1 — Blueprint (`duet graph --workflow <name>`)

Renders the compiled workflow as a vertical pipeline: stages and phases in order; each phase's block
and gate with its **default posture** (attended / auto-cross, from `defaultPosture`); each stage's
duty pair with its **config-resolved default binding** (provider · model · effort, from
`resolveRunConfig` with no flags/framing); round caps; continuity edges (and any that would degrade
to fresh under the resolved bindings); and per-phase **consultant checkpoints** when a consultant
would be bound, tagged by kind (generative / bet-audit / backstop).

Bindings render **as defaults, labeled** — "defaults · resolved against `~/.config/duet/config.toml`
(a run re-resolves and freezes at creation)". "Display every default at a glance" means *what would
actually run here*, so config is resolved; the label keeps the honesty that a real run's manifest is
frozen per-run, not read from this view.

`--mermaid` emits a static flowchart of the same spine (phases → gates, duty/posture annotations),
plain text, no ANSI — the docs/PR artifact. `--json` emits the blueprint model verbatim.

### View 2 — Run view (`duet graph [runId]`)

Renders the run's frozen workflow (`workflowFor(state)`) as the same pipeline, with the live overlay:

- **Phase status** — done (normal), current (highlighted), future (dimmed), derived from
  `probeRunPosition` + arc order (see Architecture).
- **Gates** — each shows its posture (attended vs pre-authorized, from `gatesAt`) and its crossing
  authority for a *passed* gate: **`auto-crossed`** when ledgered in `autoApprovals`, else
  **`crossed`**. The run view never claims **"attended"** for a past gate — state does not attest an
  explicit human approval (only auto-crossings are ledgered). A `high` human decision holding a
  pre-authorized gate is surfaced (from `phaseSummaries[phase].humanDecisions`).
- **Loop rounds** — used/cap per review-loop phase (from `state.rounds` + `roundCap`).
- **The current stop** — a parked question or pending gate is called out with its exact next command
  (reading the next command already carried on `StatusModel.stop`, so the two never diverge).
- **Phase drift flags** — per phase, a flag when execution diverged from the expected shape, using
  only signals state attributes to a phase: a snippet tag the phase's arc doesn't own (`sentSnippets`
  vs `phaseSnippetsFor`); rounds past cap (`state.rounds` > `roundCap`); an auto-retry in the phase
  (`autoRetries[].phase`); a steer staged during the phase (`stagedDuring`). All state-derived —
  reliable, no log read.
- **Run-level interventions** — context interventions (`contextEvents`: compaction / salvage / cutoff
  / session-reset) render as a **run/voice-level summary**, not a per-phase flag: `ContextEvent`
  carries `kind` / `voice` / `at` but **no phase** (`store.ts:71`), and the run view reads no logs, so
  it cannot honestly attribute a compaction to a phase. Per-phase attribution of context interventions
  is available only in `stats --trace`, by timestamp window.

### View 3's value — relocated, both v1

- **`duet stats [runId] --trace`** — per phase, the interleaved turn timeline: each turn's duty,
  snippet tag, and duration, in chronological order across duties; compactions (`contextEvents`) and
  retries (`autoRetries`) overlaid at their recorded `at`; steers overlaid at their **staging** time,
  labeled "staged" (not delivery — see below); and **conservative ordering drift** — a checker
  review-family turn repeating with no maker turn between (the exact rule is in Module boundaries).
  Designed for **mid-run** use: the current, still-running phase is included (its open window is
  synthesized), because a live trace whose most-relevant phase silently vanished would be a product
  regression. Built over `stats`'s existing parse exports plus any new trace parsing kept inside
  `stats.ts` — **no graph-owned log regexes**.
- The state-derived phase drift flags (and the run-level context-intervention summary) already
  described in the run view are the other half.

### Before / after

```
Workflow shape, before a run:
  before:  duet workflows check <name>   — text: phases, gate labels, caps, duty pairs, contract chain
                                           (NO consultant checkpoints, NO bindings)
  after:   duet workflows check <name>   — same + consultant checkpoints + config-resolved bindings
           duet graph --workflow <name>  — the pipeline drawn: ANSI · --json · --mermaid

Run trajectory:
  before:  duet status [runId]           — the STOP (packet / question / next command) + away-ledgers
  after:   duet status [runId]           — unchanged (pinned --json intact)
           duet graph  [runId]           — the whole ARC with cursor, gate outcomes, rounds, drift flags

Execution history:
  before:  duet stats [runId]            — per-phase elapsed + worker-turn aggregate + per-tag rollup
           (hand-read transcripts to see the actual turn interleaving / an ordering bug)
  after:   duet stats [runId]            — unchanged
           duet stats [runId] --trace    — the interleaved timeline + interventions + ordering drift
```

## Non-goals

- **No second run-state model.** The run view renders over the schema-pinned `StatusModel`; it does
  not fork a parallel model beside the concierge's contract.
- **No general graph-layout machinery.** duet workflows are linear pipelines with loops and gates —
  the render is a vertical annotated pipeline, hand-joined with box/pipe glyphs, not a DAG engine.
- **No new terminal-styling dependency.** Color reuses `view/colorize.ts` (picocolors, already a
  dep); layout is line-joining. (Argued exception to the "prefer a package" preference: a linear
  4–6-phase pipeline is trivial line assembly; a layout/TUI lib is the declined dashboard direction
  wearing a smaller hat.)
- **No Mermaid for the run/trace views.** A live cursor or a turn timeline in Mermaid adds little
  for a static docs/PR artifact; `--mermaid` is blueprint-only.
- **No workflow choreography validator.** Ordering drift is a conservative heuristic over the
  reliable signals, never a claim to validate the full expected snippet partial-order.
- **No write, anywhere.** No run-state mutation; and the blueprint path must not provision/scaffold
  workflow-dir files (below).

---

## Module boundaries and seams

The change is a **local addition** in `surfaces/`, plus one bounded prep refactor in the
workflow-source loader and **one small additive resolver export** in `registry/`. The surface
otherwise *composes* resolvers those layers already export. This respects the import-direction trust
gradient: a composer spanning `registry` + `voices` (bindings) + `run` (state/position) lives in
`surfaces/`, the `doctor.ts` cross-layer precedent.

```
src/registry/
  workflows.ts          EDIT — one additive export: consultantCheckpointView(workflow, phase, opts)
                               → { mode, kind: render-facing, live } | undefined (folds CHECKPOINT_KIND + consultantCheckpointLive)
src/run/
  steers.ts             EDIT — one read-only helper: listStagedSteersForTrace(state) (scans steers/ + delivered/, fail-soft)
src/surfaces/
  graph-model.ts        NEW — the shared workflow-spine composer + the two overlay builders + GraphModel
  graph.ts              NEW — the renderers (ANSI pipeline, --json, --mermaid) + CLI-facing entry
  workflows.ts          EDIT — renderWorkflowCheck builds the blueprint spine; adds checkpoints + bindings
  workflow-source.ts    EDIT — extract a no-provision resolver core; resolveWorkflowSource keeps provisioning
  stats.ts              EDIT — a trace model (buildTraceModel) + the open-window parsePhaseWindows extension + detectOrderingDrift
                               (as-built: the deferred `parseTraceEvents` for non-turn orch events was NOT built — steer delivery-time stays a named follow-up)
  status.ts             UNCHANGED — the run view reads its output; the pinned --json schema is not touched
  cli.ts                EDIT — wire `duet graph` (two modes) and `duet stats --trace`
```

**The one registry touch, justified.** The blueprint promises per-phase checkpoint *kind*
(generative / bet-audit / backstop), but the kind mapping (`CHECKPOINT_KIND`) is module-private
(`registry/workflows.ts:426`) and uses the internal name `challenge` for the bet-audit — exporting a
single `consultantCheckpointView(workflow, phase, { consultant, gateless }) → { mode, kind, live } |
undefined` (over the existing private map + `consultantCheckpointLive`) is cleaner than making
`surfaces/` re-encode the protocol taxonomy. The export returns the **render-facing** `kind`
(`challenge` → `bet-audit` mapped inside the registry), so one call returns everything the blueprint
renders and the surface stays entirely taxonomy-free — it never sees `challenge`.

### The shared spine — one structural core, two overlays (deep module)

The spine is the shared truth blueprint and run both lean on. It is **one structural core** with
**two overlay builders**, not a god-model:

The shapes below are the **as-built** types (reconciled after the build); two
tactical corrections against the original sketch are called out inline.

```ts
// The structure — identical for blueprint and run, since both read a CompiledWorkflow
interface PhaseNode {
  name: PhaseName;
  block: 'frame' | 'doc-loop' | 'build' | 'finish';
  artifactKind?: ArtifactKind;                // doc-loop only — the block-summary knob (as-built: added, so
  reviewPosture?: ReviewPosture;              // build only     — both graph + workflows-check render `doc-loop (spec)` / `build (critique)` from the model)
  stage: StageName;
  gate: { label: string; state: string };
  duties: { maker: Duty; checker: Duty };   // the phase's stage duties
  reviewLoop: boolean;
  roundCap?: number;                          // present when reviewLoop
  consultantCheckpoint?: ConsultantCheckpoint;
  // NOTE (as-built): `continuityFrom` was REMOVED from PhaseNode. Continuity is
  // stage-scoped (a delivery stage carries two edges: builder←architect AND
  // critic←analyst), which a singular per-phase Duty can't hold — it lives on the
  // stage node below. Binding-dependent degradation stays overlay data (see GraphModel).
}
interface StageNode {
  name: StageName;
  duties: { maker: Duty; checker: Duty };
  continuity: Partial<Record<Duty, Duty>>;    // declared edges keyed by the continuing duty, e.g. { builder: 'architect', critic: 'analyst' }; {} = fresh
}
interface WorkflowSpine {
  name: string; displayName: string; source?: WorkflowSource;
  phases: PhaseNode[];
  stages: StageNode[];
  defaultPosture: GatePhase[] | undefined;    // attended set; undefined ⇒ attend-all
}

// The one shared core (deletion test: delete it and blueprint + run each re-join
// phase→gate→stage→cap→edge→checkpoint from the raw resolvers).
function structuralSpine(workflow: CompiledWorkflow): WorkflowSpine

// Overlay 1 — blueprint: config-resolved default bindings + live consultant checkpoints
function blueprintModel(workflow: CompiledWorkflow, source: WorkflowSource | undefined,
                        resolved: { bindings: VoiceBindings; degradedEdges: DegradedEdge[] }): BlueprintGraphModel

// Overlay 2 — run: position + gate outcomes + rounds + state-derived drift, over StatusModel
function runGraphModel(frozenWorkflow: CompiledWorkflow, status: StatusModel, state: RunState, pos: RunPosition): RunGraphModel

interface BlueprintGraphModel {
  mode: 'blueprint'; spine: WorkflowSpine; bindings: BindingRow[]; degradedEdges: DegradedEdge[];
  checkpoints: PhaseCheckpoint[];              // { phase, mode, kind: render-facing, live } — see the registry export below
}
interface RunGraphModel {
  mode: 'run'; runId: string; spine: WorkflowSpine; nodes: RunNodeState[]; stop: StopModel;
  degradedEdges: DegradedEdge[];              // as-built: the run applies degradedEdgesFor(state.bindings) over the FROZEN manifest,
                                              // so the arc never implies an edge the run's providers made fresh
  interventions: ContextEvent[];             // contextEvents at RUN level — no phase in the state shape
  ledgers: { autoApprovals: StatusModel['autoApprovals']; awayRetries: StatusModel['awayRetries'] };
}
type GraphModel = BlueprintGraphModel | RunGraphModel;

interface RunNodeState {
  phase: PhaseName;
  status: 'done' | 'current' | 'future';
  gate: { posture: 'attended' | 'pre-authorized'; outcome?: 'auto-crossed' | 'crossed'; heldHigh?: true }; // non-optional: every phase gates
  rounds?: { used: number; cap: number };
  drift: DriftFlag[];                          // unexpected-tag | rounds-past-cap | auto-retry | steer-staged (all phase-attributed)
}
```

`PhaseNode.consultantCheckpoint` carries the static **mode**; the blueprint overlay enriches each phase
to `{ mode, kind, live }` via a small new registry export, `consultantCheckpointView(workflow, phase,
{ consultant, gateless })` (below) — so the surface never duplicates the private checkpoint taxonomy
(`CHECKPOINT_KIND` is module-private in `registry/workflows.ts:426`; only `isBackstopCheckpoint` is
exported today). Crucially the export returns the **render-facing** kind
(`'generative' | 'bet-audit' | 'backstop'`), mapping the internal `challenge` → `bet-audit` inside the
registry — otherwise the surface would have to know that `challenge` displays as `bet-audit`, re-leaking
the very taxonomy the export exists to hide.

`structuralSpine` reads only `registry/workflows.ts` resolvers (`phasesOf`, `stagesOf`, `gateOf`,
`stageOf`, `phaseSpec` for `roundCap`/`reviewLoop`/`consultantCheckpoint`, `continuityEdgeFor`,
`defaultPosture`+`gatePhasesOf`+`defaultPreAuthorizedOf`). It is pure and in-process — no adapter, no
seam at its interface; its only input is a `CompiledWorkflow`, which for the run comes from
`workflowFor(state)` (the frozen artifact) and for the blueprint from the resolver below. That both
paths feed the *same* `CompiledWorkflow` shape is why one core serves both without collapsing into a
god-model: the structure is identical; only the overlay (defaults-vs-frozen + live position) differs.

The **run overlay renders over `StatusModel`, it does not duplicate it.** `StatusModel` already
carries the arc (`workflowDetail.phases`/`stages`/`duties`/`edges`), `rounds` (used/cap), `gatesAt`,
`autoApprovals`, `awayRetries`, `contextEvents`, and the discriminated `stop` with its next command.
`runGraphModel` consumes those; the *one* signal `StatusModel` doesn't carry — the snippet-flow drift
— it derives directly from `state.sentSnippets` vs `phaseSnippetsFor`. No `StatusModel` field is added
or changed.

### The `stats` trace — over the existing cores, no *graph-owned* regexes

`stats.ts` owns the log-format knowledge and must keep owning it. The trace adds models to `stats.ts`,
never a parser to `graph.ts` — **no graph-owned log regexes; any new trace log parsing stays inside
`stats.ts`**:

```ts
interface TraceModel {
  runId: string;
  phases: { phase: string; inferredWindow: boolean; turns: TraceTurn[]; interventions: TraceEvent[]; drift: OrderingFlag[] }[];
  notes: string[];
}
function buildTraceModel(state: RunState, now: number): TraceModel   // fs+state composer, sibling of buildStatsModel; `now` INJECTED (CLI passes Date.now(), tests a fixed clock) so the open-window JSON is deterministic
```

`buildTraceModel` reuses `parseVoiceLogTurns` (per-worker `ParsedTurn{voice,tag,startMs,endMs,status}`),
`parsePhaseWindows` (closed-window attribution + the `inferred` flag), and `phaseForTurn` (the one
shared attribution rule) — all already exported. Three things it adds:

- **An open current-phase window (P1b).** `parsePhaseWindows` emits a window only on an `advance_phase`
  *close* (`stats.ts:115`); a phase still running has no close, so its turns would orphan as
  `unattributed` (`stats.ts:321`) — silently dropping the phase a live trace most needs. The fix stays
  **in the stats parse core and adds no run state** (`state.phaseStarted` is a boolean marker, not a
  timestamp — `store.ts:260`): the core exposes the **open** window alongside the closed ones. Its start
  is inferred exactly as closed interactive windows already are (`parsePhaseWindows` uses the recorded
  `◀ harness prompt` open for a headless phase, else `lastCloseMs ?? runStartMs`, where `runStartMs` is
  `state.createdAt`) — real for a headless current phase, `inferred` for an interactive one, carrying the
  same approximate note. `buildTraceModel` closes it at an **injected `now()`** (tests supply a fixed
  clock) and attributes turns through it. Aggregate `stats` behavior is untouched — the open window is
  additive output the aggregate path ignores.
- **Interventions at their state timestamps (P1c).** `contextEvents` and `autoRetries` carry an `at`
  and are placed on the timeline by time (context interventions attributed to a phase by timestamp
  window — the one place phase attribution of a `contextEvent` is honest, because here windows exist).
  **Steers render at `stagedAt`, labeled "staged"** — the human's staging action, phase from
  `stagedDuring` — *not* delivery time. A trace of "what happened" must include **already-delivered**
  steers, which `markSteersDelivered` renames into `steers/delivered/` (`steers.ts:73`) — but the only
  existing reader, `listPendingSteers`, scans staging only (`steers.ts:51`). So the trace adds a
  read-only helper, **`listStagedSteersForTrace(state)`**, that fail-soft scans **both** `steers/` and
  `steers/delivered/`, sorts by filename/`stagedAt`, and tolerates a mid-scan rename race (a file that
  moved between the two dirs appears once or neither, never throws). Delivery / carry-forward time
  appears only in orchestrator-log lines (`orchestrator/tools.ts:1796`, `hosts/driver.ts:345`); rendering
  it would need a stats-owned `parseTraceEvents` for non-turn orchestrator events. v1 uses the **lossless
  persisted staging timestamps** and labels them honestly; delivery-time precision is a named follow-up
  (Open questions), and if added it lands as `parseTraceEvents` inside `stats.ts`.
- **The ordering-drift rule (P2b), stated narrowly.** A new pure function beside the parse core, on
  `ParsedTurn.startMs`, with the turn's duty typed as `VoiceAddress` (turns can include `consultant`):
  **flag two consecutive checker review-family turns in the same phase when no maker turn started
  between them.** Review-family is `countsReviewRound(address, tag)` (`policy.ts` — catalog-driven via
  `ACTION_CATALOG`, deliberately *not* `tag.startsWith('review')`, and already consultant-safe); a maker
  turn is **`address !== 'consultant' && stageOfDutyLane(address) === 'maker'`** — the consultant guard
  is required because `stageOfDutyLane` takes a `Duty` and `'consultant'` is not one (`vocabulary.ts:277`).
  That is the whole v1 rule — a review round with no intervening maker response is the ordering bug the
  feature targets. Anything broader (a full expected partial-order over the snippet families) is the
  deferred choreography validator (Non-goals). The detector is not shared with the run-view drift —
  different inputs (log timeline vs state sets); forcing a shared "drift engine" would be a shallow
  abstraction.

### Coupling decisions (design-it-twice)

- **The spine is an extension of an existing concept, not a new one.** It is the `CompiledWorkflow`
  projected for display — the same data `renderWorkflowCheck` and `StatusModel.workflowDetail` half-
  build today, given one home. `workflows check` is reworked to build the blueprint spine (killing
  the latent duplication at its root); `StatusModel` is *not* reworked to consume the spine now (it is
  pinned and works — see Foundation), so the run view reads its output instead. The spine earns its
  keep by the deletion test across `graph` (both views) + `workflows check`; adopting it into
  `status` later is a clean, additive follow-up, out of scope here.
- **Two real render adapters at the spine's output** justify the `mode` discrimination: blueprint
  (config bindings, no position) and run (position overlay, frozen bindings). The trace is a *third
  kind of thing* (a log timeline, not a structural projection), so it is deliberately independent in
  `stats.ts` rather than a third `GraphModel` mode — one adapter would be a hypothetical seam.

## The foundation decision — the no-provision resolver (bounded prep)

`resolveWorkflowSource` (`workflow-source.ts:270`) is **not read-only**: on any existing project/user
workflow dir it calls `provisionWorkflowDir` (`:277–278`), which `writeFileSync`s a `tsconfig.json`
and a version-stamped `.d.ts` stub (`:164–172`). That is correct for `workflows check` and `duet new`
(the author is working the file; scaffolding their editor is welcome) but wrong for `duet graph
--workflow`, which must not write.

**The prep move, sized to this feature:** extract the resolution *core* — candidate discovery,
the shadowing/not-found rejections, and `loadWorkflowFile` — as a shared private function, and expose
two thin entry points:

```
resolveWorkflowSource(cwd, name, opts)          = provision project/user dirs, then core   (check / new — unchanged behavior)
resolveWorkflowSourceReadOnly(cwd, name, opts)   = core only, no provision                  (duet graph --workflow)
```

This makes "graph writes files" unrepresentable by construction rather than a boolean a caller could
pass wrong (illegal-states-unrepresentable), and it is two genuine adapters (provision / no-provision)
with two real callers — a real seam, not indirection. Shipped workflows already take a no-write path
(`return validatedWorkflowSpec(workflowDefinition(name))`), so only the project/user path changes.

**What compiling still does, documented plainly:** loading a project-composed definition
**executes its top-level code** via dynamic `import` (`loadWorkflowFile:250`) and registers an
in-process module-resolve hook for `duet/workflows` — exactly as `duet workflows check` does today.
The read-only resolver removes the *filesystem writes*; it cannot remove code execution, because
compiling any definition means running it. The blueprint of a *shipped* workflow executes nothing and
writes nothing (fully read-only). This is the honest boundary, stated so the builder and a later
reader both inherit it.

**Left deliberately alone:** `StatusModel` and its pinned `--json` schema (the run view reads it,
doesn't reshape it); `stats`'s existing model and regex ownership (the trace extends, doesn't fork);
`provisionWorkflowDir`'s behavior for `check`/`new` (unchanged).

## Architecture sketch — data & control flow

**Blueprint** (`duet graph --workflow <name>`):

```
name ─▶ resolveWorkflowSourceReadOnly(cwd, name) ─▶ CompiledWorkflow (+ source)
                                                     │  (shipped: no import/write; project: import, no write)
     resolveRunConfig({ workflow }, CONFIG_PATH) ─▶ { bindings, degradedEdges }   (config + shipped defaults; no flags)
                          structuralSpine(workflow) ─▶ WorkflowSpine
     blueprintModel(workflow, spine, bindings) ─▶ GraphModel{mode:'blueprint'}
                          consultantCheckpointView(wf, phase, {consultant: !!bindings.consultant}) per phase ─▶ {mode, kind, live}
     render: ANSI pipeline | --json (verbatim) | --mermaid (flowchart, plain text)
```

**Run** (`duet graph [runId]`):

```
runId ─▶ resolveRun(cwd, runId) ─▶ RunState
      workflowFor(state) ─▶ CompiledWorkflow (frozen)         probeRunPosition(state) ─▶ RunPosition
      buildStatusModel(state, position, pendingSteers) ─▶ StatusModel     (existing, pure, no log read)
      structuralSpine(frozen) ─▶ WorkflowSpine
      runGraphModel(frozen, status, state, position):
        per phase: status = done|current|future  (arc order vs position.phase — see below)
                   gate    = posture (gatesAt) + outcome (autoApprovals ? auto-crossed : crossed) + heldHigh
                   rounds  = state.rounds / roundCap
                   drift   = sentSnippets vs phaseSnippetsFor · rounds>cap · autoRetries[].phase · steer stagedDuring
        run-level: interventions = state.contextEvents (voice/kind summary — no phase in the shape)
                   stop          = status.stop (next command read off it, not re-derived)
      render: ANSI pipeline with cursor | --json (verbatim)
```

**Done/current/future** derivation, stated precisely (a named rabbit hole): the "current" phase is
`position.phase` for the `running` / `gate` / `flag` / `crashed` / `interactive` kinds. A node is
`done` if it precedes the current phase in arc order (`phasesOf` index), `current` if it equals it,
`future` if it follows. A `gate` position marks its phase `current` with the gate annotation (the
phase's work is done, it waits at the gate). `done` position ⇒ every node `done`, no cursor.
`abandoned` position ⇒ no reliable phase (the position kind carries none), so the arc renders with
**no live cursor** and a banner that the run was abandoned (revive with `duet continue`) — it does not
guess a current phase.

**Trace** (`duet stats [runId] --trace`):

```
runId ─▶ resolveRun ─▶ RunState ─▶ buildTraceModel(state, now):
      read orchestrator.log + each worker.log (fail-soft, like buildStatsModel)
      parsePhaseWindows(orch, createdAt) ─▶ closed windows + the OPEN current window,   (P1b)
                          start real (headless ◀-open) or inferred (interactive: lastClose ?? createdAt); end = now
      parseVoiceLogTurns(voice, log)      ─▶ ParsedTurn[] per duty
      phaseForTurn(windows, startMs)      ─▶ attribute each turn (incl. the live phase) to a phase
      overlay: contextEvents/autoRetries at their `at`; listStagedSteersForTrace (staging + delivered),
                          steers at `stagedAt`, labeled "staged"                                     (P1c)
      detectOrderingDrift on startMs: 2 consecutive checker review-family turns (countsReviewRound)
                          in a phase with no intervening maker turn                                   (P2b)
                          (maker = address !== 'consultant' && stageOfDutyLane(address)==='maker')
      render: per-phase interleaved timeline | --json (verbatim)
```

## Test standards

Tests are behavior-through-interface (`tests/` standalone, `test.extend` fixtures composing tmp
project → run on disk → fake workers). Fake only at the seams; filesystem and git run real in
tmpdirs. Mirror the existing `status.test.ts` / `stats.test.ts` / `workflows` suites.

**Behaviors that must be tested, and how to think about each:**

- **The spine is correct for every shipped workflow** — through `structuralSpine` / `blueprintModel`:
  phase order, gate labels/postures, duty pairs, round caps, continuity edges, and per-phase consultant
  checkpoints with their `kind` (via `consultantCheckpointView`) present for a consultant-bound config
  and absent otherwise. Assert on the model, not the rendered string, so the test survives render
  tweaks. Include a project-composed workflow fixture (a `.duet/workflows/<name>.ts`) to prove parity of
  the compiled path. Add a registry-level test for `consultantCheckpointView` itself (mode + kind + live
  across consultant-bound / gateless), since the kind taxonomy now has an exported reader.
- **Blueprint bindings are config-resolved and labeled as defaults** — through `blueprintModel` with a
  stubbed `CONFIG_PATH` fixture: a config `[duties.builder]` override shows in the model; absent
  config shows shipped defaults; degraded edges surface. The label is a render concern; pin it in the
  renderer test.
- **The blueprint path is read-only** — the load-bearing safety test. Through
  `resolveWorkflowSourceReadOnly`: run it against a project workflow dir and assert **no file was
  written** (snapshot the dir's mtimes/contents, or spy the `fs` write boundary) — while
  `resolveWorkflowSource` on the same dir *does* provision. This is the regression guard for the prep
  refactor. Test that a shipped-workflow blueprint neither imports nor writes.
- **Run view status/gate/rounds/drift** — through `runGraphModel` fed a `RunState` + a scripted
  `RunPosition` (the position probe is pure and injectable): a `gate` position marks the right node
  current with `crossed`/`auto-crossed` per `autoApprovals`; a `high` decision sets `heldHigh`; a
  `sentSnippets` entry for a foreign tag raises an unexpected-tag flag; `rounds` > cap raises the cap
  flag; an `autoRetries[].phase` / `stagedDuring` entry raises the phase's auto-retry / steer flag;
  `abandoned`/`done` render no live cursor. Assert the model.
- **Context interventions are run-level, not per-phase** — a `contextEvents` entry surfaces in the
  run-model's `interventions` (voice/kind), and does **not** appear as a per-phase drift flag (it has
  no phase to attach to). This encodes the state-shape limitation as a behavior.
- **Run view never says "attended"** — an explicit negative test: a completed gate with no
  `autoApprovals` entry renders `crossed`, never an invented attended-approval. This encodes the
  ledger limitation as a behavior.
- **Read-only-while-a-driver-holds-the-run** — the run view (like `status`/`stats`) only reads
  `state.json`, the frozen `workflow.json`, and logs; assert it builds cleanly against a run dir with
  a live `driver.pid` and mutates nothing.
- **Trace over the real cores** — through `buildTraceModel` with fixture logs: turns attribute to
  phases via the shared rule; a headless-phase log yields precise windows while an interactive-phase
  log (advance without an entry header) yields an `inferred`/approximate note carried into the model.
- **Trace shows the live/open phase (P1b)** — the explicit guard: a running phase with **no
  `advance_phase` yet** still has its worker turns attributed (via the open window the parse core now
  emits, closed at an injected fixed `now()`), not dropped as unattributed. Cover both a headless open
  phase (real `◀`-open start) and an interactive open phase (inferred start + note). Named regression test.
- **Steers render at staging time, labeled, from both dirs (P1c)** — a staged steer appears at its
  `stagedAt` in its `stagedDuring` phase, labeled "staged"; the trace does not claim delivery time.
  The load-bearing guard: an **already-delivered** steer (renamed into `steers/delivered/`) still
  appears — `listStagedSteersForTrace` reads both dirs. `contextEvents` / `autoRetries` land at their `at`.
- **Ordering drift is exactly the narrow rule (P2b)** — it fires on two consecutive checker
  review-family turns in a phase with no maker turn between them; it does **not** fire when a maker turn
  interleaves, nor on anytime/repeat snippets, nor on a non-cataloged tag (`countsReviewRound` is
  catalog-driven). Include a **consultant turn between two reviews**: it must not count as the maker
  interleave (the `address !== 'consultant'` guard), so drift still fires. Test the positive, the
  maker-interleaved negative, and the consultant-between case.
- **Additive `--json`** — pin `duet graph --json` (both modes) and `duet stats --trace --json` with a
  keys snapshot, the `status`/`stats` discipline: the schema is additive-only and stays raw UTC. This
  is a *new* pinned surface (graph/trace), distinct from `status`'s pinned schema, which stays
  byte-for-byte unchanged (assert that too).

**Testing gotchas to flag:** the trace's per-phase **elapsed** is approximate for
interactively-orchestrated phases (window inference) — test the *note*, not an exact duration, for
those; per-turn **duration** and **sequence** are reliable and *can* be asserted exactly. Don't test
past the spine interface into the private join helpers — the model is the test surface.

---

## Rabbit holes — resolved or scoped

- **Trace durations for interactive phases (honesty line).** A turn's own `start→end` is logged in the
  worker log by the interactive host's settle, so **per-turn duration and cross-duty sequence are
  reliable for every phase**. Only the *phase window* (orchestration elapsed) is inferred for
  interactively-orchestrated phases (`parsePhaseWindows` synthesizes it from the gate crossing and
  flags `inferred`). Resolution: the timeline and the ordering heuristic use per-turn `startMs`
  (reliable); phase-elapsed carries the existing `inferred`/approximate note through to the model.
  The ordering bug the feature targets is thus detectable even in planning stages, which is where it
  historically occurred.
- **No-provision resolver seam.** Resolved above — extract the core, two entry points; only the
  project/user path changes; code-on-import is documented as irreducible.
- **Done/current/future.** Resolved above — arc-order vs `position.phase`; gate ⇒ current-at-gate;
  abandoned/done ⇒ no live cursor.
- **Mermaid scope.** Blueprint only, static flowchart of the spine; run/trace excluded (Non-goals).
- **Live-phase attribution in the trace (P1b).** Resolved — the stats parse core exposes an open
  current window (start real for a headless phase, inferred for an interactive one, exactly as closed
  interactive windows already infer), closed at an injected `now()`; **no run-state change**
  (`phaseStarted` is a boolean marker, not a timestamp). Aggregate stats untouched; named regression test.
- **Intervention attribution (P1a/P1c).** Resolved — a `ContextEvent` carries no phase, so the run view
  keeps context interventions **run-level**; the trace attributes them to a phase only where windows
  exist (by timestamp). Steers render at **staging** time, labeled, read from both `steers/` and
  `steers/delivered/` (`listStagedSteersForTrace`) so a delivered steer isn't lost — delivery time is deferred.
- **`sentSnippets` fidelity (scoped, not a hole).** `state.sentSnippets` records **base templates
  only, deduped, in first-seen order** (`tools.ts:516`). That is exact for the run-view drift signals
  (a foreign base-template tag is unambiguous; a re-send is intentionally invisible there). It is
  *not* a full interleaving — which is why the ordering heuristic lives in `stats --trace` over the
  log timeline, not over `sentSnippets`. The two drift computations are deliberately separate.

## Blueprint exposure — settled

`duet graph` is the canonical visualization entry (the README verb for "see a workflow or a run");
`duet workflows check <name>` keeps its authoring-check role, now enriched over the *same* spine. Both
are real commands — neither is a thin alias — and both render the blueprint projection, so the shared
spine (not a duplicated join) is what keeps them from drifting.

## Named follow-ups (out of scope here)

- **Run-view drift flags in `status --json`.** State-derived and cheap, but this ships them in the run
  graph only (`status` untouched). If a future concierge/remote need wants them in the pinned status
  model, that is an additive follow-up — **not** in this release.
- **Steer delivery-time precision.** The trace renders steers at their **staging** time (labeled,
  lossless from state); true delivery / carry-forward time lives only in orchestrator-log lines, and
  surfacing it would add a stats-owned `parseTraceEvents` over those non-turn events — an additive
  follow-up, **not built** here.
- **Pre-existing `NaN`-stamp gap on the live steer path (not this feature's, flagged not fixed).**
  `listStagedSteersForTrace` now validates a steer's body shape before use, so a malformed steer can't
  crash the trace render. Its sibling `listPendingSteers` — which feeds the *live delivery* read path
  and `status`'s steer rendering — does **not** validate shape, so a malformed-but-parseable steer
  (missing/non-string `stagedAt`) could still surface a `NaN` stamp there. Left untouched deliberately:
  hardening the delivery path is "a change to how runs execute," a separate pre-existing concern, not
  this read-only feature's to make.
