# Spec: Claude Code as the orchestrator

An interactive Claude Code session becomes duet's orchestrator, so the human steers in natural language from inside the session that makes the routing decisions — replacing the lagged, one-way `steer`/`continue` channel for attended runs. Shipped as a new primary skill, `duet`, alongside the unchanged `duet-concierge`.

This spec covers the whole direction; the **implementation boundary for this session is Stage 0** (the §Summary makes the line explicit).

## Summary

**What we're adding.** Today the human talks to a run through a relay (`duet-concierge`) that translates chat into CLI strings, which a *separate* headless orchestrator consumes as staged input. The highest-bandwidth UX sits one hop from the model that needs the context: a `steer` note is *processed, not answered* — it rides the orchestrator's next tool result minutes later, with no reply channel (`src/harness/tools.ts` `withSteerDelivery`; `src/harness/orchestrator-prompts.ts` `<human_steers>`). We are making an **interactive Claude Code session the orchestrator itself**, so steering, triage, and gate conversation are native chat. This keeps the model count at three (the CC session *is* the orchestrator, not a fourth party) and moves orchestrator billing to the flat subscription quota — but the real prize is the live conversation.

**The approach.** The orchestrator's seven tools, the statechart, and the run state are factored into one **event-driven run-kernel** exposed over a local stdio MCP server. The orchestrator stops being something duet *drives* (today the machine `invoke`s a per-phase headless session) and becomes an MCP **client** that *calls into* the kernel. The same kernel serves two **orchestrator hosts**: the existing **headless** Agent SDK `query()` session (duet-spawned; the permanent overnight-AFK substrate) and a new **interactive** Claude Code session (the human's own session; the attended substrate). Gates stay code-enforced exactly as today: `advance_phase` only *parks* at the gate; crossing needs a `human.*` event, which originates only from human authority (a CLI decision) or deterministic pre-authorization — never from a tool the orchestrator can call.

**The Stage-0 / Stage-1 boundary (this session vs. deferred).**

- **Stage 0 — this session. Spends no invariant; reversible.** Build the event-driven kernel and the stdio-MCP boundary, and run the **headless** orchestrator on it at **behavioral parity** with today's path (the regression oracle). The headless client keeps every current guarantee — read-only by construction (`tools: []`), per-phase budget cap, ephemeral-per-phase, "nothing runs between stops." This is the lifecycle re-home `docs/future-directions.md` predicted, done where it's diff-testable against the live-verified FRAME→Ship path. This session also *designs* (but does not ship live) the `duet` skill identity and the read-only permission profile.
- **Stage 1 — defers (the invariant-spending, one-way door; per approved Q-A, awaits concierge evidence gathered in parallel).** Add the **interactive** Claude Code client as a live orchestrator of real runs; make the locked-down read-only permission profile load-bearing; ship the `duet` skill live; add gate-crossing-from-the-same-session ergonomics, partial cost telemetry for the interactive host, and interactive-host crash recovery.

