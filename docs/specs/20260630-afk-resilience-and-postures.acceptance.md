# Acceptance contract — AFK resilience & postures

**For:** `docs/specs/20260630-afk-resilience-and-postures.md`. **Status:** proposed; frozen at the plan gate.

A frozen list of falsifiable runtime assertions that define what *success* means for this change — the behaviors the product depends on that would still let every obvious author-written test pass while silently drifting from the spec's intent. Authored against the spec alone, before the implementation exists; that blindness is deliberate. Each line is SHALL / SHALL NOT, one observable per line, binary pass/fail. IDs are stable and never renumbered. `Verify by:` states WHAT to observe; the verifier resolves HOW in the built system.

Out of scope by design: the exact wall-clock cap number, the ledger's exact field shape, the `/compact` cap's exact minutes, the `recover-context` body — all deferred to the plan. The happy path (a healthy turn completes) is owned by the author's tests, not here.

---

[A1] Where a run's persisted state carries no explicit retry-infra budget (a run created before this change, or one persisted with retry off), the headless driver SHALL NOT auto-retry that run's orchestrator/host-plane failures.
  Verify by: take a `state.json` with no materialized `retryInfra` field, resume it on the headless host, and induce a retryable host-plane failure → the failure is handed back / flagged, NOT mechanically re-run — even though a run created now (which materializes the budget at `createRun`) would auto-retry the same failure.

[A2] When the headless driver mechanically auto-retries an orchestrator/host-plane failure, it SHALL surface that retry in the "while you were away" review section under a representation distinct from the gate-shaped `autoApprovals`.
  Verify by: drive a run through an auto-retried host failure, then read the morning review → the retry appears as its own away-event entry (no fabricated `gate`/packet headline), and the `autoApprovals` list is unchanged by it; a silent retry (absent from the review) fails.

[A3] When a worker turn's prompt was accepted into the session and the turn then aborted, the failure result SHALL direct the orchestrator to resume the existing session and SHALL NOT direct it to re-send the original prompt.
  Verify by: simulate the `7447` shape — a turn whose prompt reached the session (user message recorded / later assistant or tool activity) that is then killed at its cap → the rendered result text says resume-this-session, and contains no instruction to re-send the same `send_prompt`.

[A4] If a failed worker turn shows only a minted session id, only startup/system transcript records, or no located transcript, then the failure result SHALL direct a verbatim re-send of the same prompt and SHALL NOT classify the turn as accepted-and-resumable.
  Verify by: force a pre-flight failure (ENOENT / auth / connect) where a session id was minted but no user message was ever recorded → the result says "the worker never saw your prompt, retry this same send_prompt once"; a minted-id-alone or system-records-only case never renders the resume message.

[A5] If a worker turn is suspended by a machine sleep past its per-turn deadline, then on wake the provider SHALL terminate the turn on elapsed wall-clock time, not on elapsed process-active time.
  Verify by: at the `WorkerProvider` seam, advance wall-clock past the effective per-turn cap while process-active time stays under it (the suspend/wake model) → the turn is killed promptly on wake and surfaces a typed outcome; a monotonic-only timer that keeps counting awake-time-only fails this.

[A6] When a worker turn's body is a `/compact` command, the provider SHALL enforce the short dedicated compaction cap rather than the phase/impl per-turn cap.
  Verify by: send a `/compact` turn that never completes → it is killed under the short cap (minutes), not the long impl cap (the `7447` mode where a hung compact rode the hour-plus cap); a `/compact` body that falls through to the impl cap fails.

[A7] When a `/compact` turn was accepted into the session and then failed, the harness SHALL clear the implementer's worker session so the implementer's next turn seeds a fresh session.
  Verify by: drive an accepted-but-failed `/compact` → inspect that the next `send_prompt` for the implementer mints a new session (does not resume the bloated un-compacted one), and the failure result prescribes `recover-context`.

[A8] If a `/compact` turn failed pre-flight (the prompt was never accepted into the session), then the harness SHALL NOT clear the implementer's worker session.
  Verify by: drive a pre-flight `/compact` failure (auth/connect/ENOENT before the prompt is recorded) → the implementer's next turn resumes the same prior session (the one still needing compaction); a reset here, discarding a recoverable session, fails.

[A9] If the whole-phase quiescence timeout fires, then the driver SHALL queue an actionable human question carrying a next command and SHALL NOT terminate the driver process or strand the run.
  Verify by: trip `QUIESCENCE_TIMEOUT_MS` → the run reaches a quiescent flagged stop with a queued question and a stated next command (the "every stop has a next command" rule); the `_drive` process exiting / the run left unresumable (the `7447` dead-run pattern) fails.

[A10] Where a run launches under `--gates-at afk` (`gatesAt: []` with `gateless` off), the consultant SHALL retain both its holding bet-audit challenge and its backstop, and the severity hold SHALL still fire.
  Verify by: start a full-arc run with a consultant bound under `--gates-at afk` → the holding `challenge` checkpoint and the backstop are both live and a severity hold still parks the run; an `afk` run that behaves identically to `--gateless` (dropping the holding bet-audit) fails — the two diverge precisely when a consultant is bound.

[A11] While a run is launched under any attend-none posture (`--gates-at afk` or `--gateless`), the run SHALL stop at an open pull request and SHALL NOT merge it.
  Verify by: run either posture to completion → the terminal state is an open PR awaiting the human, with no merge performed by duet; any posture that auto-crosses into a merge fails (the never-automated-merge invariant holds on the most aggressive postures).

[A12] Where a Claude connection is opened — the headless worker spawn, the orchestrator's own SDK session, or the interactive transport's launched `claude` — `API_FORCE_IDLE_TIMEOUT=1` SHALL be present in that connection's effective environment, and SHALL NOT be injected for a codex turn.
  Verify by: inspect the environment at each Claude connection site, including the tmux-launched command's own env (not relying on stale parent-process inheritance) → the var is set at all three; inspect a codex worker's spawn env → the Claude-only watchdog knob is absent.
