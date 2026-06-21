# Interactive-orchestrator run frictions — problem definition

**Status:** Friction journal / problem definition (NOT a build spec — no single feature; a list of independently-actionable frictions). **Date:** 2026-06-21.
**Source run:** `20260620-1624-646e` — the FRAME→SPEC→PLAN of *"async `send_prompt` for the interactive orchestrator host"* (`docs/specs/2026-06-21-async-interactive-send-prompt.md`), orchestrated live from an interactive Claude Code session. This doc is a byproduct of that run, written by the interactive orchestrator after the plan-gate handoff.
**Host / roles:** orchestrator = interactive CC session (`state.json: orchestrationHost` was `interactive`, `orchestratorCostPartial: true`); implementer = **claude** (`bec2086e-8b75-4066-ad9e-10fefa05f993`); reviewer = **codex** (`019ee5dd-4f1e-7e33-a465-49fd29bc9f99`).

## What this is

A retrospective of process/workflow frictions observed while orchestrating one full attended arc — a mid-SPEC reconnect, then SPEC and PLAN to the plan-gate handoff — from a live interactive session. **None blocked the run**; each cost efficiency or clarity. It complements the run's own `notes.md` (which already records F8/F9 below) and is meant so a future engineer can open the exact artifacts and see the glitch. Code citations are against `main` at this commit; line numbers may drift, so each cites a symbol/string too.

## Evidence index

- **Run dir** (run-local, gitignored — may rotate/purge): `~/dev/.worktrees/duet/feat-async-mcp-tools/.duet/runs/20260620-1624-646e/`
  - `orchestrator.log` (the interactive voice log), `implementer.log`, `reviewer.log`, `state.json`, `machine.json`, `notes.md`, `framing.md`, `driver.log`.
