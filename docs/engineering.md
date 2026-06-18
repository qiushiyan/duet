# Engineering notes — the codebase's mental model

How the implementation is shaped and why. Companion to `automation-design.md` (the system design: roles, phases, gates, policies). Read that before changing *behavior*; read this before moving *code*. Audience: an engineer — human or agent — touching `src/` for the first time.

## The trust gradient

One sentence holds the architecture: **deterministic code constrains an intelligent orchestrator, which commands two workers — trust flows one way.**

```
statechart (when)   →   tool handlers (what's allowed)   →   prompts (judgment)
hard guarantee          enforced rail                        steerable
```

Placement rule for any new rule: violating it would break the human's authority or the run's integrity → statechart or tool handler. Violating it would merely waste tokens or quality → prompt. The design history (automation-design §"Design history") is one long lesson about this line — the pre-pivot router put *judgment* in code (string-matching disagreements, caps as exit rules) and failed; the pivot moved judgment up into an LLM and moved *guarantees* down into structure. Never drift back: no code that parses worker prose for meaning, no prompt that is the only thing between an agent and a gate.

## Module map

| Module | Owns | Note |
|---|---|---|
| `src/phases.ts` | The arc as data: phase order, gate state names + human copy, round caps, budgets, timeouts, review-loop posture, per-phase snippet sets | The single source. Machine states derive from it; every consumer looks up |
| `src/harness/machine.ts` | The statechart skeleton | Each phase = loop + flag-wait + gate, built from the table; `phaseDriver` is a callback actor that emits a `phase.*` event |
| `src/harness/phase-events.ts` | The completion vocabulary: `phase.advance`/`phase.flag` (internal) vs the `human.*` authority events, plus the pure marker→event read | The one place the persisted decision is read back; phase-matched, shared by both hosts |
| `src/harness/tools.ts` | The seven tools as a host-neutral `KernelTool` registry, every protocol rail, and steer delivery (pending steers ride every phase-continuing result) | The deepest module: 7-handler interface, all enforcement inside; no Agent SDK import |
| `src/harness/driver.ts` | The in-process host: one phase = one orchestrator Agent SDK session; resolves the `phase.*` event; steer carry-forward into prompts | SDK behind the injectable `RunOrchestratorTurn` seam; `toSdkTools` is the in-process adapter |
| `src/harness/mcp-server.ts` | The standard stdio-MCP adapter over the registry, and the body of the hidden `duet _mcp` dev/test harness | Sibling of driver.ts's in-process adapter; narration to stderr (stdout is JSON-RPC) |
| `src/harness/stdio-host.ts` | The out-of-process driver — the SDK-over-stdio sibling of `runPhase` — and the orchestrator-client seam | Connects a client to a real `_mcp` subprocess; reuses the lifecycle unchanged |
| `src/harness/lifecycle.ts` | The detached `_drive` process, pid guard + `killDriver`, quiescence loop, `gates_at` auto-cross, the spent-marker guard, and `probeRunPosition` (where a run is) | The only place machine actors run for real |
| `src/harness/orchestrator-prompts.ts` | System prompt + phase entry/resume prompts + the steer block renderer | Governed by `prompting-and-tool-design.md` |
| `src/run-store.ts` | `.duet/runs/<id>/` persistence: state hint, machine snapshot, voice logs, notes; the persisted terminal marker (the cross-process phase decision); the CLI↔driver input-staging handshake; the steer store (`steers/`, file-per-steer, rename-consume); the context hint + its `context/<voice>` sidecars; the abandoned marker + `purgeRun` teardown | Atomic writes; `state.json` is a HINT — transcripts are truth |
| `src/sessions.ts` | Locating a run's provider session transcripts by exact session id (claude project dir, codex rollout suffix) | The one module reaching outside `.duet/`; `purgeRun`'s `--purge` deletes what it finds |
| `src/providers/` | The worker seam: contract (`types.ts`), claude + codex adapters, factory (`index.ts`); per-provider context-window probes (claude in-band, codex rollout tail-read), fail-soft. The claude provider has two transports — headless `claude -p` and the opt-in interactive TUI driver (`interactive-claude.ts` + the `pane.ts` injection seam; `interactive-transport.md`) | Exactly two providers, by design; interactive is a second claude *transport*, not a third provider |
| `src/framing.ts` | The framing's whole journey: seed-template selection (built-in or project `.duet/templates/`), editor flow, frontmatter parse, flag-vs-frontmatter resolution | The machine/prose boundary rule lives here |
| `src/status.ts` | RunState + position → the status model; two renderers (human text, `--json` verbatim), pure | No fs, no process table, no xstate; the JSON schema is additive-only, pinned by test |
| `src/cli.ts` | Command wiring only | Behavior lives behind it; parses under `import.meta.main`, so the command table imports side-effect free. Two hidden harnesses: `_drive` (the detached in-process phase driver) and `_mcp <runId> <phase>` (serve the kernel over stdio) |
| `skills/duet-concierge/` | The shipped concierge skill: relay disciplines, the channel table, the supervision recipe, the CLI reference | Zero runtime; coherence-guarded by `tests/skill.test.ts` |
| `src/colorize.ts`, `tmux-view.ts`, `notify.ts` | View glue — best-effort, never allowed to affect the run | Deliberately untested |
| `src/spike/` | The substrate spike + SDK pause/resume repros — executable evidence | Not tests; do not modernize |

