# Plan — Async `send_prompt` for the interactive orchestrator host

- **Date:** 2026-06-21
- **Branch:** `feat-async-mcp-tools`
- **Spec:** `docs/specs/2026-06-21-async-interactive-send-prompt.md` (approved at the commit-spec gate)
- **Runs AFK after the plan gate** — every slice leaves the tree green (`pnpm typecheck && pnpm test`) and is independently committable; sequencing is explicit so no live steering is needed.

## Orientation — the shape of the change

The freeze is one `await` in the `send_prompt` handler (`tools.ts:342`). A′ keeps the headless host blocking and makes the interactive host *dispatch-now / collect-later*, by splitting that one synchronous call into a tracked **pending-turn lifecycle** (`running → ready|failed → collected`) owned by the run-scoped server, plus a new instant `check_turns` tool. The same `createPhaseTools` registry serves both hosts; a host flag toggles two things (`send_prompt` blocks vs. dispatches; `check_turns` present vs. absent).

Three reusable pieces come out of today's inline `send_prompt` body, then get recomposed two ways:

- **`startHeartbeat`** — the 5-min voice-log interval (`tools.ts:333-339`).
- **`settleTurn`** — the *worker-settled* half: the durable `load → merge → save` (`tools.ts:361-388`) for session id / round (success-only) / sent tag (success-only) / cost / tokens / context / lastActivity / voice-log ▶, plus the infra-failure branch (`tools.ts:405-417`). Persists; does not build orchestrator-facing text.
- **`renderTurnResult`** — the *result-collected* half: build the `CallToolResult` (worker text, or the prescribed-recovery infra error; plus the near-cap nudge, `tools.ts:392-404`).

Headless `send_prompt`: `await runTurn → settleTurn → renderTurnResult → return`, one blocking call (behavior identical to today). Interactive `send_prompt`: dispatch into a **`TurnDispatcher`** and return immediately; the dispatcher runs `settleTurn` when the background promise resolves; `check_turns` runs `renderTurnResult` for each settled record.

### New durable state (state.json, written only by the lease-holding server)

- `pendingTurns?: Partial<Record<WorkerRole, { tag: string; startedAt: string; status: 'running' | 'ready' | 'failed' }>>` — the lifecycle projection (interactive-only). Mirrors `activeTurns` (`run-store.ts:149`) but carries a status; written via dedicated mutators using the same fresh-load → mutate-this-role → save discipline as `markTurnActive` (`run-store.ts:342`), so a cross-role write never clobbers the sibling. `activeTurns` is **unchanged** and keeps its job as `doctor`'s running/idle health hint.
- `workerDispatched?: true` — the one-way branch-fixed flag; set at the first dispatch, never cleared.

### New run-dir file (not state.json — mirrors `driver.pid`)

- `mcp-owner.json` `{ pid, nonce, at }` — the single-writer lease for the run-scoped server. Acquired at server start; the dispatcher checks it holds before any durable settle write.

### New modules

- `src/harness/turn-dispatcher.ts` — `createTurnDispatcher({ state, phase, cap, provider(role), log, home, holdsLease, settle, render })`: a deep module (small interface, hides promise + heartbeat + durable-write + lease wiring). Interface:
  - `dispatch({ role, tag, body, isReviewRound })` — takes the **prompt body** (the dispatcher builds `RunTurnOptions` from `body` + `state.workerSessions[role]` + `state.cwd` + `readOnly: role==='reviewer'`, mirroring `tools.ts:342-347`).
  - `statusOf(role) → 'running' | 'ready' | 'failed' | undefined`, `collectReady()`, `hasPending()`.
  - **Lifetime is phase-scoped, not server-scoped** (wired in slice 3): the dispatcher binds `phase`/`cap`/`provider`, which the run-scoped server rebuilds per phase (`mcp-server.ts:151-158`). It lives **inside `ctx`** beside providers/rails and is rebuilt at a phase boundary; the `holdsLease` thunk it closes over is the one server-scoped piece (stable across phases).

### Touched existing modules (with anchors)

