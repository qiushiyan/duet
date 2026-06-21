# Async `send_prompt` for the interactive orchestrator host

- **Date:** 2026-06-21
- **Branch:** `feat-async-mcp-tools`
- **Status:** approved at the Direction gate (A′ chosen; B deferred; C declined)
- **Scope:** the interactive Claude-Code-as-orchestrator host only

## Summary

When the orchestrator is a live interactive Claude Code session (`duet orchestrate` / `duet new --interactive`, over FRAME → SPEC → PLAN), every `send_prompt` freezes that session for the full length of the worker turn — 1 to 11 minutes in the evidence run, ~64 minutes of hard block across 15 calls. The session is the human's only channel to the orchestrator, and that channel is the product's entire reason for existing ("the conversation is the channel," `prompts/orchestrator-identity.md`). While a worker turn runs, you cannot talk to the orchestrator, steer it, ask it for status, or have it fire the other worker.

**The fix (A′ — in-process fire-and-collect).** On the interactive host, `send_prompt` dispatches the worker turn as a background promise held in the run-scoped MCP server and returns immediately; the session stays responsive while the turn runs. The turn's durable bookkeeping (session id, cost, review round) commits automatically when the worker finishes (the *settle* event); a new, strictly-instant `check_turns` tool then delivers that result into the conversation — the worker's text plus any pending steers — and reopens the role. The headless AFK driver (`_drive`) keeps its blocking `send_prompt` untouched — this is a host switch inside the one shared tool registry, not a fork of the tool surface.

**What this lands.** The interactive orchestrator session is responsive throughout a worker turn: converse, `duet steer`, `duet status`, and fire the other role, all while a turn runs. Every existing rail and all bookkeeping survive, relocated to wherever the turn now completes. Headless behavior is unchanged.

**What it does not do, and why.**
- **Survive a session quit mid-turn.** A turn in flight lives in the session's MCP server process; quitting the session loses the captured result (and likely interrupts the worker — see Risks). This is the explicit trade A′ accepts for the attended arc; the robust alternative (**B**, a detached child per turn) is **deferred behind a trigger**.
- **Auto-recover a finished-but-uncollected turn's result from the transcript on reconnect.** We include cheap *detection and repair* of an orphaned turn; we **defer** reconstructing the worker result from the on-disk transcript to auto-run the finalizer (a second, provider-specific parser for a narrow window — see The reconnect evaluation).
- **C (bounded-blocking single tool)** and an **in-tool `wait_ms`** are **declined**: both reintroduce the freeze and make responsiveness prompt-enforced.

## Problem

The cause is one `await` in one handler. On the interactive host the human's `claude` session connects to the run-scoped, phase-less stdio server `duet _mcp <runId>` (`src/harness/mcp-server.ts`, `createRunScopedKernel`). Every tool call rebuilds the tool surface against fresh disk state while preserving the per-phase `ctx` (providers + the in-memory rails) in the long-lived server closure. The `send_prompt` handler (`src/harness/tools.ts`) runs its pre-flight rails, then `await provider.runTurn(...)`, and only returns the worker's text as the tool result when the worker subprocess exits. A Claude Code assistant turn cannot yield while a `tool_use` is outstanding, so for the entire await the session is frozen inside that one unresolved call.

MCP progress notifications cannot fix this: the call is still outstanding, so the session is still frozen. Only the tool *returning promptly* frees the session. The existing 5-minute heartbeat keeps the *voice log* visibly alive precisely because the turn is long, but does nothing for the session — that is the gap.

The freeze is host-specific. The headless driver (`src/harness/driver.ts`, `drivePhase`) hosts the same handler inside an in-process Agent SDK stream and blocks on the same await — but there blocking is *correct*: `_drive` is a detached background process with no live chat channel to keep responsive; it drives a phase to quiescence and exits. So the synchronous handler hosts an assumption ("the host can afford to block") that holds headless and fails interactive. The host-neutral kernel was built for exactly this kind of per-host divergence; this is that seam used once more.

## Goals / non-goals

**Goals.** On the interactive host: `send_prompt` returns before the worker turn completes; the session is responsive throughout; a later `check_turns` pulls the result in with every rail and all bookkeeping intact; steering, status, and cross-role dispatch work mid-turn. Headless `_drive` keeps blocking `send_prompt` byte-for-byte.

