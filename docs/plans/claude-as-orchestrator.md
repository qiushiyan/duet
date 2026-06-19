# Plan: Claude Code as the orchestrator — Stage 0

Implements **Stage 0 only** of `docs/specs/claude-as-orchestrator.md` (reread it first): the event-driven run-kernel, the stdio-MCP boundary, and the headless orchestrator running on the kernel at behavioral parity (the regression oracle). Stage 1 (the live interactive `duet` skill, the read-only profile, the `claude-code` host) is a stacked follow-on PR.

Authoring of any agent-facing prompt surface (tool descriptions, result text) follows `docs/prompting-and-tool-design.md` (the durable authority) and the `prompt-engineering` skill (`docs.local/prompt-engineering/skill.md`, confirmed in-repo) as an authoring aid.

## Plan-level calls (flagged for the gate)

Two tactical calls within the settled direction. Both are flagged so the plan reviewer / human can veto; neither challenges a settled coupling decision.

1. **A real stdio-boundary parity path lands in Stage 0 (revised after review).** I originally proposed keeping the stdio server an off-critical-path read-only demonstrator; the reviewer pushed back and is right on the merits. The risk this work exists to retire is whether the kernel's *control events* survive the host boundary — `advance_phase` parking, `ask_human` → flag-wait, the cooperative pause, turn-ending steer suppression, persistence, and crash conversion — and tool *enumeration* (`list_snippets`) proves none of it. So Stage 0 drives at least one real phase's control events **over** the stdio MCP boundary, via a hidden/test host (Slice 3). What stays in-process is the **production** `_drive` default — preserving the clean in-process parity oracle, read-only-by-construction (`tools: []`, `strictMcpConfig`, `src/harness/driver.ts:146`), and "nothing runs between stops." Crash framing, corrected: production in-process crash=flag is unchanged (`runPhase` catch, `src/harness/driver.ts:99`), **and** the new boundary host owns MCP client/server failure → the same persisted-question conversion, tested in Stage 0 (Slice 3). Only the full Stage-1 interactive-host *recovery* (resume-same-session / headless re-entry) still defers; the boundary *failure→flag* conversion does not. The Claude-Code-specific risks (identity, read-only profile, session lifetime) remain genuinely Stage-1 — the SDK-over-stdio path de-risks the shared MCP plumbing, not those.

2. **Stage 0 writes no inert Stage-1 artifacts.** The spec says this session *designs* (not ships) the `duet` skill identity and the read-only permission profile — and that design already lives in the committed spec (§"The interactive host and read-only enforcement"). So Stage 0 writes **no** `skills/duet/SKILL.md`, **no** `.mcp.json`, **no** managed `settings.json` profile, and **does not** add the orchestrator `host` field to `src/config.ts`. Reason: each is only meaningful once the interactive client exists; written inert now they would drift from the Stage-1 implementation, be untestable, and read as a `/duet` skill that can't drive a run (speculative artifacts). What Stage 0 *does* do toward Stage 1 is the load-bearing enabler — a host-agnostic tool surface whose control events are proven over stdio (Slices 2–3) — so Stage 1 only adds the Claude Code client, the profile, the skill, and the `host` binding. **Veto point:** if you want the `duet` identity prompt drafted now for early review, I'll add it as a non-shipped draft under `docs/`, not as a live skill.

## Current control flow being reshaped (anchors)

- `src/harness/machine.ts`: phase states `invoke` the `phaseDriver` actor; `onDone` is guarded by `isAdvanced` (`:69`, `:127`–`:139`); the only events are `human.*` (`:131`). Gates/flag-waits are actor-less, `human.*`-only (`:86`–`:103`).
- `src/harness/driver.ts`: `runPhase` → `drivePhase` runs the SDK session, then reads the `outcome` flags and returns `DriverOutput` (`:56`–`:58`, `:221`–`:223`); `createPhaseTools` is mounted in-process (`:76`, `:128`–`:137`).
- `src/harness/tools.ts`: `createPhaseTools` returns `{ tools, outcome }` (`:55`, `:59`); `ask_human` sets `outcome.questionQueued` (`:282`), `advance_phase` sets `outcome.advanceRequested` (`:380`); `withSteerDelivery` suppresses steer delivery when an `outcome` flag is set (`:451`–`:471`, esp. `:455`).
- `src/harness/lifecycle.ts`: `driveToQuiescence` runs the actor to a `quiescent` stop, auto-crosses pre-authorized gates with `human.approve` (`:253`–`:264`) — the *second* non-orchestrator `human.*` source.
- `src/run-store.ts`: `stageHumanInput`/`consumeHumanInput` (`:233`, `:243`) — the *first* `human.*` source (CLI staging).

