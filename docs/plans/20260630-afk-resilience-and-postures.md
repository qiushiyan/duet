# AFK resilience & postures — implementation plan

**Status:** Plan (uncommitted — reviewed before build). **Date:** 2026-06-30. **Branch:** `feat/afk-resilience-and-postures`.
Complementary to the spec ([`docs/specs/20260630-afk-resilience-and-postures.md`](../specs/20260630-afk-resilience-and-postures.md)) — it owns *what & why*; this owns *how*. Ships as **one PR**, all clusters, **one slice per commit**, each independently green. After this gate the build runs **AFK**, so every open number is pinned below — nothing is left as a build-time judgment call.

---

## Resolved open items (pinned)

### The impl cap number — measured from the corpus

Measured **total** healthy worker-turn wall-clock durations across the 8 local runs under `.duet/runs/` (the `~/dev/.worktrees/.../​.duet/runs/` corpus the findings cite is not present on this machine). Method: pair each voice-log `◀ prompt (tag=…)` with the next `▶ response`; a prompt followed by another prompt with no response between = a failed/abandoned turn, excluded; `/compact`-tagged turns excluded. 154 healthy paired turns:

| bucket | n | median | p90 | p95 | **max** |
|---|---|---|---|---|---|
| all healthy | 154 | 3.6 | 10.4 | 15.3 | **29.5** |
| └ implementer | 105 | 4.4 | 12.6 | 18.5 | **29.5** |
| └ reviewer | 43 | 2.8 | 6.1 | 7.4 | 13.3 |
| healthy `/compact` | 7 | 2.0 | 2.2 | 2.2 | **2.3** |