- `tools.ts` — extract the three pieces (slice 1); add the async `send_prompt` branch + `check_turns` + dispatch-time rails (slice 3); `create_branch` reads the new flag (slice 3, handler at `:476-522`, check at `:483`); `advance_phase`/`ask_human` phase-exit gate (slice 3, `:524`/`:442`); `PhaseToolsDeps` gains the async marker (`:86-110`).
- `mcp-server.ts` — `serveRunScopedKernelStdio`/`createRunScopedKernel` acquire the per-server lease at start and `toolsFor` refuses every call once superseded (slice 2, `:144-186`/`:203-206`/`:151-160`); the dispatcher lives in `ctx` and is rebuilt per phase (slice 3, `:151-160`); the async marker is passed to `toolsFor` (`:159`) and `surface()` (`:170-173`). Single-phase `buildKernelTools` (`:45`) and `driver.ts:221` stay blocking.
- `run-store.ts` — the new fields + mutators (`markPendingTurn` / `settlePendingTurn` / `clearPendingTurn` / `markWorkerDispatched`; `acquireMcpOwner` / `holdsMcpOwner`).
- `lifecycle.ts` — `waitForTurnOrStop` (slice 5), beside `waitForRunStop` (`:246`).
- `status.ts` — `StatusModel` gains a `pendingTurns` field (slice 3, `:102`); additive, schema-additive-only.
- `cli.ts` — `status --wait` uses the turn-aware wait + surfaces the ready roles (slice 5); `takeover` resolves an orphan record, with a no-session path (slice 4, command at `:680`, the hard-fail at `:699`).
- `prompts/orchestrator-identity.md` — the fire → collect rhythm (slice 3).

---

## Slice 1 — Extract the finalizer, heartbeat, and result renderer (pure refactor)

**Goal.** Pull `startHeartbeat`, `settleTurn`, and `renderTurnResult` out of the `send_prompt` body with **zero behavior change**, so slice 2 can recompose them on the async path. Deletes the "one big inline completion block" into three named, independently testable steps (deep-module move).

**Changes.**
- Extract `startHeartbeat(state, role, tag, startedAt, log, home) → () => void` from `tools.ts:333-339` (returns its `clearInterval` stop fn).
- Extract `settleTurn(state, { role, tag, isReviewRound }, outcome) → void`, where `outcome` is a `WorkerTurn` (success) or an `Error` (infra failure). Success path = `tools.ts:361-388` (the fresh `loadRunState` → merge → `saveRunState` → `Object.assign`); it must keep: round increment only when `isReviewRound` **and** success; sent-tag append only on success (the `isBaseTemplate` branch, `:366-370`); the cost-partial / codex-tokens / context merges (`:371-385`). Failure path = the voice-log `✗` line (`:408`); **no** round, **no** sent tag. Both paths clear `activeTurns` (`clearTurnActive`). Slice 1 keeps the heartbeat-stop in `send_prompt`'s `finally` exactly as today (the dispatcher takes it over in slice 2); `pendingTurns` does not exist yet.
- Extract `renderTurnResult(state, { role, tag, isReviewRound, phase, cap }, outcome) → CallToolResult` from `:392-417`: success → `{ content: [worker text] }` plus the near-cap nudge (`:398-403`); failure → the prescribed-recovery infra-error result (`:409-417`).
- Recompose blocking `send_prompt`: pre-flight rails unchanged → `startHeartbeat` → `try { turn = await runTurn } / catch (err)` → `settleTurn(...)` → `renderTurnResult(...)` → return; `finally` stops the heartbeat. Same observable behavior.