- **Implementer transcript (claude):** `~/.claude/projects/-Users-qiushi-dev--worktrees-duet-feat-async-mcp-tools/bec2086e-8b75-4066-ad9e-10fefa05f993.jsonl`
- **Reviewer transcript (codex rollout):** session `019ee5dd-4f1e-7e33-a465-49fd29bc9f99` (under `~/.codex/`; mirrored turn-by-turn in the run dir's `reviewer.log`).

---

## F1 — A pre-authorized plan gate stalls on the interactive host, and the post-advance message says the opposite

**Severity:** high (an "overnight" build silently did not start). **Already partly documented** — see relation below.

**Problem.** The run's gate posture was `attending frame, spec, pr — other gates pre-authorized` (so the plan gate was pre-authorized at `duet new`). At the plan gate I called `advance_phase`; the kernel **parked** the gate (by design — `advance_phase` only parks, never crosses) and returned a result telling me *"the run continues immediately… End your turn with a one-line status; the next phase's instructions arrive as your next message."* I ended my turn. Nothing continued: no headless driver was ever spawned, the statechart stayed in `planLoop`, and the build sat idle at the gate until the human asked for status — exactly the AFK window the pre-authorization was supposed to cover. The handoff only happened once I explicitly ran `duet continue --approve --headless`.

**Why.** On the interactive host the pre-authorization (`gates_at`) is **not honored during the attended arc**: gates_at auto-cross is a property of the *headless* driver's `driveToQuiescence` loop (`src/harness/lifecycle.ts:262`+, "the driver lives through the whole pre-authorized stretch"), and during the interactive arc there is **no driver running** — the interactive session drives via the kernel tools and crosses gates only through `duet continue` (`src/cli.ts:432`, the `orchestrationHost === 'interactive'` branch: *"advances the machine inline … until the plan-gate handoff"*). So a pre-authorized interactive gate parks and waits, with nothing to auto-cross it.

**The incremental bug (beyond the known issue below).** The `advance_phase` result message is keyed on *the gate being pre-authorized*, not on the host (`src/harness/tools.ts:584`). So on the interactive host it tells the orchestrator *"the run continues immediately… the next phase's instructions arrive as your next message"* — which is false here. A correct, careful orchestrator that trusts the message will stall the run.

**Evidence.** `machine.json` showed `value: "planLoop"` with no `driver.pid`/`driver.log`; `duet status` showed `state: (not started)`, `last: advance_phase (plan)`, `impl 0/6`. Message at `src/harness/tools.ts:584`. Interactive continue path at `src/cli.ts:425-460`.

**Relation to existing docs.** `docs/specs/2026-06-21-afk-handoff.md:7` already states the root cause: *"on the interactive orchestrator host that posture is ignored entirely… `gates_at` only governs the headless tail after the plan handoff … the run stalls at the next gate waiting for a tap you're not there to give."* This run is **live confirmation**, and adds that the stall happens even with **run-start** pre-authorization (the afk-handoff spec frames the fix, `duet afk`, around *mid-session* posture-setting). The afk-handoff spec does not appear to flag the **misleading `tools.ts:584` message** — that is the new, separable finding.

**Possible direction.** (a) Build `duet afk` per the existing spec; and **separately** (b) make the `tools.ts:584` pre-authorized-gate message host-aware: on the interactive host it should tell the orchestrator to invoke `duet continue --approve --headless` (or have an interactive pre-authorized `advance_phase` trigger the handoff) rather than to end its turn expecting auto-continuation.

---

## F2 — `write_note` is refused once a phase is parked at its gate

**Severity:** low-medium (the friction journal systematically misses gate-adjacent observations).

**Problem.** When I tried to record F1 via `write_note` immediately after `advance_phase`, the kernel refused: *"This phase is ending — it is parked at its gate or flag and that decision is recorded, so write_note is refused here."* But gate/handoff moments are exactly when friction observations crystallize — that's when you can see how the phase actually went. So the run-notes journal loses its most useful entries unless the orchestrator remembers to write them *before* advancing.

**Evidence.** Refusal string at `src/harness/tools.ts:693` (applies to non-terminal tools once parked; the parked-state guard also drives the `get_task` "you are parked" message at `tools.ts:199`). I had to hand the note to the human in chat instead.

**Possible direction.** Allow `write_note` (a pure append to `notes.md`, no statechart effect) while parked at a gate; it cannot forge a crossing, so the quiescence rationale that justifies refusing *work* tools doesn't apply to it.

---

## F3 — After a crash + reconnect, `get_task` cannot re-fold the human-input block

**Severity:** low (the reconnect note's prose saved it this time).

**Problem.** This session began as a reconnect after the previous orchestrator *"lost its kernel MCP connection mid-SPEC"* (see F4). The reconnect note said *"Call get_task first … it gives you the SPEC brief, the full framing, and the approval rider."* In practice `get_task` returned only the `<task>` brief — no framing, no rider — because the crashed prior session had already consumed the staged human-input block, and the block folds in **exactly once** (`src/harness/tools.ts:220-227`, `consumeHumanInput`; described at `tools.ts:205`: *"folded into the brief as an appended block exactly once; a later call returns the brief alone, with nothing left to consume"*). I recovered by `Read`-ing `framing.md` from disk and relying on the reconnect note's prose for the rider.

**Evidence.** My first `get_task` at SPEC start returned only the phase brief + examples; the framing/rider had to be re-read from `.duet/runs/20260620-1624-646e/framing.md`.

**Possible direction.** Either make the human-input fold **idempotent until the phase actually starts producing** (so a reconnect re-reads it), or have the reconnect path re-stage the still-relevant rider; and soften the reconnect-note guidance so it doesn't promise `get_task` will return inputs a crashed session may have already consumed.

---

## F4 — The interactive MCP connection dropped mid-SPEC (the reconnect trigger)

**Severity:** medium (forced a full reconnect; risked an in-flight turn).

**Problem.** The reason this session exists at all: *"The previous interactive orchestrator session lost its kernel MCP connection mid-SPEC."* That is a stability event in the transport between the Claude Code session and the run-scoped `duet _mcp` server. The reconnect was clean (nothing was in flight), but it cost a re-anchor and is a reliability risk for the interactive host specifically.

**Evidence.** Stated in this session's reconnect framing; the run dir is the surviving artifact. (Mechanism is the stdio MCP boundary in `src/harness/mcp-server.ts` `serveRunScopedKernelStdio` / the CC session's MCP client.)

**Possible direction.** Worth instrumenting how often the run-scoped `_mcp` connection drops on the interactive host, and whether a dropped connection mid-turn (vs. this clean idle drop) corrupts anything — it intersects the very async/orphan work this run designed.

---

## F5 — The interactive orchestrator is blind to cost/context inline, and `(not started)` is misleading

**Severity:** low (visibility, not correctness).

**Problem.** Every `send_prompt` result I received was just the worker's text — no context%/cost/round metadata. I only learned the reviewer was at **86% context (223k/258k)** by explicitly shelling out to `duet status`, and I never saw a near-cap nudge during the loop. For a host whose premise is "the conversation is the channel," having to break out to a CLI to gauge worker fullness (and whether to compact) is friction. Two smaller siblings: `state: (not started)` renders whenever `machineState` is null even though the run is deep into a phase or the driver is live; and orchestrator cost is simply unavailable.

**Evidence.** `(not started)` label at `src/status.ts:231` (and `doctor.ts:198`, `status.ts:406`); observed showing both while parked at the plan gate and while the driver was running. `orchestratorCostPartial: true` in `state.json`. (Caveat that softens this: the reviewer is **codex**, whose ~258k window auto-compacts, so the 86% was less alarming than it looked — but the orchestrator had no way to know that inline.)

**Possible direction.** Surface a compact per-turn footer on `send_prompt`/`check_turns` results (role context%, cumulative cost, round X/cap) so the interactive orchestrator can manage compaction without leaving the conversation; and make `(not started)` reflect the probed position when a driver/phase is active.

---

## F6 — The codex reviewer emits malformed file-link citations

**Severity:** low (recurring relay tax).

**Problem.** Across both the spec and plan reviews, the reviewer's markdown file-links were frequently mangled — e.g. `([spec](/Users/qiushi/dev/.worktrees/duet/feat-async-interactive-send-prompt.md:121))`, which collapses the real `…/feat-async-mcp-tools/docs/specs/2026-06-21-async-interactive-send-prompt.md` by dropping the `docs/specs/2026-06-21-async-` segment and fusing the worktree dir with the slug. I added a *"the links are malformed — read from the actual file"* caveat every time I relayed feedback. (The reviewer's *other* anchors — e.g. `src/harness/tools.ts:269`, `sessions.ts:102` — were correct; only the spec/plan self-references mangled.)