The longest healthy worker turn is **29.5 min** (an implementer turn); the longest healthy `/compact` is **2.3 min** (confirming the spec's 2–3 min — the `7447` 117-min compact is excluded as a failure, no clean response). 2–3× the longest healthy turn = **59–88.5 min**, so today's 60-min cap is already ≈2×, and the spec's floated 180 would be ≈6×.

**Pinned:**
- **Impl per-turn cap = `90 * 60_000` (90 min)** — top of the 2–3× band (3× the 29.5-min longest healthy turn). Headroom for a turn longer than any in an 8-run corpus, without the ≈6× worst-case waste 180 would impose on the one mode the watchdog can't see (a stream-alive, no-progress loop). Post-C a cap-hit is a resumable checkpoint, so erring high costs only resume-churn. **Both AFK build phases** take 90: full's `impl` (`phases.ts:222`) and rir's `implement` (`phases.ts:331`) — the measurement spans both arcs (rir `implement-direct` turns up to 25 min); leaving them split would be unmotivated. Planning/finish caps stay **30 min** (their longest healthy turns ≈17 min, already ≈2×).
- **`/compact` per-turn cap = `8 * 60_000` (8 min)** — ≈3.5× the 2.3-min longest healthy compact; the forced watchdog catches an idle stall at ~5 min anyway, so 8 min is the wall-clock backstop for a stream-alive-but-stuck compact, dramatically below the 90-min build cap.
- *(Corpus caveat: 8 runs of this project's own small-to-mid features. 90 is the high-end-of-band pick precisely to hedge a larger feature on a bigger codebase; the cap is a per-turn **resumable** bound, so the hedge is cheap.)*

### The phase-level outer bound

- **`QUIESCENCE_TIMEOUT_MS = 12 * 60 * 60_000` (12 h)** (up from 6 h, `lifecycle.ts:49`) — above a realistic worst-case overnight impl phase (several 90-min-capped turns + bounded retry backoff). The number is the smaller half; the **soft-fail conversion is load-bearing** (S4).

### Default-on retry

- **`DEFAULT_RETRY_INFRA = 3`**, materialized at `createRun`. The existing backoff (`worker-health.ts:111`, 2s/4s/8s, capped 30s) and auth-once policy are unchanged — 3 attempts recover a transient `network`/`server`/`rate-limit` blip in ≤14 s of **duet-added** backoff (each attempt may also include the provider's own native SDK/CLI retry time) before flagging.

### The auto-retry ledger shape

- **`RunState.autoRetries?: Array<{ phase: PhaseName; errorClass: ErrorClass; attempt: number; at: string }>`** — appended in `host-runner.ts` at the `decision.action === 'retry'` branch (`:148`), beside the existing `[driver] infra … auto-retry` log line.
- **Status model gains `awayRetries: Array<{ phase; errorClass; attempt; at }>`** (additive, like `autoApprovals`), rendered in the existing *"while you were away"* section (`status.ts:378`, just after the auto-approved block): `while you were away — infra auto-retries: N (network ×2, server ×1)` plus per-entry lines; and in `--brief` (`status.ts:564`): `auto-retried: network ×2, server ×1`.
- **Not the gate-shaped `autoApprovals`** (`{ gate, at }` + packet headline) — a retry has no gate; a sibling field keeps the morning review honest. Recovered-**visible**: count + class + phase is the degradation signal (the per-turn token cost is already in `costs.orchestratorUsd`).

---

## The four advisory notes — decided

1. **Honest watchdog-vs-wall-clock framing — DO** (S9 wording). Docs frame the owned **wall-clock backstop as the workhorse** for the proven machine-sleep failure, and the forced watchdog as **cheap insurance** for a mode largely already covered on duet's direct-Anthropic path (the watchdog is on-by-default there; forcing it is belt-and-suspenders for every connection).
2. **caffeinate is best-effort, not "primary" — DO (reframe).** A closed laptop lid on battery sleeps regardless of `caffeinate -i` (which prevents *idle* sleep, not lid-close). Reframe it as **best-effort** in the S4 caffeinate work and the S9 docs (aligning with the spec's own "bounded-waste-then-recover" promise), with a one-line user-expectation note ("a closed lid still sleeps → you land on the wall-clock backstop and resume"). Mechanism unchanged — caffeinate still ships (it helps the common docked/lid-open idle case). **This revises the spec's Cluster A caffeinate bullet, which still says "primary" — flagged in *Spec deltas* below.**
3. **Recovery-cost legibility on the metered path — PARTIAL DO / DEFER.** DO: the ledger records count + class + phase (the actionable "is my environment degrading / am I churning" signal). DEFER: per-retry *token-cost attribution* (total cost is already in `costs.orchestratorUsd`; count+class is the signal that matters) and a *metered-transport-specific tighter cap* (the bounded default count of 3 + the visible ledger suffice; a transport-specific cap is a speculative knob the spec forbids). Revisit only if dogfooding shows retry churn is a real cost problem.
4. **Does `afk:[]` earn its docs cost? — DO the honesty note.** The D1 + S9 docs/skill state that **`afk` and `gateless` differ only when a consultant is bound** (for the default no-consultant user they are equivalent), so the four-rung ladder is legible. No code beyond the preset.

---

## Slice order (and why)

Evidence-strength within the one PR (demonstrated core before precautionary tuning), constrained by dependencies; each slice independently green, one commit each.

| # | Slice | Cluster | Depends on |
|---|---|---|---|
| **S1** | Foundation — per-turn `timeoutMs` contract | foundation #1 | — |
| **S2** | Force the native watchdog (env, Claude-only) | A | — |
| **S3** | Wall-clock backstop + AFK build caps (90 min) | A | S1 |
| **S4** | Driver-lifecycle resilience — caffeinate + QUIESCENCE soft-fail | A | — |
| **S5** | Honest failure-result split | C | S3 (produces the new abort) |
| **S6** | Default-on retry + the auto-retry ledger | A | — |
| **S7** | Compaction robustness — `/compact` cap + reset + `recover-context` | B + foundation #2 | S1, S5 |
| **S8** | Full-arc `afk:[]` preset | D1 | — |
| **S9** | Prompts, skills, docs (methodology-gated) | E | all above |

S1 first (both A and B build on the per-turn contract). The demonstrated core (S2–S5) before the precautionary tuning (S6 retry default, S7 compaction recovery). **Foundation #2 (the session reset) is realized inside S7, not as a standalone opener** — a reset with no trigger is dead code (fails the deletion test), and its trigger (an accepted-but-failed compact) and action are one coherent behaviour; splitting them would spread the concept (an explicit, lesson-driven deviation from "two separate foundation openers"). Its prerequisite — S5's accepted-vs-never-accepted proof — is sequenced before it. D1 and E last (E documents what actually landed).

---

## Slices

### S1 — Foundation: a per-turn `timeoutMs` contract (behavior-preserving)

**What.** Add `timeoutMs?: number` to `RunTurnOptions` (`providers/types.ts:78`). Each provider computes its effective cap as `opts.timeoutMs ?? this.config.timeoutMs ?? <provider default>` and uses it exactly where it uses the construction value today — claude via `claudeExecaOptions` (`claude.ts:307`, which already takes `config.timeoutMs`; thread the per-turn override into the effective value), interactive-claude (`interactive-claude.ts:380`, `deadline = Date.now() + effective`), codex (`codex.ts`). **Behavior-preserving:** absent override ⇒ byte-for-byte today's effective timeout; this slice changes no enforcement, only adds the knob.

**Tests** (`tests/providers.test.ts`):
- `claudeExecaOptions` (or the effective-cap computation) honors a per-turn override over the construction default; absent ⇒ the construction default (existing assertions stay green).
- `FakeWorker` already records `opts` in `calls` — a handler test can later assert the per-turn `timeoutMs` that flowed through (used in S7).

**Leave alone.** The per-phase construction value (`createWorkers`, `index.ts:22`) and every existing call site — they pass no override, so nothing moves.

---

### S2 — Force the native watchdog (env injection, Claude-only)

**What.** Inject `API_FORCE_IDLE_TIMEOUT=1` at the three Claude connections:
- `claudeExecaOptions` (`claude.ts:307`) gains an `env: { ...process.env, API_FORCE_IDLE_TIMEOUT: '1' }` (it has none today — execa inherits `process.env`).
- `buildOrchestratorOptions` (`driver.ts:185`) merges it into the existing `env`.
- The interactive transport's tmux launch: extract a pure `claudePaneLaunchCommand(config)` builder from `pane.ts:64` that carries `API_FORCE_IDLE_TIMEOUT=1` at the launched `claude` / session-env level — **not** parent inheritance (tmux may reuse a stale server env). The tmux-driving glue around it stays untested; the arg/env construction becomes a tested pure function (Finding 6 — the watchdog is too load-bearing for inspection-only on an AFK build).

**Claude-only** — `API_FORCE_IDLE_TIMEOUT` is a Claude API knob; codex never sees it.

**Tests** (`tests/providers.test.ts`, `tests/driver` coverage):
- `claudeExecaOptions` includes `env.API_FORCE_IDLE_TIMEOUT === '1'`, merged over `process.env`.
- `buildOrchestratorOptions().env` includes it (and keeps `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`).
- `claudePaneLaunchCommand(config)` (unit): the built launch carries `API_FORCE_IDLE_TIMEOUT=1` at the command/session-env level (keeping `--model`/`--permission-mode`). The tmux spawn itself stays glue; the **live `API_FORCE_IDLE_TIMEOUT` probe stays environment-only** (documented manual step: `API_FORCE_IDLE_TIMEOUT=1` + a tiny idle timeout + a real `claude -p` turn, confirm it aborts on an induced stall).

**Leave alone.** Codex env; the undocumented `CLAUDE_STREAM_IDLE_TIMEOUT_MS` pair (best-effort, not shipped as load-bearing).

---

### S3 — Wall-clock backstop + the AFK build caps

**What.** A wall-clock (Date-based) deadline at the `WorkerProvider.runTurn` seam, alongside execa's monotonic `timeout`, so an overnight-suspended turn is bounded in *real* time. New tested helper (e.g. `src/providers/wall-clock.ts`): `runWithWallClockDeadline<T>({ run, abort, capMs, now, schedule })` — races the turn promise against a deadline re-checked against the injected `now()` on a timer; on the deadline it calls `abort` (the execa child-kill path) and throws a typed **`WallClockExceededError`**. claude's `runTurn` wraps its execa call in it (execa's monotonic `timeout` stays for the kill mechanics / fast path; the wall-clock catches suspend on wake). **Codex realizes the same provider-wide cap concretely: `codex.ts`'s `runTurn` wraps its `thread.runStreamed` in the same helper, with `abort` driving an `AbortController` it owns** — not relying only on `AbortSignal.timeout` (a monotonic deadline that suspend would freeze) — so a Codex turn hits the wall-clock abort that S5's honest accepted-abort recovery depends on. Set the pinned caps: `impl` and `implement` `workerTurnTimeoutMs → 90 * 60_000` (`phases.ts:222`, `:331`).

**Tests:**
- `wall-clock.test.ts` (in-process, fake timers + injected `now`): a never-resolving `run` + advancing the clock past `capMs` ⇒ `abort` called once, `WallClockExceededError` thrown. A `run` that resolves before the deadline ⇒ its value, `abort` never called, timer cleared. Advancing the clock by a *suspend-sized* jump past the deadline (one tick) ⇒ aborts (the suspend-on-wake model).
- `FakeWorker` gains a way to model an overrun (script a `WallClockExceededError`) so S5's higher-level tests can drive the abort outcome.
- `tests/phases.test.ts`: `PHASE.impl.workerTurnTimeoutMs === 90*60_000` and `PHASE.implement.workerTurnTimeoutMs === 90*60_000`; planning/finish unchanged at 30 min.

**Leave alone.** The planning/finish caps; execa's `forceKillAfterDelay` (the kill escalation) — the wall-clock deadline triggers the same kill path.

---

### S4 — Driver-lifecycle resilience: caffeinate + QUIESCENCE soft-fail

**What.** Two changes to the detached-driver lifecycle (`lifecycle.ts`):
- **caffeinate (best-effort, darwin-only).** In `spawnDrive` (`:56`), after the driver starts, spawn `caffeinate -i -w <driverPid>` detached when `process.platform === 'darwin'` (it exits when the driver pid exits — scoped to the run, never keeps the machine awake past it). Best-effort: a spawn failure is swallowed (the wall-clock backstop is the real protection). **Framed best-effort** (advisory 2) — it prevents the common *idle* sleep (docked / lid-open), not lid-close-on-battery.
- **QUIESCENCE soft-fail.** Wrap the `waitFor(actor, quiescent, { timeout })` (`:414`) so a timeout rejection does **not** propagate (today it crashes `_drive` → a stranded dead run, the `7447` pattern). On timeout, **park the machine in flag-wait, THEN queue the question** — order is load-bearing (Finding 5): `probeRunPosition` (`:215`) reports a `flag` only when the snapshot is in a `flag-wait`-tagged state AND `pendingQuestion` exists; a question beside a still-phase-loop snapshot reads as crashed/running, not an actionable flag (defeating the fix). So: `actor.send({ type: 'phase.flag' })` (drives the stuck phase loop → its `*FlagWait` state, stopping the wedged `phaseDriver` invoke), `saveMachineSnapshot` of that flag-wait snapshot, **then** save the `pendingQuestion` (`cause: 'infra'` — "the {phase} phase exceeded the {Nh} outer bound and is parked; check the logs / `duet doctor`, resume with `duet continue`"), notify, and return the stop. First-question-wins: if a question already exists, preserve it but still park in flag-wait. Raise the const to 12 h. Make the timeout **injectable** via `LifecycleDeps` (default the const) for the test.

**This reset/flag must honor first-question-wins** — never overwrite a question the orchestrator already queued (reuse the existing guard).

**Tests** (`tests/lifecycle.test.ts`):
- A scripted machine that never reaches `quiescent` within an injected short timeout ⇒ `driveToQuiescence` parks in a **`*FlagWait` snapshot** such that `probeRunPosition` on the result reads **`flag`** (not crashed/running), carrying a `pendingQuestion` (cause infra); it never throws / never kills the process.
- An already-queued question is preserved (the soft-fail doesn't clobber it) but the machine is still parked in flag-wait.
- caffeinate: behind a platform check, assert it is a no-op off darwin (inject the spawn fn / platform); the darwin spawn itself is glue (inspection), like tmux-view.

**Leave alone.** The normal quiescent-stop path; the deliver-before-clear marker lifecycle.

---

### S5 — Honest failure-result split (Cluster C)

**What.** Distinguish **prompt-accepted-then-aborted** (resume, don't re-send) from **never-accepted** (retry verbatim), keyed on *this turn's* prompt being accepted — **provider-wide** (Claude and Codex, since S1/S3 made the wall-clock cap provider-wide), and settled **without corrupting the review-round bookkeeping**.

- New `WorkerTurn.aborted?: true` (`providers/types.ts`), parallel to `interrupted` — a settled, resumable checkpoint. **`settleTurn` (`tools.ts:344`) MUST branch on it** (Finding 3): a non-`Error` `WorkerTurn` is otherwise treated as a *completed* response. For an `aborted` turn: persist `workerSessions[role]` (resumable); record the base snippet as **sent** (the prompt is in the session — a later full re-send must warn, never silently repeat); update cost/context if reported (best-effort). But do **NOT** count a review round (no usable review was delivered — counting it burns the phase cap and makes later rails believe a review ran); do **NOT** append a normal `▶ response` voice log (use a `⚠ turn aborted (resumable)` marker); and do **NOT** set the consultant contract/verify markers (`acceptanceContractDraft`/`verifiedAt`) — an aborted consultant turn did not complete its checkpoint.

- **Per-turn acceptance proof, not a whole-transcript scan** (Finding 1 — the load-bearing fix). Capture `turnStartedAt = Date.now()` at the top of `runTurn` (before spawn) and thread it into recovery. The pure helper is `transcriptShowsPromptAccepted(jsonl, sinceMs): boolean` (reuse `worker-health.ts`'s `parseRecords`) — true iff a `user`/`assistant`/`result`/tool record carries `timestamp >= sinceMs`. A persistent (implementer/reviewer) session already holds *prior* turns' records, so a whole-transcript scan would false-positive on a resumed turn that failed *before* its new prompt was accepted — and that cascades into S7 wrongly clearing the implementer session on a pre-flight compact. Gating on `turnStartedAt` is correct for both fresh (every record is this turn's) and resumed sessions.
- **Claude** (`recoverClaudeFailure`, `claude.ts:264`): on a timeout/abort error (`err.timedOut` or `WallClockExceededError`) with no usable stdout envelope, locate the transcript by the **minted** sessionId (`sessions.ts` `readTranscriptTailForSession`) and ask `transcriptShowsPromptAccepted(tail, turnStartedAt)` → accepted ⇒ `{ text: <partial or ''>, sessionId, aborted: true }`; not-accepted / no-transcript ⇒ throw infra. Inject the transcript read (a seam) so tests fake it. Non-timeout errors with no stdout stay infra (now correctly "never accepted").
- **Codex** (`codex.ts`, Finding 2 — the provider-wide cap forces provider-wide honesty): a Codex turn aborted by the same wall-clock cap must not lie either. Codex announces its thread id off the first `thread.started` of the turn (the `onSessionId` signal). Proof = **`thread.started` seen for this turn before the abort** ⇒ `{ sessionId: <thread id>, aborted: true }` (resume — `codex exec resume <id>`); not seen (pre-flight) ⇒ throw infra. No transcript read — the stream already carries the signal. (Codex never receives a `/compact` body, so S7's compact path stays Claude-only in effect; this is purely the honest-resume parity.)
- `renderTurnResult` (`tools.ts:451`): add an `outcome.aborted` arm rendering "resume, don't re-send" (mirror the `interrupted` block at `:472`); the bare-`Error` arm keeps "the worker never saw your prompt — retry verbatim" (now reached only for genuinely never-accepted).
- Interactive transport (`interactive-claude.ts`): map its three timeout throw-points — "not ready before timeout" (pre-injection) ⇒ infra/retry; "turn did not complete in transcript" (injected + nonce-correlated = accepted) ⇒ `aborted`/resume; "could not correlate" (no positive acceptance evidence) ⇒ infra/retry (deliberate: bias to resend absent proof). Kept light — opt-in/secondary.

**Bolded gotcha for this slice: the proof is THIS TURN's prompt being accepted — a record at/after `turnStartedAt` (Claude) or a `thread.started` seen this turn (Codex) — NOT a whole-transcript scan, NOT a minted id, NOT a mere transcript file.** On a persistent session a whole-transcript scan false-positives on prior turns' records. **And an `aborted` turn is a checkpoint, not a review: `settleTurn` persists the session but counts no round and sets no consultant marker.**

**Tests:**
- `transcriptShowsPromptAccepted` (unit): a record at/after `sinceMs` ⇒ true; **only records *before* `sinceMs`** (the resumed-session case — prior turns present, this turn never accepted) ⇒ **false**; system/init-only ⇒ false; empty ⇒ false.
- `recoverClaudeFailure` (`tests/providers.test.ts`, transcript read + `turnStartedAt` injected): timeout err + a post-start record ⇒ `{ aborted, sessionId }`; timeout err + only pre-start records ⇒ throws infra; timeout err + no transcript ⇒ throws infra; non-timeout no-stdout ⇒ throws infra; budget/`interrupted`/success unchanged.
- Codex recovery (`tests/providers.test.ts`): wall-clock abort + `thread.started`-seen ⇒ `{ aborted, sessionId }`; abort before `thread.started` ⇒ throws infra.
- `settleTurn` (`tests/tools.test.ts`): an `aborted` reviewer turn ⇒ session persisted, base snippet marked sent, **review round NOT incremented**, voice log is the abort marker; an `aborted` consultant turn at the contract/verify checkpoint ⇒ `acceptanceContractDraft`/`verifiedAt` **NOT set**.
- `renderTurnResult` (`tests/tools.test.ts`): an `aborted` WorkerTurn ⇒ "resume, don't re-send"; a bare `Error` ⇒ "never saw your prompt, retry verbatim". (The `7447` shape — a 117-min accepted turn — is the canonical case.)

**Leave alone.** The budget-cutoff and `interrupted` paths (already honest, already settle correctly).

---

### S6 — Default-on retry + the auto-retry ledger

**What.**
- `createRun` (`run-store.ts:469`): materialize `retryInfra: opts.retryInfra ?? DEFAULT_RETRY_INFRA` (3) — **nullish, not the current truthy `?`**, so an explicit `--retry-infra 0` stays 0 (off) and an absent value gets the default.
- `RunState.autoRetries?` field + the render: append in `host-runner.ts:148` (the retry branch); add `awayRetries` to the status model and render it in the while-you-were-away section + `--brief` (shapes pinned above).

**Bolded gotcha for this slice: materialize at `createRun`; an absent `retryInfra` on a loaded/hand-written `state.json` stays OFF byte-for-byte** — only newly-created runs get the default (`host-runner.ts:144` reads `state.retryInfra ?? 0`, so old runs are untouched). `--retry-infra 0` is the explicit off.

**Tests:**
- `createRun` materializes `retryInfra === 3` by default; `retryInfra: 0` stays 0; `retryInfra: 5` stays 5 (`tests/run-store` / `tests/phases`).
- An old-shape `state.json` (no `retryInfra`) loaded ⇒ `host-runner` sees `undefined ?? 0 === 0` ⇒ off (a `loadRunState` + retry-policy test).
- `host-runner.test.ts`: a retryable scripted host + a transient (`network`) failure ⇒ a retry **and** an `autoRetries` entry appended; exhaustion ⇒ flag (unchanged).
- `status.test.ts`: a state with `autoRetries` renders the while-you-were-away line + the brief projection.

**Build-risk callout (audit before this slice lands).** The `run` fixture now carries `retryInfra: 3`, so existing crash/flag tests on the **retryable headless host** would now *retry* instead of flagging. Audit `tests/host-runner.test.ts`, `tests/lifecycle.test.ts`, and `tests/driver.test.ts`: any case asserting "infra failure ⇒ flag, no retry" must set `retryInfra: 0` explicitly or assert the new retry-then-flag sequence. Update any test asserting `retryInfra` absence after `createRun`.

**Leave alone.** `retryDecision` itself (`worker-health.ts:128`) — the policy is correct; only the default and the ledger are new. The stdio/interactive host stays classify-but-hands-back (not retryable).

---

### S7 — Compaction robustness (Cluster B + foundation #2)

**What.**
- **`/compact` short cap.** A shared `perTurnTimeoutFor(body): number | undefined` — `body.trimStart().startsWith('/compact') ? 8*60_000 : undefined`. **Both** send paths pass it via S1's knob: the blocking `runBlockingTurn` (`tools.ts:1076`) and the dispatcher launch (`turn-dispatcher.ts`). One rule, two call sites.
- **Session reset (foundation #2).** On the **shared settled/collected worker-failure path**, when the failed turn was an **accepted-but-failed `/compact`** (S5's proof + the `isCompactTurn` flag below), clear `state.workerSessions.implementer` so the next `send_prompt` seeds fresh (`sessionIdFor → undefined → mint`), and render the compaction-recovery prescription instead of the generic "resume" (resuming the bloated session is the wrong move for a compact). A pre-flight (never-accepted) `/compact` failure ⇒ no reset, normal "retry verbatim".
- **Thread `isCompactTurn` to the settle/render path** (Finding 4 — the data isn't there today). `settleTurn` receives `{role, tag, isReviewRound}` and `renderTurnResult` has no body context, so neither can see "the body was `/compact`." Compute `isCompactTurn` **once in `send_prompt`** from the body — the same body inspection that yields `perTurnTimeoutFor(body)`, so one check produces both the 8-min cap and the flag — and thread it through both send paths: blocking `runBlockingTurn` (`tools.ts:1076`) and the async `TurnDispatcher` via `PendingRecord.meta`, into `settleTurn` and `renderTurnResult`. Do **NOT** infer compact-ness from the tag — `compact-for-impl` is a naming convention and a hand-composed compact rides `tag=custom`; the literal body is the only honest signal.
- **`recover-context` snippet.** Add to `snippets.toml` + `ANYTIME_SNIPPETS` (`phases.ts:608`). Body authored following the snippet conventions + `docs.local/prompt-engineering/SKILL.md` (the methodology gate): a frame the orchestrator concretizes — a project/status overview (what we're building; what's committed and green; what's left; the load-bearing seams/files) **plus** a reread — and it **names its narrow trigger** (use after a failed compact / fresh-session recovery, not as a generic reread — that is `reread-context`).

**Bolded gotcha for this slice: the session reset fires ONLY on an accepted-but-failed `/compact`, NEVER a pre-flight failure** (pre-flight ⇒ the old session never saw the compact and is still the one to compact) — **and it rides the shared settle/collect path, so the async interactive lifecycle is preserved** (a failed compact stays collectible, `pendingTurns` clears only on `check_turns`, the next send still respects the orphan / in-flight rails); never a free-standing state write.

**Tests:**
- `perTurnTimeoutFor` (unit): `/compact …` ⇒ `8*60_000`; a normal body ⇒ `undefined`.
- send_prompt passes the cap (handler test, `FakeWorker.calls`): a `/compact` send ⇒ the worker's `opts.timeoutMs === 8*60_000`; a normal send ⇒ `undefined`. Both hosts (blocking + dispatcher).
- Reset (handler test, `FakeWorker`/`DeferredWorker` scripted to fail): an **accepted-but-failed** `/compact` ⇒ `workerSessions.implementer` cleared **and** the result prescribes `recover-context`; a **pre-flight** `/compact` failure ⇒ `workerSessions.implementer` **unchanged** + "retry verbatim"; a non-compact accepted-but-aborted failure ⇒ no reset (generic "resume").
- `isCompactTurn` is **body-derived, not tag-derived**: a `/compact …` body sent with `tag=custom` ⇒ treated as compact (reset eligible); a non-`/compact` body ⇒ not, regardless of tag. Asserted on both send paths (blocking + dispatcher `PendingRecord.meta`).
- Async lifecycle (dispatcher/interactive test, `DeferredWorker`): a failed compact stays collectible; the reset happens on settle/collect; the next send mints fresh and the rails hold.
- `tests/snippets.test.ts`: `recover-context` is classified (`ANYTIME_SNIPPETS`), no personal-path leak; every key the prompts name still resolves.

**Leave alone.** The consultant's ephemerality and the persistent roles' normal resume (`roles.ts`); `reread-context` (the generic reread stays its own snippet).

---

### S8 — Full-arc `afk:[]` preset (D1)

**What.** Add `afk: []` to the full workflow's `presets` (`phases.ts:264`), mirroring rir's. Everything downstream already handles it (`createRun`'s `?? defaultPosture` preserves `[]`; `gateAttended` reads attend-none; `consultantCheckpointLive` keeps challenge + backstop with `gateless` off). Surface the preset name in the `--gates-at` help enum (`cli.ts:280`).

**Bolded gotcha for this slice: `afk` materializes `gatesAt: []` with `gateless` OFF — the holding `challenge` bet-audit AND the correctness backstop both still fire** (distinct from `--gateless`, which drops the challenge). For a no-consultant run `afk` and `gateless` are equivalent (the S9 honesty note).

**Tests** (`tests/phases.test.ts`, `tests/machine.test.ts`):
- `parseGatesAt('afk', 'full') === []`; `createRun({ gatesAt: parseGatesAt('afk','full') })` persists `gatesAt: []`.
- `gateAttended` reads `[]` as attend-none; the severity hold still fires.
- `consultantCheckpointLive(<a challenge phase>, { consultant: true, gateless: false }) === true` and a backstop phase true — both nets kept.
- `validateRegistry` still passes; rir's `afk: []` unchanged.

**Leave alone.** `gateless`, the severity hold, the consultant axis — D1 is registry data only.

---

### S9 — Prompts, skills, docs (Cluster E, methodology-gated)

**Binding constraint (names the gate; edits happen in the build):** before any prompt/tool/result/error/skill wording, read and follow `docs/prompting-and-tool-design.md` + `docs.local/prompt-engineering/SKILL.md`, and `docs.local/writing-great-skills/SKILL.md` for skills.

**Which surfaces learn what:**
- **Orchestrator prompts** (`orchestrator-prompts.ts`): the impl entry brief's compaction step (~`:490`) learns the `/compact`-failure → fresh-session + `recover-context` fallback; the system prompt learns the `afk` posture.
- **Tool result/error wording**: C's split and B's compact-recovery prescription follow convention 4 (name the layer, prescribe the next safe action, no false certainty).
- **Skills** (coherence-pinned by `tests/skill.test.ts`): `skills/duet-frame` learns the `afk` launch posture; `skills/duet-concierge` + `.claude/skills/onboarding/SKILL.md` learn the resilience behaviour and the completed ladder.
- **Docs, homed by kind:** runtime/API facts (native-vs-own balance, the watchdog, the env vars, the two retry planes) → `docs/engineering.md` + `docs/automation-design.md`, **version-stamped** ("verified against claude 2.1.196 — re-check on upgrade"); `docs/prompting-and-tool-design.md` carries only the *wording consequence* (C's honest result/error text); `docs/snippets.md` gets the `recover-context` entry.
- **The advisory wording stances:** the honest watchdog-vs-wall-clock framing (note 1); caffeinate as **best-effort** + the user-expectation note (note 2); the `afk`-vs-`gateless`-differ-only-with-a-consultant honesty note (note 4).

**Tests.** `tests/skill.test.ts` (any flag the skills name — incl. the `afk` preset — exists on the command table); `tests/snippets.test.ts` (the `recover-context` entry). Prose edits are not unit-tested.

**Leave alone.** `prompts/orchestrator-identity.md`'s mid-phase-bail teaching — **D2 is out of scope** (the interactive identity gets no mid-phase-drop wording). And the default-off guarantee (the spec's corrected wording): consultant-specific text stays gated; resilience wording is behavior-linked and does not change old retry-off run semantics.

---

## Spec deltas this plan introduces (surface at plan review)

Per *docs lead, code follows* — these revise spec wording and should be reconciled when the plan is approved:
1. **The cap number.** The spec defers the value; this plan pins **90 min** (measured), explicitly **not** the 180 the spec floated — the corpus shows 60 was already ≈2× the longest healthy turn, so 90 (3×) is the disciplined high-end pick. The spec's Cluster A cap bullet should be updated to cite 90 + the measurement.
2. **caffeinate framing.** The spec's Cluster A bullet calls caffeinate "the *primary* sleep-prevention lever"; this plan reframes it as **best-effort** (advisory 2) — a closed lid on battery sleeps regardless, landing on the wall-clock backstop. The spec bullet should soften to match its own "bounded-waste-then-recover" promise.
3. **rir's `implement` cap.** The spec names only full's `impl`; this plan also bumps rir's `implement` (60→90), since the measurement spans both arcs and leaving them split is unmotivated.

None changes a settled decision — they pin numbers the spec deferred and correct one framing word; all at the spec's own altitude.

## Out of scope / non-goals (held)

D2 (mid-phase bail) — dropped. No duet activity-based stall detector. No metered-transport-specific retry cap and no per-retry cost attribution (advisory 3, deferred). The undocumented idle-timeout env vars stay unused. Invariants intact: never-automated merge, no-daemon, un-forgeable gate-crossing, cooperative-pause / crash=flag, consultant default-off byte-for-byte, one-branch-per-run, two-provider limit, worker-budget-per-turn-opt-in.

## Verification

`pnpm typecheck` + `pnpm test` green per slice (one slice per commit). The live `API_FORCE_IDLE_TIMEOUT` probe is the only environment-only step — designed testable at the `WorkerProvider`/`FakeWorker` seam (S2/S3), with the live probe left as a documented manual step for the human.
