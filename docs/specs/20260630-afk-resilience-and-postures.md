# AFK resilience & postures

**Status:** Design spec. **Date:** 2026-06-30. **Branch:** `feat/afk-resilience-and-postures`.
Evidence base: [`.duet/afk-resilience-findings.md`](../../.duet/afk-resilience-findings.md) (verified Claude Code API facts + run-log provenance — re-check the raw sources before trusting a summary line). Ships as **one PR**, all clusters together.

## Summary (the leader-facing read)

**What we're hardening.** duet's whole point is the overnight-AFK center: walk away after the spec, return to an open PR. Today four failure modes quietly break that promise. A streaming Claude turn can stall and never recover (the native byte-stream watchdog isn't forced on). The per-turn timeout is *monotonic*, so an overnight machine-sleep freezes the countdown with the process — one audited run's "60-minute" cap mapped to **117 minutes** of wall-clock, and the run died (`7447`, ~5.5h lost, no code written). A hung `/compact` rides that same long cap instead of failing fast. And when a turn *is* killed after it committed work, the orchestrator is told the literal opposite of the truth — *"the worker never saw your prompt, retry verbatim"* — which the `7447` driver.log shows verbatim after a 117-minute turn. This run makes those modes **bounded, explicit, and resumable**, and completes the launch posture ladder with the one missing rung.

**The approach.** The architecture is a deliberate **native-vs-own partition**: lean on the *documented, stable* Claude Code knob (`API_FORCE_IDLE_TIMEOUT` — the native stream watchdog) for stall detection duet can't cleanly reproduce, and own only the **load-bearing backstop** a CLI flag can never cover — a wall-clock deadline, plus sleep-prevention where the OS allows it. Five clusters land together: **A** resilience backstops, **B** compaction robustness, **C** an honest failure-result split, **D1** a full-arc attend-none launch posture, **E** the prompts/skills/docs that teach the new behavior. Evidence strength (the demonstrated core vs. the precautionary tuning) is the *sequencing lens within the PR* — the optimal implementation order and commit structure are the plan's call, not this spec's.

**The boundary once it lands.**

- **Fixed:** a stalled stream aborts in ~5 min (watchdog). Recovery then splits by **plane** — a **worker** turn that fails is handed an honest, prescriptive result and the orchestrator routes its recovery (resume / re-send / flag), while the **orchestrator's own** stalled or dropped session self-heals by mechanical retry (the plane `--retry-infra` governs). An overnight sleep is prevented where the OS allows and otherwise bounded in real time, not monotonic; a hung `/compact` fails in minutes and re-anchors a fresh session; the orchestrator is told the truth about retry-verbatim vs. resume-don't-resend; auto-retries are *recorded*, never silent; the posture ladder gains `overnight → skip-plan → afk → gateless`.
- **The honest promise:** a transient outage or an overnight sleep degrades to **bounded-waste-then-recover** — *not* "never waste hours." `caffeinate` prevents the sleep where it can; the wall-clock cap bounds the waste on wake; Cluster C makes a cap-hit a resumable checkpoint, never a loss. The worst case is wasted compute, not a dead run.
- **Not fixed / deliberately not built:** no duet activity-based stall detector — measured legit pure-reasoning turns run silent up to ~29.5 min, overlapping the stalled range, so only *stream* idleness separates them, and that signal is native (build nothing here); the undocumented `CLAUDE_STREAM_IDLE_TIMEOUT_MS` / `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` vars stay best-effort, never load-bearing.
- **Dropped from scope:** **D2, the mid-phase bail** — a mid-phase headless drop re-drives the current phase in a *fresh* SDK session, discarding the interactive session's discussion history; the human ruled that "augment, never surprise" violation unacceptable. A decided non-goal for this run, not an open question. (D1 covers the launch-time half of the ladder; walking away at any *gate* already works via `duet afk`.)
- **The exact cap number is deferred to the plan** — derived from the corpus (below), not asserted here.
- **Invariants kept intact** (this work brushes several; none move): the never-automated merge; the no-daemon / nothing-runs-between-stops model; un-forgeable gate-crossing (no tool emits `human.*`); the cooperative-pause and crash=flag guarantees; consultant default-off byte-for-byte; one-branch-per-run; the two-provider limit; worker-budget-is-per-turn-opt-in (the retry default below mirrors its materialization discipline exactly).

---

## Foundation: two bounded reshapes first

Two clusters (A's wall-clock backstop, B's compact cap and fresh-session fallback) want capabilities the worker seam doesn't currently admit. Both are small, sized to this feature, and worth doing as the opening moves so the cluster work reads as a natural addition rather than a workaround.

1. **A per-turn timeout on the `WorkerProvider` seam — a provider-wide interface.** Today the timeout is frozen at construction: `createWorkers(bindings, { workerBudgetUsd, timeoutMs })` sets one `timeoutMs` per *phase* (`src/providers/index.ts:22`), and `RunTurnOptions` (`src/providers/types.ts:78`) carries no per-turn override. Add an optional per-turn `timeoutMs` to `RunTurnOptions`, and make it a **contract every provider honors** — claude, the interactive-claude transport, and **codex** alike (the implementer can be codex; roles are provider-decoupled), so `/compact`'s short cap and the wall-clock bound apply on whatever transport runs the turn, never one only. Each provider enforces the effective cap as a **wall-clock (Date-based) deadline** (claude's monotonic execa `timeout` gains the Date guard; the interactive transport already is Date-based; codex honors the same contract). This single knob serves **both** A (the wall-clock backstop) and B (the `send_prompt` handler hands `/compact` a short cap without a special provider). Kept deliberately separate: the **watchdog env is Claude-only** — `API_FORCE_IDLE_TIMEOUT` is a Claude API knob and must not leak into codex. Left alone: the per-phase default stays the construction-time value; only turns that ask get a different cap.
2. **A harness-driven worker-session reset, on the shared failure path.** There is no mechanism to start a *fresh* session for a persistent role mid-phase: `sessionIdFor(implementer)` always returns `workerSessions[implementer]` (`src/roles.ts:51`); only the consultant seeds fresh, via the `ephemeral` policy datum. B's compaction fallback needs the implementer's *next* turn to start clean, so the harness clears `state.workerSessions[implementer]` and the next `send_prompt` seeds fresh through the existing `sessionIdFor → undefined → mint` path. Two guards keep the reset correct rather than blunt: (a) it fires **only for an *accepted-but-failed* compact** — the prompt reached the session (C's proof below) — never for a pre-flight auth/connect/ENOENT failure, where the old session never saw the compact and is still the right one to compact; (b) it is attached to the **shared settled/collected worker-failure path both hosts flow through** (`settleTurn`/`renderTurnResult`), not a free-standing state write, so the async interactive lifecycle is preserved (a failed compact stays collectible, `pendingTurns` clears only on `check_turns`, and the next send still respects the orphan / in-flight rails). This is **harness-driven, not a new orchestrator tool**: the orchestrator stays a router with no session-lifecycle lever. Left alone: the consultant's ephemerality, the persistent roles' normal turn-to-turn resume, the `roles.ts` policy table.

---

## Cluster A — Resilience backstops

**Current → desired (the failure-mode → handler map).** The native-vs-own partition, and — the split Finding 1 forces us to name — recovery differs by **which plane** failed:

```
WORKER turns (send_prompt — implementer / reviewer / consultant):
  a stalled stream → NATIVE watchdog aborts (~5 min) → the turn FAILS → the
  orchestrator is handed C's honest, prescriptive result and ROUTES recovery
  (resume / re-send / flag; a failed /compact → B's fresh session). NOT mechanical —
  duet never auto-loops a worker turn; recovery is orchestrator-directed via the
  result text. (Same path for a connect failure the native 10× backoff exhausts.)

ORCHESTRATOR's own session / the phase host:
  a stalled or dropped orchestrator connection throws out of the SDK turn →
  runHostedPhase catches → classified → MECHANICALLY auto-retried on the headless
  host (retryDecision). This is the plane `--retry-infra` governs; the stdio /
  interactive host classifies-but-hands-back (a human is present there).

PHASE-LEVEL (both planes): caffeinate prevents the overnight sleep where the OS
  allows; the per-turn wall-clock cap bounds a frozen turn's waste on wake (monotonic
  can't); the QUIESCENCE_TIMEOUT_MS soft-fail bounds the whole phase as crash=flag.
```

What changes, concretely:

- **Force the watchdog on.** Inject `API_FORCE_IDLE_TIMEOUT=1` at every Claude connection: the headless worker spawn (`claudeExecaOptions`, `src/providers/claude.ts:307`, which has no `env` field today and inherits `process.env`), the orchestrator's own SDK session (`buildOrchestratorOptions`, `src/harness/driver.ts:185`, which already injects an `env`), and the interactive transport's launched `claude` (`src/providers/pane.ts:64` — applied at the launched command / tmux session env, **not** parent-process inheritance, since tmux may reuse a stale server environment).
- **Own a wall-clock backstop** at the `WorkerProvider.runTurn` seam, in each provider implementation (first concrete site: claude's execa path, `src/providers/claude.ts`): a **Date-based** deadline alongside execa's monotonic `timeout`, so an overnight-suspended turn is bounded in *real* time — on wake the deadline correctly sees the elapsed wall-clock and kills promptly, where the monotonic timer would have counted only awake time. Reads the effective per-turn cap from the foundation knob above.
- **`caffeinate` is first-class on darwin.** Hold the system awake for the detached driver's lifetime (scoped to the driver pid, so it never keeps the machine awake past the run), in `spawnDrive` / the `_drive` lifecycle (`src/harness/lifecycle.ts`). This is the *primary* sleep-prevention lever on the platform we run on; the wall-clock cap is the *portable backstop* for when it's absent or killed. Clean no-op off darwin.
- **Default-on bounded infra retry, recorded — the orchestrator/host plane.** This default governs the *second* plane above (the orchestrator's own session crashing mid-phase, caught by the phase host) — *not* worker-turn failures, which the orchestrator routes. The machinery is already built and consulted only on the retryable headless host (`retryDecision`, `src/worker-health.ts:128`; gated by `host.retryable`, `src/harness/host-runner.ts:140`). Flip the *default* — but via **materialization at `createRun` for new runs only** (the discipline `gatesAt` already uses, `src/run-store.ts:468`): a new run persists an explicit retry budget; an absent/old `retryInfra` stays off, byte-for-byte. Every auto-retry is **recorded in the same "while you were away" review section** that carries auto-crossed gates — but in **its own representation, not the gate-shaped `autoApprovals`** (`{ gate, at }` + a packet headline, `src/status.ts:378`): a retry has no gate and no packet, so forcing it into that field would lie. A sibling ledger (an `autoRetries`, or a discriminated away-events list — the shape is the plan's) keeps the morning review honest and recovered-*visible*, so a degrading environment surfaces instead of churning silently (the "never silent churn" property that motivated default-off).
- **A wall-clock-honest impl cap, value derived (not asserted).** The impl per-turn cap (`workerTurnTimeoutMs`, `src/phases.ts:222`, today `60 * 60_000`) becomes a real-time bound. Its **value** is derived from the observed *healthy total-turn-length* distribution — roughly **2–3× the longest healthy turn** — with the fail-fast tradeoff named: a looser cap trades **more worst-case waste on the one failure the watchdog can't see** — a turn that streams tokens but makes no progress (an infinite tool-loop reads as "alive" to a stream-idle watchdog). The plan fixes the number from the corpus (note: the input metric is *total turn length*, which the corpus may need measured — the findings' 11-min / 29.5-min figures are quiet-*gaps*, not turn durations). Every audited 60-min-cap hit was a *failure*, not a legit turn wrongly killed, so the raise is precautionary; and post-C a cap-hit is a resumable checkpoint, so the cost of erring low is resume-churn, not loss.
- **Fix the phase-level outer timeout.** `driveToQuiescence` wraps the whole phase in a 6-hour monotonic `waitFor` (`QUIESCENCE_TIMEOUT_MS`, `src/harness/lifecycle.ts:49`, `:414`); on timeout it rejects, the `_drive` process dies, and the run strands — part of the `7447` dead-run pattern. Convert this from an **uncaught kill into crash=flag**: a timeout queues an actionable question with a next command (the universal "every stop has a next command" rule), never a silent death. Raise it too, sized above a realistic worst-case phase (several derived-cap turns plus bounded retry backoff), so a legitimate long overnight impl phase doesn't hit it spuriously — but the *soft-fail* conversion is the load-bearing half, not the number.

**Coupling decision.** A is mostly **independent additions** at existing seams (the spawn env, the provider's run loop, the lifecycle), plus one **extension** — the retry default extends the existing opt-in `retryInfra` policy by materializing a new default value, reusing `retryDecision` and the existing "while you were away" *section* (with its own ledger entry beside `autoApprovals`, per the bullet above — not the gate-shaped field itself).

---

## Cluster B — Compaction robustness

**Problem.** `/compact` is just another `send_prompt` whose body starts with `/compact`; it inherits the phase's long cap, so a hang rode 5.5h in `7447`. Every healthy compaction is 2–3 min. With A forcing the watchdog on, a hung `/compact` now fails in ~5 min — but a *failed* compact leaves the session **un-compacted and bloated**, so resuming it (the generic recovery) is exactly wrong, and re-anchoring needs a fresh session.

What changes:

- **A short, dedicated `/compact` cap.** The `send_prompt` handler (`src/harness/tools.ts`) recognizes a `/compact` body (the provider already special-cases it, `src/providers/claude.ts:221`) and passes a short per-turn `timeoutMs` (~5–10 min) via the foundation knob — so `/compact` never rides the impl cap.
- **A fresh-session fallback re-anchored by `recover-context`.** On an **accepted-but-failed** `/compact` turn (C's proof — not a pre-flight failure), the harness resets `workerSessions[implementer]` along the shared settled-failure path (foundation #2) so the next implementer turn seeds fresh, and the failure result prescribes the orchestrator send a new snippet — working name **`recover-context`**: an orchestrator-authored project/status overview (what we're building, what's committed and green, what's left, the load-bearing seams) **plus** `reread-context` — not a bare reread. A fresh session is *sound, not a loss*, at both compaction boundaries: at plan→impl the implementer holds only the planning arc and the committed spec+plan files carry the design; at build→review the "what's committed/green/left" overview plus git is the re-anchor. The snippet's frame names its **narrow trigger** — use after a failed compact / fresh-session recovery, *not* as a generic reread (that is `reread-context`'s job) — since the tool-result text is its primary trigger surface.

**Coupling decision.** The compact cap is an **extension** of the existing per-turn-timeout knob (foundation #1). `recover-context` is an **independent** new library snippet, classified as an `ANYTIME_SNIPPETS` cross-cutting helper (`src/phases.ts:608`) — its body is a frame the orchestrator concretizes per-run, consistent with the template-economy model. The fresh-session reset reuses the existing `sessionIdFor → mint` path (foundation #2), not a new tool.

---

## Cluster C — Honest failure-result split

**Current → desired (a worker turn's failure handling).** The fork already models the honest pattern *three times* — only the catch-all lies:

```
Current — renderTurnResult / recoverClaudeFailure:
  BudgetCutoffError (no session)        → "budget stop; work may be on disk; don't infra-retry"   ✓ honest
  WorkerTurn.budgetTruncated (session)  → "checkpoint; resume; don't re-send"                      ✓ honest
  WorkerTurn.interrupted   (session)    → "connection dropped mid-response; resume; don't re-send" ✓ honest
  bare Error (everything else, INCLUDING
    a 117-min timeout-kill that committed→ "the worker NEVER SAW your prompt; retry verbatim"       ✗ FALSE
    files and git)                          (the demonstrated 7447 lie)

Desired — split the catch-all by whether the PROMPT WAS ACCEPTED into the session:
  Error, prompt ACCEPTED + turn aborted → "the worker ran to its cap; its session is resumable and
    (the 117-min timeout-kill case)        committed work may be on disk — resume, don't re-send"   ✓ honest
  Error, prompt NEVER accepted          → "the worker never saw your prompt — retry this same
    (pre-flight ENOENT/auth/connect, or    send_prompt once"                                        ✓ now correct
     only startup/system records, or no
     transcript located)
```

The branch condition is the technical call, settled — and Finding 2 sharpened it: the proof is **the prompt was accepted into the session** (the user message is recorded, or later assistant/tool activity exists), *not* "a session id was minted" and *not* merely "a transcript file exists." A headless claude session id is minted *before* the process proves it ran (`src/providers/claude.ts:373`), and a transcript can carry only startup/system records — neither proves the worker *acted*, which is exactly what makes re-sending dangerous (a duplicated, corrupted conversation). So the typed provider outcome is named for the **proof, not the symptom**: "prompt accepted, turn aborted" (resume) vs. "never accepted" (retry verbatim). `timedOut`/abort is the trigger to investigate; the *branch* is whether the session shows the prompt accepted — three-way: accepted + aborted → resume; only preflight/system records → retry verbatim; no transcript located → retry verbatim. Surfaced from the provider as a typed outcome (the shape `interrupted`/`budgetTruncated` already use) and rendered by `renderTurnResult` (`src/harness/tools.ts:451`).

**Coupling decision.** C **extends** the existing budget/`interrupted` "resume, don't re-send" model to the accepted-but-aborted case (the timeout-kill) — the same vocabulary, one more arm. It is the message layer for the new failure modes A and B produce (a wall-clock kill, a failed compact), which is why it ships in the same PR rather than as a standalone cleanup.

---

## Cluster D1 — Full-arc attend-none launch posture

**Problem.** The ladder has a gap. `overnight` attends `frame,spec`; `--gateless` attends nothing *but also* drops the consultant's holding bet-audit. There is no launch posture for "walk away from the start, keep **every** safety net." That state already exists and is exercised (bare `duet afk` mid-run; rir's `afk: []`) — full simply lacks the launch surface.

What changes: add an **`afk: []` preset to the full workflow** (`presets`, `src/phases.ts:264`), mirroring rir's. `duet new --gates-at afk` (and the parse path, `parseGatesAt`, `src/framing.ts:360`) then yields `gatesAt: []` with `gateless` *off* — completing `overnight → skip-plan → afk → gateless`. Everything downstream already handles it: `createRun`'s `?? defaultPosture` preserves an explicit `[]` (`src/run-store.ts:468`), `gateAttended` reads `[]` as attend-none (`src/run-store.ts:339`), the severity hold still fires, and `consultantCheckpointLive(phase, { gateless: false })` keeps **both** the holding `challenge` bet-audit and the backstop (`src/phases.ts:720`). So `afk` is precisely the missing rung: attend nothing, every net intact.

**Coupling decision.** Pure **registry data** — no new logic, no statechart change. The one honesty note for Cluster E: `afk` and `gateless` differ *only when a consultant is bound* (otherwise both collapse to attend-none); the docs/skill must say so or a solo dev sees four postures that read as two.

---

## Cluster E — Prompts, skills, docs (methodology-gated)

**Binding constraint — read the methodology first.** Before *any* prompt, tool description, tool result, error message, or skill wording is designed, the relevant methodology reference is read and followed: [`docs/prompting-and-tool-design.md`](../prompting-and-tool-design.md) + [`docs.local/prompt-engineering/SKILL.md`](../../docs.local/prompt-engineering/SKILL.md) for prompts/tools/results/errors, and [`docs.local/writing-great-skills/SKILL.md`](../../docs.local/writing-great-skills/SKILL.md) for skills (fallbacks under `~/dotfiles/.../skills/` if `docs.local/` is absent). No freelanced prose conventions. The reading happens at impl time; this is the scope rule, not the edits.

What learns the new behavior (the *which*, not the per-file edit plan):

- **Orchestrator prompts** (`src/harness/orchestrator-prompts.ts`) — the impl entry brief's compaction steps (~`:490`) learn the `/compact`-failure → fresh-session + `recover-context` fallback; the system prompt learns the new `afk` posture. (The interactive identity, `prompts/orchestrator-identity.md`, gets no mid-phase-bail teaching — D2 is out.)
- **Tool result / error wording** — C's split message and B's compact-failure prescription follow convention 4 (name the failure layer, prescribe the next safe action, no false certainty).
- **Shipped skills** — `skills/duet-frame` learns the new launch posture; `skills/duet-concierge` and `.claude/skills/onboarding/SKILL.md` learn the resilience behavior and the completed ladder. All three are coherence-pinned by `tests/skill.test.ts`, so any named flag must exist on the command table.
- **Docs** — fold the **verified Claude Code API lessons into permanent project knowledge**, **version-stamped** ("verified against claude 2.1.196 — re-check on upgrade") so CLI-version-specific facts don't ossify. Home them by *kind*: the runtime/API facts (the native-vs-own balance, the watchdog, the env vars, the two retry planes) live in `docs/engineering.md` (the seams / mental-model home) and `docs/automation-design.md` (the resilience layers + the new posture), while `docs/prompting-and-tool-design.md` carries only the *consequence for wording* (the honest result/error text C produces) — so it stays a prompt reference, not a mixed runtime manual. Plus `docs/snippets.md` + `tests/snippets.test.ts` (the `recover-context` entry). Keep edits behavior-linked and small.

**Coupling decision.** Pure documentation/prompt work; the load-bearing rule is the methodology gate above and the default-off-byte-for-byte guarantee — consultant-specific text stays gated, and resilience wording is behavior-linked and does not change old retry-off run semantics.

---

## Testing — behaviors and seams (cases are the plan's)

Name the behaviors that matter and where they're exercised; specific cases, fixtures, and mocking boundaries are the plan's.

- **The wall-clock backstop and the per-turn `/compact` cap** — at the `WorkerProvider` / `FakeWorker` seam: a turn that exceeds its (per-turn) wall-clock deadline is killed and surfaces as the right typed outcome; a `/compact` turn gets the short cap, not the phase cap.
- **C's honest split** — at the same provider seam: a turn whose prompt was *accepted then aborted* renders "resume, don't re-send"; a pre-flight failure (prompt never accepted) renders "never saw your prompt, retry verbatim." (The `7447` shape is the canonical case.)
- **The compaction fresh-session reset** — at the seam: an *accepted-but-failed* `/compact` clears the implementer session so the next turn seeds fresh, while a *pre-flight* `/compact` failure does **not** (the old session is still the one to compact).
- **Default-on retry, recorded** — the materialized-for-new-runs-only default (old/absent stays off), and that each auto-retry lands in the "while you were away" review under its own representation (not the gate-shaped `autoApprovals`).
- **The phase-timeout soft-fail** — the quiescence timeout produces a crash=flag with a next command, not an uncaught process death.
- **D1** — the registry/posture coherence tests (`tests/machine.test.ts`, `tests/phases.test.ts`): `afk` resolves to `[]`, `gateAttended` reads attend-none, the consultant stays full (challenge + backstop) since `gateless` is off.
- **`recover-context`** — `tests/snippets.test.ts`: the new key is classified (no silently-invisible snippet), no personal-path leak.
- **Environment-only — flag, never attempt:** the *live* watchdog probe (`API_FORCE_IDLE_TIMEOUT=1` + a tiny idle timeout + a real `claude -p` turn, confirm it aborts on an induced stall) needs real auth and a live API call. Design the behavior testable at the `WorkerProvider` seam with `FakeWorker`; leave the live probe as a documented manual step for the human (likewise any auth/network/account action).

---

## Open notes for the plan (not blocking this gate)

- **The cap number's input metric.** The corpus figures cited in the findings are quiet-*gaps* (11 min with tool activity, 29.5 min pure-reasoning) — those size the *rejection of an activity-based stall detector*, **not** the cap. The plan must derive the cap from the *total healthy worker-turn duration* distribution — **excluding known failures and excluding `/compact` turns** (which now have their own short cap) — and choose from the **high end** (≈2–3× the longest healthy turn), measuring total durations if the corpus doesn't already carry them.
- **Sequencing within the PR.** The demonstrated core (force watchdog, wall-clock cap + phase-timeout soft-fail, honest message) is lower-risk than the precautionary tuning (the cap value, the compaction fallback); that evidence-strength ordering is a lens for the plan's commit structure, but everything lands in this one PR.
