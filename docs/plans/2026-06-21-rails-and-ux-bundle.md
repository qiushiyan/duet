# Plan — Rails-and-UX bundle

**For:** `docs/specs/2026-06-21-rails-and-ux-bundle.md` (committed `1a6def7`). **Date:** 2026-06-21. **Branch:** `feat-rails-ux-bundle`.

Vertical slices, TDD (red→green per behavior, never horizontal). Each slice is one reviewable idea and one commit. Tests exercise behavior through the six seams (`docs/engineering.md` §Seams); **never mock our own modules** — fake only at a seam (the `WorkerProvider` adapters in `tests/helpers/fixtures.ts`, the SDK boundary `RunOrchestratorTurn`, the `ClaudeLauncher`, the Environment fs/process via `projectDir`). `pnpm typecheck && pnpm test` stays green at **every** commit (the suite is ~530 cases; `validateRegistry` runs at module load; `phaseBriefBuilders satisfies Record<PhaseName,…>` is a compile guard).

## Empirical grounding (spec open question 1 — resolved during planning)

A forced cutoff (`claude -p --output-format json --max-budget-usd 0.000001 "say hi"`, CLI `2.1.185`) produced:

- **exit code `1`** → `execa` (default `cleanup`/throw) **throws** before `runTurn` returns;
- but the thrown error's **`.stdout` is a complete, parseable JSON array** whose final `result` element is:
  `{"type":"result","subtype":"error_max_budget_usd","is_error":true,"session_id":"…","total_cost_usd":0.0131…,"modelUsage":{…"contextWindow":200000},"errors":["Reached maximum budget ($…)"]}`
- the assistant's partial text is in the `assistant` message elements (the `result` element has **no `result` text field** on a budget cutoff);
- `session_id`, `total_cost_usd`, and `modelUsage` are all present → **resumable, with recoverable cost/context.**

**Decisions this fixes in stone for slice 4:**
- Detection lives in the **execa-error path** of `ClaudeWorker.runTurn` (`src/providers/claude.ts:180`), inspecting `error.stdout` — *not* the normal `parseClaudeTurn` success path, which the throw bypasses.
- The observed shape maps to the spec's **parseable tier** (session id present → normal settlement). The **fallback tier** (budget detected but no usable `session_id`/stdout) is retained as a defensive branch, tested with a synthetic envelope, not the common path.
- The signal string is exactly `error_max_budget_usd`, matching the spec's assumption. The slice's tests pin this shape; a future CLI change that alters it fails those tests loudly (the intended tripwire).

## Existing tests this bundle deliberately rewrites (named so no green turns silently red)

- `tests/providers.test.ts:45-47` — currently asserts `parseClaudeTurn` **throws** `claude worker turn failed (error_max_budget_usd)…`. Slice 4 inverts this to "returns a budget-truncated turn." Rewritten there, not elsewhere.
- `tests/run-store.test.ts:199-203` ("pr stays force-attended … even when gates_at excludes it") and `:189-196` (pr via forceAttend) — Slice 6 drops `pr` from `forceAttend`, so these become "pr auto-opens by default; attended only when explicitly listed."
- `tests/framing.test.ts:20-26, 81, 97` (and the `resolveRunInputs` pr-append case near `:310`) — the `parseGatesAt`/`parseFramingFile` table asserts `pr` is appended ("pr always attended"). Slice 6 makes them "no `pr` appended; `pr` attended only when explicitly listed." Rewritten in Slice 6 (the reviewer's catch — these were missing from this list).
- `tests/status.test.ts:374` ("attending impl, pr — other gates pre-authorized") — verify/adjust under Slice 6 (it must set `gatesAt` explicitly incl. `pr`; it can no longer rely on `forceAttend` appending `pr`).
- `tests/tools.test.ts` — the `write_note`-while-parked refusal (Slice 8) and the `renderTurnResult` content assertions (Slice 9, footer is additive) get updated where they pin exact output.

## Landing order & self-hosting hazard

Order follows the spec: Change 0 (0a, then 0c) → #3 (knob, then checkpoint) → #2 → #1 → UX. **0b is folded into Slice 7 (#1)** — its only consumer is `duet afk`; #2 needs only 0a, not 0b, so no dependency is violated and a concept (an orphan mutator slice) is avoided.

**Self-hosting-hazard slices** (a fresh `duet` invocation reloads edited source): **1** (`run-store.ts`), **2** & **4/5** (`driver.ts`), **3** (`run-store.ts` + `cli.ts` + config loading — a half-baked config parse breaks any invocation), **6** (`phases.ts` load-time `validateRegistry` — a registry that fails validation throws at module load, bricking every command), **7** (`lifecycle.ts`, `cli.ts` `_drive`/spawn). Each is sequenced so the suite is green at its commit; verify `pnpm typecheck && pnpm test` before committing, and drive this run's own build from a frozen duet (per the spec's build/verify constraint), never the worktree's `src/`.

