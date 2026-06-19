# Spec: Claude Code as the orchestrator

An interactive Claude Code session becomes duet's orchestrator, so the human steers, interrogates, and decides in natural language from inside the session that makes the routing decisions — replacing the lagged, one-way `steer`/`continue` relay for attended runs. Shipped as a new primary skill, `duet`, alongside the unchanged `duet-concierge`, brought up by a `duet orchestrate` launcher.

The direction ships in two stages. **Stage 0 is built and merged** (the host-neutral run-kernel and the stdio-MCP boundary, proven at behavioral parity by the existing headless orchestrator). **This spec's active implementation boundary is Stage 1** — the live interactive orchestrator — approved at the Direction gate with both product calls settled. The Stage-0 material below is the foundation Stage 1 builds on; it is recorded, not re-opened.

## Summary

**What we're adding (product terms).** Today the human talks to a run through a relay (`duet-concierge`) that translates chat into CLI strings, which a *separate* headless orchestrator consumes as staged input — a `steer` is *processed, not answered*, riding the orchestrator's next tool result minutes later with no reply channel (`src/harness/tools.ts` `withSteerDelivery`; `src/harness/orchestrator-prompts.ts` `<human_steers>`). Stage 1 makes **the human's own interactive Claude Code session the orchestrator**, so steering, triage, and gate conversation are native chat: the human asks "why did you flag that?", re-scopes the reviewer, or settles a product call by talking to the model that actually holds the run context. The model count stays at three (the session *is* the orchestrator, not a fourth party), and orchestrator spend moves to the flat subscription quota — but the real prize is the live conversation. Interactive orchestration covers the attended front (FRAME → SPEC → PLAN); at plan-approval the human walks away and the run hands off to the headless substrate for AFK implementation.