**Non-goals.** Surviving a mid-turn session quit (that is B). A second concurrency subsystem (detached children, result files, prompt staging). Any change to how gates cross, how steers are stored, how crash=flag works, or how review rounds are counted against the backstop caps — those are preserved, only relocated.

## The design (A′)

### A host switch, not a tool-surface fork

`createPhaseTools` stays the single registry that both hosts build from. A host flag toggles two things: *how `send_prompt` completes* and *whether `check_turns` is exposed*. The headless host runs the whole turn — dispatch, settle, collect — in one blocking call and has no `check_turns`; the interactive host splits those three across `send_prompt` (dispatch + launch) and `check_turns` (collect), with settle firing automatically when the background promise resolves. The bookkeeping operations are the same code on both — parameterized by host, not duplicated — so this is a host switch, not a fork of the surface.

### Current vs. desired: the `send_prompt → result` path (interactive host)

Current — one call, frozen throughout:

```
send_prompt(role, tag, body)
  pre-flight (sync): same-role guard add · cap & warn-once checks · voice-log ◀ · markTurnActive · start heartbeat
  await provider.runTurn(...)                  ← SESSION FROZEN, whole worker turn
  completion: load→merge→save (session id · round · sent-snippets · cost/tokens/context · lastActivity)
              · voice-log ▶ · near-cap nudge
  finally: guard clear · clearTurnActive · stop heartbeat
  return { worker text (+ pending steers) }
```

Desired — dispatch returns immediately; collection is a separate, instant call:

```
send_prompt(role, tag, body)                   ← returns at once; session STAYS LIVE
  dispatch (sync): create pending record (running) · set durable branch-fixed flag (one-way) · same-role guard add
                   · cap & warn-once checks · voice-log ◀ · start heartbeat
  launch background promise: provider.runTurn(...)   (held in ctx)
  return { "dispatched to <role>, running in the background — pull it with check_turns" }

  ── settle (background promise resolves/rejects) ──
  record → ready|failed · stop heartbeat
  commit durable: session id · round (success only) · sent tag (success only)
                  · cost/tokens/context · lastActivity · voice-log ▶

check_turns()                                  ← strictly instant
  for each role whose record is ready|failed:
    deliver worker text (or the infra-error for failed) · near-cap nudge
    · release same-role guard · mark record collected
  append pending steers (phase-continuing result, the existing steer surface)
  report each still-running role with elapsed
```

Headless is unchanged: `send_prompt` runs dispatch → settle → collect in immediate succession inside the one blocking call (no record persists); `check_turns` is never reached because no turn is ever left in flight.

### The pending-turn lifecycle (the interactive host's spine)

Async splits one synchronous call into a tracked lifecycle, modeled explicitly rather than smuggled into the existing `activeTurns` hint. A **pending-turn record** — owned by the interactive `ctx`, with a small durable projection on disk — carries a dispatched turn through three transitions. The states are conceptual here; the exact fields (and how much projects to disk) are a plan/Q16 concern, not fixed by this spec. The record carries at least the role, the source tag, the start time, and a status.

States: **running** → **ready** | **failed** → **collected** (removed).

- **dispatch** — `send_prompt` fires and returns. Create the record (`running`) and run the dispatch-time rails: take the same-role guard, voice-log the prompt, start the heartbeat. The cap and warn-once template-economy *checks* run here too. Nothing is committed to the run's durable bookkeeping yet.
- **settle** — the background worker promise resolves or rejects (the *worker-settled* event). Stop the heartbeat; flip the record to `ready` (success) or `failed` (infra error). Commit the turn's **durable** bookkeeping now: the new worker session id, cost / tokens / context, the review-round count (success only — a `failed` turn counts as no round, today's semantics), the sent-snippet tag (success only — see Retry below), last activity, and the voice-log response line.
- **collect** — `check_turns` consumes a settled record (the *result-collected* event). Deliver the worker's text (or, for `failed`, the existing prescribed-recovery error) to the orchestrator; append the near-cap nudge when this round leaves one before the cap; deliver any pending steers (the existing `withSteerDelivery` surface); release the same-role guard; mark the record `collected`.