---

## Slice 1 — `defaultPreAuthorized` + disjointness invariant + materialize-at-`createRun` (0a)

**Idea.** Add the registry's "off-by-default-but-opt-in" gate set and materialize a new run's default posture at creation, leaving `gateAttended` and legacy (absent-`gatesAt`) behavior untouched. Both workflows ship `defaultPreAuthorized: []` here, so this slice is **pure infra** (no run behaves differently); #2 (Slice 6) populates it for Full.

**Seam:** registry (load-time `validateRegistry`) + Environment (createRun writes `state.json` under `projectDir`).

**Code anchors.**
- `src/phases.ts`: add `readonly defaultPreAuthorized: readonly string[]` to `WorkflowSpecInput` (`:66-89`) and to both `WORKFLOWS` entries as `[]` (`full` `:228`, `rir` `:277`). Extend `validateRegistry` (`:347-394`) beside the existing `forceAttend` check (`:379`): each `defaultPreAuthorized` entry is a gate phase, **and** `defaultPreAuthorized ∩ forceAttend = ∅`. Add a `defaultPreAuthorizedOf(workflow)` accessor next to `gatePhasesOf` (`:447`).
- A pure helper `defaultPosture(gatePhases, defaultPreAuthorized): GatePhase[] | undefined` — returns `undefined` when `defaultPreAuthorized` is empty (≡ absent ≡ attend-all/legacy), else `gatePhases.filter(g ∉ defaultPreAuthorized)`. (Pure so it's branch-testable without mutating the real registry — mirrors how `phases.test.ts` tests `validateRegistry` with synthetic `workflow({…})` inputs.)
- `src/run-store.ts` `createRun` (`:291-336`): when `opts.gatesAt` is absent, set `gatesAt = defaultPosture(gatePhasesOf(wf), defaultPreAuthorizedOf(wf))` (still absent while `defaultPreAuthorized` is `[]`).

**Tests.**
- `tests/phases.test.ts` (extend the `validateRegistry` table at `:68-70` style): a `defaultPreAuthorized` entry that isn't a gate phase throws; a gate in **both** `forceAttend` and `defaultPreAuthorized` throws (disjointness) — both via synthetic `workflow({…})` registries.
- `defaultPosture` unit: empty `defaultPreAuthorized` → `undefined`; `['pr']` over the full gate set → `['frame','spec','plan','impl','docs']` (order preserved); a 2-element exclusion drops both.
- `tests/run-store.test.ts`: `createRun` with no `gatesAt` and the shipped (empty) `defaultPreAuthorized` leaves `gatesAt` **absent** (legacy/pure-infra preserved — the existing `gateAttended` attend-all tests at `:184-196` stay green); `createRun` with an explicit `gatesAt` persists it unchanged.

**Commit:** `feat(phases): add defaultPreAuthorized gate set + materialize default posture at createRun`.

---

## Slice 2 — the `budgetFor` resolver (0c)

**Idea.** Route every budget read through one resolver, returning today's per-phase numbers (a **pure refactor — behavior identical**). This isolates the four call sites so Slice 3's knob is a one-place change.

**Seam:** the resolver as a pure function + the `WorkerProvider` construction sites.

**Code anchors.**
- New `budgetFor(state, phase): { worker: number | undefined; orchestrator: number | undefined }` — **home: `src/run-store.ts`, beside `gateAttended`** (settled: both resolve run-state policy against the phase registry, so they belong together; a separate `src/budget.ts` would be a shallow one-function module. `run-store` already imports `PHASE`, and this stays out of `worker-health.ts` to respect the no-cycle rule). At this slice it returns `{ worker: PHASE[phase].workerBudgetUsd, orchestrator: PHASE[phase].orchestratorBudgetUsd }`.
- Adopt at all sites: `src/harness/driver.ts:224` (`createWorkers` rails) and `:241` (`Options.maxBudgetUsd`); `src/harness/mcp-server.ts:54` and the `defaultWorkerFactory` `:137-138`.
- `src/providers/index.ts:21` — widen `createWorkers`' `rails.workerBudgetUsd` to `number | undefined` (`ClaudeWorker` already omits `--max-budget-usd` when undefined, `src/providers/claude.ts:161`). `Options.maxBudgetUsd` set only when defined (`driver.ts:241`).

**Tests.**
- `budgetFor` returns each phase's current worker/orchestrator caps (parity snapshot for a couple of phases, e.g. `impl` → `{25,30}`, `open` → `{5,5}`).
- `tests/providers.test.ts` `createWorkers` (`:482`) extends: a `workerBudgetUsd: undefined` rail builds a `ClaudeWorker` that omits the budget arg (assert via the existing arg-building/`claudeExecaOptions`-style inspection or a constructed-worker check). Existing driver/mcp tests stay green (parity).

**Self-hosting:** touches `driver.ts`. Pure refactor → suite green confirms no behavior drift.

**Commit:** `refactor(budget): route all per-turn caps through one budgetFor resolver`.

---

## Slice 3 — budget knob: config + RunState + `--budget` (3a)

**Idea.** A run-level budget knob (config + flag), frozen at creation, that makes `budgetFor` return "off" (undefined caps) by default.

**Seam:** config (fs) + Environment (createRun) + the `WorkerProvider` sites (observable: off → no `--max-budget-usd`).

**Code anchors.**
- `src/config.ts`: parse a **top-level** `budget` key — `"off"` | `"default"` | a positive number (multiplier) — via a sibling `parseBudget(value)`; amend the invariant comment (`:6-12`) to "role→provider/model bindings **and account/billing posture (transport, budget)**; project knowledge never goes here." **Choose the module shape now** (the reviewer's finding 4 — config is *not* part of `resolveRunInputs`, which is framing/frontmatter only; config loads separately at `cli.ts:159` via `loadRoleBindings`): introduce `loadRunConfig({ roleOverrides?, budgetOverride? }, configPath?) → { bindings: RoleBindings; budget?: number }` as the new config entry, and keep `loadRoleBindings(...) = loadRunConfig(...).bindings` as the **compatibility wrapper** (so existing callers and `config.test.ts` stay green). The `--budget` flag is the `budgetOverride`; precedence (flag > config > off) is resolved inside `loadRunConfig`, not at resolve-inputs. Default (absent) ⇒ **off**.
- `src/run-store.ts`: add `budget?: number` to `RunState` (the resolved multiplier; **absent ⇒ off**, frozen at creation, never mutated — the lifetime contrast with mutable `gatesAt`). `createRun` accepts and persists it. **AFK caution — "off" resolves to `undefined`/absent, never `0`:** the whole plan keys "disabled" off `RunState.budget` *absence* (`budgetFor` returns `undefined` caps when absent), so `loadRunConfig` must normalize `"off"` (and the default) to no `budget` field — a `0` would be read as a real zero-dollar cap that cuts every turn instantly. `parseBudget` returns `undefined` for `"off"`, a positive multiplier otherwise; `createRun` omits the field when undefined (the existing spread-when-present idiom).
- `budgetFor` (Slice 2): when `state.budget` is absent → `{ worker: undefined, orchestrator: undefined }`; else `PHASE[phase].*BudgetUsd * state.budget`.
- `src/cli.ts` `new` action (`:139-208`): a `--budget <off|default|N>` option, passed as `loadRunConfig`'s `budgetOverride` (alongside the existing `--orchestrator`/`--impl`/`--reviewer` role overrides at `:159`), and the resolved `budget` handed to `createRun`.

**Tests.**
- `tests/config.test.ts` (the config seam): `parseBudget` maps `off`→off, `default`→×1, `2`→×2; rejects negatives/garbage with an actionable message. `loadRunConfig` precedence — flag `budgetOverride` wins over a config `budget`; config `budget` wins over the absent⇒off default; `loadRoleBindings` still returns just bindings unchanged (wrapper parity).
- `budgetFor`: `budget` absent → both caps `undefined`; `×1` → today's numbers; `×0.5` → halved (both worker **and** orchestrator — one knob, both roles); a worker built under off omits `--max-budget-usd`.
- `tests/run-store.test.ts`: `createRun` freezes `budget`; it is read back by a later `budgetFor`. The CLI→createRun handoff carries the resolved value (assert via `createRun`'s persisted `RunState.budget`, the Environment seam).

**Self-hosting:** touches `driver.ts` only via the already-adopted `budgetFor`; config/run-store reload is benign.

**Commit:** `feat(budget): opt-in budget knob in config + --budget, default off`.

---

## Slice 4 — worker budget cutoff → checkpoint, not infra (3b worker half)

**Idea.** A worker that hits the cap is a graceful checkpoint (committed work on disk, session resumable), never the "worker never saw your prompt, retry" envelope. Grounded in the empirical shape above: detect in the execa-error path, parse the budget envelope, settle normally.

**Seam:** `WorkerProvider` boundary (`parseClaudeTurn` is the pure CLI-output seam, `providers.test.ts:20`) + the kernel-tool seam (`settleTurn`/`renderTurnResult` via the `tools.test.ts` `call()` harness).

**Two typed outcomes (finding 1 — a partial `WorkerTurn` is unrepresentable):** `WorkerTurn.sessionId` is **required** (`src/providers/types.ts:25`) and `settleTurn` writes it unconditionally into `workerSessions[role]` (`src/harness/tools.ts:209`), so the fallback cannot be a session-less `WorkerTurn` (TS error / corrupt session map). Model the two tiers as two distinct types:
- **Parseable tier** → a settleable `WorkerTurn` carrying `budgetTruncated?: true` (real `sessionId` present → settles normally; this is the empirically-observed common case).
- **Fallback tier** → a typed `BudgetCutoffError extends Error` (a recognizable error, **not** a `WorkerTurn`) → flows the error arm, which writes **no** bookkeeping — that *is* "no settlement promised."

**Code anchors.**
- `src/providers/types.ts:25-36`: add `budgetTruncated?: true` to `WorkerTurn`. Add a `BudgetCutoffError` class (here or in `claude.ts`) — an `Error` subclass with a discriminant (e.g. `readonly kind = 'budget'`) so `renderTurnResult` can `instanceof`-distinguish it from a generic infra `Error`.
- `src/providers/claude.ts`: `parseClaudeTurn` (`:81-114`) — on `subtype === 'error_max_budget_usd'` **with** a `session_id`, **return** a `WorkerTurn { budgetTruncated: true, sessionId, costUsd, context, text }` (text = best-effort last `assistant` text block, since the budget `result` element carries no `result` field) instead of throwing at `:94-96`; on the budget subtype **without** a usable `session_id`, throw `BudgetCutoffError`; all other `is_error`/non-success still throw a plain `Error`. In `runTurn` (`:158-183`), wrap the `execa` call (`:180`): on a thrown execa error, attempt `parseClaudeTurn((err as ExecaError).stdout ?? '', prompt)`; a returned `budgetTruncated` turn → return it (**parseable tier**); a `BudgetCutoffError` → re-throw it (**fallback tier**, propagates as the typed error); a parse failure / non-budget → re-throw the **original** execa error (genuine infra, message preserved).
- `src/harness/tools.ts`: `settleTurn` (`:194-237`) — a `budgetTruncated` turn is **not** an `Error`, so it already flows the success arm (commits session/cost/context). A `BudgetCutoffError` flows the **error arm** (`:201-206`) → clears the in-flight hint and writes **no** session/round/cost (exactly "no settlement"), **but its log/voice line gets a budget-specific branch** — "AFK caution: the error arm's log (`[send_prompt] ✗ … turn failed`, `:202`) and the voice-log line must say *budget-control stop*, not generic "worker failure," so the driver log reads honestly when no reviewer is watching. `BudgetCutoffError` is **never** treated as infra anywhere — not in `renderTurnResult` and not in this internal log — consistent with Slice 5's `cause: 'budget'`.
- `renderTurnResult` (`:245-275`) branches three ways: a `budgetTruncated` turn → the **checkpoint** message ("budget reached — the worker saw your prompt; committed work is on disk; resume the session for the remainder or raise the budget"); a `BudgetCutoffError` → a **budget-control recovery** ("budget reached; the worker ran and committed work may be on disk — check git and resume manually; not an infra failure"); any other `Error` → the existing infra envelope (`:252-262`). Never the retry/auto-retry path for either budget outcome. (Single chokepoint → covers both `send_prompt` and `check_turns`.)

**Tests.**
- `tests/providers.test.ts`: **rewrite `:45-47`** — `parseClaudeTurn` on an `error_max_budget_usd` envelope **with** `session_id` returns `{ budgetTruncated: true, sessionId, costUsd, context }` (fixture built from the captured real shape: result element + a preceding `assistant` text block); the budget envelope **without** `session_id` throws `BudgetCutoffError` (assert the type, not a string match); a genuine non-budget error still throws a plain `Error`.
- `ClaudeWorker.runTurn` over a faked `execa` (the provider's external boundary — mock `execa` here, a true system boundary): a thrown error carrying budget `stdout` (with session) → returns the `budgetTruncated` turn; budget stdout without session → throws `BudgetCutoffError`; empty/garbage stdout → re-throws the original (infra).
- `tests/tools.test.ts`: a `budgetTruncated` turn → `settleTurn` persists session/cost (and round when a review tag); `renderTurnResult` emits the checkpoint text, `isError` falsey, no "never saw your prompt" / no "Retry this same send_prompt". A `BudgetCutoffError` → `settleTurn` writes **no** session/round/cost (assert the bookkeeping is untouched — the "no settlement" guarantee), and `renderTurnResult` emits the budget-control recovery, distinct from the infra envelope. A plain `Error` still renders the infra envelope (regression).

**Self-hosting:** `driver.ts` not touched here (provider + tools only).

**Commit:** `feat(budget): a worker budget cutoff is a resumable checkpoint, not an infra error`.

---

## Slice 5 — orchestrator budget cap → `cause: 'budget'` (3b orchestrator half)

**Idea.** When the orchestrator itself hits its cap, the queued stop is classified budget/control (resumable), not infra — a coherent widening of the existing `cause` triage schema.

**Seam:** the SDK boundary (`driver.ts` via the `RunOrchestratorTurn` fake in `driver.test.ts`) + status (pure).

**Code anchors.**
- `src/run-store.ts:188`: widen `pendingQuestion.cause` from `'human' | 'infra'` to `'human' | 'infra' | 'budget'`.
- `src/harness/driver.ts:305-317`: the `message.subtype !== 'success'` branch — when `subtype === 'error_max_budget_usd'`, queue `cause: 'budget'` with a resumable question (no `errorClass`; budget isn't an infra taxonomy class), else keep today's `cause: 'infra', errorClass: 'unknown'`.
- `src/status.ts:113` (`StopModel` flag) and `:219-227` (the flag `stopModel`): carry `cause: 'budget'`; `renderStatus` flag block (`:349-354`) names a budget stop as resumable. Schema is additive-but-enum-widening — consumers gain a value and need a default branch.

**Tests.**
- `tests/driver.test.ts`: a scripted orchestrator turn whose `result` is `subtype: error_max_budget_usd` → `pendingQuestion.cause === 'budget'`, no `errorClass`, and a `phase.flag` event; a non-budget abnormal subtype still → `cause: 'infra', errorClass: 'unknown'`.
- `tests/status.test.ts`: a `budget`-cause flag renders distinctly from `infra`/`human`; the JSON model carries `cause: 'budget'`; an existing `infra`/`human` flag is unchanged (additive).

**Self-hosting:** touches `driver.ts` — keep suite green.

**Commit:** `feat(budget): orchestrator cap queues a resumable budget stop, not an infra flag`.

---

## Slice 6 — auto-open the PR (#2)

**Idea.** Flip the Full PR gate to friction-free-default-on, opt-in-attendable; make the `open` entry prompt honest about how the gate was crossed. This is where Slice 1's materialization first changes observable behavior.

**Seam:** registry (load-time) + Environment (createRun materialization) + orchestrator-prompts (pure string).

**Code anchors.**
- `src/phases.ts`: `WORKFLOWS.full.forceAttend = []` (drop `'pr'`, `:228`); `WORKFLOWS.full.defaultPreAuthorized = ['pr']` (`:228` area). `validateRegistry`'s disjointness check (Slice 1) now actively guards this pair. RIR untouched (`forceAttend: []`, `defaultPreAuthorized: []`).
- `src/harness/orchestrator-prompts.ts`: `openPhaseEntryPrompt` (`:358-367`) becomes state-aware — replace the hardcoded "The human approved opening the PR" (`:360`) with `approvalClause(state, 'pr', <attended copy>, <pre-authorized auto-crossed copy>)` (the helper at `:156-158`). Update the `phaseBriefBuilders` `open` entry (`:443`) to pass `state` (it currently ignores it).
- `src/status.ts`: `opensPr`/`completionLine` (`:24-32`) already key on the `openPrGate` **state name** — unchanged (we keep the gate). The Open-PR gate `hint` copy (`src/phases.ts:195`) — soften "(approving opens the PR…)" since approval is no longer the default path.
- **Stale user-facing "always attended" copy (finding 2):** `FRAMING_TEMPLATE` (`src/framing.ts:63`, "full's Open-PR gate is always attended") and the CLI `--gates-at` help (`src/cli.ts:128`, same wording) must change to "auto-opens by default; list `pr` to attend a pre-open stop." Also the `parseGatesAt` doc comment (`src/framing.ts:308`, "the Open-PR gate, never pre-authorizable") is now wrong.

**Tests.**
- `tests/run-store.test.ts`: **rewrite `:189-196`/`:199-203`** — a new default Full run materializes `gatesAt = ['frame','spec','plan','impl','docs']` (pr excluded) so `gateAttended(run,'pr') === false` (auto-open); an explicit `gates_at` listing `pr` → `gateAttended(run,'pr') === true` (opt-in pre-open stop); a **legacy** run (absent `gatesAt`, simulating pre-change state) → `gateAttended(run,'pr') === true` (compat — the auto-open default never reaches it).
- `tests/phases.test.ts`: `WORKFLOWS.full.defaultPreAuthorized` is `['pr']` and disjoint from `forceAttend`; `gatePhasesOf('full')` unchanged (`:109`).
- `tests/framing.test.ts`: **rewrite the pr-append cases (`:20-26, 81, 97`, the `resolveRunInputs` case near `:310`)** — `parseGatesAt('frame,spec')` → `['frame','spec']` (no `pr`); `parseGatesAt('overnight')` → `['frame','spec']`; `parseFramingFile` with `gates_at: overnight` → `{ gatesAt: ['frame','spec'] }`; an explicit `gates_at` listing `pr` → keeps `pr`. RIR cases unchanged.
- `tests/status.test.ts:374`: adjust so its explicit `gatesAt` includes `pr` rather than relying on `forceAttend` to append it.
- orchestrator-prompts: `openPhaseEntryPrompt(attendedRun)` contains the "human approved" clause; `openPhaseEntryPrompt(preAuthorizedRun)` contains the "auto-crossed / pre-authorized" clause and **not** the false "human approved opening the PR."
- A content guard (cheap regression): no shipped help/template copy claims the Open-PR gate is "always attended" (`FRAMING_TEMPLATE`, the `--gates-at` help string).

**Self-hosting:** touches `phases.ts` (load-time `validateRegistry`).

**Commit:** `feat(pr): auto-open the PR by default; keep an opt-in pre-open stop`.

---

## Slice 7 — `duet afk` + mutable posture (0b) + host-aware F1 message (#1)

**Idea.** One human tap from any interactive gate (attended *or* pre-authorized) re-sets the downstream posture and hands off to the headless driver; the `advance_phase` "what happens next" message stops lying on the interactive host. Folds in 0b (the mutator, whose sole consumer is this).

**Seam:** lifecycle (the interactive-crossing seam, as `crossInteractive`/`interactiveContinueAction` already are) + run-store (the mutator) + the kernel-tool seam (`tools.test.ts` `call()` harness, dispatcher injectable) + framing (`parseGatesAt` for presets).

**Code anchors.**
- `src/run-store.ts`: a `setGatesAt(state, gatesAt)` mutator following the **fresh-load → mutate-this-field → save** discipline (beside `markTurnActive` `:380`/`settlePendingTurn` `:415`), syncing the passed copy. This is 0b.
- A testable lifecycle function (e.g. `enterAfk(state, posture)` in `src/harness/lifecycle.ts` near `crossInteractive` `:427`/`interactiveContinueAction` `:462`): validates the run is interactive + parked at a gate via `probeRunPosition` (`:143`) / `validateInteractiveCrossing` (`:481`) — **legal at a pre-authorized gate** (kind `gate`, not `gateAttended === true`); sets posture via `setGatesAt` (stale-save-safe: combine posture + any rider in one fresh-load pass, or reload between saves — the spec's discipline); `crossInteractive(state, {type:'human.approve'})`; clears `orchestrationHost`. Returns enough for the CLI to `spawnDrive` and print the attended/pre-authorized split.
- Preset resolution: bare `afk` → `[]` (attend none, the recognized empty posture); a named arg → `parseGatesAt(preset, workflow)` (`src/framing.ts:311`). No new presets.
- `src/cli.ts`: a new `afk [preset] [runId]` command — thin wiring over `enterAfk` + `spawnDrive` (`:206`-style) + the split print. (CLI wiring stays untested directly, like the rest of `cli.ts`; behavior lives in `enterAfk`.)
- F1: `src/harness/tools.ts` `advance_phase` `next` message (`:716-723`) — the pre-authorized branch becomes host-aware on `asyncDeps?.dispatcher` presence (`:341`, the interactive-host switch): interactive → "the run does not auto-continue here; hand off with `duet afk` or `duet continue --approve --headless`"; headless → unchanged.

**Tests.**
- `tests/lifecycle.test.ts` (extend the `crossInteractive`/interactive block at `:453`): `enterAfk` at an **attended** interactive gate sets `gatesAt = preset`, crosses to the next phase-loop snapshot, clears `orchestrationHost`; at a **pre-authorized** interactive gate it is **legal** and does the same (the F1 case — the load-bearing correction); at a flag or mid-phase it is refused; **posture survives a co-staged approval rider** (set posture + `stageHumanInput`, reload → both present — the stale-save guard).
- bare `afk` → `gatesAt = []`; `afk overnight` → `['frame','spec']`; an unknown preset → the `parseGatesAt` error.
- `tests/tools.test.ts`: `advance_phase` at a pre-authorized gate **with** a dispatcher (interactive) → message names the handoff, not "continues immediately"; **without** a dispatcher (headless) → message unchanged.
- Invariant regression (already covered, re-assert): `gateAskRuleLive`/`GATE_ASK_RULE` untouched (`tests/orchestrate.test.ts`); no tool emits `human.*`.

**Self-hosting:** **highest-risk slice** — `lifecycle.ts` + `cli.ts` `_drive`/spawn. Land after the suite is otherwise green; verify `pnpm typecheck && pnpm test` before commit; the `afk` command spawns the detached driver from current source.

**Commit:** `feat(afk): duet afk hands off mid-session from any gate; mutable gate posture`.

---

## Slice 8 — `write_note` while parked (F2)

**Idea.** Allow the pure-append note tool after a phase is parked — it has no statechart effect, so the quiescence-refusal rationale doesn't apply.

**Seam:** kernel-tool (`tools.test.ts` `call()` harness).

**Code anchors.** `src/harness/tools.ts:873-879` — remove `'write_note'` from `REFUSED_AFTER_TERMINAL`. (`write_note`'s handler `:758-768` is unchanged; `withSteerDelivery`'s marker guard still suppresses steers on the dying turn, so no steer leaks.)

**Tests.** `tests/tools.test.ts`: with this phase's terminal marker set (parked at gate **and** at flag), `write_note` returns "Noted." and appends to `notes.md` — **not** the `phaseEnding` refusal (`:880-888`); the other `REFUSED_AFTER_TERMINAL` tools (`send_prompt`, `list_snippets`, …) still refuse while parked (regression). Update any existing "write_note refused while parked" assertion.

**Commit:** `fix(tools): allow write_note while parked at a gate or flag`.

---

## Slice 9 — per-turn footer + truthful `(not started)` (F5)

**Idea.** Surface inline cost/context/round on every worker result (both hosts), and stop showing `(not started)` while a phase/driver is live.

**Seam:** kernel-tool (`renderTurnResult`, the single chokepoint) + status (pure renderers).

**Code anchors.**
- `src/harness/tools.ts` `renderTurnResult` (`:245-275`): append a compact footer line — role context % (`state.contextUsage?.[role]` → `contextPercent`), cumulative cost (`state.costs`, honoring the partial flags), round `X/cap`. Additive to the existing content (the near-cap nudge at `:268-273` stays). Because both blocking `send_prompt` (`:545/549`) and `check_turns` (via `collectReady` → `renderTurnResult`) flow through here, one edit covers both hosts.
- `src/status.ts`: extract a pure `displayState(model): string` and use it at `renderStatus` (`:273`) and `renderBrief` (`:483`) instead of `model.machineState ?? '(not started)'`. There is **no `unstarted` `RunPosition` kind** (finding 5 — a no-snapshot run probes `crashed` at its entry phase), so map **every** stop kind explicitly rather than leaning on a missing one: prefer `model.machineState` when present (preserves today's headless quiescent-stop labels); else by `stop.kind` — `running`/`interactive`/`crashed` → `stop.phase`; `gate` → `stop.gate`; `flag` → `machineState` if any else `'flag'` (the flag `StopModel` carries no phase, `:113`); `done` → `'done'`; and `'(not started)'` **only** when neither a `machineState` nor a stop label exists. This fixes the real F5 case: an interactive run whose `crossInteractive` never set `machineState` shows its live phase, not `(not started)`.

**Tests.**
- `tests/tools.test.ts`: a successful turn's result includes the footer (context %, cost, `round X/cap`); a budget-truncated turn (Slice 4) still gets the footer; the footer appears on a `check_turns`-collected result too (dispatcher path). Adjust existing exact-content assertions to tolerate the appended footer.
- `tests/status.test.ts`: `displayState` over the **stop-kind table** — `interactive`→phase, `running`→phase, `gate`→gate state, `flag`→machineState/`flag`, `crashed`→phase, `done`→`done`; `machineState` present always wins; a model with neither → `(not started)`. (A table test, not just running/interactive.)

**Commit:** `feat(status): inline per-turn cost/context footer; truthful (not started)`.

---

## Slice 10 — provider-agnostic onboarding (UX)

**Idea.** Workers receive document paths, never slash commands; an only-a-slash-command framing is surfaced as incomplete, not fabricated into a path.

**Seam:** orchestrator-prompts (pure string) + the shipped skill (pinned by `skill.test.ts`).

**Code anchors.** `src/harness/orchestrator-prompts.ts` — `framePhaseEntryPrompt` (`:192`), `researchPhaseEntryPrompt` (`:384`), `docsPhaseEntryPrompt` (`:331`): drop "include its `/name` … the CLI expands it"; instruct "send the document path the framing names; if the framing gives only a slash command with no path, treat it as incomplete and `ask_human` — do not invent a path." `skills/duet-frame/SKILL.md` onboarding line: prefer a path over a bare command.

**Tests.** `tests/skill.test.ts` stays green (verb/flag coherence). Add a light content guard: the three entry prompts no longer contain the "CLI expands it" slash-command instruction and do mention a document path / incomplete-framing → `ask_human`. (No behavior logic — these are prompt-string assertions.)

**Commit:** `fix(prompts): onboard workers by document path, never a slash command`.

---

## Slice 11 — snippet path cleanup (F7)

**Idea.** Remove the tabtype-port's foreign paths and unify the split skill roots in the duet snippet copy.

**Seam:** snippets (pinned by `snippets.test.ts`).

**Code anchors.** `snippets.toml` — `write-spec` (`:38`): drop the foreign `docs/superpowers/specs/`, deferring the spec location to the framing's conventions (per the frontmatter boundary rule). Unify the split skill roots onto **`~/.claude/skills/...`** (finding 6, settled): it is the root this run handed the workers and the one `tdd-plan` already uses (`:191-198`); `review-plan`'s `~/.agents/skills/…` (`:217-218`) is the outlier and moves to `~/.claude/skills/…`. (The four `/compact` references are **out of scope** — the literal worker-compaction mechanism, not slash-command expansion.)

**Tests.** `tests/snippets.test.ts` stays green (classification/presence/`review-` prefix). Add a guard: no snippet body contains `docs/superpowers/` or `~/.agents/skills/`, and the `tdd`/`improve-codebase-architecture` references all sit under `~/.claude/skills/`.

**Commit:** `chore(snippets): drop foreign spec path; unify skill roots`.

---

## Verification per slice

Each commit: `pnpm typecheck && pnpm test` green (load-time `validateRegistry` + compile-time `phaseBriefBuilders` are part of that). **Each self-hosting-hazard slice named in the up-front list** (1, 2, 3, 4, 5, 6, 7 — kept as one list there so the two can't drift) gets an explicit green-suite check before commit, and this run's own driver is launched from a frozen duet, never the worktree `src/`. No doc updates here — those are the post-implementation docs phase (the spec lists the docs in scope).

## Open questions (assumptions encoded; non-blocking)

1. **`error_max_budget_usd`** — **resolved empirically** (above): exit 1, parseable stdout envelope with that subtype + session id; detection in the execa-error path, parseable tier primary, fallback defensive. Slice 4 pins the shape.
2. **`duet afk` surface / default preset** — assumed: legal at any interactive gate parked on the approve path (incl. pre-authorized); bare = attend-none (empty posture); named = an existing preset; no new presets. Slice 7 implements this; flag only if a product call surfaces.
3. **Config invariant amendment** — assumed narrow ("account/billing posture (transport, budget)"); budget is a top-level run-level key (one knob, both roles). Slice 3 implements; the amendment is a comment + the new key.