**The approach.** Stage 0 already factored the seven tools, the statechart, and the run state into a host-neutral run-kernel reachable over a stdio MCP server (`src/harness/mcp-server.ts`, served by the hidden `duet _mcp` command; `src/harness/stdio-host.ts` is the boundary's parity harness). Stage 1 adds a second client of that boundary — the human's session — brought up by a launcher:

- **`duet orchestrate <runId>`** launches `claude` wired to the run: a run-scoped kernel MCP server via `--mcp-config` (the runId baked in), `--strict-mcp-config` for MCP-surface hygiene, and the orchestrator identity from the shipped `skills/duet/` via `--append-system-prompt-file`, plus the single gate-safety permission rule. The session reads its current instructions from a new **`get_task`** tool and drives the phase with the unchanged seven tools.
- **Gate authority is protected by exactly one permission rule** — `ask` on `Bash(duet continue *)` — applied and self-checked by the launcher. No broad read-only/write-deny profile.
- **Crossing the plan gate is the handoff**: the orchestrator's `duet continue --approve` (behind the one tap) runs the existing `spawnDrive` path, which spawns the detached headless `_drive` for AFK impl; the interactive session ends.

**The boundary once Stage 1 lands.**

- *In:* the human talks to the orchestrator live over FRAME → PLAN; the `duet orchestrate` launcher; the run-scoped kernel server with `get_task`; the single `ask` gate rule; the plan-approval handoff to headless impl; the shipped `skills/duet/` identity; interactive-host crash recovery via `get_task` re-anchoring; partial cost telemetry for the subscription-billed orchestrator.
- *Not (unchanged):* the headless substrate stays the permanent AFK path, read-only by construction (`tools: []` + `strictMcpConfig`, `src/harness/driver.ts`) and "nothing runs between stops"; the concierge (`skills/duet-concierge/`) and `duet status --json` (additive-only, pinned by `tests/skill.test.ts`); standard transcripts, `duet takeover`, resume, `state.json`-is-a-hint.
- *Deferred (one-line why each):* impl/overnight on the interactive host — headless is the permanent overnight substrate, interactive targets attended phases; AFK-everywhere incl. framing and mid-run detach — future scope, served today by the headless + `--gates-at` path, foreclosed by nothing here; codex-as-orchestrator (Q17) — interactive deepens the claude dependency; eval/replay harness — the event-driven kernel enables it, separate direction; doc updates — post-implementation per project convention.

## Stage 0 (shipped) — the foundation Stage 1 builds on

Stage 0 made the kernel host-neutral and the stdio-MCP boundary real, proven at behavioral parity by running the headless orchestrator on it. Production still drives **in-process** (`_drive` → `driveToQuiescence` → `invoke: phaseDriver` → `runPhase`); the stdio path (`duet _mcp`, `stdio-host.ts`) is parity-tested, not the production default. What shipped, and that Stage 1 leans on directly:

- **The seven tools are one host-neutral registry** (`src/harness/tools.ts`, `KernelTool`) carrying every protocol rail — round caps, once-per-phase template economy (warn-once-then-allow), the same-role in-flight guard, branch-fixed-after-first-prompt, the cooperative `ask_human` pause, and steer delivery (`withSteerDelivery`). Two thin adapters host it: the in-process Agent SDK server (`driver.ts`, `toSdkTools`) and the standard stdio MCP server (`mcp-server.ts`).
- **Two distinct event vocabularies** (`src/harness/machine.ts`, `phase-events.ts`): a phase emits an internal `phase.advance`/`phase.flag`, valid only from phase states; `human.approve|reject|answer` is a separate authority vocabulary, valid only from gate/flag-wait states. A gate has no `phase.*` handler, so `advance_phase` parks but cannot cross — a property of the vocabulary, not a prompt.
- **The persisted terminal marker is the cross-process phase decision** (`tools.ts` writes `state.terminalMarker`; `phase-events.ts` `markerToEvent` reads it back, phase-scoped), crash-guarded by the spent-marker guard and deliver-before-clear logic (`lifecycle.ts` `driveToQuiescence`).
- **The cooperative pause is a tool-result nudge, not a mechanical interrupt** (`docs/engineering.md` §"Cooperative pause"), so it crosses any process boundary unchanged.

**How a phase advances under the shipped kernel** (one kernel server; the orchestrator is a client):

```
kernel server  ── owns the 7 tools + RunState (stdio MCP);  machine transitions are transient over disk
   ▲ stdio MCP
   client = orchestrator   (Stage 0: headless query() / parity harness;  Stage 1: interactive CC session)
     calls advance_phase ─▶ marker written ─▶ machine parks at gate (quiescent)
                            result nudges the client to end its turn (cooperative pause)
   Human: duet continue --approve  ─▶ stageHumanInput → human.approve ─▶ next phase
```

The crossing is a `human.*` event from human authority via the CLI staging handshake (`src/run-store.ts` `stageHumanInput`/`consumeHumanInput`) or `gates_at` pre-authorization (`lifecycle.ts` `driveToQuiescence`) — never from an orchestrator tool.

## Stage 1 — the interactive orchestrator

### The flow of the change

**Current.** The only orchestrator client is duet-spawned and headless (`_drive`/`runPhase`, or the `stdio-host.ts` parity harness). The human cannot talk to it; they relay through the concierge into staged CLI input. `duet _mcp` requires an explicit phase (`src/cli.ts`, `mcp-server.ts` `buildKernelTools`) because a quiescent run has no live phase to infer, and it builds the phase tools once.

**Desired.** The human's interactive Claude Code session is a live client of the kernel over FRAME → PLAN, brought up per-run by `duet orchestrate`:

```
duet orchestrate <runId>
  └▶ launches:  claude  --mcp-config {duet: {command: duet, args: [_mcp, <runId>]}}
                        --strict-mcp-config
                        --append-system-prompt-file <skills/duet identity>
                        + ask rule: Bash(duet continue *)
        the human's session = the orchestrator (MCP client of the run-scoped kernel)

  per phase (FRAME → PLAN):
    get_task                 ─▶ this phase's entry prompt (orchestrator-prompts.ts), verbatim
    send_prompt / list_snippets / … (the unchanged 7 kernel tools over stdio MCP)
    advance_phase            ─▶ marker written; machine parks at gate; result: present packet, end turn
    (chat) present packet; propose:  duet continue --approve "<rider, optionally the human's verbatim words>"
       ─▶ ONE permission tap (survives bypass)  ─▶ stageHumanInput → human.approve
          ├─ gate ≤ PLAN : cross + rest at the next phase; the connected session drives it (get_task again)
          └─ PLAN gate   : cross into impl ─▶ spawnDrive detached headless _drive (AFK)   ── THE HANDOFF
                           the interactive session ends (one /duet session = one run)
```

### Coupling decision: extension of the Stage-0 kernel, not an independent module

Stage 1 is an additional **client** of the already-shipped stdio-MCP boundary plus a launcher and one new tool — not a parallel orchestrator. The interactive client connects to the same `duet _mcp` server the Stage-0 boundary exposes; the seven tools, the marker channel, the event vocabulary, and `orchestrator-prompts.ts` are reused unchanged. The headless in-process path (`_drive`/`runPhase`) is untouched and remains the AFK substrate. The named changes are scoped to: the `_mcp` server (run-scoped, phase-derived), one new tool (`get_task`), the launcher (`duet orchestrate`), and `duet continue`'s handoff-vs-rest decision for an interactive run.

### The launcher — `duet orchestrate <runId>`

Contract: bring up an interactive Claude Code session wired to drive `<runId>` over FRAME → PLAN.

- Spawns `claude` with `--mcp-config` declaring one stdio server (`command: duet`, `args: [_mcp, <runId>]`) — the dynamic runId is baked at launch, which a static project `.mcp.json` or a mid-session skill cannot do.
- `--strict-mcp-config` so the session's MCP surface is exactly the duet kernel — the hygiene the headless host gets structurally from `strictMcpConfig: true`, here at launch, with no settings file and no user/global MCP leakage.
- `--append-system-prompt-file` pointed at the `skills/duet/` identity, giving the orchestrator role system-prompt strength (durable across compaction, unlike a skill body which can truncate/drop).
- Applies the single gate-safety `ask` rule (below) and self-checks at startup that it is live, warning loudly if not — so gate protection is not a setup step the human can forget.
- Records on the run that its orchestration host is interactive (a run-level marker, distinct from config role-bindings — `src/config.ts`'s invariant is role→provider/model only). `duet continue` reads it to decide handoff-vs-rest.

The launcher exists *because* a skill cannot do launch-time wiring; the `skills/duet/` skill (identity, discoverability, the second of the two skills) and the launcher coexist by design — the skill is what `--append-system-prompt-file` carries.

### The run-scoped kernel server

The `duet _mcp` command becomes **run-scoped and phase-less** for the interactive host (`duet _mcp <runId>`): a single stdio server alive only for the session's lifetime, no resident loop.

- It derives the active phase from persisted run state per call (the position probe, `lifecycle.ts` `probeRunPosition`) rather than taking an explicit phase — a long-lived session spans many phases and cannot keep swapping a static `.mcp.json` arg.
- It caches the current phase's `createPhaseTools` instance and rebuilds it only when the phase changes, so the in-memory rails that are per-process by construction (`turnsInFlight`, the `resendWarned` warn-once set — `tools.ts`) keep their Stage-0 one-instance-per-phase semantics within a phase. (The persisted `sentSnippets` survives either way.)
- The machine is never a resident actor in the server: run state and the snapshot are reloaded from disk, and the machine is instantiated only transiently for a transition (see *The interactive lifecycle* for who runs those, and when). Disk stays the single source of truth.
- Narration goes to stderr; stdout is the JSON-RPC channel (unchanged from `mcp-server.ts`).

### The interactive lifecycle — advancing the machine without `_drive`

Today the machine-advance, snapshot-persist, and marker-clear all live inside `driveToQuiescence` (`lifecycle.ts`), run by the detached `_drive`. An interactive FRAME → PLAN run has no `_drive` — the connected session drives each phase by calling tools, and no duet actor is resident. So the spec fixes who advances and persists the machine, and where an interactive run rests between gates.

**The interactive machine variant.** Interactive transitions use a variant of `duetMachine` via the existing `machine.provide` seam (the one `stdioPhaseMachine` already uses): its `phaseDriver` is replaced with one that does no external work and is safe to restore and restart. Phase states still carry their `invoke` block — `provide` swaps the actor, it does not remove it — so a restored phase-loop snapshot does restart that actor; the snapshot is a legitimate **resting state** because the restart is *harmless* (the provided driver carries no in-flight work to lose), which is the property the persistence guardrail actually needs (`machine.ts`: never blind-restart an actor with live work). This is the chosen resting-state model. The alternative — a purely `RunState`-derived position with the snapshot lagging at the prior gate — is set aside not because re-applying a recorded human event is forbidden (crash recovery already re-utters `approve`/`answer` on standing authority, `lifecycle.ts`), but because the chosen model keeps the machine's durable position aligned with the phase the interactive session is actually driving and avoids maintaining a second, parallel transition derivation beside the statechart.

**The terminal tools are unchanged.** `advance_phase`/`ask_human` write the marker exactly as today and nothing more (`tools.ts`); no machine logic moves into the kernel handlers. While a marker is set and no driver is live, `probeRunPosition` derives the run's position **at the phase's gate/flag from the marker** — the one extension to the probe's contract (today it reads driver liveness + `machine.json` and does not consume `terminalMarker`). So `duet status` shows the gate and packet the instant the orchestrator advances, with no resident process.

**A post-terminal quiescence rail makes the long-lived server behave like quiescence.** Headless reaches quiescence by the SDK turn ending and the process exiting; a long-lived interactive server has neither, so the kernel must enforce quiescence structurally. Today only a *second terminal* call is refused once a current-phase marker is set (`tools.ts` `terminalAlreadySet`/`alreadyEnding`); `send_prompt`, `create_branch`, `list_snippets`, `write_note`, `propose_snippet_edit` can all still run. Stage 1 generalizes the rail: while a current-phase terminal marker is set, **every phase-continuing tool is structurally refused** with the same "this phase is ending" nudge, so the orchestrator cannot send another worker turn or mutate the run after the gate packet is recorded. The only surfaces that stay open are status / re-anchor reads — `get_task`, which at a set marker simply reports the parked gate/flag and re-anchors with nothing left to consume. The rail is harmless in headless (the turn has already ended) and load-bearing in interactive; the exact tool partition is the plan's.

**`duet continue` advances an interactive machine inline** (it does not spawn `_drive` for an early gate): it loads the resting snapshot under the interactive variant, consumes the marker's `phase.*` to reach the gate/flag, applies the human's `human.*` event, and persists the result — clearing the marker deliver-before-clear (after the post-crossing snapshot is durable). The persisted result is the next phase's interactive resting snapshot, which the connected session picks up via `get_task`. The marker-derived `probeRunPosition` and the existing spent-marker guard stay consistent because the interactive snapshot rests at the phase loop and is never persisted *at* the gate with its marker still set: the probe reports the gate only while the marker is live and uncrossed, and the spent-marker guard (which fires when a snapshot is restored *at* the marker's own gate/flag, `lifecycle.ts`) therefore never collides with it. Consuming the marker's recorded `phase.*` is the machine reading the orchestrator's own recorded decision (as `markerToEvent` does today), not the orchestrator emitting `human.*`; the `human.*` event is the human's, applied here. This keeps the gate logic unified — one statechart through `machine.provide`, not a forked `RunState`-only transition path (the duplication the Stage-0 coupling decision rejected).

**Two `duet continue` paths for an interactive run** (it branches on the orchestration-host marker and the next phase):

- *Before the plan gate (FRAME → PLAN):* apply the human event inline and persist the next phase's interactive resting snapshot; do not invoke `runPhase` or spawn a headless `phaseDriver`. The connected session drives the next phase.
- *At the plan gate (handoff):* the existing `spawnDrive` path — a detached headless `_drive` for AFK impl — and clear the host marker, since impl onward is headless.

**The orchestration-host marker's lifecycle** (a `RunState` field set by the launcher, not a config role-binding — `src/config.ts` is role→provider/model only):

- *Set* by `duet orchestrate` at launch.
- *Used* by `duet continue` to choose the interactive-rest path through the plan gate, and by `probeRunPosition` to read a phase-loop resting snapshot as interactive-active rather than crashed.
- *Cleared* at the plan-gate handoff, at `done`, and at `abandon`.
- *Never traps the run:* `state.json` is a hint and manual takeover must always work. `takeover` and `abandon` ignore the marker, and when the interactive session is gone the human has an explicit headless fallback — a phase begun interactive can always be finished headless. How `duet continue` distinguishes an attached session from a dead one, and the exact fallback surface, are plan details; the contract is that a dead interactive session can never strand a run.

### `get_task` — the canonical brief surface (side-effecting, exactly-once)

A new kernel tool — the one surface the session reads its instructions from. Contract: return the active phase's entry prompt — the existing `*PhaseEntryPrompt` output from `orchestrator-prompts.ts`, **verbatim** (documents block, branch policy, attendance posture, examples) — plus the run position. **It is not read-only.** It performs, exactly once per phase, the side effects today's headless prompt construction performs (`driver.ts` `basePrompt`/`buildPrompt`): mark `phaseStarted`, and consume any staged human input (a flag answer, an approval rider) so it is folded in once and cannot be replayed. The accepted crash-window tradeoff is the same one today's `buildPrompt` takes — a crash between consume and the model processing the input loses that carry, with the voice log as the evidence record.

Returning the entry prompt is idempotent; the side effects fire once. So one tool serves three moments without a second surface (a duplicate preview/consume split is worse for the model than one honest side-effecting tool):

- **Cold start** — the session calls it to learn what to do; it marks the phase started.
- **Post-gate resume** — after a crossing, the session picks up the next phase's brief and consumes any rider/answer.
- **Re-anchor after compaction or crash** — a later call re-returns the full entry prompt (re-anchoring on disk truth, `docs/prompting-and-tool-design.md`) with nothing left to consume; the once-only effects do not re-fire.

Because it mutates, it carries no `readOnlyHint`; the name should signal that it *claims* the task rather than previews it (final name is the plan's).

### Gate-crossing and the single `ask` rule

Gate authority in the interactive session is protected by exactly one permission rule: **`ask` on `Bash(duet continue *)`**. The session may *propose* a crossing (`advance_phase` parks; the orchestrator presents the packet and proposes `duet continue --approve "…"`), but running it triggers a permission prompt the human answers — that tap, on the terminal and on the phone via remote control, is the human uttering authority. No broad read-only/write-deny profile is shipped. The launcher delivers this rule through Claude Code's `--settings` (inline JSON or a generated temp settings file — confirmed present in the installed CLI) and self-checks at startup that it is live, so the guarantee never depends on the human having configured anything; the exact settings JSON is the plan's.

Rationale (resolved fact, current Claude Code docs, `code.claude.com/docs/en/permission-modes`): **deny and explicit ask rules apply in every mode, including `bypassPermissions` / `--dangerously-skip-permissions`; only allow rules become no-ops under bypass** (as of v2.1.126 bypass also covers writes to protected paths, but explicit `ask` rules still force a prompt). So the tap survives a human who launches every session with permissions bypassed — which is why one narrow `ask` rule is sufficient and a broad profile is not needed.

What this preserves and what it spends:

- **Gate-uncrossable holds, independent of any prompt or permission.** No MCP tool emits `human.*`; `advance_phase` emits `phase.advance`, which a gate state ignores. The one Bash-shaped path to a crossing (`duet continue`) is the `ask`-gated tap. The guarantee is structural in the event vocabulary, reinforced by the tap.
- **Read-only is spent honestly, and bounded.** On the headless AFK substrate read-only stays *by construction* (`tools: []` + `strictMcpConfig`), unchanged — where it matters most, the human asleep. In the interactive session it downgrades from construction to *instruction*: a Bash-equipped session in bypass mode could in principle write files or run mutating commands if it went badly off-role. This is acceptable only because interactive orchestration is opt-in, FRAME → PLAN only, and attended — the human is watching, a stray write surfaces in the narration and is caught at the next gate, and the AFK path keeps construction-enforced read-only.

The default crossing UX is the in-session tap (one tap per gate). Crossing from a separate pane or the concierge stays available and is the right channel for a reject carrying verbatim-heavy feedback, where the human prefers to type their own words rather than have the orchestrator compose them for the tap.

### The handoff to headless impl

Crossing the plan-approval gate is the orchestrator's `duet continue --approve` (behind the tap); per the two interactive `continue` paths above, this gate alone takes the `spawnDrive` branch — a detached headless `_drive` for AFK impl (`lifecycle.ts`) — clears the host marker, and the interactive session ends. AFK impl runs under duet's own lifecycle (crash handling, pid guard, status model), supervised by the concierge exactly as today.

No Claude Code primitive owns the handoff — it is duet's existing detached-child spawn. Evaluated and rejected: `/loop` (an interval watcher; AFK supervision is already the event-driven `duet status --json --wait`, and looping inside the orchestrator would make `/duet` a watcher, not the orchestrator), `/fork` and sub-agents (a background subagent inheriting the chat context is the wrong substrate — impl needs the fresh kernel-controlled headless orchestrator with the persisted run state, phase budgets, and gate vocabulary, not a fork of the live conversation), CC background tasks (no better than the detached `_drive`), and `--resume`/`--continue` (continue a chat, not duet's per-phase headless model).

### The `skills/duet/` identity

The shipped skill carries the orchestrator's operating identity, fed to the session by the launcher's `--append-system-prompt-file`. At spec altitude it must establish: the division of labor (the orchestrator does process triage, never artifact opinions — `orchestrator-prompts.ts` `<division_of_labor>` is the governing content); that gate crossing is the human's and is performed by proposing `duet continue` for the human's tap, never assumed; that artifacts are produced by workers via `send_prompt`, never written by the orchestrator directly; and that the session re-anchors via `get_task` on cold start, after a gate, and after compaction. It is `disable-model-invocation` and explicit-invocation-only (mirroring the concierge), so a session developing duet never inherits the orchestrator role. The skill is `duet`, invoked `/duet`, distinct from the `duet` CLI binary. The exact prose is governed by `docs/prompting-and-tool-design.md` and authored at plan/impl time.

### Interactive-host crash recovery

The interactive client is the human's session, not duet-spawned, so recovery is **re-anchor-only**, with no resident daemon: relaunch `duet orchestrate <runId>`, which reconnects the kernel and re-anchors via `get_task` on disk truth; or fall back to driving that phase headless (a phase begun interactive can always be finished headless). The kernel server holds no unflushed state — every terminal decision is persisted at the moment of the tool call — so a dropped session loses no committed progress; it leaves the run at its last interactive resting position, which `probeRunPosition` reports (not a crash). Stage 0's `stdio-host.ts` crash=flag does **not** cover this case: it converts boundary failure to a flag only when duet owns the MCP client, and in Stage 1 Claude Code owns the client — if it disconnects, the kernel subprocess simply exits and no supervisor writes a pending question. A duet-owned watcher that flags a dead interactive session is possible but deferred (below); Stage 1 relies on the human, who walked away from an attended session, returning to relaunch.

### Cost telemetry

The interactive orchestrator bills the flat subscription quota, so its spend is not reported the way the headless `query()` returns `total_cost_usd` into `state.costs.orchestratorUsd`. Stage 1 marks the orchestrator cost as partial/unmetered when the host is interactive, mirroring the worker interactive-transport's `claudeWorkersCostPartial` flag (`tools.ts`), so `duet status` never presents the known sum as the complete total. The marker is an **additive** field (e.g. an `orchestratorCostPartial` flag), never an overload of `orchestratorUsd` — `status --json` is additive-only and pinned by `tests/skill.test.ts`; the exact field is the plan's.

## Behaviors that matter (for the plan to turn into tests)

Named at behavior altitude; cases, fixtures, and mocking boundaries are the plan's.

- **Gate-crossing cannot originate in the orchestrator's reasoning loop.** No MCP tool emits `human.*`; `advance_phase` parks. The Bash path is `ask`-gated and the tap survives bypass. The load-bearing invariant.
- **The interactive machine advances without `_drive`.** The terminal tools only write the marker; while a marker is set with no live driver, `probeRunPosition` reports the phase's gate/flag from the marker; `duet continue` advances the non-driving interactive variant inline through the plan gate; a phase-loop resting snapshot of that variant reads as interactive-active, not crashed.
- **`get_task` is side-effecting and exactly-once.** It returns the active phase's entry prompt verbatim (idempotent) and, once per phase, marks `phaseStarted` and consumes staged human input (same crash-window tradeoff as today's `buildPrompt`); not read-only.
- **The run-scoped server derives phase per call and caches the phase's tool instance**, so the in-flight and warn-once rails behave within a phase as they do headless, and crossing into a new phase rebuilds them.
- **The plan-approval crossing hands off to headless impl** (detached `_drive` via `spawnDrive`), clears the host marker, and ends the interactive session; earlier gates rest for the connected session to drive.
- **Read-only-by-construction is unchanged on the headless substrate** (`tools: []` + `strictMcpConfig`); the interactive downgrade to instruction is bounded to opt-in, FRAME → PLAN, attended.
- **Interactive-host crash recovery is re-anchor-only** (relaunch `duet orchestrate` + `get_task`, or explicit headless fallback); no duet-owned supervisor flags a dead interactive session, and the host marker never traps a run (`takeover`/`abandon` ignore it).
- **Concierge compatibility.** `status --json` schema unchanged and additive-only (pinned by `tests/skill.test.ts`); the concierge keeps supervising headless/AFK runs.