## Seams

A seam = a place behavior swaps without editing code in place. Six deliberate ones exist; tests fake **only** at these:

| Seam | Adapters | Why |
|---|---|---|
| `WorkerProvider` (`providers/types.ts`) | claude, codex, tests' `FakeWorker` | Role–provider decoupling (design) doubles as worker scripting (tests) |
| `RunOrchestratorTurn` (`harness/driver.ts`) | Agent SDK, scripted sessions | The in-process SDK boundary; a fake session receives the real tool handlers and may invoke them |
| `Orchestrate` (`harness/stdio-host.ts`) | scripted client (tests), interactive CC session (Stage 1) | The out-of-process sibling of `RunOrchestratorTurn` — drives the kernel over a real stdio MCP boundary; the seam the Stage-1 host slots into |
| `phaseDriver` actor (`harness/machine.ts`) | `runPhase`, `runPhaseOverStdio`, `machine.provide` scripts | XState's own substitution mechanism; the in-process and stdio hosts both plug in here, so the lifecycle is reused unchanged |
| Environment (`$EDITOR`, config path, notify fn) | real / stubbed | OS boundaries |
| `PaneController` (`providers/pane.ts`) | `TmuxPane`, tests' `FakePane`, owned-pty (later) | The injection/process sub-seam *inside* the interactive claude transport — keeps the transcript parser transport-independent so owned-pty swaps in unchanged (`interactive-transport.md`) |

Rule: a new abstraction earns a seam only when a second adapter exists or a test needs one (`PaneController` earned both — a test now, pty later). Otherwise call directly — pass-through layers get deleted on sight.

## Patterns that carry the design