---

## Slice 1 — The event-driven kernel: `phase.*` events replace the outcome/guard coupling

**Goal.** Delete the in-memory `outcome`-flag coupling and make phase completion a pair of internal machine events — `phase.advance`, `phase.flag` — handled only by phase states. This is the concept-deleting refactor; a real headless run drives the new kernel end-to-end, so the slice is a full vertical tracer.

**What changes (cited):**

- `src/harness/machine.ts`
  - Add `phase.advance` and `phase.flag` to the event union (`:131`).
  - `phaseState` (`:56`–`:84`): replace `invoke.onDone` + `isAdvanced` guard with `on: { 'phase.advance': → gate, 'phase.flag': → flagWait }`; keep `onError → flagWait` as the bug-backstop. The `phaseDriver` actor still runs (so the seam survives) but now **emits** events to the parent rather than resolving an outcome.
  - Delete the `isAdvanced` guard (`:134`) and the `DriverOutput`-shaped `onDone` mapping.
  - Gate states (`:95`–`:103`) are unchanged — and now *structurally* ignore `phase.*` (no handler), which is the gate guarantee expressed in the vocabulary.
- `src/harness/driver.ts`
  - The phase actor body runs the orchestrator session as today (`sdkTurn`, the nudge-once loop, crash→flag), but instead of returning `DriverOutput` it **emits** `phase.advance` / `phase.flag` *after the session quiesces* — preserving the cooperative pause (the tool result still nudges "end your turn" before any transition). Delete the `outcome`-read return mapping (`:221`–`:223`) and the `DriverOutput` type (`:56`–`:58`).
  - Which event to emit is read at quiescence from the **persisted terminal marker** (below) — not a polled in-memory object; an absent marker resolves to continue/nudge (clean quiescence) or flag (abnormal exit) per the qualifier below. The marker is cleared only after the resulting snapshot is saved (deliver-before-clear), and a present marker on re-entry re-drives without re-running the session. This is the same read-and-clear discipline the stdio host runner uses in Slice 3.
