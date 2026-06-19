# Plan: Claude-as-orchestrator — Stage 1 (the interactive orchestrator)

Implementation plan for the approved spec `docs/specs/claude-as-orchestrator.md` (Stage 1). The spec is the authority for *what*; this file is *how*. It is self-contained: impl runs AFK and context may compact, so re-anchor on this file plus the spec.

## Orientation (read before the slices)

- **Authority.** `docs/specs/claude-as-orchestrator.md` (what to build). `docs/engineering.md` (the codebase's mental model — §Seams, §XState usage, §Testing strategy, §Patterns). For any slice that authors prompt / tool-description / identity prose (Slices 2, 5, 6), the governing authorities are `docs/prompting-and-tool-design.md` (duet's durable prompting rules + the 5 binding conventions) and `docs.local/prompt-engineering/skill.md` (the authoring craft) — re-read the relevant parts at the top of those slices.
- **Conventions (non-negotiable).** Behavior-through-interface; **fake only at the seams in `docs/engineering.md` §Seams, never mock our own modules** (the relevant seams here: `Orchestrate` in `stdio-host.ts`, the `phaseDriver` actor via `machine.provide`, and Environment/process-spawn for the launcher — see Slice 5). Erasable TS only (no `enum`/`namespace`/param-properties), explicit `.ts` import extensions, no dev build step (Node 24 runs `.ts`). Filesystem + git run real in tmpdirs (`tests/helpers/fixtures.ts`). Time via fake timers only where needed.
- **Test layout.** Standalone `tests/`, composed via `test.extend` (`tests/helpers/fixtures.ts`: `projectDir` → `run`). Scripted statechart in `tests/helpers/scripted-machine.ts`. Patterns to mirror: `tests/lifecycle.test.ts` (probe + `driveToQuiescence` over disk), `tests/tools.test.ts` (call a handler, assert `result.isError` + text + `run.terminalMarker`), `tests/mcp-server.test.ts` (in-memory MCP client/server; real subprocess in `tests/stdio-host.test.ts`), `tests/skill.test.ts` (skill coherence).
- **Verification cadence.** `pnpm typecheck` + `pnpm test` at the end of Slices 1, 2, 3, 4, 5 and once more at the very end. Not every change. Each slice = one commit (conventional message; one slice per commit, don't engineer boundaries).
- **Doc updates are explicitly deferred** to a post-implementation step, per this run's convention. Do **not** touch `README.md`, `docs/automation-design.md`, `docs/engineering.md`, `docs/future-directions.md`, or `CLAUDE.md` in these slices — except the spec's own deferred-doc note already records this. (`docs/open-questions.md`/`future-directions.md` syncing happens in the later `/update-docs` pass.)

## Resolved open questions (tactical calls, recorded here)

1. **Post-terminal tool partition.** While a current-phase terminal marker is set: **open** = `get_task` only (the status/re-anchor read). **Refused** with the "this phase is ending" nudge = `send_prompt`, `list_snippets`, `create_branch`, `propose_snippet_edit`, `write_note`. (`advance_phase`/`ask_human` are already refused by the existing `terminalAlreadySet`/`alreadyEnding` rail, `tools.ts:99`.)
2. **`get_task` name.** Keep **`get_task`** — it is the verb the orchestrator naturally reaches for ("what's my task?"), and it is *effectively idempotent from the model's view* (re-callable; the entry-prompt body is returned every time, the side effects fire once). Honesty about the mutation lives in the tool description (surface-the-implicit, per the prompting doc), not in a `claim_`/`begin_` name that would read as a heavier commit than it is. No `readOnlyHint`.
3. **`duet continue` attached-vs-dead detection + headless fallback.** No liveness detection is needed for correctness: the inline transition (Slice 4) persists the next resting position regardless of whether a session is attached; an attached session picks it up via `get_task`, a dead one simply leaves the run resting until the human relaunches `duet orchestrate <runId>`. The explicit, named **headless fallback** is `duet continue <runId> --headless`: it clears `orchestrationHost` and hands the current phase to a detached `_drive` (so a phase begun interactive finishes headless). `takeover`/`abandon` never read `orchestrationHost`, so they already ignore it — nothing to change there beyond a test pinning it.
4. **Identity-delivery file layout (reuse-not-duplicate).** `skills/duet/SKILL.md` carries the human-facing skill (frontmatter + the role narrative, like the concierge). The launcher feeds the orchestrator's **operating identity** to the session via `--append-system-prompt-file` pointed at **`skills/duet/identity.md`** — a sibling file in the skill dir holding the system-prompt-strength identity text. `SKILL.md` references `identity.md` by relative link and does **not** restate it (the body summarizes the role and points at the launcher; the identity file is the canonical prose). One source of truth for the identity, two consumers (the `/duet` skill description for discoverability; the launcher for the running session).
5. **`orchestratorCostPartial`.** A new additive `RunState.costs` boolean (Slice 7), **distinct** from `orchestrationHost`: `orchestrationHost` is mutable (set at launch, cleared at handoff), but the *fact* that orchestrator spend went unmetered must persist past the handoff — so `orchestratorCostPartial` is sticky (set true, never cleared). Never overload `orchestratorUsd`. Mirrors `claudeWorkersCostPartial` (`run-store.ts:137`).

## Slices

### Slice 1 — The interactive resting model (machine variant, host marker, probe positions)

**One idea:** define *where an interactive run rests between gates* and *how that rest is read off disk* — deleting the current "a non-quiescent phase-loop snapshot means crashed" assumption for interactive runs. Foundation for Slices 3 and 4. Subtle (snapshot restability + probe contract change) → **strict red-green-refactor**.

**Changes:**
- `src/run-store.ts`: add `orchestrationHost?: 'interactive'` to `RunState` (interface ~`:60`); default unset in `createRun` (`:197`). Sticky/mutable per Resolved-Q5/Slice-4 — set in Slice 5, cleared in Slice 4. (Headless runs never set it → fully backward-compatible.)
- `src/harness/machine.ts`: export an **`interactiveMachine`** built via `duetMachine.provide({ actors: { phaseDriver: <non-driving callback actor> } })` — mirrors `stdioPhaseMachine` (`stdio-host.ts:141`) and the test `scriptedMachine`. The provided `phaseDriver` does **no external work** and never `sendBack`s a `phase.*` event, so a restored phase-loop snapshot re-invokes it harmlessly (the property the persistence guardrail needs — `machine.ts` header comment, engineering §XState "restore never resumes an invoke"). Note in a comment: `provide` swaps the actor, it does **not** remove the `invoke`; restability comes from the actor being inert, not absent.
- `src/harness/lifecycle.ts`: extend `RunPosition` (`:126`) with `{ kind: 'interactive'; phase: PhaseName }`. Extend `probeRunPosition`/`stoppedPosition` (`:134`/`:150`): when `state.orchestrationHost === 'interactive'` and no live driver —
  - a current-phase **`terminalMarker` set** ⇒ derive the parked stop from the marker: `{ kind: 'gate', phase }` for `kind: 'advance'`, `{ kind: 'flag', phase }` for `kind: 'flag'` (this is the spec's "probe reports the gate/flag from the marker"; today the probe does not consume `terminalMarker`);
  - **no marker** ⇒ `{ kind: 'interactive', phase }` where `phase` is the resting phase: derived from the restored interactive snapshot's phase-loop value, or the entry phase (`specPath ? 'spec' : 'frame'`) when there is no snapshot yet (first phase, never parked). A phase-loop snapshot must **not** fall through to `crashed`.
  - Headless runs (`orchestrationHost` unset) keep today's exact behavior — guard the new branch on the marker.
- `src/status.ts`: `describeStop` / the `status --json` `stop` union gets an `interactive` arm (renders "the interactive orchestrator is driving the <phase> phase"). Additive only (Slice 7 guards the schema test).

**Helpers/fixtures:** none new; reuse `scriptedMachine`, `driveToQuiescence`, `loadMachineSnapshot`, and a new tiny test helper `restInteractive(state, phase)` only if needed to persist a phase-loop snapshot (it may be simpler to drive the `interactiveMachine` directly in-test). A `run.extend` fixture variant `interactiveRun` (a `run` with `orchestrationHost: 'interactive'` saved) added to `tests/helpers/fixtures.ts`.

**Tests (`tests/lifecycle.test.ts` + `tests/machine.test.ts`):**
- `interactiveMachine`: sending `phase.advance` from a phase-loop reaches the gate; sending `human.approve` from the gate reaches the **next phase-loop** and a `getPersistedSnapshot()` round-trips (restore → same value) without running any driver work (the provided actor records nothing).
- probe — interactive, no snapshot, no marker → `{ kind: 'interactive', phase: 'frame' }` (and `'spec'` for a spec-entry run).
- probe — interactive, resting phase-loop snapshot at `specLoop`, no marker → `{ kind: 'interactive', phase: 'spec' }` (the key anti-crash assertion).
- probe — interactive, `terminalMarker {phase:'spec', kind:'advance'}`, no driver → `{ kind: 'gate', phase: 'spec' }`.
- probe — interactive, `terminalMarker {phase:'spec', kind:'flag'}`, no driver → `{ kind: 'flag', phase: 'spec' }`.
- probe — interactive, **live driver pid present** → still `{ kind: 'running', … }` (the `--headless` fallback case; liveness wins, unchanged path).
- probe — **headless run with the same snapshots** → unchanged (`crashed`/`gate` exactly as today) — pins no regression.
- `status --json` renders the `interactive` arm; existing arms unchanged.

**Commit:** `feat(harness): interactive resting model — machine variant, host marker, probe positions`.

### Slice 2 — `get_task` + the post-terminal quiescence rail

**One idea:** the interactive tool surface — the brief comes *in* through one side-effecting-exactly-once tool, and quiescence is enforced *structurally* once a phase has ended. **Strict RGR** for `get_task`'s exactly-once semantics; the rail is a wrapper (test+code together). **Re-read `docs/prompting-and-tool-design.md` §"Descriptions are prompts"/§"Errors prescribe recovery" and `docs.local/prompt-engineering/skill.md` before writing the tool description.**

**Design — reuse, don't duplicate:** the side effects `get_task` performs already exist in `driver.ts` `basePrompt`/`buildPrompt` (`:262`/`:286`): mark `phaseStarted` (`:291`), consume staged human input (`consumeHumanInput`, `run-store.ts:266`), fold answer/rider via `answerResumePrompt`/`approvalRiderBlock` (`orchestrator-prompts.ts:382`/`:375`). Extract a shared **`buildPhaseBrief(state, phase): string`** in `orchestrator-prompts.ts` that returns the `*PhaseEntryPrompt` body for the phase (the existing dispatch at `driver.ts:295-310` moves/copies here). `get_task` composes: `buildPhaseBrief` + a folded staged-input block; `driver.ts` keeps its headless prompt path but delegates the entry-prompt construction to the shared builder (deep-module: one place builds a phase brief).

**`get_task` contract (handler in `tools.ts`, added to the `createPhaseTools` registry):**
- **No current-phase marker (mid-phase):** return `buildPhaseBrief(state, phase)` — the **base brief, returned identically every call (idempotent)**. Two **independent** side effects (this is the split that fixes the round-1 over-tying, and matches the headless split where `basePrompt` marks `phaseStarted` while `consumeHumanInput` is called per invocation, `driver.ts:117`/`:291`):
  - **`phaseStarted[phase]` is marked once per phase** — on the first call that finds it unset.
  - **A pending staged human input is consumed once per message, whenever present** — *not* gated on `phaseStarted`. So an `approval` rider into the *next* phase, **and** a same-phase `reject`-feedback / `answer` resume (where `phaseStarted[phase]` is already true), is folded as an appended block on the next `get_task`. A call with **no** pending message returns the base brief alone. No new persistence; same accepted crash-window tradeoff as `buildPrompt` (`driver.ts:260`).
- **Current-phase marker set (parked at gate/flag):** return a short "you are parked at the <gate/flag>; the packet/question is recorded — present it and propose `duet continue …`; do not start new work" status. No side effects. This is the status/re-anchor surface the rail leaves open.
- No `readOnlyHint`. Description surfaces the mutation and the three moments (cold-start, post-gate, re-anchor).

**The post-terminal rail (`tools.ts`):** generalize the existing first-terminal-wins refusal. Today `terminalAlreadySet()` (`:99`) gates only `advance_phase`/`ask_human`. Add a wrapper — sibling to `withSteerDelivery` (`:506`) — `withPostTerminalRail(def)` applied to the **refused set** (`send_prompt`, `list_snippets`, `create_branch`, `propose_snippet_edit`, `write_note`): if `state.terminalMarker?.phase === phase`, return `alreadyEnding()`'s nudge (reuse the existing copy at `:100`, lightly generalized to "this phase is ending — it is parked at its gate; present the packet and cross with duet continue, or re-anchor with get_task") instead of running the handler. `get_task` and the terminal tools are **not** wrapped (terminal tools self-gate; `get_task` stays open). Order vs `withSteerDelivery`: rail first (refuse before steer-delivery), so a refused call still won't deliver steers into a dying phase.

**Tests (`tests/tools.test.ts`):**
- first `get_task` mid-phase (with a staged `approval` rider via `stageHumanInput`) returns `buildPhaseBrief(state, phase)` **plus the folded block** and marks `phaseStarted[phase]`; a second `get_task` (no pending message) returns the **base `buildPhaseBrief` body without the block** (byte-equal to the renderer, like `mcp-server.test.ts:72`), `phaseStarted` still set once, `consumeHumanInput` empty.
- **same-phase re-entry** (the reject/answer case): with `phaseStarted[phase]` already `true` and a freshly staged `feedback` (or `answer`) message, the next `get_task` **still folds it** (consumption is per-message, independent of `phaseStarted`), and the following call returns the base brief — consistent with the Slice-4 reject test ("a following `get_task` folds the staged feedback once").
- `get_task` with `terminalMarker` set returns the "parked at gate" status, marks nothing, consumes nothing.
- `get_task` carries no `readOnlyHint`.
- rail: with `terminalMarker {phase:'spec',kind:'advance'}` set, `send_prompt` / `list_snippets` / `create_branch` / `propose_snippet_edit` / `write_note` each return `isError` with the "phase is ending" nudge and perform no side effect (no voice-log line, no worker call); `get_task` still succeeds.
- rail is a no-op when no marker is set (every tool runs normally) and when the marker is for a *different* phase (stale marker from a prior phase, the `tools.ts:97` scope rule).
- headless parity: `driver.ts` building a frame/spec entry prompt is unchanged after the `buildPhaseBrief` extraction (a focused `tests/driver.test.ts` assertion that the headless entry prompt still equals the expected `*PhaseEntryPrompt`).

**Commit:** `feat(harness): get_task brief surface + post-terminal quiescence rail`.

### Slice 3 — The run-scoped, phase-less `_mcp` server

**One idea:** the kernel server becomes a single long-lived server for a *run*, resolving the phase per call and caching the phase's tool instance — so one connection spans the whole interactive arc with the in-flight/warn-once rails intact within a phase.

**Changes:**
- `src/harness/mcp-server.ts`: today `buildKernelTools(cwd, runId, phaseRaw)` (`:31`) takes an explicit phase and builds the registry once; `serveKernelStdio` (`:73`) serves it. Add a **run-scoped** path: a `RunScopedKernel` that, per tool call, resolves the active phase from disk via `probeRunPosition(loadRunState(cwd, runId))`, and holds a `{ phase, tools }` cache — rebuilds `createPhaseTools` only when the resolved phase differs from the cached one. The cache preserves the per-process in-memory rails (`turnsInFlight`, `resendWarned` — `tools.ts:116`/`:127`) within a phase and rebuilds them across a phase boundary (matching headless one-instance-per-phase).
- **Hosting is gated on the live interactive marker, and phase resolution is partial.** Per call the resolver first checks `state.orchestrationHost === 'interactive'`. If it is **not** — the run handed off to headless at the plan gate, dropped via `--headless`, or finished (all clear the marker) — it throws a **prescribed-recovery error** ("this run is no longer interactive — a headless `_drive` now owns it (or it has completed); the interactive session's job is done. Observe with `duet status`; relaunch `duet orchestrate` only if it becomes interactive again"). This closes the safety gap the round-1 resolver opened: a still-connected old Claude session could otherwise resolve `running` and keep serving **mutating phase tools into a headless-owned run** (two writers). With the marker live, it resolves the position via `probeRunPosition`: `RunPosition` (`lifecycle.ts:126`) carries a `phase` for `interactive`/`gate`/`flag`/`crashed` — host that phase. A position with **no** phase (`abandoned` — `markAbandoned` does not clear the marker — or a degenerate `done`/`running`) throws the same prescribed error (never an invented phase), in the `mcp-server.ts:32` shape, surfaced as a tool error and to stderr.
- Mechanism for "resolve per call": register the tools on the `McpServer` once with stable names/schemas (the surface is phase-independent), but route each handler through the run-scoped resolver so the *handler that runs* is the current phase's. Simplest deep design: the resolver owns a `callTool(name, args)` that looks up the cached phase registry's handler by name. Keep `buildKernelMcpServer` (`:53`) as the registration shell; feed it handlers that delegate to the resolver.
- `src/cli.ts`: `_mcp` command (`:349`) — make the `<phase>` argument **optional**. With a phase → today's single-phase server (keeps the Stage-0 test/inspector path and `mcp-server.test.ts:101-108` behavior). Without a phase → the run-scoped server. The launcher (Slice 5) bakes `args: [_mcp, <runId>]` (no phase).
- `get_task` (Slice 2) is part of the per-phase registry, so it is served by the run-scoped server automatically.

**Test seam:** the in-memory MCP client/server pattern (`mcp-server.test.ts:42` `linkedClient`) plus a **real subprocess** parity case like `stdio-host.test.ts` (driving `duet _mcp <runId>` with no phase). No LLM — `FakeWorker`s back `send_prompt`.

**Tests (`tests/mcp-server.test.ts`):**
- a run-scoped server resolves the phase from disk: with the run resting interactive at `frame`, `list_snippets` returns the **frame**-focused library; after advancing on disk to rest at `spec`, the next call returns the **spec**-focused library — same connection, phase followed the run.
- the tool-instance cache: two concurrent `send_prompt`s to the **same role** within one resolved phase hit the same instance and the second is refused by the in-flight rail (the rail only works if the instance is shared — proves the cache, not per-call rebuild); crossing to a new phase resets `turnsInFlight`/`resendWarned` (a base template re-sent in the new phase warns fresh). **Use a promise-controlled `FakeWorker`** — a worker whose `runTurn` blocks on a test-resolved deferred (the shape `tests/tools.test.ts:156-208` uses for its parallel/in-flight cases), so the first turn is genuinely in flight when the second arrives. The default `FakeWorker` (`fixtures.ts:31`) resolves immediately and would never exercise the in-flight guard.
- non-hostable positions: a run-scoped server whose run is `done`/`abandoned`, or whose `orchestrationHost` is cleared, answers a tool call with the prescribed-recovery error (no invented phase); an interactive `crashed` run hosts its `phase`.
- **handoff safety (the two-writer gap):** an already-connected run-scoped server serves normally while `orchestrationHost === 'interactive'`; after the host marker is cleared on disk (plan handoff or `--headless`), the **next** mutating tool call on the *same* connection is refused with the handed-off error — the old session cannot write into a headless-owned run.
- phase-less `_mcp` over a real subprocess enumerates the surface (incl. `get_task`) and answers `list_snippets` at zero worker cost (parity with `stdio-host.test.ts`).
- the explicit-phase `_mcp` path is unchanged (existing refuse-unknown-phase/run tests still green).

**Commit:** `feat(harness): run-scoped phase-less _mcp server with per-phase tool cache`.

### Slice 4 — `duet continue`: the unified interactive continue/handoff model

**One idea:** every interactive crossing is an inline disk transition sharing one **marker-then-human** ordering — across all three paths (inline rest / plan-gate handoff / headless fallback) — and no headless `_drive` runs until a handoff. Subtle (marker consumption, validation against a phase-loop rest, spent-marker consistency, the handoff ordering) → **strict RGR**.

**The ordering constraint that drives the design (verified against the real code).** `driveToQuiescence` sends its human event immediately after actor start (`lifecycle.ts:270`); marker replay happens *later*, inside the phase driver (`driver.ts:114`/`:247`). So `spawnDrive(state, 'approve')` from an interactive phase-loop rest carrying `{plan, advance}` restores the **real** machine at `planLoop` (re-invoking `runPhase` for *plan*), sends `human.approve` to a phase state that ignores it, then the marker replays `phase.advance` → parks at `planApprovalGate` and stops — it **never crosses into impl**. Therefore every interactive crossing must apply **marker `phase.*` then `human.*` itself**, before any headless spawn. This is the load-bearing fix.

**The named operation — `crossInteractive(state, humanEvent)` (`lifecycle.ts`):**
1. restore `interactiveMachine` from the persisted snapshot, or start fresh from `{ input }` when none (first phase: `route → frameLoop`);
2. send the current-phase marker's `phase.*` (via `markerToEvent`) to move from the resting phase-loop to its gate/flag;
3. send `humanEvent` (`human.approve|reject|answer`);
4. persist the resulting **phase-loop rest** directly via `saveMachineSnapshot` (deliberate — the interactive phase loop *is* the rest; the provided actor is inert, so restore is safe), then clear the marker **deliver-before-clear** (after the snapshot is durable).
- It does **not** call `driveToQuiescence` (which waits for a `quiescent` tag the phase loop lacks). Comment the spent-marker consistency: the interactive rest is a phase loop, never persisted *at* a gate with its marker still set, so the spent-marker guard (`lifecycle.ts:258`) never collides with the marker-derived probe.
- `duet continue` stages the human *text* (rider/feedback/answer) as today (`cli.ts:300`/`:307`/`:317`); `crossInteractive` applies the *event*; `get_task` folds the text on its next first-call (Slice 2).

**`src/cli.ts` `continue` command (`:164`) — the three paths, one ordering:**
- **Interactive validation path (replaces the snapshot `can()` check for interactive runs).** Today's validation restores the saved snapshot and checks `restored.can(human.*)` (`:237`-`:278`); for an interactive run the saved snapshot is a phase-loop rest with no `human.*` handler, so it would reject *every* crossing before `crossInteractive` runs. For an interactive run, validate against the **marker-derived position** instead: `probeRunPosition(state)` → `gate` admits `--approve`/`--reject`, `flag` admits `--answer`; anything else (e.g. `interactive` with no marker) is a friendly error ("the run isn't at a gate/flag yet — the orchestrator hasn't advanced; nothing to cross"). The headless path's `can()` validation stays unchanged.
- After validation + staging, branch on `state.orchestrationHost` and a post-cross action from `interactiveContinuePlan(gatePhase, eventType, headless): 'inline' | 'handoff'`:
  - **headless run** (`orchestrationHost` unset) → today's `spawnDrive(state, eventType)` (`:320`), unchanged.
  - **interactive, `'inline'`** (any interactive crossing except the plan-approve handoff; `--reject`/`--answer` re-enter the same phase) → `crossInteractive(state, humanEvent)`; **no spawn**. The connected session picks up via `get_task`.
  - **interactive, `'handoff'`** → `crossInteractive(state, humanEvent)` first (lands at `implLoop`, the marker-then-human ordering), then on a fresh load **clear `orchestrationHost`**, save, and `spawnDrive(state)` with **no event** — `_drive` restores the `implLoop` rest and drives impl headless to the Ship gate. `interactiveContinuePlan` returns `'handoff'` iff `(gatePhase === 'plan' && eventType === 'approve') || headless`.
- **`--headless` fallback flag** on `continue`:
  - with a human event → routes through `'handoff'` (crossInteractive then headless spawn) — `--headless --approve|--reject|--answer` shares the marker-then-human ordering, so no replay-to-gate bug;
  - with **no** event and **no current-phase marker** (a mid-phase drop) → clear `orchestrationHost`, `spawnDrive(state)` no event; `_drive` restores the current phase-loop rest and continues the phase headless (`phaseStarted` is already set, so the headless orchestrator resumes via the continue-nudge in `basePrompt`; workers keep their sessions);
  - with **no** event but a marker **is** set → refuse ("the run is parked at its gate — cross with `--headless --approve/--reject`, or `--answer` the flag"). This is Resolved-Q3 + the reviewer's point-4 definition: `--headless` is never the replay-to-gate path.

**Host-marker lifecycle pinned:** set (Slice 5), used here (the branch + interactive validation), cleared at the handoff and at `done`; `markAbandoned` (`run-store.ts:281`) and `takeover` never read it (a test asserts an interactive run still abandons/takes-over).

**Test seam:** disk truth; `crossInteractive` is a pure disk function (no spawn). The branch decision is the pure `interactiveContinuePlan`. For the handoff/headless paths that DO spawn, assert the **durable position** (snapshot reached `implLoop`/the phase rest, `orchestrationHost` cleared, marker cleared) — not merely "a driver was spawned" — plus a thin integration that a real `_drive` started where that's the behavior under test. `spawnDrive` is not a seam, so don't fake it; assert through disk state.

**Tests (`tests/lifecycle.test.ts` + a CLI-path validation test):**
- `crossInteractive` first crossing (no prior snapshot): `{frame,advance}` + `human.approve` → persists `specLoop` rest, marker cleared; probe → `{ interactive, spec }`.
- mid-arc: resting `specLoop` + `{spec,advance}` + `human.approve` → `planLoop` rest; probe → `{ interactive, plan }`.
- reject: resting `specLoop` + `{spec,advance}` + `human.reject` → re-enters `specLoop` rest, marker cleared; a following `get_task` folds the staged feedback once.
- answer: `{spec,flag}` + `human.answer` → re-enters `specLoop` rest.
- **plan-gate handoff (the ordering test):** interactive run resting `planLoop` + `{plan,advance}`, `--approve` → the **durable snapshot reaches `implLoop`** (impl entered, *not* parked at `planApprovalGate`), `orchestrationHost` and marker cleared, and a headless `_drive` was spawned with no event (a `driver.pid` appears). Asserting the durable snapshot is `implLoop` is the "reaches impl/headless-drive" proof; driving impl to the Ship gate is `driveToQuiescence`'s own tested behavior, not re-proven here. A comment records why a naive `spawnDrive(state,'approve')` would instead have parked at the gate (the `lifecycle.ts:270` ordering).
- **interactive validation (through the CLI/validation path, not only `interactiveContinuePlan`):** `--approve` on an interactive run parked by `{spec,advance}` is accepted (probe = gate); `--answer` there is rejected with the "use --approve/--reject" error; `--approve` on an interactive run with **no marker** (mid-phase rest) gives the "not at a gate yet" error.
- `interactiveContinuePlan`: `('plan','approve',false)→'handoff'`; `('frame','approve',false)→'inline'`; `('spec','reject',false)→'inline'`; `(_,_,true)→'handoff'`.
- `--headless` no-event + no marker → clears `orchestrationHost`, spawns headless, continues the current phase; `--headless` no-event + marker set → refused with the prescribed message; `--headless --approve` at a gate → handoff ordering (durable `implLoop`/next-phase rest, then headless drive).
- never-trap: `markAbandoned` on an interactive run → probe short-circuits to `abandoned`; an interactive run can be taken over (neither reads `orchestrationHost`).

**Commit:** `feat(harness): unified interactive continue/handoff (marker-then-human ordering)`.

### Slice 5 — The `duet orchestrate <runId>` launcher + the single `ask` rule

**One idea:** bring up the wired interactive session — the one place that spawns `claude`, applies the gate-safety rule, and marks the run interactive. **Re-read `docs/prompting-and-tool-design.md` §"Errors prescribe recovery"/§5 before writing the self-check + launch messages.** Mostly mechanical wiring over a spawn seam → test+code together, except the self-check (RGR-light).

**The process-spawn seam (how we test without launching Claude Code):** mirror the `PaneFactory` pattern (`providers/pane.ts`, engineering §Seams "Environment"). The launcher takes an injectable launcher fn — `type ClaudeLauncher = (spec: { command: string; args: string[]; env: NodeJS.ProcessEnv }) => { pid?: number }` — defaulting to a thin real `spawn`/`execa` of `claude`. Tests pass a **recording fake** that captures the spec and never spawns. The launcher module (`src/orchestrate.ts`, new) builds the spec; `cli.ts` wires the real default.

**Changes:**
- `src/orchestrate.ts` (new): `buildLaunchSpec(state): { command:'claude'; args:[…] }` producing — `--mcp-config <inline JSON {mcpServers:{duet:{command:'duet',args:['_mcp', runId]}}}>`, `--strict-mcp-config`, `--append-system-prompt-file <abs path to skills/duet/identity.md>`, `--settings <inline JSON or generated temp file with the single ask rule>`. Resolve the identity path package-relative (same `import.meta.url`-relative resolution `snippets.ts` uses — survives the bundle, engineering §Build). `runOrchestrate(state, launcher)`: set `orchestrationHost: 'interactive'` (+ `orchestratorCostPartial` per Slice 7), save, then `launcher(spec)`; run the **ask-rule self-check** and warn loudly (to stderr) if the rule isn't expressible/applied.
- The **single ask rule** JSON: `{ permissions: { ask: ['Bash(duet continue *)'] } }` — **space form** (see the Bash-rule verification below). Delivered via `--settings` (inline JSON if the installed CLI accepts a JSON string, else a generated temp settings file — confirm in the verification step; pick one, the test pins whichever).
- `src/cli.ts`: add the public **`orchestrate <runId>`** command (not `_`-prefixed → appears in `publicCommands`, pinned by Slice 6's skill test) that loads the run and calls `runOrchestrate` with the real launcher. Add **`new --interactive`** (`new` at `:98`): create the run, set `orchestrationHost`, **skip the auto `spawnDrive(state)` at `:159`**, and either launch via `runOrchestrate` or print the `duet orchestrate <runId>` next step (launch directly — one command to start). Guard: `--interactive` and `--gates-at` together is fine (gates beyond plan still pre-authorize for the headless tail).

**Bash-rule-form verification (concrete step, do early in this slice):** run the installed `claude` once with a candidate `--settings` carrying `ask: ['Bash(duet continue *)']` and confirm a `duet continue …` invocation triggers the ask prompt (space form, per current docs). If the **colon** form is required instead, (a) use it, and (b) it means the shipped `skills/duet-concierge/SKILL.md` colon rules (`Bash(duet status:*)`) and the `tests/skill.test.ts:53` regex `^Bash\(duet (status|logs|runs):\*\)$` are correct as-is — no migration. If the **space** form is required and the colon form is silently ignored, the concierge has a latent bug: migrate `skills/duet-concierge/SKILL.md` to the space form and update the `skill.test.ts:53` regex accordingly (this is the only place this slice may touch the concierge — record it in the commit body). Resolve which form before writing the launcher's rule string; the launcher test pins the chosen form.

**Tests (`tests/orchestrate.test.ts`, new):**
- `buildLaunchSpec` for a run produces argv containing `--mcp-config` with the runId baked into `args:['_mcp', runId]` (parse the JSON and assert), `--strict-mcp-config`, `--append-system-prompt-file` pointing at an existing `skills/duet/identity.md`, and `--settings` carrying the single `ask` rule in the chosen form.
- `runOrchestrate` with the recording fake: sets `state.orchestrationHost='interactive'` (persisted), calls the launcher exactly once with the spec, and never spawns a headless `_drive`.
- `new --interactive`: creates the run with `orchestrationHost` set and does **not** write a `driver.pid` (no headless auto-spawn); a plain `new` is unchanged (still auto-spawns).
- self-check: a launcher/settings path where the rule can't be applied makes `runOrchestrate` emit the loud warning (assert on the captured stderr), but still launches (the session is attended; the human sees the warning).

**Commit:** `feat(cli): duet orchestrate launcher + single ask-rule gate safety`.

### Slice 6 — The `skills/duet/` identity skill + coherence test

**One idea:** ship the second skill — the orchestrator's identity — and pin it to the CLI the way the concierge is pinned. **Governing authority: `docs/prompting-and-tool-design.md` (the `<division_of_labor>`/`<protocol>` content at `orchestrator-prompts.ts:15-63` is the canonical source to adapt) and `docs.local/prompt-engineering/skill.md`.** Prose slice → write against those, then pin with a test.

**Changes:**
- `skills/duet/SKILL.md`: frontmatter `name: duet`, `description: …`, `disable-model-invocation: true` (mirrors the concierge `:4`; explicit `/duet` only, so a duet-dev session never inherits the role). Body: what the `/duet` session is, that it is brought up by `duet orchestrate <runId>`, the FRAME→PLAN scope, gate crossing is the human's via a proposed `duet continue` (the tap), artifacts are produced by workers via `send_prompt` (never written by the orchestrator), and re-anchor via `get_task` on cold-start/after-gate/after-compaction. References `identity.md` by relative link; does not restate it.
- `skills/duet/identity.md`: the system-prompt-strength orchestrator identity (the launcher's `--append-system-prompt-file` target). Adapt `ORCHESTRATOR_SYSTEM_PROMPT` (`orchestrator-prompts.ts:15`) division-of-labor + protocol + steers content for the interactive context (the human is in-session; steering is chat; gate crossing is proposing `duet continue`). Reuse-not-duplicate: this is the canonical interactive identity; `SKILL.md` points at it.
- `tests/skill.test.ts`: extend the coherence suite to cover `skills/duet/` — a parallel `describe('the duet skill coheres with the CLI')`: frontmatter `name: duet` + `disable-model-invocation: true`; every `duet <verb>` named in `SKILL.md`/`identity.md` exists on `publicCommands` (so `orchestrate` must be a public command — Slice 5); and any `get_task`/MCP-tool mentions are recognized as tool names (not asserted against `publicCommands`, since they're MCP tools, not CLI verbs — match the existing `codeLines` verb/flag extractor and exclude tool spans). Keep the concierge suite untouched (only its regex if the Bash-form migration in Slice 5 required it).

**Tests:** the new coherence cases above; reuse the `codeLines`/`frontmatterOf` helpers (`skill.test.ts:21`/`:28`). A focused case: `publicCommands.has('orchestrate')` is true.

**Commit:** `feat(skills): duet orchestrator identity skill + coherence test`.

### Slice 7 — Cost telemetry (`orchestratorCostPartial`)

**One idea:** record that interactive-orchestrator spend is unmetered, additively, without overloading `orchestratorUsd` — keeping the concierge/`status --json` schema additive-only. Small, test+code together.

**Changes:**
- `src/run-store.ts`: add `orchestratorCostPartial: boolean` to `RunState.costs` (`:126`), default `false` in `createRun` (`:224`), mirroring `claudeWorkersCostPartial`. Sticky: set true by `runOrchestrate` (Slice 5) when `orchestrationHost` is set; **never cleared** (survives the handoff that clears `orchestrationHost`).
- `src/status.ts`: the cost rendering reads `orchestratorCostPartial` and marks the orchestrator total as partial/unmetered (human text + `status --json`), exactly as `claudeWorkersCostPartial` is surfaced today. Never present `orchestratorUsd` as the complete total when the flag is set.

**Tests (`tests/status.test.ts` + `tests/run-store.test.ts`):**
- `createRun` defaults `orchestratorCostPartial` false.
- after `runOrchestrate`, the flag is true and persists through a `crossInteractive` plan-gate handoff that clears `orchestrationHost` (the fact outlives the marker).
- `status --json` includes the additive field and marks the orchestrator total partial when set; unchanged when unset.
- additive-only compatibility: the existing `tests/skill.test.ts` concierge cross-check and any `status --json` schema assertions still pass (no field renamed/removed).

**Commit:** `feat(harness): additive orchestratorCostPartial telemetry for the interactive host`.

## Final verification

After Slice 7: `pnpm typecheck` && `pnpm test` (full suite green). Spot-confirm the cross-cutting behaviors the spec's "Behaviors that matter" lists are each covered by a named test above (gate-uncrossable is already pinned by `machine.test.ts` + the event vocabulary — no new tool emits `human.*`, unchanged; add a one-line assertion in the new suites that `get_task` and the rail introduce no `human.*` path).

## Out of scope (deferred, per the spec)

- **Doc updates** — a separate post-implementation `/update-docs` pass (README/automation-design/engineering/future-directions/open-questions/CLAUDE.md). Not in any slice.
- **Duet-owned watcher for a dead interactive session** — recovery is re-anchor-only (relaunch `duet orchestrate`); no supervisor is built (spec deferred scope).
- **AFK-everywhere / mid-run detach, `new --interactive` beyond the minimal flag, codex-as-orchestrator, eval/replay harness** — spec deferred.
- **Live end-to-end with a real Claude Code session** — manual validation after the slices land (the spec's manual-validation analogue); the slices prove behavior over disk + the spawn seam + the MCP boundary, never a live LLM.