**Tests** (`tests/tools.test.ts`, existing suite is the safety net).
- The existing `send_prompt` cases (`routes to the addressed worker…`, the round-count / sent-snippet / cost / context cases, the infra-failure case) must stay green unchanged — that is the refactor's proof.
- Add one focused behavior test per extracted boundary only where the recomposition could drift: `settleTurn` on an `Error` outcome commits **no** round and **no** sent tag (assert via `loadRunState` that `rounds[phase]` and `sentSnippets` are untouched) — this pins the success-only rule the async path depends on. (Behavior through `settleTurn`'s interface; no internals mocked.)

**Gate / commit.** `pnpm typecheck && pnpm test` green → commit `refactor(tools): extract settleTurn/renderTurnResult/startHeartbeat from send_prompt`.

---

## Slice 2 — Single-writer lease primitive (foundation for safe async)

**Goal.** Land the interactive-vs-interactive write fence *before* any background writer exists, so no committed tree ever has async dispatch without the owner check (the AFK-safety point: the lease and the async feature must not be separately-committed). This slice adds the lease and has the run-scoped server acquire it at start; nothing depends on it yet (no dispatcher), so it is inert but tested in isolation.

**Changes.**
- `run-store.ts`: `acquireMcpOwner(state) → nonce` writes `mcp-owner.json` `{ pid, nonce, at }` in the run dir (atomic temp+rename, like `driver.pid`/`state.json`); `holdsMcpOwner(state, nonce) → boolean` reads it and compares the nonce. (Run-dir file, **not** `state.json`, so it never races the server's state saves — same reason `driver.pid` is its own file.)
- `mcp-server.ts`: `createRunScopedKernel` (`:144`, called once per `duet _mcp <runId>`) acquires the lease at construction, holds the nonce in its closure, and exposes a `holdsLease()` thunk. `serveRunScopedKernelStdio` (`:203`) reaches it through that factory.
- **The superseded-server gate (the broad lease rule).** `toolsFor()` (`:151-160`, which runs on **every** `callTool`) refuses with a prescribed error — "this interactive server was superseded by a newer `duet orchestrate`; end this session, observe with `duet status`, relaunch only if it becomes interactive again" — **whenever `holdsLease()` is false**, alongside the existing `orchestrationHost !== 'interactive'` refusal (`:153`). The rule: **a superseded server refuses every tool call** (read or write), so no stale-owner mutation can ever land. Because `toolsFor` runs `holdsLease()` synchronously immediately before the handler — with no `await` between the check and a tool's dispatch-time writes — this gate covers the dispatch-time writes slice 3 adds (`pendingTurns`/`activeTurns`/`workerDispatched`) without a redundant inner check; the *one* path it cannot reach is the dispatcher's background settle continuation (no tool call to gate), which keeps its own fence (slice 3). Stating the two-boundary rule here so slice 3 inherits it: **lease checked at `toolsFor` (all tool calls) and at settle (the background promise).**

**Tests** (`tests/run-store.test.ts` for the primitive; `tests/mcp-server.test.ts` for the gate).
- `acquireMcpOwner` writes `mcp-owner.json`; `holdsMcpOwner(nonce)` is true for the returned nonce.
- Two acquires yield different nonces; after the second, `holdsMcpOwner(firstNonce)` is false (last writer wins).
- `createRunScopedKernel` acquires the lease on construction (the file exists; `holdsLease()` is true); a second `createRunScopedKernel` over the same run makes the first's `holdsLease()` false.
- **Superseded gate:** server A holds the lease; server B (`createRunScopedKernel` over the same run) acquires it; A's next `callTool` (any tool, e.g. `get_task`) returns the prescribed superseded error and performs no mutation (`loadRunState` unchanged).

**Gate / commit.** Green → commit `feat(mcp-server): single-writer lease for the run-scoped kernel`.

---

## Slice 3 — The pending-turn lifecycle, async `send_prompt`, and `check_turns`

**Goal.** The heart of A′: on the interactive host, `send_prompt` dispatches and returns; the worker turn settles in the background, **lease-guarded from this slice's first commit**; `check_turns` collects. Headless stays blocking with no `check_turns`. The orchestrator identity learns the fire → collect rhythm, and `duet status` surfaces in-flight turns.

**State + mutators** (`run-store.ts`).
- Add `pendingTurns` and `workerDispatched` to `RunState` (`:73`+) and to `createRun`'s initializer (`:263`+, both optional/absent by default).
- `markPendingTurn(state, role, tag)` (status `running`), `settlePendingTurn(state, role, status)` (`ready`/`failed`), `clearPendingTurn(state, role)`, `markWorkerDispatched(state)` — each fresh-load → mutate → save, mirroring `markTurnActive` (`:342`).

**The dispatcher** (`src/harness/turn-dispatcher.ts`).
- `createTurnDispatcher({ state, phase, cap, provider(role), log, home, holdsLease, settle, render })` returns:
  - `dispatch({ role, tag, body, isReviewRound })`: write `pendingTurns[role]=running` + `markTurnActive` + `markWorkerDispatched`; `startHeartbeat`; build `RunTurnOptions` from `body` + `state.workerSessions[role]` + `state.cwd` + `readOnly: role==='reviewer'` (`tools.ts:342-347`) and launch `provider(role).runTurn(...)` **un-awaited**. (These dispatch-time writes are already lease-gated by the slice-2 `toolsFor` superseded gate, which ran `holdsLease()` synchronously immediately before this handler — no inner re-check needed.) On settle (resolve→success / reject→error): **`if (!holdsLease()) return` — a superseded server's settle is inert**; this is the second lease boundary, the one `toolsFor` cannot cover because the settle is a background promise continuation, not a tool call. Otherwise stop heartbeat, `settle(outcome)`, `settlePendingTurn(ready|failed)`, and stash the outcome in the in-memory record for `collectReady`.
  - `statusOf(role) → 'running' | 'ready' | 'failed' | undefined` — the same-role guard reads this.
  - `collectReady() → Array<{ role, result: CallToolResult }>` — for each `ready`/`failed` record: `render(...)` → push → `clearPendingTurn(role)` + clear the in-memory record (releases the guard); leaves `running` records untouched.
  - `hasPending() → boolean` — true if any **live** record is non-collected (running/ready/failed). The phase-exit gate ORs this with a fresh-disk `state.pendingTurns` check so a reconnect orphan (on disk, absent from this empty dispatcher) is also caught — the dispatcher reports only what it owns; disk-awareness lives in the handlers.
- Deep module: promise wiring, heartbeat, durable writes, and the lease check are hidden behind those four methods.

**`createPhaseTools` host switch** (`tools.ts`).
- `PhaseToolsDeps` (`:86-110`) gains `async?: { dispatcher: TurnDispatcher }`. Absent → blocking (driver, single-phase `_mcp`, `surface()`-without-marker); present → async.
- `send_prompt` handler (`:253-440`) forks after the pre-flight rails:
  - **Same-role guard** — async: refuse when `dispatcher.statusOf(role)` is set (a live running/settled-uncollected record), reusing the existing refusal copy (`:271-279`); **and also refuse when `state.pendingTurns[role]` exists but the dispatcher has no live record for it** — a reconnect **orphan** (a prior server dispatched, then died; the fresh server's dispatcher is empty). Slice 3 ships a *minimal, generic* orphan refusal ("an earlier turn to this role was orphaned when its session ended — recover it before re-sending"); slice 4 refines that copy (session vs. no-session) and adds the `takeover` recovery. **This bare refusal is what makes the slice-3 committed tree self-safe**: without it, a reconnect's empty dispatcher would let a same-role send race the orphaned worker — the exact reconnect hazard A′ closes. Blocking host: the existing `turnsInFlight` check (`:270`). The dispatcher subsumes `turnsInFlight` on the async path; `resendWarned` stays in `ctx.rails`.
  - Cap check (`:281-294`) and warn-once template-economy check (`:296-315`) run unchanged at dispatch (checks only; the sent-tag commit stays in `settleTurn`, success-only).
  - **Branch-fix:** at dispatch the handler causes `markWorkerDispatched` (via the dispatcher). `create_branch` (`:483`) now refuses when `state.workerDispatched || workerSessions.implementer || workerSessions.reviewer`.
  - Async tail: `voice-log ◀` (`:320`), `dispatcher.dispatch({ role, tag, body, isReviewRound })`, return the "dispatched — pull it with `check_turns`" result (convention 5: says what to do next). Blocking tail: unchanged (`startHeartbeat → await → settleTurn → renderTurnResult`).
- **`check_turns` tool** — added to the registry only when `async` is present. Handler: `const ready = dispatcher.collectReady()`; deliver each ready/failed `result`; append a still-running line per live running role; **append a generic orphan-recovery line for every role present in `state.pendingTurns` but absent from the live dispatcher** (a reconnect orphan — slice 4 refines this copy). Only when there are no live records **and** no orphans does it say "no turns in flight" — so a reconnect orphan is never hidden behind that message. (Convention 5: the orchestrator keeps conversing; the human / `/loop` / `duet status --wait` will surface completion.) Role-keyed, instant, never blocks. Wrapped by `withSteerDelivery` (`:644`) so steers ride its result; **not** in `REFUSED_AFTER_TERMINAL` (`:682`) — like `get_task`, an empty post-terminal check is harmless.
- **Phase-exit gate** — `advance_phase` (`:524`) and `ask_human` (`:442`), when `async` is present, refuse first if `dispatcher.hasPending()` **or `state.pendingTurns` has any role present**. The disk half is load-bearing on reconnect: the fresh server's live dispatcher is empty, so a `dispatcher.hasPending()`-only gate would let `advance_phase`/`ask_human` **bypass an orphan** — violating the invariant "refused while *any* pending record is non-collected," and on disk is exactly where an orphan lives. (Disk and live move in lockstep for the lease-holder — dispatch writes the record, settle updates it, collect clears it — so the only case the disk check adds is the orphan; the `||` is the belt-and-suspenders.) Prescribed-recovery copy: collect the outstanding turn with `check_turns` (or recover the orphan) before advancing/flagging. Blocking host: both halves empty → no-op.

**Run-scoped server wiring** (`mcp-server.ts`).
- The dispatcher lives **inside `ctx`** beside providers/rails (`:149`), constructed with the current `phase`/`cap`/`providers` and the server-scoped `holdsLease` thunk (slice 2). `toolsFor` (`:151-160`) **rebuilds the dispatcher when `ctx.phase !== phase`** (the same condition that rebuilds providers/rails at `:156`) — so a gate crossing never serves a stale phase/cap/provider. This rebuild is safe because the phase-exit gate forbids advancing with a pending turn: the old `ctx`'s dispatcher is always empty (no live promise, no uncollected record) at the moment `ctx` rebuilds, so dropping it strands nothing. `toolsFor` passes `async: { dispatcher: ctx.dispatcher }`.
- `surface()` (`:170-173`) passes `async` with a throwaway 'frame' dispatcher (mirroring its existing throwaway-providers pattern) so `check_turns` appears in the advertised metadata; its delegating handler routes through `callTool` → `toolsFor` like the rest, so the throwaway is never invoked.
- The delegating wrapper (`:191-194`) is unchanged — it already forwards every surface tool, including the new one.
- Driver (`driver.ts:221`) and single-phase `buildKernelTools` (`mcp-server.ts:45`) pass **no** async marker → blocking, no `check_turns`.

**Status observability** (`status.ts`).
- `StatusModel` (`:102`) gains `pendingTurns?: Array<{ role: WorkerRole; tag: string; status: 'running' | 'ready' | 'failed'; startedAt: string }>`, built from `state.pendingTurns` in `buildStatusModel` (`:130`); the text renderer (`:228`) and `--brief` surface a one-liner per role (e.g. "reviewer: ready — collect with check_turns"). Additive only (schema-additive-only house rule). This makes a running/ready turn visible from `duet status` the moment async exists, not only under `--wait` (slice 5 then leverages it).

**Identity** (`prompts/orchestrator-identity.md`, `<protocol>` block ~line 14-20).
- Teach: `send_prompt` now dispatches a worker turn and returns immediately (the session stays live); pull results with `check_turns`; the rhythm is fire → keep talking / steer / check status → `check_turns` to collect; a phase cannot advance while a turn is uncollected. Keep it provider/CLI-coherent so `tests/skill.test.ts` stays green (`check_turns` is a kernel tool, not a `duet` verb, so the verb extractor ignores it).

**Tests.**
- `tests/tools.test.ts` — extend the `harness()` helper to optionally construct a `TurnDispatcher` (with a passing `holdsLease: () => true` by default) and pass `async: { dispatcher }`. Add a **`DeferredWorker`** to `tests/helpers/fixtures.ts` — a third adapter on the `WorkerProvider` seam whose `runTurn` returns a promise the test resolves/rejects on command (`worker.resolve(turn)` / `worker.reject(err)`), so "returns before the worker completes" is directly observable. New cases:
  - `send_prompt` (async) **resolves before** the worker turn: dispatch with a `DeferredWorker`; the tool result arrives (the "dispatched" message) while the worker promise is still pending (`expect.assertions` guards the ordering).
  - `check_turns` reports still-running before settle, then delivers the worker text after `worker.resolve(...)`; after collection `loadRunState` shows the durable bookkeeping committed (round +1 for a review tag, sent tag appended, session id, cost).
  - same-role guard across the lifecycle, **all three settled states**: a second `send_prompt` to the same role is refused while `running`, while `ready`-uncollected, **and while `failed`-uncollected**; allowed after `check_turns` collects (covering both a ready and a failed collection).
  - cross-role concurrency: dispatch implementer and reviewer; both run; `check_turns` returns both results.
  - **failed settle:** `worker.reject(infraError)`; `check_turns` delivers the prescribed-recovery error; `loadRunState` shows **no** round, **no** sent tag; a retry `send_prompt` of the same tag trips **no** duplicate-template warning (retry rail preserved).
  - **branch-fix one-way:** after one async dispatch, `create_branch` is refused; after that turn **fails** and is collected, `create_branch` is **still** refused (`workerDispatched` durable).
  - **phase-exit gate, all settled states:** `advance_phase` and `ask_human` refused while a record is `running`, `ready`-uncollected, **or `failed`-uncollected**; allowed once `check_turns` has drained every record.
  - **lease fence:** with `holdsLease: () => false` at settle time, the settle is inert — `loadRunState` shows no round / no session-id / `pendingTurns` not flipped (the durable proof the superseded-server case is safe, now testable because the dispatcher + lease coexist in this slice).
  - **reconnect orphan, every surface (slice-3 self-safety):** seed `state.pendingTurns[reviewer]=running` on disk, build a **fresh** dispatcher (empty in-memory, `dispatcher.hasPending()===false`) over that run, and assert the orphan is neither bypassed nor hidden on any async surface: (a) a same-role `send_prompt` is refused with the minimal orphan copy and does **not** route to the worker (`FakeWorker.calls` empty); (b) `advance_phase` **and** `ask_human` are refused (the disk half of the gate, since the live dispatcher is empty); (c) `check_turns` emits a generic orphan-recovery line and does **not** say "no turns in flight". This proves the invariant holds on disk in the slice-3 tree, before slice 4 refines the recovery copy.
  - **heartbeat stops at settle:** with `vi.useFakeTimers()`, after `worker.resolve` no further `⏳ … running` voice-log lines accrue even before `check_turns` (assert the voice-log tail count is stable across `advanceTimersByTime`).
  - **steer rides `check_turns`:** `stageSteer` before collect; the `check_turns` result carries the steer block (via `withSteerDelivery`).
- `tests/mcp-server.test.ts` — update `ALL_TOOLS` to assert host-divergent surfaces: the blocking registry advertises the 8 existing tools; the run-scoped (interactive) surface advertises 9 (adds `check_turns`). Add a case: a standard MCP client against the run-scoped server sees `check_turns`; against `buildKernelTools` (single-phase) it does not. Add a phase-boundary case: after a `crossInteractive` gate crossing, `toolsFor` rebuilds the dispatcher for the new phase (the new phase's `cap` governs).
- `tests/status.test.ts` — `buildStatusModel` surfaces a `running`/`ready` `pendingTurns` entry; the text/`--brief` renderer names "collect with check_turns".
- `tests/skill.test.ts` + `tests/snippets.test.ts` — must stay green (no new `duet` verb/flag, no snippet change). Verify in the gate.

**Gate / commit.** Full suite + typecheck green; `skill`/`snippets` green; `mcp-server` ALL_TOOLS updated. Commit `feat(tools): async send_prompt + check_turns on the interactive host`.

---

## Slice 4 — Reconnect orphan contract (with a no-session recovery path)

**Goal.** Slice 3 already ships the *minimal* orphan refusal (a same-role send is refused when an on-disk `pendingTurns[role]` has no live dispatcher record). Slice 4 **refines** that into branch-aware recovery and the `takeover` resolution — including a path that works **even when the orphaned turn never captured a session id** (the spec's first-turn reconnect case; today `takeover` hard-fails there, `cli.ts:699`).

**The two orphan sub-cases** (different recovery because the hazards differ):
- **Session orphan** (`state.workerSessions[role]` present): a resend would `claude --resume <id>` and race the still-possibly-alive old worker on that session. Recovery: `duet takeover <role>` resumes the session so the human can inspect/finish it.
- **No-session orphan** (`workerSessions[role]` absent — the role's first turn died before settle persisted an id): there is **no session to resume**, so a resend would start a *fresh* session (no resume race) — **but the old worker process may still be alive and editing the repo.** So dropping the orphan is **not "safe"**: it is a deliberate human decision to **abandon that in-flight turn**, and the copy must say so. Recovery: confirm the old worker is done (or accept the risk), then drop the orphan.

**Changes.**
- `send_prompt` / `check_turns`: **refine** the slice-3 minimal orphan refusal into a prescribed-recovery refusal (convention 4) that **branches on session presence**:
  - **session present** → "the prior turn to this role was orphaned when its session ended; it may still be resumable — inspect/finish it with `duet takeover <role>`, then re-send."
  - **no session** → "the prior turn was orphaned before a session id was captured. The old worker process **may still be running and editing the repo**, and there is no session to resume — dropping the orphan **abandons that in-flight turn**. Confirm it is done (or accept the risk), then run `duet takeover <role>` to drop it and re-send."
  The orphan persists (keeps the role closed); never auto-cleared, never auto-resent. (`check_turns` reports the same branch-aware copy; never delivers a worker result, never auto-collects.)
- `cli.ts` `takeover` (`:680`): make it the single "resolve this role's interrupted turn" affordance. At the `sessionId` check (`:699`): if a session exists → resume as today **and** `clearPendingTurn(role)` on return; if **no** session exists but an orphan `pendingTurns[role]` record does → do **not** hard-fail; print "no session was captured for the interrupted turn — **the old worker may still be running and touching the repo**; dropping the orphan **abandons that in-flight turn** so you can re-send" and `clearPendingTurn(role)`; if no session and no orphan → fail as today ("no session yet"). The orphan-clear is a per-role fresh-load→mutate→save (`clearPendingTurn`); it races the live server's saves only in theory — the human resolves an orphan when the orchestrator is stalled on the closed role (not mid-tool-call), so the window is negligible and per-role-scoped (the `markTurnActive` precedent, `run-store.ts:336`).
- No transcript classification: the contract never claims running-vs-finished from `readRoleTranscriptTail` (`sessions.ts:102`, needs a session id a first turn lacks) or `probeRole`. Detection is purely the durable record's existence-without-a-live-owner.

**Tests** (`tests/mcp-server.test.ts` for the tool behavior; a `takeover` test for the clears).
- **Session orphan:** seed `pendingTurns[implementer]=running` **and** `workerSessions.implementer`; fresh dispatcher (empty in-memory); `send_prompt` to implementer → refused, copy names `takeover` for inspect, `FakeWorker.calls` stays empty. `check_turns` → reports the orphan, no worker text, `pendingTurns` unchanged. `takeover implementer` → resumes (provider launch is the Environment seam — assert the launch spec, not a real spawn) and clears the record (`loadRunState().pendingTurns?.implementer` undefined); the role reopens.
- **No-session orphan:** seed `pendingTurns[reviewer]=running` with **no** `workerSessions.reviewer`; `send_prompt` to reviewer → refused, and the copy **states the race honestly** (names that the old worker may still be running / touching the repo and that dropping abandons the in-flight turn — the point-4 honesty check), no worker call. `takeover reviewer` → does **not** hard-fail; clears the orphan, prints the same race-honest no-session message, no provider launch; the role reopens.
- `takeover` with no session **and** no orphan → still fails ("no session yet") — the existing behavior is unregressed.
- A different role with no orphan is unaffected (cross-role isolation).

**Gate / commit.** Green → commit `feat(mcp-server): reconnect orphan contract + takeover recovery (incl. no-session)`.

---

## Slice 5 — `duet status --wait` wakes on turn completion

**Goal.** Keep the collect tool strictly instant; put "block until ready" in the CLI (separate process, no session freeze). Today `waitForRunStop` (`lifecycle.ts:246`) wakes only on a run *stop*; the status output already carries the pending-turn field (slice 3), so the wake just needs to fire on a turn settling.

**Changes.**
- `lifecycle.ts`: `waitForTurnOrStop(cwd, runId, opts?) → RunPosition | { kind: 'turn-ready'; roles: WorkerRole[] }` — polls fresh state each interval. **The predicate must be turn-aware, not stop-only:** an interactive orchestrator run probes as `interactive`, never `running` (`lifecycle.ts:174`), so a naive "wake when not `running`" would wake instantly on exactly the host this is for. The rule:
  - return `{ kind: 'turn-ready', roles }` as soon as any `pendingTurns` record is `ready`/`failed`;
  - return the position for a real stop — `gate` / `flag` / `crashed` / `done` / `abandoned`;
  - return the position immediately for `interactive` (or headless `running`) with **no** `running` pending turn (nothing to wait for);
  - **keep polling** only while position is `interactive`/`running` **and** a pending turn is still `running`.
  Read-only (interrupting it cannot mutate the run), mirroring `waitForRunStop`.
- `cli.ts` `status --wait` action (the `opts.wait` branch that today calls `waitForRunStop`): call `waitForTurnOrStop`; when it returns `turn-ready`, print the ready roles' line **before** `showStatus` (so the wake says *why* it woke — "reviewer ready; call check_turns"); otherwise `showStatus` as today. The pending-turn field added in slice 3 means `showStatus` already carries the signal; this only ensures the wake foregrounds it. (`status --wait` flag text already exists; no `skill.test` impact.)

**Tests** (`tests/lifecycle.test.ts`).
- `waitForTurnOrStop` returns `turn-ready` with the role when a `pendingTurns` record flips to `ready` mid-poll (write `running`, then on the next tick write `ready`; with fake timers the wait resolves with that role).
- **Regression guard for the immediate-wake bug:** an **interactive** run with a `running` pending turn does **not** wake — it keeps polling — until the turn flips to `ready`/`failed` (without this the predicate would return on the first poll because the position is `interactive`, not `running`).
- An `interactive` run with **no** pending turn returns immediately (nothing to wait for — the interactive rest is itself the answer).
- It still returns the stop position on a real stop (existing `waitForRunStop` behavior preserved — a gate/flag/done resolves it).
- It is read-only: the run state before and after an interrupted wait is byte-identical (no marker, no mutation).

**Gate / commit.** Green → commit `feat(status): --wait wakes on worker-turn completion`.

---

## Verification story

**The two spec Risks.**
- *execa `cleanup:true` interrupts the worker on session quit (`claude.ts:152`).* This is execa's documented default, not our code. Plan coverage: (a) a cheap unit guard asserting our `execa('claude', …)` options in `claude.ts` do **not** set `cleanup:false` (a regression tripwire); (b) the **slice-3 lease-fence test** covers the operationally important case — *even if* the old worker/process lingers, a superseded settle is inert — so correctness does not depend on the kill actually firing. The live confirmation (spawn a real `_mcp`, dispatch a long turn, SIGTERM the parent, observe the worker child dies and the process exits) is **environment-touching and the human's to run in the verify phase** — flagged, not attempted here.
- *The `_mcp` process may not exit promptly on transport close.* Same: named as a human verify-phase manual check; the lease (slice 2 primitive, enforced at the slice-3 dispatcher's settle) is the guarantee that holds regardless, and the slice-3 fence test proves it in-process.

**Gates kept green every slice.** `pnpm typecheck && pnpm test`, including `tests/skill.test.ts` and `tests/snippets.test.ts` (the five-second pins). Slice 3 updates `tests/mcp-server.test.ts` `ALL_TOOLS` for the host-divergent surface. **Every committed tree is safe**: the lease primitive (slice 2) lands before any background writer, so async dispatch (slice 3) is lease-guarded from its first commit — no intermediate commit exposes the two-interactive-writers hazard.

**Test-pinned vs. narrative docs (the boundary the AFK run must respect).**
- **Lands with code, in-slice** (needed for the feature to function and/or to keep a gate green): the fire → collect rhythm in `prompts/orchestrator-identity.md` and the `check_turns` tool description / result / error text — both in **slice 3** (the tool is inert if the orchestrator isn't taught to collect, and all tool text follows `docs/prompting-and-tool-design.md` conventions 3/4/5); the `mcp-server.test.ts` surface assertions — **slice 3**. `skill.test`/`snippets.test` need no edits (no new `duet` verb/flag, no snippet change) but are verified green each slice.
- **Deferred to the DOCS phase** (narrative, not test-pinned): `docs/automation-design.md` (tool-surface table + interactive-orchestrator section), `docs/engineering.md` (module map + the interactive-host / host-neutral-kernel patterns), the `docs/open-questions.md` A′-vs-B fork entry with its revisit trigger, and the stale `skills/duet/identity.md` reference cleanup in framing / `CLAUDE.md` / docs. None gate the AFK build.

## Test inventory (by seam)

- **`WorkerProvider` seam** — `FakeWorker` (existing) and a new `DeferredWorker` (commandable resolve/reject) in `tests/helpers/fixtures.ts`. The only fake in the async tests; nothing internal is mocked.
- **Filesystem / run dir** — real, in the `projectDir`/`run`/`interactiveRun` fixtures (`tests/helpers/fixtures.ts`); `pendingTurns`, `workerDispatched`, and `mcp-owner.json` are asserted through `loadRunState` / the run dir, behavior-through-interface.
- **Time** — `vi.useFakeTimers()` for the heartbeat-stops-at-settle and the `waitForTurnOrStop` poll cases only (the documented heartbeat exception in the testing strategy).
- **MCP boundary** — `tests/mcp-server.test.ts`'s existing real client/server over the in-memory transport, for surface divergence and the lease/orphan behaviors.

No new seam is introduced — the dispatcher is our own module (tested through its interface and through the `send_prompt`/`check_turns` handlers), not a fake.