**Evidence.** `.duet/runs/20260620-1624-646e/reviewer.log` lines 116, 120, 124 (and **13 occurrences** of `feat-async-interactive-send-prompt.md` across the file). Attributable to the **codex** reviewer (the implementer's claude citations did not show this).

**Possible direction.** A provider-specific quirk, not a kernel one — either a reviewer-prompt nudge to cite repo-relative paths, or a tolerance for it in how the orchestrator relays (don't trust worker-emitted absolute self-links; rewrite to the known artifact path).

---

## F7 — The snippet library carries another project's paths and inconsistent skill roots

**Severity:** low (a small standing tax on every adapt).

**Problem.** `write-spec` instructs writing the spec to `docs/superpowers/specs/` — a foreign path (this project uses `docs/specs/`). And the TDD skill references are inconsistent between sibling snippets: `tdd-plan` cites `~/.claude/skills/tdd/…` while `review-plan` cites `~/.agents/skills/…`. I collapsed each onto the real paths per turn, but they are stale generality from the tabtype port.

**Evidence.** `snippets.toml:38` (`docs/superpowers/specs/`); `snippets.toml:192-197` (`~/.claude/skills/tdd/…`) vs `snippets.toml:217-218` (`~/.agents/skills/…`). (Porting edits back to tabtype is a manual human step, per `CLAUDE.md`.)

**Possible direction.** A `propose_snippet_edit` cleanup pass to neutralize the foreign spec path and unify the skill root — guarded by `tests/snippets.test.ts`.

---

## F8 — First worker turn died at a 30-minute infra timeout before seeing the prompt *(already in `notes.md`)*

**Severity:** medium when it happens (a wasted ~30 min + a retry).

**Problem.** The implementer's first `think-holistic` turn (FRAME) died at the infra layer — `claude -p` timed out after 1,800,000 ms (30 min) before the worker ever processed the prompt. Retried once per the tool's recovery guidance and succeeded.

**Evidence.** `notes.md` entry `2026-06-20T17:07:06Z [orchestrator]`. Provider turn-timeout default noted in `src/providers/claude.ts` (the framing's onboarding read also flags the 15-min default elsewhere — worth reconciling which timeout governs a heavy onboarding+analysis turn).

**Possible direction.** Watch whether a large onboarding read-set + deep design analysis routinely brushes the claude turn timeout for FRAME-class tasks; consider a longer timeout or a lighter first-turn onboarding for design runs.

---

## F9 — `/onboarding` does not expand in headless worker sessions *(already in `notes.md`)*

**Severity:** low (the explicit file list carried the load; no harm this run).

**Problem.** The reviewer reported `/onboarding` was unavailable in its headless `claude -p` worker session, so it onboarded from the listed docs/code directly. The framing's instruction to "include the skill's `/name` and the CLI expands it" assumes an *interactive* CC session; a headless worker does not expand slash commands.

**Evidence.** `notes.md` entry `2026-06-20T17:07:06Z [orchestrator]`. (I applied this lesson for the rest of the run — onboarding workers by listing files to read, never via a slash command.)

**Possible direction.** Worker onboarding in framings/prompts should always enumerate files, never rely on slash-command expansion; the framing template's onboarding line should say so.

---

## Summary (severity = efficiency/clarity cost, not correctness — the run produced a correct spec + plan)

| # | Friction | Severity | Kind | Already tracked? |
|---|---|---|---|---|
| F1 | Pre-auth plan gate stalls on interactive host + misleading post-advance message | High | kernel / prompt | Root in `afk-handoff.md`; message bug is new |
| F2 | `write_note` refused once parked at a gate | Low-Med | kernel | New |
| F3 | `get_task` can't re-fold human input after a crash | Low | kernel | New |
| F4 | Interactive MCP connection dropped mid-SPEC | Med | transport | New |
| F5 | No inline cost/context; `(not started)` misleading | Low | UX/visibility | New |
| F6 | Codex reviewer emits malformed file-links | Low | provider | New |
| F7 | Snippet library carries foreign/inconsistent paths | Low | snippets | New |
| F8 | First worker turn hit a 30-min infra timeout | Med | provider | `notes.md` |
| F9 | `/onboarding` doesn't expand in headless workers | Low | prompt | `notes.md` |