- **Phase table.** Adding or tuning a phase is one row in `phases.ts`. A `Record<PhaseName, …>` appearing anywhere else means the field belongs in the table.
- **Rails as tool results.** Every rail is a handler that *refuses with steering text*: template-economy warn-once-then-allow, review-round backstop caps, branch-fixed-after-first-prompt, advance-needs-a-review-round. A rail isn't real until its result text tells the orchestrator what to do instead (prompting doc, convention 5).
- **Host-neutral kernel, two adapters.** The tool surface is one `KernelTool` registry (`tools.ts`), independent of any SDK; two thin adapters host it — the in-process Agent SDK server (`driver.ts`'s `toSdkTools`) and the standard stdio MCP server (`mcp-server.ts`, reached via `duet _mcp`). The same handlers, rails, and steer delivery serve both, so an out-of-process orchestrator behaves identically to the in-process one — proven by a parity test driving a real `_mcp` subprocess. The single dependency this added, `@modelcontextprotocol/sdk`, is pinned to the one version the Agent SDK already resolves, so both hosts share one `CallToolResult` type.
- **Cooperative pause.** `ask_human` persists the question at call time, the result text says "end your turn", the process exits at quiescence. Mechanical SDK interrupts corrupt resume — proven, with executable repros (`src/spike/repro-*.ts`).
- **Parallel worker turns.** The claude CLI runs MCP tools serially unless `annotations.readOnlyHint` is true (its scheduler's concurrency test for MCP tools — verified 2.1.175, undocumented; full note: `docs/prompting-and-tool-design.md` §Concurrency). `send_prompt` carries the annotation as a concurrency hint, not a purity claim, so independent turns to different workers overlap; the genuinely unsafe case — two concurrent turns into one session — is refused by the handler's same-role in-flight rail. If parallel sends stop overlapping after a CLI upgrade, re-verify that mapping first.
- **Staging handshake.** Human input crosses the CLI→driver process boundary via `stageHumanInput`/`consumeHumanInput`, consumed exactly once so a retried driver can't replay an answer. Known edge, chosen deliberately: a crash after consume loses the staged text — the crash question asks the human to re-supply, which beats risking double-delivery into a session that may have already used it.
- **Steer channel.** The human's mid-phase voice rides tool results: file-per-steer staging under `steers/` (never `state.json` — a CLI write would race a live driver's saves), delivery appended to every phase-continuing result, carry-forward through the next harness prompt otherwise. The crash trade inverts the staging handshake's: deliver-then-consume, so a crash *redelivers* rather than loses (a repeated instruction is benign where a lost one is not). Turn-ending results (advance recorded, question queued) never carry steers — guidance delivered into a dying turn lands and dies — and the delivery path is fail-soft: a steer bug must never corrupt a tool result.
- **Position probe.** Where a run is cannot be read from the snapshot alone — persistence is quiescence-only, so mid-phase the snapshot shows the *previous* stop. `probeRunPosition` joins driver liveness, the parked snapshot, and the state evidence the driver writes continuously (`phaseStarted`, `pendingQuestion`) into running / gate / flag / crashed / abandoned / done; a crashed position names how its dead crossing is re-uttered (`approve` / `answer`), so bare `duet continue` recovers every crash shape. The `abandoned` short-circuit comes first: `duet abandon` kills the driver and writes a marker, so a deliberate stop reads as abandoned rather than crashed — and stays reversible, since `continue` clears the marker and the transcripts are kept. Steer gating, crash recovery, and the status model all derive from this one probe.
- **Crash = flag.** Any infrastructure failure lands the run on an actionable queued question, never a silent state; a question the orchestrator already queued is never overwritten by a crash question. The stdio host owns this across the process boundary too: a dead `_mcp` peer becomes the same persisted question, so crash = flag survives the boundary, and a silent turn gets one nudge before flagging (parity with the in-process driver).
- **Phase decision via a persisted marker.** `advance_phase`/`ask_human` record a terminal marker `{phase, kind}` written atomically with the gate packet or queued question it carries — the one cross-process channel for "which `phase.*` event to emit," read back through the pure, phase-matched `markerToEvent` (`phase-events.ts`) by both hosts. The lifecycle clears it deliver-before-clear (after the quiescent snapshot is durable, before any `gates_at` auto-cross). The subtlety that bit: the marker survives the crash window between the snapshot save and the clear, and a same-phase re-entry is *not* inherently harmless — a stale `flag` re-entered by an answer, or a stale `advance` by a reject, would replay the old decision and swallow the human's input. The **spent-marker guard** closes it: on entry the lifecycle reads the *restored snapshot* and clears the marker iff it resumed at that marker-phase's own gate/flag-wait (the transition already applied); a crash *before* the transition restores at a prior state, so the live marker still replays as intended.
- **View-time color.** Log files are plain text always — they are the inspectable-without-duet artifacts. One palette (`colorize.ts`), applied only where a human is watching.
- **Atomic writes** (temp + rename) for everything crash recovery reads: `state.json`, `machine.json`.

## XState usage

The machine is deliberately small; the discipline is in what it refuses to represent:

- **Two event vocabularies, kept disjoint.** A phase state completes by emitting an internal `phase.advance`/`phase.flag`; a gate or flag-wait transitions only on a `human.*` authority event (approve, reject, answer). A gate has no `phase.*` handler and a phase state has no `human.*` handler, so `advance_phase` can *park* a run at a gate but can never *cross* it — that's a property of the vocabulary, not a prompt. No tool emits `human.*`, in-process or over the MCP boundary, so gate-skipping stays *unrepresentable* even for an out-of-process orchestrator.
- **Tags are API, not decoration.** `quiescent` = the lifecycle may persist a snapshot here (no live actors); `gate` / `flag-wait` / `phase` drive CLI copy and event validation. The tag sets are pinned exactly by tests (`tests/machine.test.ts` coherence suite) because a mis-tagged state would persist a snapshot that restore cannot resume.
- **Persist only at quiescence; restore never resumes an invoke.** Mid-phase crash recovery re-enters the phase loop; position truth is the JSONL transcripts. `state.json.machineState` is display-only — reconstructing machine state from it is the anti-pattern, and the spent-marker guard (below) keys off the *restored snapshot* (`machine.json`), never that mirror, for exactly this reason.
- **The snapshot is typed at the store boundary** (`Snapshot<unknown>` in `run-store.ts`), so hydration is `createActor(machine, { snapshot })` with no casts anywhere.
- **Context is input, not state** (`runId`, `cwd`, `hasSpec`). Anything that changes during a run lives on disk, owned by the run store.
- **`snapshot.can(event)` before side effects** — the CLI validates a gate decision against the restored machine before staging input, so a wrong flag errors instead of silently no-oping.
- **Test through `machine.provide`** — script the actor, never reach into machine internals.

## Testing strategy

Standalone `tests/`, not co-located: the test surface is the public interface, and the interfaces here span process boundaries — co-located files invite testing internals. Fixtures compose via `test.extend` (`tests/helpers/fixtures.ts`: tmp project dir → run on disk → fake workers); the scripted statechart lives in `tests/helpers/scripted-machine.ts`.

- Behavior through real interfaces: tool handlers, store functions, machine events, rendered strings.
- Fake only at the seams table above. Filesystem and git run real, in tmpdirs. Time via fake timers (heartbeats only).
- Never mock our own modules; when tempted, write a third adapter for the seam instead.
- Deliberately untested: view glue (its designed failure mode is already "degrade to a one-line note") and the thin codex SDK wrapper.
- `tests/snippets.test.ts` guards the hand-edited `snippets.toml` and cross-checks every snippet key the orchestrator prompts name — a broken library fails a five-second test, not a $90 run.
- `tests/skill.test.ts` guards the shipped concierge skill the same way: every duet verb and flag the skill names must exist on the imported command table, and read verbs must be the only pre-approvals — a renamed flag fails in five seconds, not in a phone session.

## Build & publish

Dev has no build step: Node 24 runs `.ts` directly, and the global `duet` command (`pnpm add -g .`) is a symlink whose bin points at `src/cli.ts` — every edit is live. Publishing is the one place this cannot hold: Node refuses type stripping for files inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so an npm-installed copy must ship JavaScript.

The split lives in `package.json`: `bin` → `src/cli.ts` for dev; `publishConfig.bin` → `dist/cli.mjs`, rewritten by pnpm only in the published tarball. `pnpm build` (tsdown, config in `tsdown.config.ts`) bundles `src/` into `dist/cli.mjs` with dependencies external and publint validating the result; `prepack` chains typecheck → tests → build, so a tarball can't be cut from a broken tree. `dist/` is gitignored and never used in dev.

Two facts the setup depends on: `snippets.toml` is listed in `files` because `src/snippets.ts` resolves it package-relative at runtime (`src/` and `dist/` both sit one level below the root, so the `import.meta.url + '..'` resolution survives bundling), and the `_drive` respawn uses `process.argv[1]`, so it is agnostic to which entry was invoked. `private: true` stays as the guard against accidental publish; the `license` (MIT), `author`, and `repository` fields are now set, so removing `private` and checking the npm name is the deliberate remaining step when publishing becomes real.

## Condensed lessons

1. **Don't approximate judgment with mechanism.** Every pre-pivot compensation (schema fields, disagreement string-matching, caps as exits) existed because code lacked judgment. When tempted to parse LLM output for meaning, hand the judgment to the orchestrator; keep code for structure.
2. **Guarantee in structure, steer in text.** The same rule usually needs both halves: the cap refuses in the handler *and* the refusal names the legal next moves.
3. **Soft constraints want warn-once-then-allow.** A hard block on a usually-wrong action recreates the dumb-router trap; one steering refusal plus a deliberate identical retry keeps judgment in charge and leaves the choice in the transcript.
4. **Infrastructure parameters leak into product scope unless named.** The per-turn budget rail shaped a descope decision before the prompts said "budget is per-turn; never shrink scope for it" (Q19).
5. **Fixed value + deterministic consumer → config; anything soft → prose.** The frontmatter boundary rule: a deterministic consumer of a soft value *enforces* errors that judgment would have resolved.
6. **Long silent operations need heartbeats.** Non-streaming worker turns run 30+ minutes; a silent pane reads as a hang.
7. **Every stop needs a next command.** A run state the human can see but not act on is a bug — the crash-without-question gap was exactly this, and the fix (crash = flag) is now a pattern.