**The boundary once Stage 0 lands.** *Fixed:* the architecture is inverted and proven — one kernel, an MCP boundary exercised by a real (headless) client, the machine event-driven, gates still uncrossable by the orchestrator. *Not yet:* the human cannot yet talk to the orchestrator — Stage 0 changes no user-facing behavior by design (parity is the whole point). *Explicitly deferred (one-line why each):* the interactive host live on real runs (spends the read-only invariant — Q-A); impl/overnight on interactive (headless is the overnight substrate — Q-B/Q-D); codex-as-orchestrator (interactive deepens the claude dependency — Q-F, Q17 stays unbuilt); an eval/replay harness (the event-driven seam enables it, but it's a separate direction).

## Current vs. desired

**Preserved, unchanged in contract:**

- **Code-enforced gates.** Gates transition only on `human.approve|reject|answer` (`src/harness/machine.ts`); the orchestrator has no `human.*` / gate-crossing event channel (its `phase.*` events never reach a gate state). This guarantee is *strengthened in framing*, not weakened: it must survive even an orchestrator that (in Stage 1) has a Bash tool.
- **Augmentation guarantees.** Standard JSONL transcripts, `duet takeover`, resume, `state.json`-is-a-hint. The kernel reads and writes the same run dir (`src/run-store.ts`).
- **The headless substrate.** Retained permanently as the overnight-AFK path — the only one that keeps "nothing runs between quiescent stops" and read-only-by-construction. This is *additive*: an interactive substrate beside headless, not a replacement.
- **The concierge.** `skills/duet-concierge/` is untouched; it supervises headless/overnight runs. `duet status --json` stays additive-only (pinned by `tests/skill.test.ts`).

**Changing:**

- **Control direction inverts.** Today duet drives the orchestrator (`machine.ts` `invoke: phaseDriver` → `src/harness/driver.ts` `runPhase`, which blocks to quiescence). Desired: the orchestrator is an MCP client that calls into the kernel; the kernel owns the run loop and reaches quiescence when the client calls `advance_phase`/`ask_human`.
- **Tools move behind the stdio-MCP boundary.** The seven tools are currently mounted in-process inside the SDK turn (`src/harness/driver.ts` `createSdkMcpServer`, `tools: []`, `strictMcpConfig`). Desired: they live in the kernel and are reachable over stdio MCP, so a client process outside duet can call them.
- **The machine becomes event-driven, with two distinct event vocabularies.** Today phase completion is not an event at all — it's an invoked actor's result guarded by `isAdvanced` (`src/harness/machine.ts`), and the only events are `human.*`. Desired: a tool call fires an **internal `phase.*` event** (e.g. `phase.advance`, `phase.flag`), valid only from phase states and ignored by gates; the in-memory `outcome`-flag coupling (`src/harness/tools.ts`, `driver.ts`) is removed. `human.*` stays a *separate authority vocabulary*, valid only from gate/flag-wait states. Because an orchestrator tool call (`phase.*`) and a gate crossing (`human.*`) are different event classes routed to different states, "advance_phase parks but cannot cross" becomes structural — a property of the vocabulary — rather than prompt-enforced.

## How a phase advances — before / after

**Today** (`_drive` process owns everything):

```
_drive ─▶ XState invoke: phaseDriver (runPhase)
            └▶ headless query() + in-process createSdkMcpServer tools (tools:[])
                 orchestrator calls advance_phase
                   └▶ sets outcome.advanceRequested (in-memory)
            driver loop returns 'advanced' ─▶ guard isAdvanced ─▶ gate state (quiescent)
       persist + process exits.  Human later: duet continue --approve
         └▶ new _drive ─▶ human.approve event ─▶ next phase loop ─▶ new query()
```

**Under the kernel** (one kernel server, orchestrator is a client):

```
kernel server  ── owns machine + RunState + the 7 tools (stdio MCP)
   ▲ stdio MCP
   client = orchestrator   (Stage 0: headless query();  Stage 1: interactive CC session)
     calls advance_phase  ─▶ handler fires phase.advance ─▶ gate state (quiescent)
                              result nudges the client to end its turn (cooperative pause)
   headless: kernel persists + exits.   interactive: kernel idles, CC session stays connected.
   Human: duet continue --approve  (permission-ask-gated)
     └▶ stageHumanInput → human.approve event ─▶ next phase ─▶ entry prompt delivered
                                                  as the client's next tool result
```

The crossing is a `human.*` event in both eras — from human authority via the CLI staging handshake (`src/run-store.ts` `stageHumanInput`/`consumeHumanInput`) or from deterministic `gates_at` pre-authorization (`src/harness/lifecycle.ts` `driveToQuiescence`, which sends `human.approve` on the standing authority without staging) — never from an orchestrator tool; `advance_phase` only parks. The **cooperative pause survives the inversion** — it's already a tool-result nudge, not a mechanical interrupt (`docs/engineering.md` §"Cooperative pause"), so it works identically across the MCP boundary.

## Coupling decisions

- **The kernel is a refactor of `driver.ts` + `machine.ts` + `lifecycle.ts`, not a parallel module.** Unify, don't fork: the interactive client forces the event-driven machine regardless (an external process can't share an in-process `outcome` object), so keeping headless on the old actor/flag mechanism would duplicate gate logic — the duplication `docs/engineering.md` warns against. The in-process `createSdkMcpServer` hosting (`driver.ts`) becomes one client transport; the quiescence loop and `gates_at` auto-cross (`lifecycle.ts` `driveToQuiescence`) re-home into the kernel, while crash=flag (today's `runPhase` catch) re-homes but stays owned by the supervising parent (see *Crash supervision* below). The phase table (`src/phases.ts`) stays the single source.
- **The orchestrator gets its own `host` selector, distinct from worker `transport` — they are different axes.** Worker `transport` (`'headless' | 'interactive'`, `src/config.ts`) is documented as *how duet talks to a claude worker* — a billing/IO choice for a session duet drives — and stays untouched (implementer-only for `interactive`). The orchestrator's choice is not that: it selects session-ownership and kernel topology — `host = "sdk"` (duet-spawned Agent SDK client; today's default and the headless substrate) vs `host = "claude-code"` (the human's interactive session as the client). Overloading the worker field would give one name two divergent meanings with the same value strings — the false-unification a later reader trips on (an earlier draft of this spec reused `transport` and had to caveat it away). The `claude-code` host is claude by nature, so the orchestrator-requires-claude guard (`config.ts` `loadRoleBindings`) stands. Exact field placement is a plan detail; the spec decision is that orchestrator host is a *separate concept* from worker transport.
- **Gate authority has exactly two non-orchestrator sources.** A `human.*` event originates only from explicit human authority (a CLI decision via the `stageHumanInput` handshake) or from deterministic pre-authorization captured at run start (`gates_at`, crossed in `src/harness/lifecycle.ts` `driveToQuiescence` without staging). Both are outside the orchestrator. No MCP tool emits `human.*`; the orchestrator's only phase-exit tool, `advance_phase`, emits the internal `phase.advance` event, which a gate state ignores. In Stage 1 the interactive orchestrator may *run* `duet continue` itself (one window), but only as a permission-`ask`-gated Bash command that stages a human decision — its MCP tool surface still contains no crossing tool. The guarantee ("a gate crossing cannot originate in the orchestrator's reasoning loop") is preserved by the event vocabulary and the absence of the tool, not by a prompt.
- **Crash supervision (Stage 0) stays with `_drive`.** The inversion adds a process boundary (kernel server + Agent SDK client), so the crash=flag invariant needs an owner that outlives both: `_drive` remains the supervising parent and converts any kernel/client failure — including a kernel crash *before* it persisted state — into a persisted pending question (today's `runPhase` catch, re-homed to the parent). Interactive-host crash recovery, where the client is the human's session rather than duet-spawned, is a separate Stage-1 concern (deferred below).
- **The steer store is unchanged and stays.** File-per-steer under `steers/` (`src/run-store.ts`), delivered on phase-continuing tool results, remains the headless/overnight channel and the audit/carry-forward record. In interactive mode chat is the live steering surface, but the persisted primitive is not removed — it serves the retained headless substrate and keeps steers auditable.

## The interactive host and read-only enforcement (Stage 1 design)

Designed now (the rider binds the MCP/permissions and prompt-engineering research), shipped live in Stage 1. The single invariant this spends: read-only stops being a property of construction (`tools: []` is unavailable to a full Claude Code session) and becomes an **enforced permission profile + identity**. Grounded in the Claude Code surface confirmed via the official docs:

- **Connection.** The `duet` skill ships a project-scoped `.mcp.json` (the documented pattern for a local stdio server) pointing at the kernel server entry. `.mcp.json` only *adds* the kernel server; it cannot exclude other user/global tools, so "only the duet surface" is never something the connection file promises.
- **Read-only profile.** Exclusivity comes from a shipped managed `settings.json` `permissions` block, not from `.mcp.json`: it **denies** artifact-writing and shell-mutating tools, allows only the duet orchestration MCP surface plus read tools, and sets `disableBypassPermissionsMode: "disable"` with `allowManagedPermissionRulesOnly` so the session cannot self-escalate. Gate crossing is `ask`-gated (`Bash(duet continue:*)`), the same double-gate the concierge already relies on. This is materially weaker than the headless host's `strictMcpConfig: true` (`src/harness/driver.ts`), which *structurally* excludes user-config MCP servers; the spec names that downgrade plainly, and the mitigation is that the profile is shipped and pinned, not hand-configured per session.
- **Identity.** The skill's identity prompt carries the orchestrator's division-of-labor and read-only posture (governed by the in-repo `docs/prompting-and-tool-design.md`, the durable authority; the `prompt-engineering` skill is an authoring aid, not a shipped dependency); `disable-model-invocation` and explicit-invocation-only mirror the concierge, so a session developing duet never inherits the orchestrator role. The skill is `duet`; it is invoked `/duet` and is distinct from the `duet` CLI binary.

## Behaviors that matter (for the plan to turn into tests)

Named at behavior altitude; cases, fixtures, and mocking boundaries are the plan's.

- **Gate-crossing cannot originate in the orchestrator's reasoning loop.** `human.*` is a separate event vocabulary valid only from gate/flag-wait states, emitted only by human authority (CLI staging) or `gates_at` pre-authorization — never by any MCP tool. `advance_phase` emits the internal `phase.advance` event, which a gate state ignores, so it parks and never crosses. This is the load-bearing invariant.
- **Stage-0 behavioral parity (the regression oracle).** The headless orchestrator over the kernel produces the same gate/flag/quiescence/auto-cross/crash outcomes as today's path, faked at the existing seams (`RunOrchestratorTurn`, `WorkerProvider`, the `phaseDriver` actor — `docs/engineering.md` §Seams).
- **Cooperative pause survives the boundary.** Advance and flag still exit at quiescence via the tool-result nudge, not a mechanical interrupt, with the orchestrator session resumable.
- **Crash = flag, across the new process boundary.** `_drive` (the Stage-0 supervising parent) converts kernel or client death — including a kernel crash before it persisted state — into an actionable persisted question, never a silent state. Stage 1 adds interactive-host recovery (resume the same session, or fall back to headless re-entry) — no resident daemon.
- **Read-only enforcement for the interactive host (Stage 1).** The shipped profile denies writes/exec and bypass; the orchestrator cannot edit artifacts; crossing stays `ask`-gated.
- **Concierge compatibility.** `status --json` schema unchanged and additive-only (pinned by `tests/skill.test.ts`); the concierge keeps working against headless runs.

**Manual validation (Stage 0).** Because the headless orchestrator is the kernel's first client, an ordinary end-to-end `duet new … / continue …` run drives the new event-driven kernel through the retained headless path — so a normal run *is* the manual parity check, and its run-dir artifacts (`state.json` rounds/costs/`autoApprovals`/`phaseSummaries`, the quiescent `machine.json` snapshots, the per-voice logs) diff against the live-verified oracle run's shape. Cheaper by-hand spot-checks reach the distinct kernel paths short of the full arc: a FRAME-only run for the park-at-gate / quiescence / cross loop, killing the driver mid-phase for crash=flag and bare-`continue` re-entry, a `duet steer` for tool-result delivery, and a `--gates-at` run for pre-authorized auto-cross. The stdio-MCP boundary itself is pokeable read-only without the interactive skill — a standard MCP client (e.g. the MCP Inspector) enumerates the seven tools and calls `list_snippets` at zero worker cost to confirm the surface answers over stdio. What stays unobservable until Stage 1: the human talking to the orchestrator, the read-only permission profile, and in-session gate-crossing — none have a client in Stage 0.

## Deferred / out of scope (with the one-line why)

- **Interactive host live on real runs, read-only profile load-bearing, `duet` skill shipped live, gate-from-session ergonomics, partial cost telemetry, interactive crash recovery** — Stage 1; the invariant-spending one-way door, awaiting concierge evidence (approved Q-A).
- **Impl / overnight on the interactive host** — headless is the permanent overnight substrate; interactive targets attended phases (frame/spec/plan) first (Q-B/Q-D).
- **Codex-as-orchestrator (Q17)** — interactive deepens the claude dependency; the codex path stays designed-but-unbuilt (Q-F).
- **Eval/replay harness** — the event-driven kernel makes it tractable, but it is a separate future direction, not this work.
- **Doc updates** — post-implementation, per project convention.
