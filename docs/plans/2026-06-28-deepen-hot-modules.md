# Plan: deepen the five hottest modules

**Reads against** `docs/specs/2026-06-28-deepen-hot-modules.md` — the spec owns *what/why* and has
settled its four open questions (named rail functions + test-pinned ordering; keep `kernelTool()`;
boolean host oracles; the full staged sequence). This plan owns *how*: per-slice test cases,
fixtures, helper/sketch shapes, and line-level anchors. It does not re-argue the spec; where a
spec gotcha bites, it is **bolded in the slice that must honor it**.

The interface choices are settled, so there is **no design-it-twice exploration** here — the rail
interface (`(input, ctx) => Refusal | null` composed by `firstRefusal`) and the boolean-oracle
shape are the spec's chosen designs; this plan implements them.

## Orientation

- **One slice = one commit**, in the spec's landing order. Each slice is independently revertable.
- **Master oracle:** the 727-test suite stays green at every commit. Commands: `pnpm test`
  (`vitest run`), `pnpm typecheck` (`tsc --noEmit`). Several slices are guaranteed by the
  *typecheck*, not a runtime test (gate-non-nullable in #5, exhaustiveness in #4, the typed
  `refuse` in #1-floor) — run both.
- **Green at every commit is literal:** run `pnpm typecheck && pnpm test` (the full suite) before
  **every** slice commit — including #2 and #4 — since one slice = one commit. Targeted test files
  are fine *during* a slice; the full run gates the commit. (The spec's emphasis on #5/#1-floor/#3/
  #1-deep marks where the surface change is largest, not an exemption for the rest.)
- **Lessons applied:** the *deletion test* (every slice that extracts a helper must justify it by
  imagining its deletion — the discipline re-growing at N sites is the pass); *replace, don't
  layer* (a deepened interface's tests replace the old shallow tests) — **with one deliberate
  exception called out in slice 6**; *make illegal states unrepresentable* (the typed `refuse`,
  the `Refusal | null` return, the non-nullable `gate`) over runtime guards; *mock only at seams*
  (fake `WorkerProvider`, real fs in tmpdirs — never mock our own modules); *test.extend* fixtures
  (`tests/helpers/fixtures.ts`: `projectDir`, `run`, the interactive run, `FakeWorker`,
  `DeferredWorker`, `SyncThrowWorker`).
- **Right-size:** the spec **rejected** `validateRails()`/`after`-metadata, a `register()`/`defineTool`
  framework, a `RailGroup` data registry, and a richer `RailHost` interface — **do not reintroduce
  any of them.** This is a behavior-preserving internal refactor: **no new dependencies.** If a slice
  seems to need one, stop and flag it.

## Landing order (one slice per commit)

```
1. #5        retire gate:null               (deletion; lands clean non-null gate types)
2. #1-floor  result builders + Refusal type (mechanical; biggest deletion win)
3. #2        resolveRun + continuePlanner    (pure planner; restores the doc claim)
4. #4        renderStatus switch + posture   (renderer only)
5a. #3       mutate() helper                 (core; signature-preserving)
5b. #3       steer-store.ts split            (#3's DESCOPE line — drop first if trimming)
6. #1-deep   named rails + boolean oracles   (LAST; the DESIGNATED descope — truncatable)
```

**Descope map** (so a truncated run still lands green — see §Descope):
- Drop **slice 6** entirely → floor banked, rails inline-but-typed, run green.
- Drop **slice 5b** → `mutate` banked, steer store stays in `run-store.ts`, run green.
Nothing after #1-floor depends on #1-deep; nothing depends on 5b.

## Carry-forward for the FINISH phase (NOT a code slice)

> The human's gate rider: the README/`CLAUDE.md` status lines calling the **acceptance contract,
> the finish/publish tails, and `duet stats`** "test-verified-only / not-yet-live" are **stale** —
> those are live-verified. The finish/reconcile-docs step must update those status lines. This is
> documentation reconciliation, not part of this refactor's code slices — recorded here so it
> isn't lost.

---

## Slice 1 — #5: retire the dead `gate:null` topology

**Idea a reviewer grasps in one sentence:** every phase gates, so make `gate` non-nullable and
delete every branch/comment that pretended otherwise. **This slice deletes a concept** (the
gate-less phase) — the preferred kind of slicing.

### Changes (anchors)
- `src/phases.ts:389` — `GatePhase = Extract<AnyPhase, { gate: object }>['name']` → **one-line alias
  `type GatePhase = PhaseName`** (the spec's type-shape decision; not the 48-site name-collapse).
- `src/phases.ts` `PhaseSpecInput.gate: GateInput | null` (~84) and `PhaseSpec.gate: {…} | null`
  (~408–413) → drop `| null`. **This is the load-bearing edit** — it turns the deadness into a
  compile-time fact and auto-derives every consequence below.
- `src/phases.ts:602` `isGatePhase` → **delete** (sole caller is `tools.ts:1155`).
- `src/phases.ts:607` `gateOf` → drop the throw-guard; body becomes a direct `return PHASE[phase].gate`
  (non-null by construction). Keep the function — callers use it.
- `src/phases.ts:671` `consultantCheckpointOf` → **delete** (production-unused). Repoint its only
  callers, `tests/phases.test.ts:217–230`, to read `PHASE[x].consultantCheckpoint` directly.
- `src/phases.ts` gate-derivations, now that `gate` is non-null (verified line-by-line):
  - `validateRegistry`: the **`if (p.gate)` guard at `:455`** (the gate-state-uniqueness check)
    becomes **unconditional**, and the `.filter((p) => p.gate !== null)` at `:464` drops the vacuous
    predicate.
  - `gatePhasesOf` (`:568`): drop the predicate and the now-identity `as GatePhase`.
  - `phaseOfGateState` (`:597`): `p.gate?.state` → `p.gate.state` — here the deadness is the
    **optional chaining**, not a `!== null` filter (correcting my first pass, which called it a
    predicate).
- `src/phases.ts:27–31, 383–389, 405–413` — the stale comments naming a nonexistent open-ended
  `open` phase → correct them (the cleanup that makes invariant 6 true).
- `src/harness/tools.ts:1154–1156` — `advance_phase`'s `next` message: drop the `!isGatePhase(phase)
  ? 'the run is complete…' :` arm; the ternary collapses to the live `gateAttended(...) ? … :
  (dispatcher ? … : …)`. Remove the now-unused `isGatePhase` import (`tools.ts:4`).
- `src/status.ts:174–177` — drop `p.gate !== null &&` from the `rounds` filter and the gate-less
  comment. **Gotcha: this feeds `model.rounds` — removing a vacuously-true predicate yields the
  identical array; the status JSON model is untouched.**
- `src/harness/machine.ts:137–143` — `advanced: p.gate?.state ?? (next ? \`${next.name}Loop\` : 'done')`
  → `p.gate.state`; `if (p.gate) { states[p.gate.state] = … }` → unconditional. Update the comment.
  **Gotcha: the statechart STATES are unchanged — every phase still emits loop + gate + flag-wait;
  only the gate-*optional* builder branches collapse.**

### Tests
- **Preservation oracle (must stay green):** `tests/machine.test.ts` (the coherence suite pins the
  generated states + tag sets — proves the builder still emits byte-identical states),
  `tests/phases.test.ts` (registry derivations), `tests/status.test.ts` (rounds rendering),
  `tests/tools.test.ts` advance_phase cases (the `next` message text).
- **Changed:** `tests/phases.test.ts:217–230` — repoint `consultantCheckpointOf(x)` →
  `PHASE[x].consultantCheckpoint`. *Replace, don't layer:* they tested a deleted helper; move them
  to the surviving registry access (same assertions).
- **The real proof is the typecheck:** `pnpm typecheck` green with `gate` non-nullable *is* the
  spec's "#5 compiles with the gate field non-nullable." Add **no** speculative runtime test — a
  pure deletion needs no new behavior test.

---

## Slice 2 — #1-floor: result builders + the `Refusal` return type

**One sentence:** collapse the 58 hand-built tool-result envelopes onto a shared block constructor
+ four wrappers, and make a refusal's text a *type* requirement. **This slice deletes 58 literals.**

### Changes (anchors)
All in `src/harness/tools.ts`. The builders live near the top (beside `kernelTool`, ~66).
- `block(text)` — the `{ type: 'text' as const, text }` constructor (replaces 40 literal sites).
- `result(blocks, { isError? })` — low-level; used directly where `isError` is **conditional**:
  `combineFanoutResults` (514) sets it only when a fan-out role errored.
- `ok(...blocks)` — success wrapper. **Gotcha: must be multi-block (variadic)** — `renderTurnResult`
  (404–444) composes worker-text + optional checkpoint/interrupt/near-cap notes + footer, and
  `check_turns` (1233–1275) assembles an arbitrary list. Each keeps building its blocks via `block`
  and wraps once.
- `error(...blocks)` — non-rail `isError` wrapper for **worker/tool failures, not protocol
  refusals**: `renderTurnResult`'s budget-cutoff (382) and infra-failure (393) envelopes.
- `refuse(...text: [string, ...string[]])` — the rail-refusal wrapper. **Gotcha: the param type is a
  non-empty tuple so a text-less `refuse()` is a COMPILE ERROR** (steering-in-text becomes
  structural). Reserved for rails, including `create_branch`'s single branch-fixed guard (1022).

**Gotcha (the whole slice): keep the two kinds of `isError` apart** — `refuse` (a rail declining an
orchestrator action) vs. `error`/`result` (a worker turn or fan-out that failed). Do **not** route
the budget/infra envelopes or the conditional fan-out aggregate through `refuse`.

**Gotcha: byte-for-byte.** This is a mechanical substitution — every produced string and `isError`
flag is identical. Rails now *return* `Refusal | null` but **stay inline** (extraction is slice 6).

Migration is the 18 `isError:true` sites split by kind (rail → `refuse`; worker/tool → `error`/
`result`) and the 40 `block` sites. Scope is `tools.ts` only — leave `mcp-server.ts:221`'s
delegating error envelope alone (the spec scopes #1-floor to `tools.ts`).

### Tests
- **Preservation oracle:** the *entire existing* `tests/tools.test.ts` (every send_prompt /
  template-economy / cap / fan-out / ask_human / advance_phase / check_turns case) staying green is
  the no-regression proof — the envelopes were never separately tested, so the handler tests are
  the oracle.
- **New (small, characterizes the builder contract):** in `tests/tools.test.ts`, a focused
  `describe('result builders')` — `ok(a, b)` yields a two-block content array; `refuse('x')` yields
  `{ isError: true }` with the text; `error(...)` yields `isError` without the non-empty-text
  constraint; `result(blocks, { isError: false })` omits the flag. (The compile-time non-empty
  guarantee on `refuse` can't be runtime-tested — `pnpm typecheck` is its oracle.)
- *Replace, don't layer:* nothing to delete — these builders had no prior tests.

---

## Slice 3 — #2: `resolveRun` + `continuePlanner`

**One sentence:** lift `continue`'s ~10 tangled decisions into a pure planner the action merely
executes, and kill the 11× run-resolution boilerplate — restoring `cli.ts` to wiring.

### Changes (anchors)
- **`resolveRun(cwd, runId, notFoundMsg)`** replaces **all 11** sites of `runId ? loadRunState(cwd,
  runId) : latestRun(cwd)` + `if (!state) fail(<msg>)`. **Gotcha: there are FOUR distinct not-found
  strings — pass the message in so every byte stays identical** (full inventory, verified):
  - `cli.ts:326` orchestrate → `…start one with duet new --interactive`
  - `cli.ts:501` afk (uses `runIdArg`) → `…start one with duet new`
  - `cli.ts:557` continue, `:967` status, `:991` doctor, `:1006` **stats** → `…start one with duet
    new (bare opens your editor on a framing draft)`
  - `cli.ts:778` steer, `:817` abandon, `:853` view, `:872` takeover, `:929` logs → bare
    `no runs found in this project`
  (Correction to my first pass: it said 10 sites and mis-grouped afk — `stats` at `:1006` was the
  omitted 11th, and afk carries the `duet new` suffix, not the bare string.)
- **`continuePlanner(facts) → ContinueAction`** — a pure function in `cli.ts` (or a new
  `src/continue-planner.ts` if it reads cleaner), generalizing the in-file `takeoverPlan`
  (`cli.ts:178–186`) precedent. It lifts the decision logic out of the `continue` action
  (`cli.ts:555–726`). `ContinueAction` is a discriminated union covering the action's ~10 exits:
  ```
  | { kind: 'interactive-cross'; event; after: 'inline' | 'handoff'; freezeContractPhase?: PhaseName }
  | { kind: 'interactive-drop-headless' }      // bare --headless mid-phase on an interactive run
  | { kind: 'interactive-show-status' }
  | { kind: 'crash-recover'; resumeEvent? }
  | { kind: 'preauth-recover' }                // snapshot parked at a pre-authorized gate
  | { kind: 'gate-decision'; eventType }
  | { kind: 'show-status' }
  | { kind: 'fail'; message }                  // every current fail(...) path
  ```
  **Gotcha: the interactive crossing is ONE action, not two.** `cli.ts:631–650` always runs the same
  sequence (stage text → freeze-if-approve → `crossInteractive`) and *then* branches on
  `interactiveContinueAction(...) === 'handoff'`. So handoff is the crossing's *continuation*, not a
  separate decision: the planner computes `after` by calling the (pure) `interactiveContinueAction`,
  and sets `freezeContractPhase` only when `event` is approve at the contract phase. The executor:
  stage → freeze (if `freezeContractPhase`) → `crossInteractive` → if `after === 'handoff'`
  spawn-handoff, else print the inline-rest message.
- **Split of responsibility — the load-bearing design point.** The planner is **pure**: it receives
  already-probed facts (`state`, `position: RunPosition`, the restored-machine facts `{ value,
  status, canApprove/canReject/canAnswer (from `snapshot.can`), hasTag('gate') }`, `eventType`,
  `opts.headless`, the abandoned/chosen-count flags) and returns a `ContinueAction`. The **action**
  keeps all I/O: `resolveRun`, the abandoned-revival write, `aliveDriverPid` (the "phase still
  running" guard runs *before* the planner), `probeRunPosition`, `loadMachineSnapshot` +
  `createActor`, then `stageContinueText`, `freezeContractAt`, `spawnDrive`. **Gotcha:
  `snapshot.can(event)` before side effects** (XState invariant) — the planner encodes the
  validation; the action stages input only after the planner returns a crossing/decision action.
- Outcome: the `continue` action becomes gather-facts → `continuePlanner(...)` → execute. This makes
  the `engineering.md:51` "command wiring only" claim true again (the in-module correction for
  invariant 6 — the comment/claim is fixed here, the standalone `engineering.md` edit is finish-phase).

### Tests (the win: decisions tested **without spawning a process**)
- **New `tests/continue-planner.test.ts`** — one case per `ContinueAction`, building `RunPosition`
  literals and restored-machine fact objects directly (no `_drive`, no editor, no git). Cases:
  - interactive + gate + `approve` → `interactive-cross` with `after: 'handoff'` at the handoff gate
    vs `after: 'inline'` at an earlier attended gate, and `freezeContractPhase` set **only** at the
    contract phase; + `reject` → `interactive-cross` (`after` per `interactiveContinueAction`); flag
    + `answer` → `interactive-cross`.
  - interactive + no event + `--headless` mid-phase → `interactive-drop-headless`; + at a gate/flag
    → `fail` (owes a decision first).
  - interactive + bare (no event) → `interactive-show-status`.
  - interactive + invalid crossing (`approve` at a flag) → `fail` (the `validateInteractiveCrossing`
    message).
  - headless + `crashed` + no flags → `crash-recover` (carries `resumeEvent`).
  - headless + snapshot parked at a pre-authorized gate + no flags → `preauth-recover`.
  - headless + no snapshot + a flag → `fail` ("no gate to act on…").
  - headless + restored `done` + a flag → `fail` ("complete…").
  - headless + event invalid at state → `fail` (the gate-vs-flag-specific message).
  - headless + valid gate event → `gate-decision`.
  - headless + no event → `show-status`.
- **Preservation oracle (stays green):** `tests/cli.test.ts`, `tests/continue-input.test.ts`,
  `tests/lifecycle.test.ts` — the end-to-end continue/afk/takeover paths that exercise the executor
  wiring `resolveRun` and the planner feed. *Replace, don't layer:* the planner tests are new (the
  decisions had no unit surface); the existing end-to-end tests remain the integration oracle for
  the executor — keep them.

---

## Slice 4 — #4: `renderStatus` exhaustive switch + `formatGatePosture`

**One sentence:** make a new `stop.kind` a compile error instead of a silent blank render, and give
the posture sentence one home.

### Changes (anchors)
- `src/status.ts:293–443` `renderStatus` — the header section (294–365) runs for every stop and is
  unchanged; convert the **tail** if-chain (early returns at 368/373/384/415/421/429, with `running`
  emitting no tail and `done` falling through) into a single `switch (stop.kind)`. **Gotcha:
  exhaustiveness via `default: { const _: never = stop }`** — the compile-time guarantee that a
  future `stop.kind` errors here (matching the siblings `stopModel`/`displayState`/`briefHeadline`/
  `briefNextCommand`/`steerRefusal`). **Gotcha: byte-for-byte output** — each case emits the exact
  current lines; `running` returns the header alone. **Gotcha: renderer only — `StatusModel`,
  `buildStatusModel`, and the additive-only `--json` schema are untouched.**
- **`formatGatePosture(...)`** — single source for the posture sentence built 3× (`status.ts:307–313`,
  `cli.ts:296–301` new, `cli.ts:513–517` afk). The three share only the `attending-X` vs
  `attending-none` branch shape; they differ in copy (status drops the parenthetical and pads the
  label; afk uses the explicit pre-authorized list + "downstream"). **Gotcha: takes per-surface copy,
  never a byte-merge** — sketch: `formatGatePosture(attended, { attendedSuffix, noneSuffix })`
  returning the joined sentence, each call site supplying its own suffixes (afk also threads its
  `preAuthorized` list). This is the *modest* half of #4; the switch is the substance.

### Tests
- **Preservation oracle:** `tests/status.test.ts` `describe('renderStatus')` (401+) — the
  rendered-output assertions stay byte-identical; the `cli.test.ts` new/afk posture-line assertions
  stay green.
- **Exhaustiveness is the typecheck** (the `never` arm) — `pnpm typecheck`, not a runtime test.
- **New (small):** `tests/status.test.ts` unit cases for `formatGatePosture` — each of the three
  styles (status / new / afk) and the attend-none branch produce their exact current strings.

---

## Slice 5a — #3: the `mutate(state, fn)` helper

**One sentence:** concentrate the fresh-load→mutate→save→sync concurrency discipline (re-described
in 4 doc-comments across 8 mutators) in one helper, signature-preserving.

### Changes (anchors)
- `src/run-store.ts:477–573` — the 8 mutators (`markTurnActive`, `clearTurnActive`,
  `recordTurnSessionId`, `markPendingTurn`, `settlePendingTurn`, `clearPendingTurn`,
  `markWorkerDispatched`, `setGatesAt`) become thin callers of `mutate`.
- **Helper sketch:** `mutate(state, fn: (s: RunState) => boolean): void` where `fn` mutates a copy in
  place and **returns whether it changed anything**. Body: load fresh; `if (fn(fresh))
  saveRunState(fresh)`; then `fn(state)` to mirror the same mutation into the passed copy. The
  role-keying lives **in the callback** (e.g. `clearTurnActive` → `mutate(state, s => { if
  (s.activeTurns?.[role]) { delete s.activeTurns[role]; return true } return false })`).
- **Gotcha — the callback must be replayable (no internal nondeterminism).** Because `mutate` runs
  `fn` against *both* the fresh copy and the passed copy, any **generated** value (a timestamp) must
  be computed ONCE by the caller and closed over — never `new Date()` *inside* `fn`, or disk and the
  in-memory copy would get different `startedAt`s. `markTurnActive` (`run-store.ts:478`) and
  `markPendingTurn` (`:525`) build their `entry` (with `new Date().toISOString()`) **outside** and
  the callback only assigns that one `entry` to both copies — byte-identical to today's single-
  `entry` write. With generated values lifted out, `fn` is otherwise pure: idempotent, surgical,
  deletion-safe.
- **Gotcha — deletion-safe surgical sync:** applying `fn` to *both* fresh and the passed copy makes
  a delete reflect in both and touches only the field `fn` changed. Do **NOT** `Object.assign(state,
  fresh)` (leaves deleted keys behind; clobbers unrelated in-memory fields). The clears
  (`clearTurnActive`/`clearPendingTurn`) prove this.
- **Gotcha — no-op ⇒ no-save:** the boolean return is the save gate. `recordTurnSessionId`,
  `settlePendingTurn`, and the clears must **skip the disk write when the entry is absent**; an
  always-save helper would clobber a concurrent sibling write.
- **Gotcha — `markWorkerDispatched` keeps its pre-load short-circuit:** today it returns *before*
  `loadRunState` when already set. Keep a cheap `if (state.workerDispatched) return;` before
  `mutate` so the no-op doesn't add a fresh-load (read-only, but preserve it).

### Tests
- **Preservation oracle:** `tests/run-store.test.ts` (`describe('persistence')`, the mutator
  coverage) + the `tools`/`turn-dispatcher` tests that drive these via send_prompt/dispatch — all
  stay green unchanged, because the 8 mutators keep their names and signatures.
- **The named property to characterize (through the mutator interface, not `mutate` directly —
  `mutate` is internal):** the spec's *concurrent cross-role* property. Add to
  `tests/run-store.test.ts`:
  - "a concurrent cross-role write does not clobber the sibling": load two `RunState` copies of the
    same on-disk run; `markTurnActive(copyA, 'implementer')` then `markTurnActive(copyB, 'reviewer')`;
    reload from disk and assert **both** entries survive (the fresh-load merge).
  - "a no-op clear does not clobber a concurrent sibling write": role B writes a field; a
    `clearTurnActive` for an absent role-A entry must not save over it — reload and assert B's field
    survives (this is the observable face of no-op⇒no-save).
- *Replace, don't layer:* none deleted — the mutators remain the public interface; `mutate` is an
  internal helper, tested through them.

## Slice 5b — #3: lift the steer store to `steer-store.ts` (#3's DESCOPE line)

**One sentence:** move the cohesive steer cluster (a different crash contract from `state.json`)
into its own module — recommended, but the first thing cut if trimming.

### Changes (anchors)
- Move `Steer` type, `steersDir`, `stageSteer`, `listPendingSteers`, `markSteersDelivered`
  (`src/run-store.ts:680–747`) → `src/steer-store.ts`; it imports `runDirOf`/`appendVoiceLog` from
  `run-store.ts`. A clean move, not a re-export (re-exports are the pass-through the deletion test
  frowns on). **Full importer inventory** (so it's a move, not a half-extraction — verified):
  - *value imports:* `cli.ts:42,51` (`listPendingSteers`, `stageSteer`), `driver.ts:12,14`
    (`listPendingSteers`, `markSteersDelivered`), `tools.ts:20,22` (`listPendingSteers`,
    `markSteersDelivered`).
  - *type-only `Steer` imports:* `status.ts:7`, and `orchestrator-prompts.ts:13` (used by
    `renderSteerBlock`, `:646`).
  - *tests:* `run-store.test.ts` (the moving `describe('the steer store')`), plus `tools.test.ts`,
    `driver.test.ts`, `stdio-host.test.ts`.
- **Gotcha: byte-for-byte file format + deliver-by-rename** — the hrtime-suffixed name, the `wx`
  atomic create, the rename into `steers/delivered/` are unchanged. **Steers must never live in
  `state.json`** (the reason the store is separate — a CLI write there races the live driver).

### Tests
- *Replace, don't layer:* move `tests/run-store.test.ts` `describe('the steer store')` (185+) into a
  new `tests/steer-store.test.ts` (same assertions, new import path) — the behavior is identical, the
  module is what moved.

---

## Slice 6 — #1-deep: named rails + boolean host oracles (LAST; DESIGNATED descope)

**One sentence:** extract the rail-bearing handlers' inline rails into named `(input, ctx) =>
Refusal | null` functions composed by an explicit ordered `firstRefusal`, and collapse the host
divergence into one boolean oracle pair — giving the rails a unit surface for the first time.

This is the one **preparatory refactoring** the spec names, and the **descope line**: nothing else
depends on it. If the run is trimming, stop after slice 5 — floor banked, run green.

### Changes (anchors, all `src/harness/tools.ts` unless noted)
- **Types/composition:** a `Rail = (input, ctx: RailCtx) => Refusal | null` (where `Refusal` is the
  shape `refuse()` already produces), and `firstRefusal(input, ctx, ...rails: Rail[]): Refusal |
  null` returning the first non-null (else null → proceed).
- **`RailCtx`, built once in `createPhaseTools` (572):** `{ state, phase, cap, inFlight(role),
  orphanedOnDisk(role), sentThisPhase(role), resendWarned, clearOrphan(role), log }`. **Gotcha: the
  boolean oracles are the ONE place host divergence lives** — `inFlight`/`orphanedOnDisk` are
  constructed from `dispatcher ?? turnsInFlight` (today's split at `tools.ts:829` and `pendingTurnGate`
  at `670–692`). The rails read the oracles and **never re-branch on host**. **The `send_prompt`
  host-switch (blocking vs. dispatch-and-collect) stays ONE registry** — only the oracle differs.
- **Gotcha: `orphanRail` is NOT a pure predicate — it needs `clearOrphan`/`log`.** The current
  discard-and-reseed branch (`tools.ts:848–850`) does `clearPendingTurn(state, role)` + `log(...)`
  and *then* proceeds, so the rail must clear the stale record (a side effect) and return null. That
  is why `RailCtx` carries `clearOrphan(role)` and `log`. Only `orphanRail` carries side effects;
  every other rail stays a pure `Refusal | null`.
- **Named rails:**
  - send_prompt per-role: `sameRoleInFlightRail`, `orphanRail` (a `takeover`-policy orphan →
    refuse; a `discard-and-reseed` orphan → `ctx.clearOrphan(role)` + `ctx.log(...)` then return
    null, by `orphanRecoveryFor(role)`), `reviewCapRail`, `warnOnceTemplateRail` — extracted from
    `validateRole` (`826–887`). The reseed/dispatch itself happens **later in the handler**, not in
    the rail.
  - **Shared terminal rail group** — `terminalAlreadySetRail` (from `terminalAlreadySet`/
    `alreadyEnding`, 581–590) and `pendingTurnGateRail` (from `pendingTurnGate`, 670–692) —
    **defined once and composed by BOTH terminal tools** (never two implementations).
  - advance_phase-specific: `reviewLoopRail`, `contractCheckpointRail`, `verifyCheckpointRail` (from
    `1089–1135`).
- **Composition sites:**
  - `send_prompt` (805): the empty-array guard, then per role `firstRefusal(input, ctx,
    sameRoleInFlightRail, orphanRail, reviewCapRail, warnOnceTemplateRail)`. **Gotcha: the order is
    load-bearing — `sameRoleInFlightRail` MUST precede `orphanRail`** (a live running turn also has
    a disk pending record, so orphan-first misclassifies it). Order is an explicit, commented list
    at this one site; pinned by a characterization test (below). **NO `validateRails()`/`after`
    metadata** (spec OQ1).
  - `advance_phase` (1088): `firstRefusal(input, ctx, terminalAlreadySetRail, pendingTurnGateRail,
    reviewLoopRail, contractCheckpointRail, verifyCheckpointRail)`.
  - `ask_human` (982): **the staged-answer fast path (983–987) STAYS FIRST** — the harness
    delivering a previously-staged answer must not be gated by a terminal marker (it *is* the answer
    to the flag that set one) — *then* `firstRefusal(input, ctx, terminalAlreadySetRail,
    pendingTurnGateRail)`, then queue.
- **Gotcha — left inline:** `role === 'consultant'` in `settleTurn` (`tools.ts:341`) **stays** — the
  blessed exception (invariant 5), not a rail, not moved to `roles.ts`. `settleTurn` is not part of
  the extraction. `kernelTool()` stays (no `register()`). The `withSteerDelivery`/
  `withPostTerminalRail` wrappers and the in-memory rail *state* (`rails.turnsInFlight`/
  `resendWarned`, the dispatcher) are unchanged — the oracle only *reads* the state.
- **Gotcha — rails refuse, never throw:** `Rail` returns `Refusal | null`; throwing stays reserved
  for `lifecycle.ts`.

### Tests — honor the spec's testing contract precisely
- **The preservation proof is the EXISTING full-handler tests** (`tests/tools.test.ts`:
  `describe('send_prompt')`, `'template economy'`, `'review-round backstop cap'`, `'parallel worker
  turns'`, the fan-out blocks, ask_human, advance_phase). They drive the rails end-to-end through
  the **external** tool interface; *those staying green across the extraction is what proves behavior
  was preserved.* The new rail-unit tests are **additive**, not the no-regression oracle.
- **Host-clean oracle: the real-`_mcp`-subprocess parity test (`tests/mcp-server.test.ts`) stays
  green** — it drives a real stdio MCP subprocess, the faithful check that the interactive
  run-scoped server and headless driver behave identically through the new oracle.
- **New rail-unit tests** (the new *internal-seam* surface — see the reconciliation note below). Add
  `describe('rails')` in `tests/tools.test.ts` (or `tests/rails.test.ts`), each rail called directly
  with a minimal `RailCtx` built by a small helper `railCtx(overrides)` whose oracles are boolean
  stubs (`inFlight: () => true/false`, `orphanedOnDisk: () => …`) over a real `run` fixture state:
  - `sameRoleInFlightRail` refuses when `inFlight(role)`; passes otherwise.
  - `orphanRail`: a `takeover`-policy orphan → refusal (and `clearOrphan` **not** called); a
    `discard-and-reseed` (consultant) orphan → **clears the stale record (`clearOrphan` called) and
    returns null** — driven by `orphanRecoveryFor`, not a role-literal. (The fresh body actually
    *dispatching* after the clear is the **full-handler** test, downstream of the rail — not the
    rail's to prove.)
  - `reviewCapRail` refuses at the cap (`rounds[phase] === cap`).
  - `warnOnceTemplateRail` refuses once then allows the identical retry (the `resendWarned` set).
  - `terminalAlreadySetRail` refuses a second terminal call; `pendingTurnGateRail` refuses a pending
    phase-exit.
  - `contractCheckpointRail`/`verifyCheckpointRail` refuse a silent skip.
  - **The ordering-invariant test (named by the spec):** a `RailCtx` with `inFlight(role)` true AND
    `orphanedOnDisk(role)` true → `firstRefusal(..., sameRoleInFlightRail, orphanRail, ...)` returns
    the **in-flight** refusal, not the orphan one.
  - **The shared terminal group through BOTH terminal tools (named by the spec):** at the
    *handler* level, drive `ask_human` and `advance_phase` each with a terminal marker already set →
    both refuse via the same group, so the one invariant is proven on both.
- **The `railCtx` stub is mocking at a seam, not our own module:** the oracles are the rails'
  injected dependencies (two real adapters — the dispatcher/`turnsInFlight`-derived one in
  production, the boolean stub in tests), exactly the `test.extend`/injected-port pattern. We are
  **not** mocking `tools.ts` internals.
- **Reconciliation with "replace, don't layer":** the rails are an **internal seam** of the
  `tools.ts` deep module; the full-handler tests are the **external-interface** tests. Per
  `deep-modules.md` ("a deep module can have internal seams used by its own tests alongside the
  external seam"), both legitimately coexist — this is *not* the "old shallow-module unit tests
  replaced by a new interface" case, so we deliberately **keep both** here (the spec's "additive"
  contract). This is the one slice where layering is correct, and why.

### Descope behavior
- If cut: slices 1–5 leave `tools.ts` with the floor (typed `refuse`, `Refusal | null` rails) but
  rails still inline — green, shippable, no half-applied state. Re-attempt #1-deep in a later run at
  no extra cost (the floor's types persist).

---

## Final checks (after slice 6, or after the last slice landed if descoped)

- `pnpm typecheck` and `pnpm test` green.
- The real-`_mcp` parity test green (host-clean).
- Spot-confirm the in-module doc corrections landed in their slices: `engineering.md:51` claim
  (slice 3), the `gate:null` comments in `phases.ts`/`status.ts`/`machine.ts` (slice 1). Standalone
  `engineering.md`/README/`CLAUDE.md` updates — including the stale "test-verified-only" status
  lines in the carry-forward note — are the **finish phase's** job, not this plan's.