- `src/harness/tools.ts`
  - `createPhaseTools` stops returning a driver-polled `outcome` object (`:55`, `:59`). The terminal decision becomes a **persisted structured terminal marker in run state** — at least `{ phase, kind: 'advance' | 'flag' }` — written when `advance_phase`/`ask_human` run (`:282`, `:380`) **in the same `saveRunState` as** the `phaseSummaries`/`pendingQuestion` they already persist, so first-terminal-wins and the gate packet are one atomic write. Their cooperative-pause result text is unchanged (`:285`–`:292`, `:392`–`:394`).
  - **Why persisted, not in-memory (the cross-process channel — round-2 #2/#5).** The host emits `phase.*` by *reading the persisted marker after the orchestrator session quiesces*, never by scraping tool-result text. An in-memory latch works in-process but is invisible once Slice 3 moves the tools into the `_mcp` server process; a persisted marker is **one channel serving all three hosts** — the in-process driver, the stdio host runner, and Stage 1's interactive client.
  - **Consume ordering: deliver-before-clear (round-3, load-bearing).** `state.json` (the marker) and `machine.json` (the snapshot) are atomic per file but not transactional across the two (`src/run-store.ts:164`, `src/harness/lifecycle.ts:249`), so the marker must outlive the transition until it is durably reflected. The host **reads the marker and emits `phase.*` without clearing it first**; the marker is cleared **only after** the machine reaches the resulting quiescent state *and* that snapshot is saved (`lifecycle.ts:249`). Replay is then safe — a crash before the clear re-delivers the marker: re-entered in the original phase it re-drives the same transition (the `phaseSummaries`/`pendingQuestion` it carries were written atomically with it, so nothing double-applies, and the session need not re-run); if the snapshot already advanced, the marker's `phase` no longer matches the active phase and the parked gate/flag-wait ignores `phase.*` (the Slice-1 structural no-op), so the stale re-delivery is harmless.
  - **Absent-marker qualifier (precise).** A *failed/abnormal* session with no marker is crash=flag (today's `runPhase` catch); a *cleanly quiesced* session with no marker is the normal continue/nudge path (today's `'continue'` outcome — nudge once, then flag), **not** a crash. The marker only changes how advance/flag is observed across a process boundary; the failure-vs-success distinction stays the session's, exactly as today.
  - **Terminal-marker rule (replaces today's implicit precedence).** Today both flags are mutable and the driver reads `advanceRequested` before `questionQueued` (`src/harness/driver.ts:221`) — an accidental advance-beats-flag order, not a rule. It is **first-terminal-wins**: the first of `advance_phase`/`ask_human` in a turn sets the marker; a second terminal call afterward returns a steering error (the warn pattern, `docs/prompting-and-tool-design.md`) naming that the phase is already ending — so exactly one `phase.*` event is emitted at quiescence. `withSteerDelivery`'s suppression (`:455`) reads the same single-turn decision locally; the `ask_human` staged-answer fast-path (`:274`) is **not** terminal and never sets the marker.
- `tests/helpers/scripted-machine.ts`: the fake `phaseDriver` **sends** scripted `phase.*` events (`sendBack`) instead of returning `DriverOutput[]`; signature becomes `scriptedMachine(events: PhaseEvent[])`.

**Design notes.** The cooperative-pause timing is the subtle part and warrants red-green-refactor: the transition must fire only after the session loop ends, or the open `query()` stream is torn down before the model sees the nudge. The exact XState idiom (a `fromCallback` actor that `sendBack`s on completion vs. an equivalent) is settled during the loop; the tests below pin the behavior regardless. Aim for a deep `phaseDriver` actor: small interface (emits two events), all session/nudge/crash complexity hidden — keeps the test surface at the machine's event boundary.

**Behaviors to test** (through public interfaces — the machine actor and `runPhase` via the existing seams):

- `advance_phase` parks the run at the phase's gate, not past it (frame → `directionGate`, quiescent).
- `ask_human` lands the run at the phase's flag-wait (`frameFlagWait`) with the `pendingQuestion` persisted.
- **Load-bearing gate guarantee:** a `phase.advance` (or `phase.flag`) event delivered to the machine while it sits in a gate state is a no-op — the run stays at the gate. (Drive to a gate via `scriptedMachine`, send `phase.advance`, assert unchanged.)
- **Authority side (the other half of the invariant — named, not folded into "suite stays green"):**
  - `human.approve` / `human.reject` delivered while the machine is in a phase state crosses nothing (phase states have no `human.*` handler).
  - `phase.advance` / `phase.flag` delivered at a flag-wait is ignored.
  - `gates_at` pre-authorization auto-crosses **only after** `phase.advance` has parked the machine at the gate — the second legitimate `human.*` source: a scripted phase that advances under a pre-authorized gate auto-crosses; one that flags first parks at the flag-wait instead.
  - A gate otherwise crosses only on `human.approve`; reject re-enters the loop (`tests/machine.test.ts` re-asserted).
- **Terminal marker:** a scripted session that calls both `advance_phase` and `ask_human` in one turn emits exactly one `phase.*` event (first wins) and the second call's result is a steering error; the `ask_human` staged-answer fast-path emits no `phase.*` and continues with the answer consumed.
- **Marker replay across the persistence boundary:** a crash *after the snapshot is saved but before the marker is cleared* must not double-emit on re-entry (the parked gate/flag-wait ignores the stale `phase.*`, and the marker's `phase` no longer matches); a crash *after the marker is written but before the transition* re-drives the same transition on re-entry without re-running the session. Absent-marker: clean quiescence → continue/nudge; abnormal exit → flag.
- **Cooperative pause preserved:** the `advance_phase`/`ask_human` result still carries the "end your turn" nudge, and steer delivery is suppressed on a turn-ending result while still delivered on phase-continuing ones (adapt `tests/tools.test.ts` steer-delivery cases to the latch).
- **Crash = flag preserved:** a scripted session that throws lands the run at the flag-wait with an infra `pendingQuestion` (re-assert the existing `tests/driver.test.ts` crash path).
- **Parity safety net:** the full existing suite (`machine`, `driver`, `tools`, `lifecycle`, `status`) stays green — the regression oracle for "no observable behavior changed."

**Helpers & fixtures.** Reuse `tests/helpers/fixtures.ts` (`projectDir`, `run`, `FakeWorker`) and `scriptedSession` (`tests/driver.test.ts`). Update `scriptedMachine` as above. Add a small fixture for "a run parked at a gate" (drive `scriptedMachine([{type:'phase.advance'}])` to the gate) to exercise the gate-ignores-`phase.*` case without a full session.

**Verification.** RED-GREEN-REFACTOR within the slice (subtle timing). Run `pnpm typecheck` and `pnpm test` at slice end. Commit.

---

## Slice 2 — A host-neutral tool registry and the stdio-MCP adapter

**Goal.** Make the kernel's tool surface genuinely host-agnostic — a source of truth independent of any one SDK — and expose it over a standard stdio MCP server. This is the seam Stage 1's interactive host connects to; here it carries the read-only transport proof. (Slice 3 then drives control events over it.)

**What changes (cited):**

- **Host-neutral registry.** Introduce a small internal `KernelTool` type/registry (name, description, zod schema, handler, annotations) as the single source of truth, extracted from the current `createPhaseTools` body (`src/harness/tools.ts:82`–`:437`). The handler logic is unchanged; what changes is the *type* it's packaged as — today it's `SdkMcpToolDefinition` from `@anthropic-ai/claude-agent-sdk` (`src/harness/tools.ts:1`–`:2`, `:47`), which leaks the Agent SDK into anything that hosts the tools. The registry removes that coupling so the "standard MCP" adapter doesn't depend on the Claude SDK's tool shape.
- **Two adapters over one registry:** one to `createSdkMcpServer` (the in-process headless host — `src/harness/driver.ts:76`–`:86` adapts `KernelTool[]` instead of importing the SDK tool type), one to a standard MCP `Server` + stdio transport in a new `src/harness/mcp-server.ts`. No handler logic is duplicated.
- **Dependency.** Add `@modelcontextprotocol/sdk` as a **direct** dependency (`package.json:33`–`:42` declares only `@anthropic-ai/claude-agent-sdk` among MCP-capable deps), pinned compatibly with the Agent SDK's protocol version — a first-class boundary shouldn't ride a transitive SDK.
- **Hidden harness command `duet _mcp <runId> <phase>`** in `src/cli.ts`, beside `_drive` (`:325`–`:341`): loads the run, builds the registry for the **explicit** `<phase>`, and serves it over stdio. The explicit phase is deliberate — `createPhaseTools` requires a `PhaseName` (`src/harness/tools.ts:36`, `:58`) and a quiescent run has no live phase context, so inferring it would force ad-hoc guessing; `_mcp` is a *developer/test harness*, not the production driver (which derives its phase from the running machine). It refuses a run/phase it can't host with a recovery-prescribing error (convention 4).
- `src/config.ts`: **unchanged** (the orchestrator `host` field defers to Stage 1 — nothing in Stage 0 selects a host).

**Design notes.** The registry is a deep module: a small interface (the `KernelTool` list) hiding all handler/rail logic, with thin transport adapters on top — the test surface stays at the protocol boundary and the same handlers serve both hosts. Keep `.duet/` real; the MCP protocol is the boundary the tests exercise, not a mocked internal.

**Behaviors to test:**

- A standard MCP client (`@modelcontextprotocol/sdk` client over a linked/in-memory transport against `mcp-server.ts`) **enumerates all seven tools** by name and schema.
- `list_snippets` over the boundary returns the phase-focused library body for the named phase — identical to the in-process host (compare against a direct `renderSnippetLibrary`); `list_snippets` is the safe read-only poke (`readOnlyHint`, no side effects, `src/harness/tools.ts:101`).
- **One source of truth, two transports:** a table-driven check that the SDK-host and stdio-host tool sets expose identical names and **normalized JSON-schema (the MCP-visible shape)** — comparing the serialized schema each transport advertises, not Zod internals or object identity (round-2 #3).
- `_mcp` refuses a run/phase it can't host with a prescribed-recovery error.

**Helpers & fixtures.** Reuse `projectDir`/`run`. Add a helper that links an MCP SDK client to the server over the in-memory transport (no subprocess) for fast tests; the *manual* poke uses `duet _mcp <id> <phase>` + the MCP Inspector (the spec's manual-validation story).

**Verification.** Test + code together. `pnpm typecheck` and `pnpm test` at slice end. Commit.

---

## Slice 3 — Behavioral parity over the boundary: control events survive stdio MCP

**Goal.** Retire the actual risk this work exists to build: prove the kernel's **control events** survive a real host boundary, not just tool enumeration. A test orchestrator client drives a real phase over stdio MCP, and the kernel parks, persists, and converts failure exactly as the in-process path does. Production `_drive` stays in-process; this is a hidden/test parity host.

**What changes (cited):**

- A thin **stdio host runner** (the boundary owner) that drives one phase by connecting an orchestrator client (a real SDK `query()` against the `_mcp` server) to the kernel and running it to quiescence — the SDK-over-stdio sibling of the in-process `runPhase`, and the seam Stage 1's interactive host slots into.
- **Terminal-event channel (round-2 #2, round-3 ordering):** after the client quiesces, the host runner *reads* the persisted terminal marker (Slice 1) and emits `phase.advance`/`phase.flag` to its machine — no tool-result-text scraping — then clears the marker **only after** the resulting quiescent snapshot is saved (deliver-before-clear). The marker lives in run state, not the `_mcp` process's memory, which is what makes the cross-process latch observable and crash-safe. This is the same channel Stage 1's interactive client will use — leverage, not test plumbing.
- It owns MCP client/server failure and converts it to the same persisted `pendingQuestion` the in-process `runPhase` catch produces (`src/harness/driver.ts:97`–`:113`) — a dead peer leaves no marker, which reads as crash=flag.
- No change to production `_drive` / `lifecycle` defaults.

**Behaviors to test** (the boundary, end to end, at the existing state/seam interfaces):

- `advance_phase` **called over stdio** parks the run at the gate (quiescent) with `phaseSummaries` persisted — the same end state as the in-process path.
- `ask_human` over stdio lands the run at the flag-wait with `pendingQuestion` persisted.
- **Cooperative pause survives the boundary:** the "end your turn" result reaches the client across the transport, and turn-ending steer suppression still holds (a steer staged mid-turn is not delivered on the terminal result).
- **Boundary failure → flag:** killing the MCP client (or server) mid-turn converts to a persisted `pendingQuestion`, never a silent state — the boundary's crash=flag, owned by the stdio host runner.
- `gates_at` pre-authorization still crosses **only after** the kernel has parked at the gate over the boundary (authority unchanged by the transport).

**Helpers & fixtures.** Reuse `projectDir`/`run`. The **parity smoke runs over a real `duet _mcp <runId> <phase>` subprocess + stdio client** — at least one `advance_phase` and one `ask_human` happy-path case — so the proof exercises a genuine separate stdio peer, the same topology as the failure test (round-2 #1/#7); the failure test then spawns that subprocess and signals one peer mid-turn. The linked in-memory transport stays for the faster lower-level adapter coverage in Slice 2, never as the parity proof.

**Verification.** RED-GREEN-REFACTOR (the failure-conversion is subtle). `pnpm typecheck` and `pnpm test` at slice end. Commit.

---

## Cross-cutting

- **Mocking boundaries (the four seams only; never our own modules):** `RunOrchestratorTurn` via `scriptedSession`; `WorkerProvider` via `FakeWorker`; the `phaseDriver` actor via `machine.provide`/`scriptedMachine`; the `.duet/` filesystem real in tmpdirs. The MCP protocol is exercised with a real MCP client/server, never a mocked internal: the linked in-memory transport covers **Slice-2 adapter behavior only**, while **Slice-3 control-event parity *and* the boundary-failure test both run over a real `_mcp` subprocess** (same topology).
- **What stays untouched (parity surface):** `probeRunPosition`, `status.ts`, the `--json` schema, the concierge skill, `gates_at` auto-cross, the steer store, branch policy — none depend on the `outcome`/`isAdvanced` internals, so all are unchanged and their tests are the parity net.
- **Verification cadence (project convention):** `pnpm typecheck` + `pnpm test` at the end of each slice and at the end of implementation — not per change.
- **Docs:** deferred wholesale to post-implementation via the `/update-docs` skill. No slice writes docs.
- **Commits:** one per slice (Slice 1, then 2, then 3). No engineered intermediate commit boundaries.

## Out of scope (Stage 1 follow-on PR)

The interactive `claude-code` host wiring (an external CC session driving the kernel over stdio), the read-only managed-permissions profile + `.mcp.json`, the `duet` skill shipped live, the orchestrator `host` config field, partial cost telemetry, and interactive-host crash *recovery* (resume-same-session / headless re-entry). Note the boundary's crash=flag *conversion* is in scope now (Slice 3) — only the recovery flows defer. All of the above rests on Slices 1–3 and the committed spec's design.
