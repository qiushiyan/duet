# Automation design

This document describes the duet design as of the **2026-06-11 pivot**: a three-role architecture in which an intelligent, read-only LLM **orchestrator** routes the snippet protocol between an **implementer** and a **reviewer**, inside a deterministic phase-and-gate skeleton enforced in code. It supersedes the dumb-router design of 2026-05-26. The reversal and its rationale are recorded in §"Design history" below; the decision ledger (`docs/open-questions.md`) tracks what the pivot settled and what it opened.

**Implementation status:** the full arc is implemented (`src/phases.ts` table + `src/harness/` statechart, tool surface, driver, lifecycle; `src/cli.ts`; `src/providers/`; behavior suite in `tests/` — the code-level map is `docs/engineering.md`) — framing-only entry (FRAME → Direction gate), the SPEC and PLAN loops of attended PLANNING, the AFK IMPLEMENTATION phase (slices → midpoint/compaction at orchestrator judgment → handoff → review loop → `ceo-summary` → Ship gate), and FINAL REVIEW (docs proposal → Docs-plan gate; docs apply + `pr-description` → Open-PR gate; push + `gh pr create` → done), with worker compaction, the branch policy (`create_branch`), and macOS notifications at every quiescent stop. FRAME through the Ship gate is live-verified — first on a scratch repo, then by the first real-feature run (planlab `20260611-1542-aeca`: framing-only entry, a human scope inversion absorbed as Direction-gate feedback, midpoint checkpoint, 3 impl review rounds to convergence, and a full ship packet; ~$93 claude-side + ~82M codex input tokens for the whole arc). The docs, pr, and open phases are smoke-tested and await their first crossing. `--tmux` opens the per-voice viewer (§"Visualization"). Gate pre-authorization (`gates_at`, §"Gate pre-authorization") and the view-time log styling landed 2026-06-12 from the first run's reflection and await their first overnight run. The concierge package — the mid-phase steer channel (§"The steer channel"), `status --json`, and the shipped `skills/duet-concierge/` (§"Remote interaction") — is implemented and test-guarded (spec: `docs/specs/2026-06-12-concierge-package.md`), awaiting its first live remote session. Its **run-operations** layer — the `duet doctor` health view, the enriched heartbeat, the machine-legible triage signals (`humanDecisions[]` on a gate packet; `cause`/`errorClass` on a queued question), the lean `status --brief` digest, the hardened non-TTY write path, and opt-in bounded infra retry (§"Supervising a run from outside") — is implemented and test-verified (418 tests across 20 files), with live end-to-end verification and the environment smoke tests still pending; the codex `error`/`stream_error`/`turn_aborted` classification branch is validated synthetically only (no real codex error transcript yet). Spec: `docs/specs/2026-06-19-concierge-run-operations.md`. Codex-as-orchestrator (Q17) is the one designed-but-unbuilt piece.

## Design principles

These shape every other choice. Re-read before adding scope.

### Augment, don't replace

Duet drives the same `claude` and `codex` CLIs the user already uses, with the same snippet protocol, against the same codebase. Every artifact duet produces is also producible by the manual workflow — JSONL transcripts in the standard locations, branches with regular names, commits with regular messages. The pivot *extends* this principle rather than weakening it: the orchestrator is itself an LLM session with its own JSONL transcript, so every routing decision it makes is inspectable and auditable the same way the workers' turns are. There is no "duet mode" the user is locked into.

### Stop anytime

A run can be paused indefinitely. The state file at `.duet/runs/<run_id>/state.json` is a fast-access hint; the source of truth is the JSONL transcripts of all **three** sessions (implementer, reviewer, orchestrator). The user can stop at any gate, switch to manual `claude --resume <id>` / `codex exec resume <id>`, add turns by hand, and either resume duet later or never. On resume, the harness re-reads JSONL tails; the orchestrator re-derives position from the transcripts, not from cached offsets.

### Personal tool first, publish-ready

Built for one developer's use across their own projects. The CLI is project-agnostic: no project conventions hardcoded, no skill registry, no `.duetrc`, no codebase introspection. Project-specific knowledge — which skills exist, where specs go, branch conventions, model choices — flows in through the user's framing turn at `duet new`. When the framing references something that doesn't exist, the orchestrator flags it to the human rather than inventing fallbacks.

Publishing (npm / public repo) is a kept-open option, not a goal (2026-06-12): the design constraints above don't soften for hypothetical users, but shipped artifacts — the `skills/` folder, the README — are written for any user and never reference the author's personal setup. No community roadmap.

### Not a daemon — but alive through a phase

*Amended from the 2026-05-26 "per-gate process" rule.* The process model is **per-phase, not per-gate**: each phase (which may take 1–3 hours during AFK implementation) is driven by a detached child process that exits at the next gate or queued exception, persisting state. The invoking `duet new` / `duet continue` returns immediately — it stages the human's input, spawns the driver (`_drive`, stdout to `.duet/runs/<id>/driver.log`, pid in `driver.pid`), and frees the terminal for follow-up duet commands; a pid guard refuses to start a second driver for a run whose phase is still running. With gate pre-authorization (§"Gate pre-authorization") the driver lives through the whole pre-authorized stretch — several phases, crossing each recorded gate on the human's standing authority — and exits at the next attended stop. Nothing runs when no phase is active; there is still no resident daemon, no GUI, no webhook listener. An intelligent orchestrator must hold its session open *across* the many routed turns inside a phase — but gates remain process exits, which is what keeps the semi-AFK shape (answer a gate from any terminal, hours later). An **interactively-orchestrated** run has no `_drive` during the attended arc at all — the human's interactive orchestrator session holds it open and `duet continue` crosses the gate inline; the detached driver starts only at the plan-gate handoff to AFK implementation.

## Design history — the 2026-06-11 pivot

The 2026-05-26 design stated, as an explicit non-goal: *"Use an LLM as the routing judge. The orchestrator is a state machine that drives subprocess CLI calls… It is not a third agent."* That decision is reversed. Three strands of evidence drove the reversal:

1. **The old design was already approximating judgment with mechanism.** The `needs_human`/`disagree` schema fields approximated "noticing something is off"; string-matching `disagree.point` across rounds approximated "this argument isn't resolving"; fixed iteration caps approximated "this loop converged"; the `ORCHESTRATOR_RESUME_FROM_PROPOSAL` token approximated "knowing where we are in a skill." Each compensation existed because the router had no judgment. **(observed in this repo's own design docs)**

2. **The real workflow has variance a fixed state machine cannot absorb.** A 22-session corpus scan of the user's planlab project (2026-05-29 → 2026-06-11, `~/.claude/projects/-Users-qiushi-dev-planlab-main/`; see `docs/observed-pattern.md` §"Corpus scan: planlab") found multi-PR pivots inside one session, a parallel worktree session run concurrently, review polling started and stopped by hand, a recurring human-as-environment-proxy loop (migrations, smoke tests), and the user evolving the snippet library itself mid-session. **(observed)**

3. **The routing tax is heaviest exactly where judgment is needed.** The same scan: 41 `/copy` invocations, ~84 sub-60-char glue messages ("go ahead", "continue with the rest"), keyboard touches every 7–15 minutes during spec/plan loops. **(observed)**

**The cost of the reversal, named:** routing becomes nondeterministic (mitigated: every sent prompt is logged with its source snippet tag and delta; gates are un-skippable in code); token cost rises materially — the orchestrator reads all inter-agent traffic, and Anthropic measured orchestrator-worker systems at ~15× chat-level token use (mitigated: per-invocation budget caps, orchestrator self-compaction); debugging "why did it route that" is harder than reading a state machine (mitigated: the orchestrator's transcript *is* the explanation); and v1 is larger than the old Slice 1.

What did **not** change: the human gate list, the snippet protocol as the substance of the workflow, every augmentation principle, the worker plumbing (CLI resume, JSONL transcripts), and the personal-tool non-goals.

## The three roles

| Role | Writes? | Job |
|---|---|---|
| **Orchestrator** | **Never** — enforced by tool surface, not instruction | Drives the protocol: picks the next snippet, adapts it, routes worker output, judges loop exits, triages questions, flags the human |
| **Implementer** | Yes | Specs, plans, code, handoffs, summaries |
| **Reviewer** | No (review only) | Critiques each artifact at the right altitude |

The orchestrator is not a worker and not a tiebreaker: **it does triage, never substance**. It never answers a product, design, or technical question with its own opinion — it decides *who* should answer (the worker itself, per protocol, or the human, via a flag). Future role expansion (e.g. multiple specialized reviewers) is explicitly anticipated by this structure but out of scope now.

### Roles are decoupled from providers

Settled 2026-06-11: **a role is a capability contract; a provider is an implementation that can serve one or more roles.** No role is hardcoded to a vendor — orchestrator-on-codex with reviewer-on-claude is a legal configuration, not a fork. This generalizes the earlier implementer/reviewer-swap decision to all three roles.

Exactly two providers exist, and their configuration philosophies deliberately differ:

- **`claude`** — Anthropic models via the Agent SDK / `claude` CLI. Configured **per-model**: each role binding may name a specific model ID (`claude-opus-4-8`, `claude-opus-4-6`, `claude-fable-5`, …), because choosing the Anthropic model per role is a knob the user actually turns.
- **`codex`** — the Codex CLI. **No model key by design**: duet defers entirely to the user's own `~/.codex/config.toml` (model, reasoning effort, profiles). That's how codex is meant to be configured, and duet doesn't duplicate it. Specific ChatGPT model support in duet is a non-feature.

**Capability contract per role.** Worker roles (implementer, reviewer) need session resume, streamed output, and — for the reviewer — read-only operation; both providers satisfy these today (claude via SDK/CLI flags, codex via `codex exec -s read-only` + `resume`). The **orchestrator** role demands more: custom harness tools (`send_prompt`, `ask_human`, …), read-only enforcement, and pause/resume at a tool call. The claude provider satisfies this natively (Agent SDK in-process tools + `canUseTool`). A local MCP server exposing the harness tools now **exists** — the kernel is host-neutral and served over standard stdio MCP (above) — so the harness-side half of the codex bridge is no longer hypothetical; what remains unbuilt is the codex-side wiring and its two open verification questions (pause/resume at a tool call, tool-call faithfulness), which live in Q17.

**Configuration.** Role bindings live in a minimal config file — the one config duet ships, scoped to role→provider/model bindings and nothing else (see the amended non-goal below):

```toml
# ~/.config/duet/config.toml — role bindings only.
# Project knowledge never goes here; that's the framing turn's job.

[roles.orchestrator]
provider = "claude"
model = "claude-opus-4-8"     # any Anthropic model ID; e.g. claude-fable-5

[roles.implementer]
provider = "claude"
model = "claude-opus-4-8"

[roles.reviewer]
provider = "codex"            # no model key — ~/.codex/config.toml governs
```

Per-run CLI flags override the file: `--orchestrator <provider[:model]>`, `--impl <provider[:model]>`, `--reviewer <provider[:model]>` (e.g. `--impl claude:claude-fable-5`, `--reviewer codex`). The file above is also the **shipped default** when absent: `{orchestrator: claude/claude-opus-4-8, implementer: claude/claude-opus-4-8, reviewer: codex}` — both claude roles default to Opus 4.8 (updated 2026-06-15 from the earlier Fable-5 implementer default); a more capable or costlier model (e.g. Fable 5, ~2× Opus) can be bound to the implementer per run when an artifact-heavy feature warrants it.

## Architecture: three layers

### Layer 1 — Harness (deterministic code)

A statechart: each **phase** is a state that runs the orchestrator agent; each **gate** is a state in which no agent runs and which transitions only on human events. The two event vocabularies are kept disjoint: a phase completes by emitting an internal `phase.advance`/`phase.flag`, while a gate transitions only on a `human.*` authority event. A gate has no `phase.*` handler, so `advance_phase` can park a run at a gate but can never cross it — gate-skipping is unrepresentable, not merely forbidden. No tool emits `human.*` — whether the orchestrator runs in-process or in a separate process over the tool boundary (§"Architecture", below) — so that guarantee holds across the process boundary too. (Implemented in XState v5; the states are built from the phase table at `src/phases.ts`, the single source for the arc's order, caps, budgets, and gate copy. How the code uses XState — tags, persistence, the test seam, the event vocabulary — is `docs/engineering.md` §"XState usage".)

The harness also owns:

- **Worker subprocess plumbing** — spawn/resume worker sessions, completion detection, output capture, graceful kill (SIGTERM→SIGKILL escalation; the one bug *not* to inherit from prior art is sandcastle's missing `proc.kill()`). Prior art is vendored at `references/sandcastle/` (MIT — copy with attribution): exact CLI invocations in `src/AgentProvider.ts`, stream-line parsers for both CLIs, idle-vs-completion dual timeouts in `src/Orchestrator.ts` + ADR 0019, session-file lookup by id in `src/SessionStore.ts`. See `references/README.md` for the full per-repo borrowing guide.
- **Read-only enforcement** — the orchestrator's tool surface contains no write/edit/bash tools. Its read-only nature is a property of the harness, not a promise in a prompt.
- **Gate interception** — `ask_human` and `advance_phase` are harness-owned tool handlers: the handler persists the question/phase-exit at the moment of the call (the human-visible artifact exists before the model regains control), then instructs the orchestrator to end its turn; the harness exits when the turn ends. The interception is the handler side effect, not the permission system — the SDK's mechanical pauses corrupt resume (repros: `src/spike/repro-*.ts`).
- **State persistence** — the machine snapshot is written **only at quiescent states** (gates, flag-waits, done — states with no live actors). Mid-phase crash recovery comes from the JSONL transcripts, which is where it always came from.

### Layer 2 — Orchestrator (LLM agent)

A read-only agent whose system prompt is the workflow protocol operationalized — phases, snippet usage rules, altitude lenses, compaction discipline, triage rules — plus the per-run framing the user supplies. The role is provider-decoupled (§"Roles are decoupled from providers"); when bound to the **claude provider** — the default, and the only orchestrator-capable provider in v1 — the substrate is the Claude Agent SDK (read-only via tool configuration — `tools: []` hides all built-ins, custom tools via `tool()` + `createSdkMcpServer()`; session JSONL on disk in the standard location, so the orchestrator's session stays manually resumable with `claude --resume`); confirmed by the substrate spike (`src/spike/q11.ts`), **with one correction**: the AFK pause at `ask_human` is *cooperative*, not mechanical — the tool handler queues the question, persists state, and instructs the orchestrator to end its turn; the SDK's mechanical pause options (hook `defer`, `canUseTool` deny+interrupt) both corrupt session resume in SDK 0.3.170 (repros at `src/spike/repro-*.ts`). The SDK source is vendored for API study at `references/claude-agent-sdk-typescript/` (proprietary license — consume as an npm dependency, don't copy code; see `references/README.md`).

The tool surface is **host-neutral**: the eight tools live in one registry independent of any SDK, hosted by thin adapters — the in-process Agent SDK server (the default), a standard stdio MCP server, and the run-scoped server the interactive orchestrator connects to (`docs/engineering.md`, the "Host-neutral kernel" and "Interactive orchestrator host" patterns). The same handlers and rails serve all, so the orchestrator behaves identically wherever it runs. On that footing the **interactive CC session is itself an orchestrator host** over the attended arc (`duet orchestrate` / `duet new --interactive`): the human's own session drives FRAME → PLAN, steering and gate conversation happen in chat, and the run hands off to the headless driver at plan approval (`docs/future-directions.md` §A). Gates are still structural — `advance_phase` only parks — and the one safety setup is a single `ask` permission rule on `duet continue` (`Bash(duet continue:*)`) that survives the human's bypass-permissions default, since no tool can emit `human.*` regardless of host.

**Tool surface** (definitions and the rails they enforce: `src/harness/tools.ts`):

| Tool | What it does |
|---|---|
| `get_task()` | Read the current phase's entry brief — documents in scope, branch policy, attendance, worked examples — returned in full every call. The interactive host's way in: read at phase start, after a gate, or to re-anchor after compaction; it folds a staged human input (approval rider / reject feedback / answer) in once. Not read-only — marks the phase started on first call; reports the park (no side effects) once the phase is at its gate/flag. |
| `list_snippets(all?)` | Read the snippet library, **phase-focused by default**: this phase's templates and the anytime helpers in full, other phases indexed by key, annotated with what's already been sent this phase. `all: true` returns every body — the cross-phase escape hatch. |
| `send_prompt(role, tag, body)` | Send a prompt to the implementer or reviewer and return the worker's response. `tag` names the source snippet (`"custom"` when composed from scratch); `body` is the final text. Every call logs the tag and the body, so adaptation drift is auditable. Independent turns to different roles run concurrently when issued as parallel calls (the frame phase's two analyses); a second turn to the same role while one is in flight is refused — one session is one conversation. |
| `ask_human(question, context?)` | Flag something for the human. Always the cooperative pause: the handler persists the question, the run exits at quiescence, and the human answers via `duet continue --answer` — in attended phases they're at the terminal and answer in minutes; during AFK the question waits. |
| `advance_phase(summary, artifacts, spec_path?)` | Declare the phase complete. Legal only when the phase's exit criteria are plausible; lands on the phase's human gate (the `open` sub-phase, which runs after the last gate, advances straight to done). `spec_path` reports where the spec file landed when the phase produced it (framing-only entry). |
| `create_branch(name)` | Create and switch to the run's working branch (§"Branch policy"). Harness-executed; structurally legal only before the first worker prompt. |
| `propose_snippet_edit(snippet_key, proposed_body, rationale)` | Queue a persistent snippet-library change for the human's end-of-run review. Never applied mid-run. |
| `write_note(observation)` | Append a friction observation to `.duet/runs/<run_id>/notes.md` — the dogfooding journal, written by both the human and the orchestrator. |

#### Prompting and tool-surface conventions

Adopted 2026-06-11 from Anthropic's published guidance, first applied in the substrate spike. The full reference — the distilled guidance, the duet house patterns, and the source links — is **`docs/prompting-and-tool-design.md`**; consult it whenever writing or revising a prompt, tool definition, or tool result. The five binding rules:

1. **Artifacts first, task last, XML-tagged** — longform content at the top in `<documents>` tags, instructions in a `<task>` block at the end.
2. **Thinking framework over prohibition** — positive instructions carrying the *why*; no aggressive emphasis (current models overtrigger on it).
3. **Tool descriptions surface the implicit, load-bearing facts** (e.g. `send_prompt`: roles are persistent sessions; worker turns are slow).
4. **Errors prescribe the recovery path** — name the failure layer, say what to do next; never bare tracebacks.
5. **Results that change the agent's next step say so explicitly, with the reason** (the `ask_human` queued-response nudge that makes the cooperative pause work).

### Layer 3 — Workers

Unchanged in shape from the 2026-05-26 design: resumed CLI sessions, transcripts in the standard locations, invoked per turn by the harness on the orchestrator's instruction. Driving mechanics verified 2026-06-11 against the locally installed CLIs:

- **Codex reviewer** — `codex exec -s read-only` is the correct minimal sandbox for a read-only reviewer (no `--dangerously-*` flags); resume is a verb (`codex exec resume <id>`) and **`--output-schema` works on resume** in codex-cli 0.133.0 (upstream issue fixed May 2026 by openai/codex#23123 — live-verified locally with a two-turn schema-enforced smoke test). Resume lacks `-s`/`-C` flags; pass `-c 'sandbox_mode="read-only"'` instead. Gotcha: an open stdin pipe makes `codex exec` block waiting for EOF — close stdin or pipe the prompt through it deliberately. Preferred wrapper: `@openai/codex-sdk` (thin spawn-the-CLI wrapper; rollouts still land in `~/.codex/sessions/`, so augmentation holds), pinned to the same release as the CLI, with the raw flags as known-working fallback. SDK source + docs vendored at `references/codex/`.
- **Claude implementer** — a spawned `claude -p --output-format json --resume <id>`, writing the standard `~/.claude/projects/` transcripts and drawing from the subscription credit pool (headless usage is metered separately from interactive sessions since 2026-06-15 — hence the per-invocation budget rails). An opt-in **interactive transport** (`transport = "interactive"`) drives the interactive `claude` TUI instead, so the implementer's turns bill the *flat* subscription quota rather than that metered pool — built as a spike, claude-implementer-only, transcript-as-truth (`docs/interactive-transport.md`). Headless permission posture: **`--permission-mode bypassPermissions`** (the user's 2026-06-11 decision) — the AFK implementer edits files, commits, and runs project commands (tests, typecheck, builds) with nobody at the keyboard, and the user accepts the unprompted-execution tradeoff on their own repos. Explicit deny rules still apply, and the CLI refuses to run as root. (The interactive transport shares this bypass posture and is implementer-only for it.)

### Worker compaction

Two implementer-side `/compact` moves, each at a phase boundary:

- **Plan→implementation (`compact-for-impl`)** — the impl phase's first act, after the plan commits. Deliberately *not* at spec→plan: exploration and planning share one substrate (reading the code to design against it), so a cut there only forces a reread before a line-cited plan — whereas the committed plan file already carries the design across the plan→impl seam, and the slices reread fresh anyway. (`compact-for-plan`, the manual after-spec variant, stays in the library for a judgment-timed early cut when a long spec phase bloats context — not the default; context-fill telemetry is the signal.)
- **Build→review (`compact-for-review`)** — before the review cycle, orchestrator-timed: drop the build journey, keep the mental model, decisions, and test state.

Per provider: **claude** compacts in place — a `/compact …` prompt body (same session, instructions honored; the provider substitutes a synthetic confirmation for the empty turn) — then `reread-context` re-anchors it. **codex** auto-compacts near its window ceiling, so it is never commanded and `~/.codex/config.toml` is never touched (its context-window overrides are the one way to break exec-mode auto-compaction); it gets the `reread-context` re-anchor alone. Either way **the plan must be a repo file**: compaction drops the journey, so the committed plan + spec are the re-anchor.

## Question triage

The orchestrator's flagging rules, stated as instructions it must follow. Questions from workers come in three kinds:

1. **Product / direction questions** ("should this be billing-gated?", "is breaking compatibility acceptable?") — **always flag** via `ask_human`. No exceptions.
2. **Environment questions** ("do you need me to run the migration?", anything touching DB/Slack/deploy credentials) — **always flag**; only the human can act. **(observed: planlab b7487993 12:10:23Z, e9607005 10:34:53Z)**
3. **Tactical questions the worker can answer itself** ("do I need a migration step for this schema change?") — the orchestrator answers with **process, not substance**: "decide per the plan and record the decision; if it's actually a product call, say so and I'll flag it."

The orchestrator never supplies a technical opinion of its own — answering would make it an invisible third opinion-holder whose influence bypasses the human gates. Whether these rules over-flag or under-flag in practice is Q13, validated in the first slice. The triage outcomes are also surfaced as structured signals for a supervisor reading from outside — a gate packet's `humanDecisions[]` and a queued question's `cause` (`human` vs `infra`) — so the concierge or interactive orchestrator decides hold-vs-relay and escalate-vs-resume mechanically; both are signal-only and described under §"Supervising a run from outside".

## Phases and gates

duet is **workflow-aware**: a run picks one arc at start (`--workflow`, default `full`; a `workflow:` framing key by another door), and every arc-shaped fact lives in one registry — the single source of truth (`docs/engineering.md` §"the workflow registry"). Two arcs exist by design.

The **full** arc — the thorough path, three top-level phases (the old nine-phase machine survives as nested steps inside them):

```
PLANNING (attended)
  onboard → frame (both, parallel) → synthesize
    ── GATE: Direction ──
  spec draft → review/update rounds
    ── GATE: Commit spec ──
  plan draft → review/update rounds   (planning keeps full spec-exploration context)
    ── GATE: Plan approval ──            ← human walks away here
IMPLEMENTATION (AFK)
  commit plan → compact-for-impl + reread → single implementation pass (one midpoint checkpoint only if large)
  → compact-for-review (judgment) → implementation-handoff
  → review/respond rounds → fixes → re-review
  → ceo-summary (implementer drafts; last act of the phase)
    ── GATE: Ship ──                     ← human returns here
FINAL REVIEW (attended)
  human verification (environment proxy: migrations, smoke tests)
  → update-docs (skill; internal gate maps to a harness gate)
  → pr-description
    ── GATE: Open PR ──                  ← never auto-opened
```

| Gate | Boundary | What the human decides |
|---|---|---|
| **Opening framing** | start of run | Provides issue text, product context, scope. The input, not a pause. |
| **Direction** | inside PLANNING | "Does this direction match what I meant?" |
| **Commit spec** | inside PLANNING | "Spec is solid; commit and move on." |
| **Plan approval** | PLANNING → IMPLEMENTATION | "Plan is workable." This is the walk-away point. |
| **Ship** | IMPLEMENTATION → FINAL REVIEW | Reads the final-gate packet (below); runs environment verification (migrations, smoke tests — the human as environment proxy acts *here*, before deciding); "ship" / "another round" / specific changes. |
| **Docs plan** | inside FINAL REVIEW | Approves the docs-update proposal (a skill-internal gate when the project has a docs skill, surfaced as a harness gate). Reject-with-feedback is the adjust path. |
| **Open PR** | end of run | Reads the PR description; approves opening. Non-negotiable; the PR is never opened without this gate. Approval authorizes the mechanics: the implementer pushes the branch and runs `gh pr create`, and the run ends with the PR URL in its final summary. |

Plus **in-phase exception gates** whenever the orchestrator calls `ask_human`. The machinery is identical in every phase — the question is persisted, the process exits at quiescence, `duet continue --answer` resumes. What differs is the human: attended means they're at the terminal and the pause lasts minutes; AFK means the question waits hours until they return (with a desktop notification fired either way).

The **rir** arc (Research → Implement → Review) — the lighter path, for small, well-understood work where the spec-and-plan ceremony costs more than it returns:

```
research (attended)
  onboard → think-holistic (both, parallel) → compare-notes synthesis
    ── GATE: Direction ──                  ← the research decisions ARE the design; human walks away / hands off here
implement (AFK)
  build directly from the decisions → implementation-handoff
  → ONE writable review round (review-direct → apply-review, fixes applied in place)
    ── GATE: Ship ──                       ← human returns; run complete, no PR opened
```

It drops spec, plan, docs, and PR: the synthesized research decisions stand in for the spec, so the implementer builds from them directly. Its review loop is a single **writable** round (the reviewer critiques once, the implementer fixes in place) rather than the full arc's reflect-then-`-again` loop, and its Ship gate ends the run — there is no Open-PR gate to be non-negotiable about. Pre-authorizing both its gates is the `afk` preset (below). The two arcs share their machinery: the same gate/flag/steer idiom, the same statechart skeleton built per-arc, the same registry-derived per-phase facts.

Inside a phase the orchestrator drives; the human's channels in are the gates, the `ask_human` flags, and — into a live phase — the steer channel below.

### The steer channel

The human's voice has a channel for every run condition: gates take decisions (an approval may carry a rider — agreement plus adjustments, gate feedback in approving form), flags take answers, and a **live phase takes steers** — `duet steer "<note>"`, the editor-in-chief's voice mid-flight. A steer is processed, not answered: it reaches the orchestrator appended to its next *phase-continuing* tool result (one phase is typically one long orchestrator turn, so turn boundaries are too rare to ride; tool results arrive every few minutes all phase long and are already the harness's steering surface), tagged as human guidance that outranks reviewer opinions and counts toward no cap. The orchestrator folds it into its routing — relaying into worker prompts at its judgment, reflecting it in the next gate packet — and a steer is never by itself a reason to `ask_human`: the human chose the non-pausing channel deliberately.

Two boundaries keep the channel honest. Results that end the orchestrator's turn (a recorded phase advance, a queued question) never carry steers — guidance delivered into a dying turn lands and dies — so those steers wait and ride the next harness prompt instead, tagged with provenance, staleness judged by the orchestrator (a steer that misses its phase is carried, never dropped). And at a quiescent stop the CLI refuses the steer outright, naming that stop's own channel — gate decisions and flag answers stay explicit, never smuggled in as notes.

Storage is file-per-steer under `.duet/runs/<id>/steers/`, consumed by rename into `delivered/` — steers arrive while a live driver holds and continuously saves its in-memory state, so they can never live in `state.json`. The crash trade is deliberate: deliver-then-consume, so a crash redelivers a steer rather than losing one (a repeated instruction is benign where a lost one is not). Staging and delivery both land in the voice logs, and `duet status` lists what is still pending — the channel is auditable end to end.

In the harness, the three top-level phases decompose into machine sub-phases, each on the same loop/flag-wait/gate idiom: PLANNING is `frame` (onboard → think-holistic in both workers → compare-notes synthesis → Direction gate; runs only on framing-only entry) then `spec` (draft on framing-only entry, then review rounds → Commit-spec gate) then `plan` (→ Plan-approval gate); IMPLEMENTATION is `impl` (→ Ship gate); FINAL REVIEW is `docs` (drive the docs update to its proposal → Docs-plan gate) then `pr` (execute the approved docs plan, draft `pr-description` → Open-PR gate) then `open` (push + `gh pr create` → done, no further gate). The rir arc decomposes the same way into two sub-phases: `research` (→ Direction gate, the walk-away/handoff) then `implement` (→ Ship gate). The review-loop sub-phases (`spec`, `plan`, `impl`, and rir's `implement`) must run at least one review round before `advance_phase`; the others (`frame`, `research`, `docs`, `pr`, `open`) may advance without one — their substance is synthesis or mechanics, and the reviewer is available but optional. Backstop caps: spec 6, plan 4, impl 6, frame/research/docs/pr 2, open 1; rir's `implement` is 1 — its single writable round is the loop, not a runaway backstop.

### Gate pre-authorization (`gates_at`)

Added 2026-06-12, after the first real run. A gate bundles three functions — the human's **authority**, **steering** (early-correction leverage), and a **quiescent stop** — and pre-authorization gives up only the steering: the authority is granted in advance, the stop still happens and is recorded.

By default every gate is attended. A run may pre-authorize a subset at `duet new`: `--gates-at <list|preset>` or a `gates_at:` key in the framing file's frontmatter (the flag wins) names the phases whose gates the human will attend — the rest auto-cross. The gate set, the presets, and the force-attended gates are all **workflow-scoped** (they live in the registry per arc). The full arc's presets, named for the human's posture: `overnight` (= `frame,spec` — attend nothing after the spec) and `skip-plan` (= `frame,spec,impl,docs` — walk away at spec approval, return at the Ship gate; born from the second run's observation that plan-gate approvals were rubber stamps, with whether it earns *default* status tracked as Q20 evidence). The rir arc has one preset, `afk` (= attend nothing — both its gates auto-cross, straight to done). At an auto-crossed gate the harness persists the gate packet, fires the notification, sends `human.approve` on the standing authority, and records the crossing in `state.json` (`autoApprovals`); `duet status` lists the crossings in a "while you were away" section for the morning review. Force-attended gates can never be pre-authorized — the full arc force-attends Open-PR (`pr`), the rir arc force-attends nothing (it has no outward-facing action). The statechart is untouched — gates still transition only on `human.*` events; pre-authorization changes *when* the approval is uttered, never *who* may utter it.

The orchestrator never interprets gate posture from prose. Frontmatter is parsed deterministically by the CLI, stripped from the framing body, and rendered into the phase entry prompts and the `advance_phase` result as harness-authored instructions — including the escape hatch: product calls that would have waited for a live gate are encoded as recommendations and carried forward, *unless* proceeding unanswered would make most downstream work throwaway, in which case `ask_human` (which still pauses the run; pre-authorized ≠ uninterruptible).

The rework path deliberately compresses: a deep error discovered at the next attended gate is handled by reject-with-feedback there (the orchestrator routes the rework) or by abandoning the run — no re-open-an-earlier-phase machinery. Whether overnight runs' encoded recommendations hold up is Q20.

**The frontmatter boundary rule** (also at `src/framing.ts`): a key earns frontmatter only when its practical expression is a **fixed value** and the **harness consumes it without judgment** — if either side is soft, it stays prose. Current keys: `gates_at`, `spec` (a draft-spec path; `--spec` by another door), and `workflow` (the arc name — a fixed value from a closed set, consumed without judgment; `--workflow` by another door). Pre-approved if Q19 lands a run-level budget model: `budget_usd`. Spec/plan locations, verification posture, skills: prose, always — the planlab run's framing gave a spec dir that was wrong relative to the worktree root and judgment resolved it; a deterministic consumer would have enforced the error.

### Branch policy

A run works on **exactly one branch, fixed before the first worker prompt** — created either by the human before `duet new`, or by the orchestrator. The harness reports the repo's current branch in the first phase's entry prompt; the orchestrator judges whether it already looks like the working branch for this problem (a feature branch whose name fits the framing) and proceeds on it, or — when the run sits on the default branch or an unrelated one — calls `create_branch` with a name it chooses. The git side (`git switch -c`) is harness-executed; the tool is structurally legal only before any worker session exists, so mid-run branch switches are unrepresentable.

Workers take the branch as given: the orchestrator names the working branch in its first prompt to each worker, with the instruction that branch management is settled outside their sessions. Branch creation has exactly two owners — the human before the run, or the orchestrator before the first routed prompt — and is never a worker's call.

### The final-gate packet and the CEO summary

When the AFK phase's review loops converge, the orchestrator's **last act before `advance_phase`** is sending the `ceo-summary` snippet to the implementer. The Ship gate then presents, in order:

1. **CEO summary** — the lead artifact. Product-first: what the PR does from a product perspective, bugs fixed, features added, what problems it solves; then the technical approach at CEO/CTO altitude. Written for the user *and* for explaining the PR to a colleague without walking them through the diff. **(general — and directly observed as a recurring free-form move: "give me a more CEO-facing description…" in planlab b7487993 07:22:37Z, a463ad80 07:12:21Z, e9607005 05:12:52Z)**
2. **Implementation handoff** — the review-aligned map (what/why, change map, decisions, deviations, tests, where-to-look-hardest).
3. **Review history** — rounds run, points raised/resolved/disputed, disagreement summary.
4. **Diff stats and round counts vs. backstop caps.**

The full proposed snippet body lives in `docs/workflow-model.md` §"Proposed snippet: ceo-summary". It is documented here before being added to the tabtype library; once adopted there, the duet copy and the tabtype copy stay in sync by hand (duet owns `snippets.toml`; the tabtype config is the human's to update). `ceo-summary` is distinct from `pr-description`: the former is for the human gate and colleague-facing explanation (CEO/CTO altitude), the latter for the PR body (technical colleague who won't read the diff). Both run; `pr-description` follows in FINAL REVIEW.

## Prompt agency

Two-tier, settled 2026-06-11:

- **Per-turn: free.** Each routed turn, the orchestrator adapts the snippet to the run at hand — collapsing the template's deliberate generality onto the actual task while keeping its discipline intact, never steering the solution (`docs/prompting-and-tool-design.md` §"Snippet adaptation") — or composes a custom prompt when nothing fits. Every `send_prompt` logs the source tag and the delta from the template — drift is auditable in the orchestrator's transcript.
- **Library: gated.** Persistent snippet changes are proposals (`propose_snippet_edit`), accumulated and presented at the end-of-run gate for human approval. The library only changes with the user's editorial sign-off.

Rationale: the user already evolves snippets mid-session by hand **(observed: planlab b7487993 08:10–08:28Z, revising `.tabtype.local.toml`)** — so evolution is a real workflow behavior, but a bad adaptation that persists silently would compound across every later run, the same early-correction-leverage logic the `review-midpoint` snippet encodes.

### Template economy

A snippet is a durable **behavioral frame** plus an ephemeral **per-turn payload**, and worker sessions are persistent — so a full template goes to a given worker **once per phase**, with every later turn steered by the delta (`-again` variants for review loops; short frame-referencing follow-ups otherwise). Re-sending a full template makes the worker restart the exercise instead of continuing it **(observed: the first planlab run re-sent `think-holistic` after gate feedback)**. Enforced at three altitudes, none of them a hard block: the principle with its motivation in the orchestrator's system prompt, per-phase send-history annotations on `list_snippets` (`already_sent_this_phase_to`), and a **warn-once-then-allow** gate on `send_prompt` — a duplicate base-template send gets one steering refusal naming the delta alternatives; repeating the identical call passes, so judgment can still override (a human re-scope at a gate is the legitimate case) but the choice is deliberate and auditable.

## Loop semantics

Loop exit (another review round vs. converged) is **orchestrator judgment** — the thing the human currently does by reading the reviewer's response and feeling whether the remaining points are minor. Two deterministic backstops remain in the harness:

- **Hard per-phase round caps** (spec 6, plan 4, impl 6 — deliberately ~2× the round counts the manual sessions ever needed; frame/docs/pr 2, open 1) as runaway protection, not as the exit mechanism. Hitting a backstop is itself an `ask_human` event.
- **Budget caps** per invocation (`--max-budget-usd` on the Claude side) as cost protection. The caps are **per worker turn** — a fresh `send_prompt` carries a fresh ceiling — and since 2026-06-12 the prompts and `send_prompt`'s description say so explicitly, after the first real run showed the rail silently shaping a scope decision (the slice-5 descope cited "~$7 of budget left" mid-turn). Whether an explicit run-level budget model is needed is Q19.

The old mechanisms this replaces: severity-label parsing (never built), `disagree.point` string-matching across rounds (the orchestrator now *reads* the disagreement and judges whether it's persistent and substantive — flagging via `ask_human` when it is), and fixed caps as the primary exit rule.

Implementation runs as a **single pass** by default: the orchestrator instructs the implementer to build the whole plan end to end, and crosses worker turns only because a turn is budget/time-bounded (resumption, not a review rhythm) — the review loop runs once, after the full implementation, never between slices. Splitting the build into implement-a-slice → review → implement-more cycles is the waste this guards against (observed in the first runs: a 3-slice plan driven as two implement turns with a needless inter-turn hold). The **midpoint checkpoint** is the one judgment-gated exception, for a genuinely large plan — more than ~6 slices is a rough signal, but the orchestrator judges by real size and structural risk, not the count. It is a *single* pause: the implementer takes the reviewer's midpoint guidance, applies the now-fixes, and folds the rest into the remaining slices, then continues to the handoff — it pauses once, not per slice, and is skipped entirely for small or moderate work. It is *not* a mandatory human gate (per the user's 2026-06-11 decision); if the midpoint triage surfaces a product question, that flags like any other.

## Worker structured output — demoted, not removed

The 2026-05-26 design made `schemas/agent-response.json` the protocol contract: `needs_human` and `disagree` were how a judgment-free router detected exceptions. With an orchestrator that reads prose, the schema is not load-bearing — workers currently run schema-free and the orchestrator reads their final messages. Whether a minimal `{response_text}` envelope earns its way back is Q16, decided from dogfooding evidence. Two operational notes if it does: the schema must remain OpenAI-strict-compliant, and `--output-schema` on `codex exec resume` works on the pinned CLI (verified — see Q16's resolution note).

## Invocation and lifecycle

CLI surface (implemented in `src/cli.ts` across the full arc):

| Command | What it does |
|---|---|
| `duet new [--spec <draft-path>] [--framing <file>] [--template <name>] [--gates-at <phases\|overnight>] [--retry-infra <n>] [--orchestrator …] [--impl …] [--reviewer …] [--tmux]` | Starts a run. With neither `--spec` nor `--framing`, opens `$VISUAL`/`$EDITOR` on `.duet/framing-draft.md` (seeded from the built-in template, the project's `.duet/templates/default.md`, or — with `--template <name>` — `.duet/templates/<name>.md`, a typo'd name aborting with the available list; GUI editors like VS Code get `--wait` injected; the draft is archived into the run dir as `framing.md` on creation) and starts framing-only from what the user saves — an empty or untouched file aborts (the untouched check tracks whichever seed was used). `--template` is the bare-entry path only; it conflicts with `--spec`/`--framing`, which supply the framing directly. With a draft spec, enters at the spec review rounds; framing-only entry runs the FRAME phase first (onboard → think-holistic → compare-notes → Direction gate) and the spec is drafted after it. `--gates-at` (or the framing frontmatter's `gates_at:`) pre-authorizes the unlisted gates (§"Gate pre-authorization"). `--retry-infra <n>` (or the framing's `retry_infra:`, flag-wins) opts the headless run into bounded auto-retry of transient infra failures (§"Supervising a run from outside"); absent ⇒ no auto-retry, byte-for-byte as today. Returns immediately; the phase runs in a detached driver to its next attended stop. |
| `duet continue [run_id] [--approve ["rider"] \| --reject ["…"] \| --answer "…"] [--tmux]` | Resumes past the current gate or answers a queued `ask_human` flag; defaults to the latest run. An approval may carry a **rider** — agreement plus adjustments, delivered into the next phase as gate feedback in approving form. At a TTY a bare `--approve`/`--reject`/`--answer` opens `$EDITOR` to compose the text (shell flags are a hostile place for substantial feedback — the first-run friction): an empty save approves plain / aborts the rejection. Off a TTY — a headless concierge — it never opens an editor: a bare `--approve` approves with no rider, while a bare `--reject`/`--answer` fails fast naming the inline / file / stdin forms. `--reject-file <path>` / `--answer-file <path>` (with `-` for stdin) relay the human's exact words — apostrophes, newlines, em-dashes — byte-for-byte, past shell quoting. Returns immediately (detached driver); refused while the run's phase is still driving. With no flags: status if waiting at a stop, crash recovery if a phase died mid-flight (the run-position probe says which, and re-utters the crossing the run state evidences). `--tmux` opens or reuses the run's viewer. |
| `duet steer "<note>" [run_id]` | Stages a mid-phase note for the orchestrator — the human's voice, delivered verbatim on the next phase-continuing tool result (§"The steer channel"). Legal only while a phase is live or died mid-flight; at a gate, flag, or finished run the refusal names that stop's own channel. |
| `duet view [run_id]` | Opens (or reuses) the tmux viewer for a run and prints the raw log paths. |
| `duet logs [run_id]` | Streams the driver narration inline (replay + follow of `driver.log`) — the foreground view `new` used to hold. Ctrl-C detaches; the run is unaffected. |
| `duet takeover <role> [run_id]` | Hands a role's session to the human: opens the provider's interactive CLI (`claude --resume <id>` / `codex resume <id>`) on that role's session. Refused while the phase driver is alive (a manual turn would race the orchestrator); at a gate or flag it's the augmentation principle as a command — manual turns land in the same transcript duet later continues from. |
| `duet abandon [run_id] [--purge]` | Stops a run for good: kills the live driver if one is running (SIGTERM→SIGKILL — only the driver pid, so an in-flight worker turn finishes into its own transcript) and marks the run abandoned, so the position probe reads a deliberate stop, not a crash. The transcripts stay, so `continue` revives it (clearing the marker) and `takeover` is unaffected. `--purge` also deletes the run dir and the three session transcripts (orchestrator + both workers, by exact session id — `src/sessions.ts`): the one place duet reaches outside `.duet/` into the user's `~/.claude`/`~/.codex`, so it echoes every path it removes, and it doubles as the post-PR cleanup. |
| `duet status [run_id] [--json] [--brief] [--wait]` | Current state, queued flags, phase summaries, round counts vs. caps, costs, queued snippet proposals, pending steers, gates auto-crossed while you were away, next command. `--json` emits the status model verbatim: one derivation under both renderers, whose discriminated `stop` (running / gate / flag / crashed / abandoned / done) carries the exact command that acts at each position. The schema is additive-only — it is what the concierge skill reads, so a field rename is a breaking change to the shipped skill (pinned by test). `--wait` blocks until the next stop, then prints — the one deterministic supervision cycle, owned by the CLI so watchers never reinvent polling. `--brief` is a lean projection — position, a one-line headline, the next command, pending steers, auto-approvals, and the gate's `humanDecisions` — for fast polling; the three flags compose on orthogonal axes (projection × renderer × timing). The model also carries `sessions[]` (each voice's role / provider / session id) and, on the relevant stop, the gate packet's `humanDecisions[]` and the flag's `cause`/`errorClass` — all additive. |
| `duet doctor [run_id] [--json]` | Per-role **health**, not position: each voice's verdict (`idle` / `working` / `long-inference` / `retrying` / `silent-stuck` / `crashed`), last-activity age, retry count, recent classified errors, and a one-shot connectivity probe (network-down vs. reachable-but-auth-rejected). Reads the workers' own transcripts and the network — heavier than `status`, so it is its own verb and strictly the health renderer (never a third position surface). `--json` adds each role's resolved transcript path. Fail-soft: every transcript/network read degrades to a note, never throws. |
| `duet runs` | Lists known runs in the project. |

The framing input is a single markdown file: an optional machine-parsed frontmatter block (`gates_at`, `spec` — parsed deterministically by the CLI and stripped before the orchestrator sees the framing; §"Gate pre-authorization" carries the boundary rule) followed by prose sent verbatim, structure by convention not contract. The prose is also the orchestrator's project briefing — the only place project knowledge enters the system. A shipped `/duet-frame` skill authors this framing — a CC session that sharpens a rough problem into the framing document (the project's real names, structure, gate posture) without changing intent or proposing solutions, then emits the `duet new --interactive` command (coherence-pinned by `tests/skill.test.ts`).

**Seed templates.** The framing is mostly project-stable — onboarding skill, conventions, verification, doc rules — and only the problem changes run to run, so a project can pre-bake framings under `.duet/templates/` (location and self-ignore policy in "State persistence" below) and seed the editor draft from one. `duet new --template <name>` reads `.duet/templates/<name>.md`; a bare `duet new` prefers `.duet/templates/default.md` over the built-in skeleton. A template is a *full framing* — the same frontmatter-plus-prose shape — so each kind of work can carry its own posture: a `feature.md` that pre-sets `gates_at: skip-plan`, a `bug.md` that names a different onboarding skill or a lighter verification section, with `# Problem` left as the per-run blank. The name is a plain slug (`bug` → `bug.md`); a typo'd `--template` aborts with the available list rather than silently seeding the wrong run, and `--template` is the bare-entry path only — it conflicts with `--spec`/`--framing`, which supply the framing outright. Bootstrap one by copying the built-in skeleton (left in `.duet/framing-draft.md` by a bare `duet new`) or a past run's archived `framing.md`, then clearing the problem. A template is pre-baked framing, not config: it is parsed and archived as the framing itself, so the framing turn stays the single entry seam (§"What the MVP should *not* do" carries the rule, under "Bundle project conventions in config").

**Ending a run.** Between quiescent stops no duet process exists, so a run never *needs* terminating — leaving it is simply never calling `duet continue` again; the run dir stays an inert record (keep `notes.md`, the dogfooding evidence) and a later `duet new` supersedes it as the default. `duet abandon [run_id]` is the explicit form: it stops the live driver if one is running (SIGTERM→SIGKILL — only the driver pid, so an in-flight worker turn finishes harmlessly into its own transcript) and marks the run abandoned, so `probeRunPosition` reads a deliberate stop rather than a crash. Abandonment stays reversible: the session transcripts are untouched, so `duet continue` revives the run (clearing the marker) and `takeover` opens the session unchanged. `duet abandon --purge` is the destructive form — it deletes the run dir and the three session transcripts (orchestrator + both workers, located by exact session id, `src/sessions.ts`). That is the one place duet reaches outside `.duet/` into the user's `~/.claude` / `~/.codex`, so it is opt-in and echoes every path it removes; on a finished run there is no driver to stop, which makes `--purge` the post-PR cleanup too.

State persistence: the run dir `.duet/runs/<run_id>/` holds `state.json` (the human-readable hint: state value, session ids, queued flags, rounds, costs, proposals, auto-crossed gates), `machine.json` (the statechart snapshot, written **only at quiescent states** — gates, flag-waits, done), `framing.md` (the verbatim framing archive), one append-only log per voice, `driver.log` + `driver.pid` (the detached phase driver's stdout and liveness), and `notes.md`. All three JSONL transcripts are the source of truth.

Duet's runtime artifacts live under `.duet/`, never at the repo root: the directory self-ignores (`.duet/.gitignore` containing `*`, written on first creation — the user's own `.gitignore` is never touched, and `git add -f` still allows committing a run record deliberately), the bare-`new` framing draft edits at `.duet/framing-draft.md`, a project's own framing seed templates live in `.duet/templates/<name>.md` (self-ignored like the rest — a template is the human's authoring convenience, not a tracked artifact of the host repo; carve `!/templates/` into `.duet/.gitignore` to share them across worktrees), and the impl entry prompt steers workers to keep throwaway verification harnesses in `.duet/scratch/` or delete them before handoff. Specs, plans, and docs are project files and never live here.

### Visualization: tmux is a viewer, never the runtime

Settled 2026-06-11. Duet owns its subprocesses and writes **one append-only log file per voice** (orchestrator, implementer, reviewer) under `.duet/runs/<run_id>/`. Without tmux, the same lines stream to duet's stdout with colored `[tag]` prefixes (the concurrently/turbo idiom; picocolors auto-disables off-TTY). With `--tmux` on `duet new` / `duet continue` (`src/tmux-view.ts`), duet shells out a handful of tmux commands via execa (no library) to open three titled panes in a 50-50 vertical split — left column: orchestrator narration on top (60%) over reviewer critiques (40%); right column: the implementer at full height, since it produces the longest content — each running `tail -n +1 -F` on its voice's log: `-n +1` so a late-opened pane replays the full transcript, and BSD tail's `-F` waits for logs that don't exist yet. Inside tmux it opens a `duet-<run_id>` window in the current session without stealing focus; outside, a detached session with a printed attach command. Re-invocations reuse the existing viewer; any tmux failure degrades to a one-line note (the notify.ts philosophy — a viewer must never affect the run).

**Context fill is first-class run telemetry.** Each voice's context-window percentage is captured at turn boundaries — never polled: claude-bound roles report usage in-band (the last request's input + cache reads + cache creation + output against `modelUsage`'s context window, the same formula Claude Code's own statusline uses), and codex turns end with one tail-read of the session rollout (`last_token_usage.total_tokens` against `model_context_window`). The reading lands in `state.json` (a hint, like everything there — stale after manual takeover turns, refreshed on the next driven turn), in the voice-log response headers (`· context 41%`), in `duet status` and the `--json` model's `context` field, and in the tmux pane titles via a plain-text sidecar (`.duet/runs/<id>/context/<voice>`, e.g. `41%`) that the border format `#(cat)`s at its refresh interval. Numeric percentages only, by decision; capture is best-effort and fail-soft — a missing reading is an absent line, never a failed turn.

**Color is view-time only** (added 2026-06-12): the log files stay plain text — they are the inspectable-without-duet artifacts — and each pane pipes its tail through `duet _colorize <voice>` (`src/colorize.ts`, picocolors), which dims timestamps and paints header lines in the role's color (orchestrator cyan ◆, implementer blue ■, reviewer yellow ●; errors red) while bodies pass through untouched. Pane titles carry the role glyphs, colored via a `pane-border-format` branch on the leading glyph (tmux has no per-pane border style). `duet logs` applies the same `[tag]` palette to the driver narration. Because worker turns are non-streaming and can run 30+ minutes (observed in the first real run), `send_prompt` emits a heartbeat line into the voice log and driver narration every 5 minutes — panes never look hung. A streaming sink remains the eventual fix.

The properties this buys: killing tmux doesn't kill agents; killing duet doesn't corrupt tmux; one code path produces lines and two dumb sinks consume them; and the log files are themselves inspectable-without-duet artifacts. The rejected alternative is the claude-squad architecture (agents live *inside* tmux sessions, state read back by `capture-pane` screen-scraping) — vendored as the anti-model at `references/claude-squad/` (AGPL — read-only inspiration, no code reuse).

Separately from the viewer, every quiescent stop fires a best-effort macOS notification (`src/notify.ts`) — gate reached, question queued, or run complete — because the AFK phase's whole point is that the human is elsewhere when those land. Notification failure is silently swallowed; `duet status` carries the same information.

### Supervising a run from outside

Supervising a run — by the human, the concierge, or the interactive orchestrator — is mostly answering one recurring question: **is this run healthy, waiting on my decision, or recoverably broken — and if it's waiting, what do I type?** The *position* half is the `status` model and its discriminated `stop`. The *health* half is a pure substrate (`src/worker-health.ts`): an error taxonomy (first-match-wins: login-required → quota-billing → auth → rate-limit → network → dns → server) and a per-role probe that reads each voice's own transcript and returns a verdict (`idle` / `working` / `long-inference` / `retrying` / `silent-stuck` / `crashed`). Three read-only surfaces share it — never three parsers: `duet doctor` (the on-demand health view plus a connectivity probe), the `send_prompt` heartbeat (so a quiet pane reads as thinking-vs-hung without running a command), and the driver's crash classification. Two liveness sources feed the verdict — the two workers via a persisted `activeTurns` hint reconciled against driver liveness, the orchestrator via driver + phase state — and every read is fail-soft: a missing transcript is an absent detail, never a failed command.

Two triage outcomes are promoted from prose to fields, so a supervisor decides mechanically rather than re-reading paragraphs — both **signal-only**, neither touching gate-crossing:

- **`humanDecisions[]` on a gate packet** — the orchestrator's structured echo of the genuine human decisions it surfaced, each `severity: low | high`. Empty or all-`low` → safe to relay an approve; any `high` → hold and escalate. The statechart cannot see it; only the human's tap crosses a gate (the two-vocabulary guarantee, untouched).
- **`cause` + `errorClass` on a queued question** — an `ask_human` flag is `cause: 'human'` (escalate); an infra-caught failure is `cause: 'infra'` plus the taxonomy `errorClass` (resume / retry territory). The `crashed` *position* (driver death, observed by `probeRunPosition`) is a separate, unchanged signal.

**The opt-in auto-retry policy.** By default a transient infrastructure failure flags exactly as before — the run returns to a well-formed question, never silent churn. A run may opt the **headless** driver into bounded recovery (`--retry-infra <n>` / `retry_infra:`, default-off): on a caught failure the driver classifies via the same taxonomy and, for a recoverable class (`network`, `server`, `rate-limit`), re-enters the phase through the existing session-resume path after a capped backoff rather than flagging. `auth` retries once, then a second consecutive `auth` escalates as `login-required`; `login-required`, `quota-billing`, `dns`, and `unknown` never retry; exhaustion always falls back to a flag (every stop still has a next command). The policy lives in exactly one place — the headless driver; the classification taxonomy reaches two — the driver and the stdio interactive host — but the interactive host only classifies, never auto-retries, because a human is present to resume.

### Remote interaction: Claude Code is the concierge layer

Duet never builds its own remote, mobile, or notification infrastructure (the standing constraint in `docs/future-directions.md`); Claude Code is the remote layer. `skills/duet-concierge/` ships a skill that teaches any CC session to drive the duet CLI on the human's behalf — so CC's native remote control, mobile push, and `/loop` supervision become duet's reach-from-anywhere for free. The concierge is interaction glue with zero runtime: killable without consequence, and the run is exactly as operable from the terminal as without it (augment-never-lock-in holds).

The skill's substance is discipline, in priority order: **identity** — a relay, not a fourth engineer; it reports, translates, and executes intent, never opines on artifacts (the orchestrator's division-of-labor rule extended one layer out). **Verbatim relay** — the human's words cross unparaphrased into `--reject`, `--answer`, and `steer`; summarize toward the human freely, never editorialize from them. **Channel translation** — `status --json`'s `stop.kind` keys a mechanical table from intent to command. **Turn-ending stop reports** — when a gate, flag, crash, or completion lands, the concierge ends its turn with the report, which is what reliably fires CC's mobile push. **Double-gated gates** — the skill pre-approves read verbs only (`status`, `logs`, `runs`); the recommended permission `ask` rule on `duet continue` means crossing a gate takes the human twice — chat intent plus the permission prompt, on the phone too — so even a rogue concierge cannot cross alone. The skill is invoked explicitly (`/duet-concierge`), never auto-triggered: a session that merely mentions runs and gates — a session developing duet itself is the standing example — must not inherit the relay role. A coherence test (`tests/skill.test.ts`) pins every verb and flag the skill names to the real command table, and asserts both deliberate frontmatter properties: read-verbs-only pre-approval and explicit-invocation-only.

`duet takeover` stays terminal-only by nature (it opens an interactive CLI); multi-run supervision and the orchestrator-in-CC variant are tracked in `docs/future-directions.md`.

## What the MVP should *not* do

- **Auto-merge or auto-open the PR.** Never. The Open PR gate is the handoff to human product judgment.
- **Let the orchestrator write.** No write/edit/bash tools in its surface — a property of the harness. It commands workers; it never touches artifact content. The single, deliberate exception is `create_branch` (§"Branch policy"): a harness-executed ref creation before any work exists — the orchestrator supplies the judgment and the name, the harness runs the git command, and the tool is structurally unavailable once a worker has been prompted.
- **Let the orchestrator answer substance.** Triage only. Product, environment → human; tactical → bounced to the worker.
- **Apply snippet-library edits mid-run.** Proposals queue to the end-of-run gate.
- **Run a daemon or concurrent runs per repo.** The process lives through a phase, exits at gates; runs stay serial.
- **Support more than two providers.** *(Reworded 2026-06-11 from "be agent-agnostic" — roles are now provider-decoupled by design, but the provider set is exactly {claude, codex}.)* A third provider still means forking the code — an explicit choice, not a gap. No vendor-abstraction layer general enough for OpenRouter/AI-SDK/etc.
- **Bundle project conventions in config.** *(Amended 2026-06-11.)* One config file now exists — the role-bindings file (§"Roles are decoupled from providers") — and it is scoped to role→provider/model bindings only. Spec paths, skill names, branch conventions, doc-update rules: still framing-turn territory, never config. If a key that isn't a role binding is about to land in the config file, that's the design failing. *(Framing templates (`.duet/templates/`, added 2026-06-16) are the apparent exception that proves the rule: they do carry conventions across runs, but they are **pre-baked framing**, not config — parsed and archived as the framing itself, so the framing turn stays the single entry seam. The heavier "project profile" that would auto-merge such pre-context is still shelved; see `docs/future-directions.md`.)*

(Removed from this list, by reversal: "Use an LLM as the routing judge" — see §"Design history".)

## Success criteria

1. **Planning:** a full attended PLANNING phase where the human's only keyboard touches are the framing, the gates, and `ask_human` answers — zero copy-paste routing.
2. **AFK:** an IMPLEMENTATION phase the human leaves for 1–3 hours, returning to either a Ship-gate packet (CEO summary on top) or a well-formed queued question — never a silently stuck or runaway loop.
3. **Auditability:** for any routed turn, the orchestrator's transcript answers "why this snippet, why this adaptation" without asking anyone.

If duet achieves that on three features of varying size in the user's own projects, the design has earned further investment.