| Event | Durable / persisted | Orchestrator-facing |
|---|---|---|
| **dispatch** | record `running`; durable branch-fixed flag (one-way); voice-log ◀ prompt; start heartbeat | same-role guard add; cap & warn-once *checks* |
| **settle** (worker-settled) | record `ready`/`failed`; stop heartbeat; session id, cost / tokens / context, round count (success only), sent tag (success only), last activity, voice-log ▶ | — |
| **collect** (`check_turns`) | record `collected` | deliver text (or infra error); near-cap nudge; steer delivery; guard release |

On the **headless host** the three transitions run in immediate succession inside the one blocking `send_prompt` call — no record persists, the worker-settled and result-collected events coincide, and behavior is unchanged.

**Why settle and collect are distinct events (point 4).** If heartbeat-stop and the durable merge waited for `collect`, a worker that finished at 6 minutes but was not yet collected would keep logging "running — 12m elapsed" and hold its session id and cost uncommitted. Stopping the heartbeat and committing the durable bookkeeping at settle keeps the voice log and `duet status` truthful the instant the worker finishes, independent of when the orchestrator collects. Persisting the session id at settle is itself load-bearing: it is the only handle to the worker's conversation, and losing it would orphan a resumable session. Only the orchestrator-facing delivery (text, steers, guard release) waits for `collect`.

**Retry semantics are preserved by committing the sent tag at settle, not dispatch (point 1).** Today the sent-snippet tag is recorded only after a *successful* turn, and an infra failure returns "retry this same `send_prompt` call once." Committing the tag at dispatch would make that prescribed retry trip the duplicate-template warning — so the tag commits at **settle, success only**, exactly as today. The duplicate-template rail needs nothing earlier: the same-role guard already refuses a second send to a role with a `running` or settled-uncollected record, so a same-role re-send can never reach the warn-once check while a turn is outstanding. (This is why I don't follow the review's suggestion to route duplicate refusal through a "pending dispatched tag" — the guard already serializes same-role sends, so the only thing that must move earlier is the branch-fix fact, below.)

**The branch-fix fact is the one thing that moves to dispatch — and it is durable and one-way.** `create_branch` is legal only before the first worker prompt; today it reads `state.workerSessions.*`, written at settle, so under async it would stay wrongly legal during the dispatched-but-uncollected window. Refuse `create_branch` once the first turn has been **dispatched**. This must be a durable "a worker prompt has been dispatched" flag, set at the first dispatch and **never cleared** — *not* "a pending record exists," because records are removed at `collected`, so a first turn that fails would clear its record and wrongly reopen branch creation. A failed dispatch does **not** reopen it: the worker process may already have acted on the branch, and the one-branch-per-run invariant fixes the branch the moment any worker is prompted, success or not. This flag is the only dispatch-time persistence required.

This whole lifecycle is the coupling decision: A′ models the pending turn as a first-class concept owned by the existing per-phase `ctx`, over the promise-shaped `WorkerProvider.runTurn` seam, and does not stand up a parallel mechanism (no detached children, no result files — that is B).

### Same-role guard: held by the pending-turn record, dispatch → collect

