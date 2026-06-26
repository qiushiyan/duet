# Rails-and-UX bundle — opt-in rails with friction-free defaults

> **Historical (pre-`finish`).** Dated record from before the 2026-06-26 collapse of the `docs`/`pr`/`open` tail into one `finish` phase (open-then-review, draft-PR-by-default, `overnight` as full's default posture). Its **"no phase collapse"** decision (keep `pr`/`open` as separate states for the pause-before/act-after stop) was *reversed* by that collapse — the Open-PR gate now sits after a draft open. Its arc / tail / gate-posture descriptions are the topology of their time; the current arc lives in [`../automation-design.md`](../automation-design.md).

**Status:** Spec. **Date:** 2026-06-21. **Branch:** `feat-rails-ux-bundle`.

Inputs (problem definitions, not specs — do not edit): `docs/specs/2026-06-21-afk-handoff.md`, `docs/specs/2026-06-21-auto-open-pr.md`, `docs/specs/2026-06-21-worker-budget-policy.md`, `docs/specs/2026-06-21-interactive-run-frictions.md`. The FRAME-phase synthesis (the Direction gate packet) is the design this spec builds on; it is not re-derived here. The human approved that direction with a rider settling change #2 (recorded under "#2" below).

---

## Summary (for the leader)

**What this delivers.** One PR clearing four pending problem-definitions at once. Three of them share a shape — *a hardcoded mandatory rail the maintainer wants relaxed, while a future audience may still want it available* — and the bundle makes one principle true across them: **duet's rails become opt-in controls with friction-free defaults, not mandatory stops.** A fourth cluster (provider-agnostic onboarding plus several in-scope frictions) is ordinary UX cleanup riding along.

The three rails:

1. **Mid-session AFK handoff (#1).** Today gate posture is chosen once at `duet new` and ignored entirely on the interactive orchestrator host. You cannot say "I've seen the framing, it's good, take the rest unless something major comes up." A new `duet afk [preset]` crosses the current attended gate, re-sets the downstream posture to a pre-authorized one, and hands off to the headless driver — from *any* attended gate. The only genuinely new capability is that **gate posture becomes mutable mid-run**.
2. **Auto-open the PR (#2).** Opening a PR is non-destructive and reversible, but the Open-PR gate is force-attended as if it weren't. After this change a Full run **auto-opens the PR by default**; the pre-open review survives as an **opt-in stop that defaults OFF**.
3. **Worker/phase budget (#3).** The per-turn cost cap is pure downside for a flat-quota maintainer and — worse — has been observed *shaping scope* by killing a turn mid-work behind a misleading "the worker never saw your prompt" error. Budgets become **opt-in (default off)**, and a hit budget becomes a **graceful checkpoint**, never an infra-error costume.

**Approach and scope.** Two *narrow* resolvers, deliberately **not** a unified policy struct (gates and budget share only a thin resolve-and-persist pattern, not a mechanism, and even differ in lifetime — gate posture becomes mutable; budget is frozen at run creation):

- **The gate-attendance model** gains a per-workflow *default-pre-authorized* set — **materialized into each new run's posture at creation** (so a legacy run with absent `gatesAt` keeps attend-all, byte-for-byte unchanged) — plus a mutable `gatesAt`. `gateAttended`'s own logic stays as-is. This is the shared prerequisite for #1 and #2.
- **A single effective-budget resolver** (`budgetFor`) becomes the one source every worker-construction and orchestrator-construction site reads, replacing the direct `PHASE[phase].*BudgetUsd` reads.

**Landing order** (a design decision; the per-commit sequence is the plan's job): the gate-model prerequisite first → #3 budget → #2 auto-PR → #1 AFK handoff → the UX cluster last. Rationale in "Landing order" below.

**The boundary once it lands.**

*Fixed:* mutable gate posture + `duet afk`; the host-aware `advance_phase` message (F1's incremental bug); auto-open PR with an opt-in default-off pre-open stop; opt-in budgets with a graceful budget-checkpoint; provider-agnostic worker onboarding; `write_note` allowed while parked (F2); an inline per-turn cost/context footer and a truthful `(not started)` (F5); the snippet library's foreign paths and split skill roots cleaned (F7).

*Not changed:* the `ask` rule and permission model; the `phase.*`/`human.*` gate-crossing invariant; the per-phase budget *numbers* (scaled, never deleted); the RIR arc's tail (it has none); the PR description's content; **in-flight legacy runs** (created before this change keep absent `gatesAt` = attend-all, so an upgrade mid-run never silently auto-opens their PR — see Change 0a).

*Deferred, one line each:* **turn-sizing** (one turn asked to build four slices) — orthogonal prompt-altitude lever, named not built; **F4** (interactive `_mcp` drop mid-SPEC) — instrument later; **F6** (codex malformed file-links) — provider quirk; **F8** (first-turn 30-min infra timeout) — watch-item; **`budget_usd` frontmatter key** — stays *reserved* for its distinct Q19 meaning (a run-level spend target the orchestrator reasons about), not this PR's per-turn enablement knob; **literal `pr`+`open` phase collapse** — declined, because a single linear phase cannot honestly model pause-before-then-act-after without a real second state (see #2).

---

## The non-negotiable invariants (preserved by every change below)

- **One un-forgeable tap.** The launch-injected `ask` rule (`GATE_ASK_RULE = 'Bash(duet continue:*)'`, `src/orchestrate.ts`) is unchanged. Entering AFK still costs exactly one human tap; the agent cannot author it.
- **Only `human.*` crosses a gate.** The statechart's two disjoint vocabularies (`phase.*` from phase states, `human.*` from gate/flag states — `src/harness/machine.ts`, `phase-events.ts`) are untouched. No tool emits `human.*`. **No inline-LLM-crosses-a-gate mode is introduced.** After an AFK handoff the deterministic headless driver is the only crosser.
- **Budget never shapes scope, and budget fields are never deleted.** The per-phase numbers stay as the default cost-controlled profile for the metered audience; the knob scales or disables them.
- **RIR tail untouched.** RIR has no spec/plan/docs/PR tail; #2 touches only the Full arc.

**Build/verify constraint (self-hosting hazard).** This run edits the very modules a detached driver re-spawns from (`spawnDrive` → `process.execPath process.argv[1] _drive`, `src/harness/lifecycle.ts`; `cli.ts`, `phases.ts`, `tools.ts`, `driver.ts`, `providers/*`). A running driver loads its modules once at spawn, but *any fresh `duet` invocation* (a crash-recovery `continue`, a mid-edit command, the next phase after a crossed gate) loads the edited — possibly half-written — source. Therefore this bundle must be **driven from a frozen duet** (a separate checkout or a global install), never from this worktree's own `src/`, **or** built attended (no AFK-headless impl on itself). `pnpm typecheck && pnpm test`, `validateRegistry` (load-time), and the exhaustive `phaseBriefBuilders satisfies Record<PhaseName,…>` (compile-time) are the safety net.

---

## Change 0 — the shared gate-model prerequisite

This lands first; #1 and #2 are thin additions on top.

### 0a. The default attended posture (registry `defaultPreAuthorized`, materialized at creation)

**Current** (`gateAttended`, `src/run-store.ts`):

```
gateAttended(state, phase):
  if forceAttend(workflow).includes(phase): return true
  return state.gatesAt === undefined || state.gatesAt.includes(phase)
```

`gatesAt` absent means attend **every** gate — and this is *explicitly* the pre-feature compatibility signal (`RunState.gatesAt` comment, `src/run-store.ts`; old/hand-written `state.json` resolve to defaults and are never rewritten, the same convention `workflow` uses). There is no way to express "pre-authorized by default, opt-in attendable" — which an opt-in-default-off rail needs.

**Desired** — add a per-workflow `defaultPreAuthorized` set (the *inverse* of `forceAttend`) to the registry (`src/phases.ts`, `WORKFLOWS`), and **materialize the resolved default posture at `createRun`**: a run created with no explicit `gatesAt` persists `gatesAt = (the workflow's gate phases) − defaultPreAuthorized`. The default posture is written concretely onto the new run, and **`gateAttended`'s logic is unchanged**.

This is the deliberate fix for the meaning-shift hazard the review flagged. Because the new default rides a *concrete materialized value* rather than a reinterpretation of "absent," a legacy run (created before this change) still has *absent* `gatesAt` and so keeps attend-all — it still stops at Open-PR after an upgrade, byte-for-byte unchanged, even though `pr` has left `forceAttend`. The new auto-open behavior reaches only runs created after the change. "Absent" stays the pre-feature signal, exactly as `workflow` does. The net behavior change for a *new* default Full run is precisely one thing — the PR auto-opens — and nothing else moves.

**Registry invariants.** `validateRegistry` checks `defaultPreAuthorized` the same way it checks `forceAttend` — each entry must be a gate phase of its workflow — **plus a disjointness rule: a gate may not appear in both `defaultPreAuthorized` and `forceAttend`.** An overlap would be incoherent: materialization omits a `defaultPreAuthorized` gate from `gatesAt`, but `gateAttended` still force-attends it, so the status/CLI posture text would claim the gate is pre-authorized while it actually stops — the load failure catches that at module load, not at runtime.

**Coupling decision.** `defaultPreAuthorized` is an **extension of the gate-attendance model** — a registry sibling of `forceAttend` — consumed as a `createRun`-time *default-computation input*, not a second runtime branch in the hot `gateAttended` path. It is *not* coupled to budget. I chose materialize-at-creation over the reviewer's suggested gate-policy version field because it reuses the codebase's established "absent = pre-feature, never rewrite old files" convention, leaves `gateAttended` untouched (smaller blast radius under the self-hosting hazard), and makes a run's posture self-describing on disk.

**Anchors.** `WORKFLOWS` + `validateRegistry` (`src/phases.ts`); the materialization in `createRun` (`src/run-store.ts`); `parseGatesAt`'s forceAttend-append (`src/framing.ts`) — with `pr` out of `forceAttend`, an explicit `gates_at` list no longer auto-appends it, the desired opt-in semantics; the status/CLI display that special-cases absent vs `[]` `gatesAt` (`src/cli.ts`, `src/status.ts`) now renders a concrete default list for new runs (acceptable — the posture becomes always-visible).

### 0b. Mutable gate posture (the write path)

**Current.** `gatesAt` is written once in `createRun` (`src/run-store.ts`) and never rewritten. The "CLI write races a live driver's saves" rule (why steers live outside `state.json`) is why no command mutates `state.json` mid-run.

**Desired.** `gatesAt` becomes writable after creation, via a small dedicated mutator. The race rule does **not** apply in the one window #1 uses it: there is no live headless driver during the interactive arc, and the AFK handoff *spawns* the driver only *after* the posture is written. No other path mutates `gatesAt`.

**Stale-save discipline (the real hazard).** The cross-process race (a live driver) genuinely does not apply here; the *in-process* one does. Within the single `duet afk` CLI process, several steps each save the whole `RunState` — `stageHumanInput` (an approval rider), and `crossInteractive`'s persist-then-fresh-load-to-clear-the-marker (`src/run-store.ts`, `src/harness/lifecycle.ts`). A posture write followed by staging approval text against a *stale* copy would clobber the posture. The mutator therefore follows the codebase's established **fresh-load → mutate-this-field → save** discipline (as `markTurnActive`/`settlePendingTurn` do), and AFK either combines the posture write and any staged approval into one fresh-load mutation or reloads before each subsequent mutating step. **Failure-mode if ignored:** the AFK posture is silently lost, downstream gates revert to attended, and the human who tapped "take it the rest of the way" returns to a stalled run — a safety regression, not a cosmetic one.

**Coupling decision.** Mutability is added to the gate model; budget stays **frozen at creation** (billing posture does not change mid-run) — the explicit reason the two are separate resolvers, not one struct.

**Anchors.** A `gatesAt` mutator beside the existing fresh-load-mutate-save `RunState` mutators (`src/run-store.ts`); consumed by #1's command.

### 0c. The budget resolver

(Introduced here as the second narrow resolver; its policy/knob is #3.)

**Current.** Every worker- and orchestrator-construction site reads the phase constants directly: `createWorkers(state.bindings, { workerBudgetUsd: PHASE[phase].workerBudgetUsd, … })` at `src/harness/driver.ts`, `src/harness/mcp-server.ts` (single-phase server *and* the run-scoped `defaultWorkerFactory`), and the orchestrator's own `Options.maxBudgetUsd: PHASE[phase].orchestratorBudgetUsd` (`driver.ts`).

**Desired.** A single `budgetFor(state, phase)` helper returns the effective `{ worker, orchestrator }` caps (a number, or **undefined when off**). All the sites above read it instead of `PHASE` directly; `createWorkers`'s `workerBudgetUsd` rail becomes `number | undefined`, and `ClaudeWorker` already omits `--max-budget-usd` when the cap is undefined, while the orchestrator `Options.maxBudgetUsd` is set only when defined. One code path, three call sites, both roles.

**Coupling decision.** A **separate** resolver from the gate model — they share only the "resolve from run state, read by the harness" pattern, deliberately not unified.

---

## Change #3 — worker/phase budget: opt-in, and a graceful checkpoint

### Part (a) — budgets become opt-in (config knob, default off)

**Current.** The per-phase caps are unconditional. For a flat-quota (subscription) maintainer they can only cut work, never save money.

**Desired.** A run-level budget knob, resolved at `createRun` and **frozen onto `RunState`**, feeding `budgetFor` (0c):

- `budget = "off"` → omit all caps (unbounded).
- `budget = "default"` → today's per-phase profile (multiplier 1).
- `budget = <scalar>` → the per-phase profile scaled by the multiplier.
- absent → **off** (the maintainer's posture, and "off where duet can't tell the billing reality").

A `--budget` CLI flag overrides config per run (the same override grammar as `--impl`/`--reviewer`). One knob covers **both** the worker and the orchestrator caps (no split — a stated non-goal).

**Coupling decision — the knob lives in config, not framing frontmatter.** This is account/billing posture, the **same family as the existing `transport: "headless" | "interactive"`** binding (itself a metered-vs-flat-quota knob already in `src/config.ts`), and it is account-stable rather than per-run, so it belongs on the account-stable surface. The config invariant ("role→provider/model bindings only; project knowledge never goes here") gets a **narrow, principled amendment** — *"role→provider/model bindings **and account/billing posture (transport, budget)**; project knowledge never goes here"* — not a general loosening. The `budget_usd` **frontmatter** name stays reserved for its distinct Q19 meaning (a run-level spend target the orchestrator can *reason about*); conflating that orchestrator-visible budget with this invisible per-turn kill-switch is precisely the Q19 scope-shaping failure, so the two are kept separate and only the config knob ships here.

**Anchors.** `RoleBindings`/parse + the invariant comment (`src/config.ts`); the resolved budget field on `RunState` and its read in `createRun` (`src/run-store.ts`); `budgetFor` (0c); the `--budget` flag (`src/cli.ts`).

### Part (b) — a hit budget is a checkpoint, not an infra envelope

**Current.** A worker budget cutoff makes `claude -p --max-budget-usd` end abnormally; `parseClaudeTurn` (`src/providers/claude.ts`) treats any non-success as a thrown `Error`, which `renderTurnResult` (`src/harness/tools.ts`) renders as *"The worker never saw your prompt, so this is not a content problem. Retry this same send_prompt call once."* That is false (the worker ran and committed slices) and it **contradicts the impl prompt's own coaching** (`src/harness/orchestrator-prompts.ts`: "resume that session… don't re-send the original prompt").

**Desired.** A budget cutoff is surfaced as a **budget checkpoint**, never an error — with two tiers, because what evidence the cutoff leaves is not guaranteed (the review's point: `ClaudeWorker.runTurn` uses `execa`, and a non-zero CLI exit can throw before `parseClaudeTurn` ever sees stdout, `src/providers/claude.ts`):

- **Parseable tier** (the budget signal arrives with a recoverable result — session id present): the provider recognizes the signal (assumed `error_max_budget_usd` — see open questions) and returns a `WorkerTurn` marked truncated-by-budget rather than throwing; `settleTurn` commits the normal bookkeeping (session id, cost, context) — the work is on disk and the session is resumable; `renderTurnResult` surfaces "budget reached — the worker saw your prompt and committed work is on disk; resume the session for the remainder, or raise the budget."
- **Fallback tier** (no parseable result is recoverable — e.g. `execa` throws with an incomplete envelope): render a **budget-control recovery** — still naming that the worker ran and committed work may be on disk (check git; resume manually once a session id is available) — but **do not promise normal `WorkerTurn` settlement**.

The one invariant across both tiers: a budget exit is **never** the infra "the worker never saw your prompt, retry this same call" envelope and **never** the auto-retry/`errorClass` path. Which tier is the common case depends on the empirical signal (open question 1).

**Orchestrator cap — a new flag cause (schema-coherent with the existing triage fields).** An orchestrator budget cap (`src/harness/driver.ts`, the `message.subtype !== 'success'` branch, today flagged `cause: 'infra', errorClass: 'unknown'`) becomes a queued stop with a **new `cause: 'budget'`** — the router itself stopped, so it is a real stop, but it is resumable (raise the budget / resume), distinct from both infra-retry and a human-product question. This **widens the flag-cause enum** on `RunState.pendingQuestion.cause` (`src/run-store.ts`) and the `StopModel` flag's `cause` (`src/status.ts`) from `'human' | 'infra'` to `'human' | 'infra' | 'budget'`: additive to the status JSON schema but an **enum-widening**, so consumers (the concierge reference doc, the brief's hold-vs-relay logic) gain a value and need a default branch; `errorClass` stays absent for a budget stop (budget is not an infra taxonomy class). This folds into the existing `cause`/`errorClass` triage schema rather than standing up a parallel mechanism.

Both halves are worth doing regardless of part (a) — they de-risk budgets for the metered audience.

**Coupling decision.** Worker detection lives at the provider boundary (`parseClaudeTurn` for the parseable tier, the `execa`-error path for the fallback); the parseable budget outcome travels the existing `WorkerTurn` success path (a truncation marker, not a new error class), and the orchestrator budget stop reuses the existing flag/`cause` channel (a new enum value, not a new field).

**Anchors.** `parseClaudeTurn`/`resultEnvelope` and the `execa` call (`src/providers/claude.ts`); `WorkerTurn` (`src/providers/types.ts`); `settleTurn`/`renderTurnResult` (`src/harness/tools.ts`); the orchestrator abnormal-exit branch + `pendingQuestion.cause` (`src/harness/driver.ts`, `src/run-store.ts`); the flag `StopModel` (`src/status.ts`).

---

## Change #2 — auto-open the PR (settled by the human's rider)

> **Rider (settled decision):** keep the opt-in pre-open PR stop (default OFF): drop `pr` from `forceAttend`, add it to `defaultPreAuthorized`; the PR opens automatically unless `pr` is listed in `gates_at`.

**Current** (Full arc, registry-derived statechart):

```
docs → docsPlanGate → pr(writes description) → openPrGate(force-attended) → open(gh pr create) → done
forceAttend: ['pr']
```

The Open-PR gate is the single gate even pre-authorization cannot skip.

**Desired** — same topology, flipped default:

```
docs → docsPlanGate → pr(writes description) → openPrGate(default pre-authorized) → open(gh pr create) → done
forceAttend: []            (pr removed)
defaultPreAuthorized: ['pr']
```

- **Default** (`gates_at` absent): `openPrGate` auto-crosses (the headless driver's existing `driveToQuiescence` auto-approve), `open` runs `gh pr create`, the run reaches `done` at an opened PR. For a fully-AFK Full run, "return" becomes the opened GitHub PR rather than a terminal gate packet — the deliberate, human-approved change to "return to a ship packet" (the impl/ship packets remain recorded in `autoApprovals` for the morning review).
- **Opt-in**: listing `pr` in `gates_at` makes `openPrGate` a real attended approve/reject pre-open stop again.

**The `open` entry prompt becomes state-aware (a binding-convention fix, same class as F1).** `openPhaseEntryPrompt` (`src/harness/orchestrator-prompts.ts`) currently opens with "The human approved opening the PR — that approval covers the mechanics, so run them." Under default pre-authorization that is **false** — the gate auto-crossed, the human did not tap. It adopts the existing `approvalClause(state, 'pr', <attended copy>, <pre-authorized copy>)` helper the other entry prompts already use (the convention that forbids claiming "the human approved X" when a gate was pre-authorized and auto-crossed), so the opening line tells the truth in both cases. This requires the `open` brief builder to receive `state` (today it ignores it). Fold this in with the F1 host-aware-message fix (#1) — both are messages keyed on the wrong assumption.

**Coupling decision.** This is *only* the `defaultPreAuthorized` flip plus dropping `pr` from `forceAttend` (Change 0a) and the state-aware `open` prompt above — **no phase collapse**. The `pr → openPrGate → open` topology is kept intact precisely so the opt-in stop has a **real second state** (the `open` phase is the action-after; `openPrGate` is the pause-before). Collapsing into one linear phase was declined: it could not honestly model pause-then-act without re-adding a state or a prompt-enforced pause, and the human-felt ceremony (the mandatory tap) is removed by the default flip, not by trimming invisible phases.

**Anchors.** `WORKFLOWS.full.forceAttend` + the new `defaultPreAuthorized` (`src/phases.ts`); the createRun materialization (Change 0a); `opensPr`/`completionLine` key on the `openPrGate` state name (`src/status.ts`) — keep the state name; the Open-PR gate `hint` copy and `openPhaseEntryPrompt` + its `phaseBriefBuilders` entry (`src/phases.ts`, `src/harness/orchestrator-prompts.ts`). The existing `overnight`/`skip-plan` presets need no edits — dropping `pr` from `forceAttend` means they stop auto-appending it, so they auto-open as intended.

---

## Change #1 — mid-session AFK handoff

**Current.** Gate posture is fixed at `duet new`. On the interactive host it is ignored during the attended arc: `crossInteractive` applies one human event inline and rests, and `interactiveContinueAction` (`src/harness/lifecycle.ts`) hands off to headless *only* at the workflow `handoffGate` or with explicit `--headless`. There is no path that, from a mid-arc attended gate, re-sets the downstream posture and hands off — so "I'm going to sleep, take the rest" stalls at the next gate (`docs/specs/2026-06-21-afk-handoff.md`).

**Desired** (from the afk-handoff problem definition):

```
interactive arc: tap per gate
   └─ at ANY interactive gate (attended OR pre-authorized):  duet afk [preset]   ← one tap
        ├─ re-sets downstream gatesAt to the preset (mutable write, Change 0b)
        ├─ crosses this gate (crossInteractive, human.approve)
        └─ clears orchestrationHost, hands off to the detached headless driver,
           which auto-crosses the pre-authorized rest and parks on
           ask_human / a still-attended gate / done
```

`duet afk [preset] [runId]` is sugar for "set posture, then `duet continue --approve --headless`." Behavior: legal when an **interactive run is parked at a gate** (`probeRunPosition` kind `gate`, the approve path) — **including a pre-authorized one**. This is a load-bearing correction to the FRAME-era sketch: F1 is precisely a *pre-authorized* gate parked on the interactive host (the interactive host never auto-crosses — only the headless `driveToQuiescence` does, `src/harness/lifecycle.ts`), so AFK legality must **not** gate on `gateAttended === true`; a pre-authorized interactive gate is exactly where `afk` is the one human tap that hands off. It writes the new downstream posture (stale-save-safe, Change 0b), crosses the current gate (`crossInteractive`, `human.approve`), clears `orchestrationHost`, and spawns the detached `_drive`. The AFK-entry surface prints the resulting split (which downstream gates are now attended vs pre-authorized) so the single tap is informed consent. (A run mid-phase, or parked on a flag, is not an AFK position — steer it, or answer the flag.)

**Default preset (assumption — flag below):** bare `duet afk` = maximum AFK = attend nothing downstream (the empty posture, `gatesAt = []`, already a recognized "attend none" signal in status/CLI). A named argument selects an existing workflow preset (`overnight`/`skip-plan` for Full, `afk` for RIR). **No new presets are added** (honoring the "no presets richer than the existing set" non-goal); bare-AFK reuses the empty posture rather than a new named preset.

**Folded bug F1 — host-aware `advance_phase` result.** `advance_phase`'s "what happens next" message (`src/harness/tools.ts`) currently branches on `gateAttended`, not on host, so on the interactive host a pre-authorized gate falsely reports "the run continues immediately… the next phase's instructions arrive as your next message" — nothing auto-continues there. The host is knowable inside the tool: `asyncDeps?.dispatcher` presence *is* the interactive-host switch. The pre-authorized branch becomes host-aware: on the interactive host it tells the orchestrator the run does **not** auto-continue here and to hand off (`duet afk` / `duet continue --approve --headless`), per the "results say what actually happens next" convention.

**Coupling decision.** #1 is built on Change 0b (mutable `gatesAt`); it introduces **no new authority model** — the `ask` rule, the `phase.*`/`human.*` split, and the deterministic-headless-crosser are all untouched. The only genuinely new capability is mutable posture.

**Anchors.** A new `afk` command + the host-aware message (`src/cli.ts`, `src/harness/tools.ts`); `interactiveContinueAction`/`crossInteractive`/`spawnDrive` (`src/harness/lifecycle.ts`); the `gatesAt` mutator (Change 0b).

---

## The UX cluster (independent cleanup, lands last)

- **Provider-agnostic onboarding.** Slash commands are an interactive-Claude feature; headless `claude -p` workers and codex do not expand them, so a worker handed `/onboarding`/`/skill` silently fails (F9). The three orchestrator entry prompts that actively instruct the slash-command path (`framePhaseEntryPrompt`, `researchPhaseEntryPrompt`, `docsPhaseEntryPrompt` in `src/harness/orchestrator-prompts.ts`) drop the "include its `/name` and the CLI expands it" instruction. The convention becomes: **workers receive document paths only.** The framing author supplies the path (the framing is the single knowledge-entry seam), and the shipped `skills/duet-frame/` template instructs authors to give a path rather than a bare slash command. The orchestrator's rule is to send the path it was given; **if the framing supplies only a slash command with no path, it treats the framing as incomplete (`ask_human` / surface it), not fabricate a translation** — there is no deterministic `/command → path` map in the harness, so the convention must not imply one (the reviewer's correction). When the framing names a skill file by path (the well-formed common case), the orchestrator sends that path. This corrects now-wrong instructions, not new prompt logic; `tests/skill.test.ts` (verb/flag coherence) stays green.
- **F2 — `write_note` while parked.** `write_note` is a pure append to `notes.md` with no statechart effect, so the quiescence rationale for refusing *work* tools does not apply. It is removed from the post-terminal `REFUSED_AFTER_TERMINAL` set (`src/harness/tools.ts`) so friction observations can be recorded at the gate moment they crystallize.
- **F5 — inline cost/context, and a truthful `(not started)`.** A compact per-turn footer (role context %, cumulative cost, round X/cap) is added in `renderTurnResult` (`src/harness/tools.ts`) — the single chokepoint both the blocking `send_prompt` (headless) and `check_turns` (interactive, via the dispatcher's `collectReady`) flow through, so one edit covers both hosts. Separately, the status label is derived from the probed `stop` (which carries the live phase) instead of rendering `(not started)` whenever `machineState` is null (`renderStatus`, `renderBrief` in `src/status.ts`).
- **F7 — snippet path cleanup.** The duet copy carries another project's paths: `write-spec` writes to a foreign `docs/superpowers/specs/`, and `tdd-plan` cites `~/.claude/skills/…` while `review-plan` cites `~/.agents/skills/…` for the same skills (`snippets.toml`). Neutralize the foreign spec path (defer the spec location to the framing's conventions, per the frontmatter boundary rule) and unify the skill root. `tests/snippets.test.ts` (classification/presence) stays green. (The four `/compact` references are out of scope — that is the literal worker-compaction mechanism the providers handle, not a slash-command-expansion bug.)

---

## Landing order (design decision; per-commit sequence is the plan's job)

1. **Change 0 — the gate-model prerequisite** (0a default attended posture + `defaultPreAuthorized`, 0b mutable posture, 0c budget resolver). No gate-crossing/attendance behavior change on its own (with `defaultPreAuthorized` empty it is pure infra; once #2 populates it, a new run materializes and renders a concrete default `gatesAt`, but no gate crosses differently until #2's `forceAttend` drop lands). Landing it first prevents #1 and #2 from each inventing their own attendance hack and gives #3 its single resolver.
2. **#3 budget** — config knob + the part-(b) checkpoint. Builds on 0c. Highest-value single fix (kills the misleading mid-turn failure) and decoupled from the gate work.
3. **#2 auto-PR** — the `defaultPreAuthorized` flip. Builds on 0a; lowest-blast-radius gate change, and it validates the materialized default-posture path (with `gateAttended` itself untouched).
4. **#1 AFK handoff + F1 message** — the mutable-posture write path and `duet afk`. Builds on 0b.
5. **UX cluster** — independent; bundled last to avoid churning against the structural diffs.

---

## Testing (behaviors that matter; cases/fixtures/mocking are the plan's job)

- **Gate model (0a).** A new default Full run materializes `gatesAt = gate phases − defaultPreAuthorized` at creation (so its `pr` auto-opens and every other gate is attended); an explicit `gates_at` listing `pr` makes the pre-open stop attended; `validateRegistry` rejects a `defaultPreAuthorized` entry that is not a gate phase.
- **Legacy compatibility (0a).** A run whose persisted state predates this change (absent `gatesAt`) still attends every gate — including Open-PR — after an upgrade; the auto-open default never reaches an in-flight legacy run.
- **Mutable posture (0b).** A mid-run `gatesAt` write persists and is read by a subsequently spawned driver; a run that never mutates it behaves exactly as today. **The AFK write survives its own staging:** setting the posture and staging an approval rider in the same `duet afk` invocation does not clobber the posture (the fresh-load-mutate-save discipline holds).
- **Budget knob (#3a).** `budget = "off"` (and absent) omits `--max-budget-usd` and the orchestrator cap entirely; `"default"` reproduces today's per-phase caps; a scalar scales both roles; all worker-construction sites and the orchestrator read the *same* resolved value; the `--budget` flag overrides config.
- **Budget checkpoint (#3b).** A worker budget hit with a recoverable result settles normal bookkeeping and reports a **checkpoint**; a worker budget hit with no parseable result renders a **budget-control recovery** without promising settlement; neither is ever the "worker never saw your prompt" infra envelope, and neither auto-retries. An orchestrator budget hit queues a stop with `cause: 'budget'` (resumable), not `infra`. A genuine infra failure still produces the infra envelope (the three are distinguishable). A flag-cause consumer handles the new `'budget'` value without breaking on the existing two.
- **Auto-PR (#2).** A default (post-change) Full run auto-crosses `openPrGate` and reaches `done` at an opened PR; listing `pr` in `gates_at` restores an attended approve/reject pre-open stop; the `open` entry prompt's opening line is honest in both the attended and pre-authorized cases; RIR is unaffected; the `overnight`/`skip-plan` presets auto-open without preset edits.
- **AFK handoff (#1).** `duet afk` at any interactive gate parked on the approve path — **including a pre-authorized gate** — re-sets the downstream posture, crosses that gate, and hands off headless with no further taps until a still-attended gate, an `ask_human`, or `done`; a still-attended gate under the new posture parks (is not auto-crossed); a plain `duet continue --approve` still fires the `ask` rule (invariant path untouched); the AFK-entry surface lists the resulting attended/pre-authorized split.
- **F1 message.** On the interactive host, `advance_phase` at a pre-authorized gate reports that nothing auto-continues and names the handoff command (`duet afk` / `duet continue --approve --headless`); on the headless host the message is unchanged.
- **UX cluster.** Onboarding prompts/templates name a document path, never a slash command, and instruct surfacing an incomplete framing (only-a-slash-command, no path) via `ask_human` rather than inventing a path; `write_note` succeeds while parked at a gate/flag; the per-turn footer appears on both `send_prompt` and `check_turns` results; `(not started)` no longer shows while a phase/driver is active; the cleaned snippets keep `tests/snippets.test.ts` and `tests/skill.test.ts` green.

---

## Open questions / spec-phase confirmations (assumption stated; not blocking)

1. **The `error_max_budget_usd` signal (part b).** *Assumption:* a Claude worker budget cutoff surfaces as a distinct, infra-distinguishable result (subtype `error_max_budget_usd`) recognizable at the provider boundary. The part-(b) fix's correctness rests on this; it **must be confirmed empirically against the installed `claude` CLI** (including *where* it is observable — a JSON envelope subtype vs a non-zero-exit error to inspect — since that decides whether detection lives in `parseClaudeTurn` or the execa-error path). The mapping (budget → checkpoint, not infra) is fixed regardless.
2. **The `duet afk` surface and default preset.** *Assumption:* `duet afk [preset] [runId]`, legal at any interactive gate parked on the approve path (including a pre-authorized one — see #1/Point 2); bare = maximum AFK (attend none, the empty posture); a named argument selects an existing workflow preset; **no new presets are added**. Confirm the bare-AFK semantics and that reusing the empty posture (rather than a new named preset) is the intended reading of the "no presets richer than the existing set" non-goal.
3. **Config invariant amendment wording.** *Assumption:* the amendment is narrow — "role→provider/model bindings **and account/billing posture (transport, budget)**; project knowledge never goes here." Confirm the budget knob is a top-level run-level key (not per-role), consistent with "one knob covers both roles."

---

## Relation to the ledger

- **Q19 (per-turn budget must never shape scope):** the observed mid-turn cut is direct evidence the cap *can* shape scope via hard failure; #3 (both the opt-out and the graceful checkpoint) is the response. `budget_usd` frontmatter stays reserved for Q19's distinct "explicit run-level budget the orchestrator reasons about."
- **Q20 (pre-authorization precision):** #1 and #2 are its first real exercises — mid-session posture-setting and a pre-authorizable Open-PR gate; the recorded packets/`autoApprovals` remain the morning-review evidence stream.