## Confirmed defaults (settled at the Direction gate)

- **Walk away at plan-approval** — the plan-gate crossing hands impl to headless; the human supervises from the concierge.
- **One permission tap per gate, in-session** — the orchestrator proposes, the human taps; a separate-pane/concierge crossing stays available for verbatim-heavy rejects.
- **One `/duet` session = one run**, ending at the plan-approval handoff.
- **Docs/PR via the concierge/CLI**; interactive `/duet` is reserved for FRAME → PLAN.

## Open questions / risks / deferred scope

- **Bash-rule form (verify at impl).** Current docs give the space form `Bash(duet continue *)`; the shipped `duet-concierge` SKILL.md uses the colon form (`Bash(duet status:*)`). Confirm the correct form against the live CLI and migrate the concierge if the colon form is a latent bug. The `ask` rule's correctness depends on this.
- **Duet-owned watcher for a dead interactive session (deferred scope).** Stage-1 interactive recovery is re-anchor-only; a supervisor that flags a disconnected interactive session — so a dropped attended run surfaces rather than waiting for the human — is possible and deferred. Not required, since the human attends FRAME → PLAN. (The interactive resting-state model itself is resolved above, in *The interactive lifecycle*, not an open question.)
- **Identity delivery.** Skill body fed via `--append-system-prompt-file` vs. a separate identity file in the skill directory; reuse-not-duplicate is the constraint, the file layout is a plan detail.
- **AFK-everywhere — explicit non-goal / deferred future scope.** Starting a well-framed run and walking away even from framing, and detaching an interactive session into headless mid-run, are not built here. They are served today by the pure-headless path with `--gates-at`, which Stage 1 leaves untouched (interactive is purely additive: if `duet orchestrate` is never run, the run is headless exactly as today). Nothing in Stage 1 forecloses them — interactive and headless share one kernel, and the detach point would be the same `gates_at`-style pre-authorization applied to an interactive run.
- **Doc updates** — post-implementation, per project convention.