Today the guard (`turnsInFlight`) is a binary in-memory set, added before the await and cleared in `finally` within one call. Under async it is held by the pending-turn record's state: `send_prompt` to a role is refused while that role's record is **running** *or* settled-uncollected (**ready**/**failed**) — one session is one conversation, and a parallel resume would race it. The guard clears only at **collect**, when `check_turns` consumes the result — not at settle when the worker process finishes — because the orchestrator must read the prior answer, and the session-id merge must have landed, before that worker's conversation continues.

Cross-role dispatch stays concurrent: independent turns to the two roles run in parallel. Under async this no longer depends on emitting both `send_prompt` calls in one message — two sequential instant dispatches already overlap — which reduces reliance on the `readOnlyHint` CLI-scheduler concurrency hint (the hint stays; the dependence weakens).

### Phase-exit is refused while any turn is pending

`advance_phase` **and** `ask_human` are both refused while any role's pending-turn record is non-collected (running, ready, or failed). A turn the orchestrator dispatched but has not collected means the phase is not done — advancing or queuing a flag would strand the turn and its bookkeeping. This also makes the per-phase `ctx` registry safe: because no phase can exit with a pending turn, the registry is always drained before the `ctx` rebuild at a phase boundary, so a turn can never be orphaned by the phase advancing out from under it. (The post-terminal quiescence rail already refuses *new* sends after a terminal marker; this extends the same discipline to the terminal tools themselves while work is outstanding.)

### Collect rhythm: strictly instant; blocking lives only in the CLI

`check_turns` never blocks. It returns ready results and reports still-running roles, immediately. The reason is structural: an MCP tool's only caller is the orchestrator session, so any wait *inside* the tool — even capped and opt-in — is an outstanding `tool_use`, i.e. the exact session freeze this work removes, and it would make responsiveness depend on prompt discipline (don't chain long waits) rather than on the tool's shape.

"Block until ready" therefore lives only in the CLI, where it runs in a *separate process* and costs the session nothing: extend `duet status --wait` to wake on **turn completion**. Today `waitForRunStop` (`src/harness/lifecycle.ts`) wakes only on a run *stop* (gate / flag / crashed / done), not on a worker-turn completion. The wake condition is the pending-turn record's durable status flipping to `ready`/`failed` — observed by re-reading the projection, **not** by a marker appearing or disappearing (a marker that is merely present can't distinguish running from finished). That gives a human, a `/loop`, or the concierge a free way to know when to tell the orchestrator to collect.

### Surface / verbs

- `send_prompt` keeps its verb and its meaning ("send a prompt to a worker"). It is async on the interactive host, blocking on headless — switched by the host, not renamed.
- One new tool, `check_turns`: instant, role-keyed, consumes ready turns and reports the rest. **No opaque handles** (there are exactly two roles and the same-role guard forbids two per role, so the role is the natural key) and **no separate per-handle `collect_turn`** (there is no case where you want to know a turn is ready but not pull it, so surveying and consuming are one verb).
- `check_turns` is **present only on the interactive host** — the host flag that switches `send_prompt`'s completion mode also controls whether `check_turns` is exposed. The headless host never leaves a turn in flight, so a `check_turns` there would be dead surface. "Not a fork" still holds precisely: there is one registry, one set of handlers and rails, one finalizer — the host flag toggles two things (`send_prompt` blocks vs. dispatches, and `check_turns` present vs. absent), it does not duplicate the surface.

Tool-surface coherence is pinned by `tests/skill.test.ts` and `tests/snippets.test.ts`, and the **fire → collect rhythm must be taught in the orchestrator identity**, which is now `prompts/orchestrator-identity.md` (the old `skills/duet/identity.md` no longer exists; the identity path is pinned by `tests/skill.test.ts`). Correcting the stale `identity.md` references that linger in the framing, `CLAUDE.md`, and docs is in-scope cleanup (named here, not enumerated).

### Reconnect, and single-writer ownership

Two hazards meet at reconnect, both new to A′ because A′ is the first thing to leave background work behind a closed session.

**The orphaned pending turn.** `duet orchestrate <runId>` can reconnect a run. A fresh `send_prompt` after reconnect would `claude --resume <id>` against a worker session a prior turn may still hold (or may have finished without its result captured) — the double-resume the same-role guard exists to prevent, except the new server rebuilt that in-memory guard empty. The durable pending-turn projection is what survives: a non-collected record on reconnect tells the new server that role has an outstanding turn it does not own.

**The lingering old server (point 5).** When the human quits the session, Claude Code closes the stdio transport and `serveRunScopedKernelStdio` resolves — but the Node process only *exits* once the event loop drains. A still-running background promise or heartbeat interval keeps it alive, so the old server can keep settling and writing to disk after the transport is gone. `execa`'s `cleanup:true` kills the worker only when that process actually exits, and `orchestrationHost` guards against interactive-vs-*headless* two-writers, not against two interactive servers. So A′ needs a **single-writer guarantee for the interactive host**: an owner/lease on the run-scoped server (the interactive analogue of the headless `driver.pid` guard), so a superseded old server cannot finalize over the new one's run — the new server is the sole writer, the old one's late settles are inert. On a graceful transport close the server should also best-effort stop its timers and stop owning in-flight promises so the process can exit; the owner/lease is the guarantee, the teardown is the courtesy.

**The honest reconnect contract: detect the orphan; require deliberate recovery (points 2 + 3).** The detection signal is the durable pending-turn record, not a transcript classification. I had over-promised a "still mid-turn vs. finished" read from `readRoleTranscriptTail` / `probeRole`; that does not hold. `readRoleTranscriptTail` needs `state.workerSessions[role]`, which a role's *first* turn does not have until settle persists it (`sessions.ts`), and `probeRole` is a recency/health classifier, not a completion detector. And after a mid-turn quit the durable status is stuck at `running` while the worker is (likely) dead, so `running` cannot be trusted as "alive." Reconnect's contract is therefore: a non-collected record means an **orphaned turn whose owning server is gone** — refuse to dispatch into that role and prescribe inspection-first recovery (`takeover` to read the worker's state). The lease (above) makes the old server's *state writes* inert, but it does not kill the old `claude -p` worker, which may still be running against that session — so an **immediate same-role resend would race a live worker**, the very thing the same-role guard exists to prevent. The conservative rule the contract follows: clear the stale record, but keep the role **closed to a fresh send** until the prior worker is known done or the human explicitly accepts the race; do not auto-issue a "resend a short continuation." Where a session id exists, the transcript tail is best-effort *context* for that recovery (and `takeover` is the safe way to see it), never a programmatic running-vs-finished verdict. (The heavier option — lease semantics that also cancel an outlived server's in-flight workers on supersession — is deferred; the conservative recovery copy is the A′ default.) (`activeTurns` keeps its present job as `doctor`'s running/idle health hint; it is no longer asked to carry the lifecycle — that is the pending-turn record's job.)

### The reconnect result-recovery evaluation — detect now, defer reconstruction

The open question this spec settles: on reconnect, when a pending turn is found settled-but-uncollected, should we reconstruct its result from the worker transcript and auto-run the finalizer, or only detect-and-prescribe-resend?

**Decision: include detection + ownership repair (low-cost — it reads the durable record and adds honest recovery copy); defer auto-reconstructing the result.** Reconstruction is not low-cost and serves a narrow window: it needs a *second* parser, per provider, that rebuilds a `WorkerTurn` from the on-disk `~/.claude/projects/` (or codex rollout) JSONL — a different shape from the `claude -p --output-format json` envelope `provider.runTurn` parses today — and some completion fields (notably claude's per-turn cost) are not faithfully reconstructable. The window is narrow: the worker must have finished, gone uncollected, *and* the session quit in that gap; the common quit is mid-turn, which reconstruction cannot complete anyway. Deferring stays inside A′ — detection reads a small durable record and pulls in nothing from B; reconstruction would be a later enhancement of the same reconnect path (a transcript→`WorkerTurn` adapter feeding the existing finalizer), recorded as such, not B's detached children.

### The steer channel improves

No regression, and in fact a gain. Today, during a `send_prompt` block the session is frozen, so the orchestrator can fire no tool call to receive a steer — the blocking call is the only outstanding one, and it delivers appended steers only when it returns minutes later. Under A′ the session stays live, so `check_turns` and `get_task` results become frequent steer-delivery surfaces all turn long. Steer storage, the carry-forward when a steer misses its phase, and the at-a-quiescent-stop refusal are all unchanged; steers ride `check_turns`'s phase-continuing result through the existing `withSteerDelivery` wrapper.

## What is preserved

- **Headless `_drive` `send_prompt` behavior is byte-for-byte unchanged** — dispatch, settle, and collect run as one blocking sequence in the single call; `check_turns` is absent from the headless surface (interactive-only), so the headless tool surface is unchanged too.
- **Every rail:** the same-role in-flight refusal (now held by the pending-turn record, dispatch→collect), the review-round backstop caps, the branch-fixed-after-first-prompt rule, advance-needs-a-review-round, the warn-once template economy, the post-terminal quiescence rail.
- **All bookkeeping:** the load → merge → save of worker session id / cost / tokens / context / sent-snippets / round count, the cost-partial marking, the context-usage recording — the same operations, run as one blocking sequence on headless and split across the settle and collect events on the interactive host.
- **Gate-crossing structure, the steer store, crash = flag** — untouched.

## Deferred and declined

- **Deferred — B (a detached child per turn).** The robust endgame: each worker turn runs as a detached process writing its result to disk, surviving session quit and reconnect. Deferred because its machinery (prompt staging across the process boundary, result files, child lifecycle and cleanup, a second concurrency model) is not justified for the attended arc, where a turn lost to a deliberate quit is a re-fire, not a silent overnight failure. **The A′-vs-B fork is recorded as a new entry in `docs/open-questions.md` (in scope), with its revisit trigger: mid-turn quits become common, or overnight orphans misfire.**
- **Deferred — transcript-tail result reconstruction on reconnect** (the sub-decision above), inside A′.
- **Declined — C (bounded-blocking single tool)** and an **in-tool `wait_ms`** on `check_turns`: both keep freezing the session (for the cap window) and make responsiveness depend on prompt discipline; C also still needs A's background ownership to avoid wasting a non-idempotent turn, so it is not meaningfully simpler.

## Risks / to confirm (plan & verify)

- **A session quit likely interrupts the worker mid-turn, not merely loses the captured result.** The worker turn is an `execa('claude', …)` child of the `duet _mcp` server (`src/providers/claude.ts`); execa's default `cleanup: true` kills spawned children when the parent *exits*. So quitting the interactive session may SIGTERM the in-flight worker. The worker session is resumable by id, but the turn is interrupted, and a non-streaming `claude -p` turn may have written little to its transcript before completion. The plan/verify confirm execa's actual behavior here; the reconnect copy and the B trigger both assume it.
- **The `_mcp` process may not exit on transport close, which is exactly why the single-writer lease is needed.** `cleanup` fires on process *exit*, but a lingering background promise or heartbeat keeps the event loop alive past the transport closing, so neither the worker-kill nor a clean shutdown is guaranteed. Plan/verify confirm whether the old server exits promptly; the single-writer owner/lease (§Reconnect) must hold even if it does not.

## Test story (at spec altitude)

The change is concurrency-shaped, so the behaviors that matter — left for the plan to turn into cases, fixtures, and seam boundaries:

- Interactive `send_prompt` returns **before** the worker turn completes; the session is free to make other tool calls while a turn runs.
- The pending-turn lifecycle drives the same-role guard: a `running` or settled-uncollected record refuses a same-role re-dispatch; `check_turns` consuming the result is what re-opens the role.
- Settle and collect are distinct: at settle the heartbeat stops and the durable bookkeeping (session id, cost/context, round, sent tag) commits, so a finished-but-uncollected turn does **not** keep logging "running"; the orchestrator-facing text/steers/guard-release wait for collect.
- An infra-failed turn commits **no** review round and **no** sent tag, and a subsequent retry of the same `send_prompt` is clean (no duplicate-template warning) — the existing retry rail preserved.
- `create_branch` is illegal once the first turn is **dispatched**, and **stays** illegal even if that first turn fails and its pending record is cleared — the branch-fixed flag is durable and one-way.
- Phase-exit (`advance_phase` and `ask_human`) is refused while any pending-turn record is non-collected.
- Reconnect treats a non-collected pending record as an **orphan**: it refuses dispatch into that role and prescribes recovery — no running-vs-finished claim derived from the transcript tail.
- After reconnect, the role stays **closed to a fresh same-role send** while the prior worker may still be alive (inspection-first via `takeover`); the lease makes stale state writes inert but does not by itself make an immediate resend safe.
- Single-writer: a superseded old run-scoped server cannot finalize over a newly launched one (the owner/lease holds).
- `duet status --wait` wakes on a pending record's transition to `ready`/`failed`, not on a marker's presence.
- **Parity: the headless host still blocks** `send_prompt`, never leaves a turn in flight, and does not expose `check_turns`.

Verification is the standard gates: `pnpm typecheck` and `pnpm test`, with `tests/skill.test.ts` and `tests/snippets.test.ts` kept green for the new tool/verb and the identity rhythm.

## In-scope documentation

Named here, planned later: the fire → collect rhythm in `prompts/orchestrator-identity.md`; the `check_turns` tool and the host-divergent `send_prompt` behavior in `docs/automation-design.md` (the tool-surface table and the interactive-orchestrator section) and `docs/engineering.md` (module map + the interactive-host pattern); new tool description / result / error text following `docs/prompting-and-tool-design.md`; the A′-vs-B fork entry in `docs/open-questions.md`; and the stale `skills/duet/identity.md` reference cleanup.
