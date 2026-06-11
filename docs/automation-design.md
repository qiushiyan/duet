# Automation design

This document describes the duet design as of the **2026-06-11 pivot**: a three-role architecture in which an intelligent, read-only LLM **orchestrator** routes the snippet protocol between an **implementer** and a **reviewer**, inside a deterministic phase-and-gate skeleton enforced in code. It supersedes the dumb-router design of 2026-05-26. The reversal and its rationale are recorded in §"Design history" below; the affected open questions carry amendment notes (`docs/open-questions.md` Q7, Q8, Q10) and the new questions the pivot raises are Q11–Q17.

**Implementation status:** the attended PLANNING phase is implemented and live-verified (`src/harness/` statechart + driver, `src/cli.ts`, `src/providers/`; the verifying run is recorded in Q14). The AFK IMPLEMENTATION phase is implemented (plan-approval gate → slices → midpoint/compaction at orchestrator judgment → handoff → review loop → `ceo-summary` → Ship gate) along with worker compaction (Q18) and macOS notifications at every quiescent stop — not yet live-verified by a real AFK run. Approving the Ship gate currently ends the run: the FINAL REVIEW phase, the framing-entry front half of PLANNING, and `--tmux` remain design-only.

## Design principles

These shape every other choice. Re-read before adding scope.

### Augment, don't replace

Duet drives the same `claude` and `codex` CLIs the user already uses, with the same snippet protocol, against the same codebase. Every artifact duet produces is also producible by the manual workflow — JSONL transcripts in the standard locations, branches with regular names, commits with regular messages. The pivot *extends* this principle rather than weakening it: the orchestrator is itself an LLM session with its own JSONL transcript, so every routing decision it makes is inspectable and auditable the same way the workers' turns are. There is no "duet mode" the user is locked into.

### Stop anytime

A run can be paused indefinitely. The state file at `.duet/runs/<run_id>/state.json` is a fast-access hint; the source of truth is the JSONL transcripts of all **three** sessions (implementer, reviewer, orchestrator). The user can stop at any gate, switch to manual `claude --resume <id>` / `codex exec resume <id>`, add turns by hand, and either resume duet later or never. On resume, the harness re-reads JSONL tails; the orchestrator re-derives position from the transcripts, not from cached offsets.

### Personal tool, not OSS

Built for one developer's use across their own projects. The CLI is project-agnostic: no project conventions hardcoded, no skill registry, no `.duetrc`, no codebase introspection. Project-specific knowledge — which skills exist, where specs go, branch conventions, model choices — flows in through the user's framing turn at `duet new`. When the framing references something that doesn't exist, the orchestrator flags it to the human rather than inventing fallbacks.

### Not a daemon — but alive through a phase

*Amended from the 2026-05-26 "per-gate process" rule.* The process model is now **per-phase, not per-gate**: a `duet` invocation runs one phase (which may take 1–3 hours during AFK implementation), exits at the next gate or queued exception, and persists state. Nothing runs when no phase is active; there is still no daemon, no GUI, no webhook listener. The amendment exists because an intelligent orchestrator must hold its session open *across* the many routed turns inside a phase — but gates remain process exits, which is what keeps the semi-AFK shape (answer a gate from any terminal, hours later).

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

Settled 2026-06-11: **a role is a capability contract; a provider is an implementation that can serve one or more roles.** No role is hardcoded to a vendor — orchestrator-on-codex with reviewer-on-claude is a legal configuration, not a fork. This generalizes Q6 (which established the impl/reviewer swap) to all three roles.

Exactly two providers exist, and their configuration philosophies deliberately differ:

- **`claude`** — Anthropic models via the Agent SDK / `claude` CLI. Configured **per-model**: each role binding may name a specific model ID (`claude-opus-4-8`, `claude-opus-4-6`, `claude-fable-5`, …), because choosing the Anthropic model per role is a knob the user actually turns.
- **`codex`** — the Codex CLI. **No model key by design**: duet defers entirely to the user's own `~/.codex/config.toml` (model, reasoning effort, profiles). That's how codex is meant to be configured, and duet doesn't duplicate it. Specific ChatGPT model support in duet is a non-feature.

**Capability contract per role.** Worker roles (implementer, reviewer) need session resume, streamed output, and — for the reviewer — read-only operation; both providers satisfy these today (claude via SDK/CLI flags, codex via `codex exec -s read-only` + `resume`). The **orchestrator** role demands more: custom harness tools (`send_prompt`, `ask_human`, …), read-only enforcement, and pause/resume at a tool call. The claude provider satisfies this natively (Agent SDK in-process tools + `canUseTool`). The codex provider could satisfy it via a local MCP server exposing the harness tools — the interface is designed to allow it, but it is **not built in v1**; the bridge sketch and its open verification questions live in Q17.

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

Per-run CLI flags override the file: `--orchestrator <provider[:model]>`, `--impl <provider[:model]>`, `--reviewer <provider[:model]>` (e.g. `--impl claude:claude-opus-4-6`, `--reviewer codex`). The file above is also the **shipped default** when absent: `{orchestrator: claude/opus, implementer: claude/opus, reviewer: codex}` — matching the user's current setup and the observed sessions.

## Architecture: three layers

### Layer 1 — Harness (deterministic code)

A statechart: each **phase** is a state that runs the orchestrator agent; each **gate** is a state in which no agent runs and which transitions only on human events. Agent-emitted events at a gate are no-ops by construction — gate-skipping is unrepresentable, not merely forbidden. (XState v5 semantics are the reference model; whether the implementation uses XState or a ~100-line hand-rolled transition table is Q15. The semantics are settled either way.)

The harness also owns:

- **Worker subprocess plumbing** — spawn/resume worker sessions, completion detection, output capture, graceful kill (SIGTERM→SIGKILL escalation; the one bug *not* to inherit from prior art is sandcastle's missing `proc.kill()`). Prior art is vendored at `references/sandcastle/` (MIT — copy with attribution): exact CLI invocations in `src/AgentProvider.ts`, stream-line parsers for both CLIs, idle-vs-completion dual timeouts in `src/Orchestrator.ts` + ADR 0019, session-file lookup by id in `src/SessionStore.ts`. See `references/README.md` for the full per-repo borrowing guide.
- **Read-only enforcement** — the orchestrator's tool surface contains no write/edit/bash tools. Its read-only nature is a property of the harness, not a promise in a prompt.
- **Gate interception** — `ask_human` and `advance_phase` are harness-owned tool handlers: the handler persists the question/phase-exit at the moment of the call (the human-visible artifact exists before the model regains control), then instructs the orchestrator to end its turn; the harness exits when the turn ends. The interception is the handler side effect, not the permission system — the SDK's mechanical pauses corrupt resume (Q11).
- **State persistence** — the machine snapshot is written **only at quiescent states** (gates, flag-waits, done — states with no live actors). Mid-phase crash recovery comes from the JSONL transcripts, which is where it always came from.

### Layer 2 — Orchestrator (LLM agent)

A read-only agent whose system prompt is the workflow protocol operationalized — phases, snippet usage rules, altitude lenses, compaction discipline, triage rules — plus the per-run framing the user supplies. The role is provider-decoupled (§"Roles are decoupled from providers"); when bound to the **claude provider** — the default, and the only orchestrator-capable provider in v1 — the substrate is the Claude Agent SDK (read-only via tool configuration — `tools: []` hides all built-ins, custom tools via `tool()` + `createSdkMcpServer()`; session JSONL on disk in the standard location, so the orchestrator's session stays manually resumable with `claude --resume`); confirmed by the Q11 spike, **with one correction**: the AFK pause at `ask_human` is *cooperative*, not mechanical — the tool handler queues the question, persists state, and instructs the orchestrator to end its turn; the SDK's mechanical pause options (hook `defer`, `canUseTool` deny+interrupt) both corrupt session resume in SDK 0.3.170 (see Q11 and the repros at `src/spike/repro-*.ts`). The SDK source is vendored for API study at `references/claude-agent-sdk-typescript/` (proprietary license — consume as an npm dependency, don't copy code; see `references/README.md`).

**Tool surface:**

| Tool | What it does |
|---|---|
| `list_snippets()` | Read the built-in snippet library (keys + bodies). |
| `send_prompt(role, tag, body)` | Send a prompt to the implementer or reviewer and return the worker's response. `tag` names the source snippet (`"custom"` when composed from scratch); `body` is the final text. Every call logs the tag and the body, so adaptation drift is auditable. |
| `ask_human(question, context?)` | Flag something for the human. Always the cooperative pause: the handler persists the question, the run exits at quiescence, and the human answers via `duet continue --answer` — in attended phases they're at the terminal and answer in minutes; during AFK the question waits. |
| `advance_phase(summary, artifacts, spec_path?)` | Declare the phase complete. Legal only when the phase's exit criteria are plausible; lands on the phase's human gate (the `open` sub-phase, which runs after the last gate, advances straight to done). `spec_path` reports where the spec file landed when the phase produced it (framing-only entry). |
| `create_branch(name)` | Create and switch to the run's working branch (§"Branch policy"). Harness-executed; structurally legal only before the first worker prompt. |
| `propose_snippet_edit(snippet_key, proposed_body, rationale)` | Queue a persistent snippet-library change for the human's end-of-run review. Never applied mid-run. |
| `write_note(observation)` | Append a friction observation to `.duet/runs/<run_id>/notes.md` (the Q10 convention, with a second author). |

#### Prompting and tool-surface conventions

Adopted 2026-06-11 from Anthropic's published guidance, first applied in the Q11 spike. The full reference — the distilled guidance, the duet house patterns, and the source links — is **`docs/prompting-and-tool-design.md`**; consult it whenever writing or revising a prompt, tool definition, or tool result. The five binding rules:

1. **Artifacts first, task last, XML-tagged** — longform content at the top in `<documents>` tags, instructions in a `<task>` block at the end.
2. **Thinking framework over prohibition** — positive instructions carrying the *why*; no aggressive emphasis (current models overtrigger on it).
3. **Tool descriptions surface the implicit, load-bearing facts** (e.g. `send_prompt`: roles are persistent sessions; worker turns are slow).
4. **Errors prescribe the recovery path** — name the failure layer, say what to do next; never bare tracebacks.
5. **Results that change the agent's next step say so explicitly, with the reason** (the `ask_human` queued-response nudge that makes the cooperative pause work).

### Layer 3 — Workers

Unchanged in shape from the 2026-05-26 design: resumed CLI sessions, transcripts in the standard locations, invoked per turn by the harness on the orchestrator's instruction. Driving mechanics verified 2026-06-11 against the locally installed CLIs:

- **Codex reviewer** — `codex exec -s read-only` is the correct minimal sandbox for a read-only reviewer (no `--dangerously-*` flags); resume is a verb (`codex exec resume <id>`) and **`--output-schema` works on resume** in codex-cli 0.133.0 (upstream issue fixed May 2026 by openai/codex#23123 — live-verified locally with a two-turn schema-enforced smoke test). Resume lacks `-s`/`-C` flags; pass `-c 'sandbox_mode="read-only"'` instead. Gotcha: an open stdin pipe makes `codex exec` block waiting for EOF — close stdin or pipe the prompt through it deliberately. Preferred wrapper: `@openai/codex-sdk` (thin spawn-the-CLI wrapper; rollouts still land in `~/.codex/sessions/`, so augmentation holds), pinned to the same release as the CLI, with the raw flags as known-working fallback. SDK source + docs vendored at `references/codex/`.
- **Claude implementer** — a spawned `claude -p --output-format json --resume <id>`, writing the standard `~/.claude/projects/` transcripts and drawing from the subscription credit pool (see Q11). Headless permission posture: **`--permission-mode bypassPermissions`** (the user's 2026-06-11 decision) — the AFK implementer edits files, commits, and runs project commands (tests, typecheck, builds) with nobody at the keyboard, and the user accepts the unprompted-execution tradeoff on their own repos. Explicit deny rules still apply, and the CLI refuses to run as root.

### Worker compaction (evidence: Q18)

The compaction points in the workflow (`compact-for-plan`, `compact-for-review`) are implementer-side moves, and the mechanics are per-provider:

- **claude** — the orchestrator sends the implementer a prompt whose body is literally `/compact ` followed by the adapted compaction snippet; the session compacts natively in place (same session id, `compact_boundary` event, instructions honored — live-verified headlessly, including via the stdin path the provider uses). The provider substitutes a synthetic confirmation for the compaction turn's empty result. A `reread-context` turn pointing at the plan file and spec re-anchors the implementer afterward.
- **codex** — auto-compaction only, built into the core session engine every frontend shares (default threshold: 90% of the model's context window). Duet never sends codex a compaction command and never touches `~/.codex/config.toml` (whose `model_context_window` / `model_auto_compact_token_limit` overrides are the one known way to break exec-mode auto-compaction).

This is also why **the plan must be a file in the repo** (path named by the framing; the orchestrator flags the human if the framing is silent): compaction drops the implementer's journey, and the plan file plus the committed spec are what post-compaction turns re-anchor on.

## Question triage

The orchestrator's flagging rules, stated as instructions it must follow. Questions from workers come in three kinds:

1. **Product / direction questions** ("should this be billing-gated?", "is breaking compatibility acceptable?") — **always flag** via `ask_human`. No exceptions.
2. **Environment questions** ("do you need me to run the migration?", anything touching DB/Slack/deploy credentials) — **always flag**; only the human can act. **(observed: planlab b7487993 12:10:23Z, e9607005 10:34:53Z)**
3. **Tactical questions the worker can answer itself** ("do I need a migration step for this schema change?") — the orchestrator answers with **process, not substance**: "decide per the plan and record the decision; if it's actually a product call, say so and I'll flag it."

The orchestrator never supplies a technical opinion of its own — answering would make it an invisible third opinion-holder whose influence bypasses the human gates. Whether these rules over-flag or under-flag in practice is Q13, validated in the first slice.

## Phases and gates

Three top-level phases (the old nine-phase machine survives as nested steps inside them):

```
PLANNING (attended)
  onboard → frame (both, parallel) → synthesize
    ── GATE: Direction ──
  spec draft → review/update rounds
    ── GATE: Commit spec ──
  compact-for-plan → plan draft → review/update rounds
    ── GATE: Plan approval ──            ← human walks away here
IMPLEMENTATION (AFK)
  slices (midpoint checkpoint at orchestrator's judgment)
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

During attended phases the human does not interject mid-turn; the orchestrator drives, and the gates plus `ask_human` flags are the interaction points.

In the harness, the three top-level phases decompose into machine sub-phases, each on the same loop/flag-wait/gate idiom: PLANNING is `frame` (onboard → think-holistic in both workers → compare-notes synthesis → Direction gate; runs only on framing-only entry) then `spec` (draft on framing-only entry, then review rounds → Commit-spec gate) then `plan` (→ Plan-approval gate); IMPLEMENTATION is `impl` (→ Ship gate); FINAL REVIEW is `docs` (drive the docs update to its proposal → Docs-plan gate) then `pr` (execute the approved docs plan, draft `pr-description` → Open-PR gate) then `open` (push + `gh pr create` → done, no further gate). The review-loop sub-phases (`spec`, `plan`, `impl`) must run at least one review round before `advance_phase`; the others (`frame`, `docs`, `pr`, `open`) may advance without one — their substance is synthesis or mechanics, and the reviewer is available but optional. Backstop caps: spec 6, plan 4, impl 6, frame/docs/pr 2, open 1.

### Branch policy

A run works on **exactly one branch, fixed before the first worker prompt** — created either by the human before `duet new`, or by the orchestrator. The harness reports the repo's current branch in the first phase's entry prompt; the orchestrator judges whether it already looks like the working branch for this problem (a feature branch whose name fits the framing) and proceeds on it, or — when the run sits on the default branch or an unrelated one — calls `create_branch` with a name it chooses. The git side (`git switch -c`) is harness-executed; the tool is structurally legal only before any worker session exists, so mid-run branch switches are unrepresentable.

Workers take the branch as given: the orchestrator names the working branch in its first prompt to each worker, with the instruction that branch management is settled outside their sessions. Branch creation has exactly two owners — the human before the run, or the orchestrator before the first routed prompt — and is never a worker's call.

### The final-gate packet and the CEO summary

When the AFK phase's review loops converge, the orchestrator's **last act before `advance_phase`** is sending the `ceo-summary` snippet to the implementer. The Ship gate then presents, in order:

1. **CEO summary** — the lead artifact. Product-first: what the PR does from a product perspective, bugs fixed, features added, what problems it solves; then the technical approach at CEO/CTO altitude. Written for the user *and* for explaining the PR to a colleague without walking them through the diff. **(general — and directly observed as a recurring free-form move: "give me a more CEO-facing description…" in planlab b7487993 07:22:37Z, a463ad80 07:12:21Z, e9607005 05:12:52Z)**
2. **Implementation handoff** — the review-aligned map (what/why, change map, decisions, deviations, tests, where-to-look-hardest).
3. **Review history** — rounds run, points raised/resolved/disputed, disagreement summary.
4. **Diff stats and round counts vs. backstop caps.**

The full proposed snippet body lives in `docs/workflow-model.md` §"Proposed snippet: ceo-summary". It is documented here before being added to the tabtype library; once adopted there, the duet copy and the tabtype copy should stay in sync via the Q12 library-home convention. `ceo-summary` is distinct from `pr-description`: the former is for the human gate and colleague-facing explanation (CEO/CTO altitude), the latter for the PR body (technical colleague who won't read the diff). Both run; `pr-description` follows in FINAL REVIEW.

## Prompt agency

Two-tier, settled 2026-06-11:

- **Per-turn: free.** Each routed turn, the orchestrator may use a snippet verbatim, adapt it to context (file paths, project vocabulary, focus), or compose a custom prompt. Every `send_prompt` logs the source tag and the delta from the template — drift is auditable in the orchestrator's transcript.
- **Library: gated.** Persistent snippet changes are proposals (`propose_snippet_edit`), accumulated and presented at the end-of-run gate for human approval. The library only changes with the user's editorial sign-off.

Rationale: the user already evolves snippets mid-session by hand **(observed: planlab b7487993 08:10–08:28Z, revising `.tabtype.local.toml`)** — so evolution is a real workflow behavior, but a bad adaptation that persists silently would compound across every later run, the same early-correction-leverage logic the `review-midpoint` snippet encodes.

## Loop semantics

Loop exit (another review round vs. converged) is **orchestrator judgment** — the thing the human currently does by reading the reviewer's response and feeling whether the remaining points are minor. Two deterministic backstops remain in the harness:

- **Hard per-phase round caps** (spec 6, plan 4, impl 6 — deliberately ~2× the round counts the manual sessions ever needed; frame/docs/pr 2, open 1) as runaway protection, not as the exit mechanism. Hitting a backstop is itself an `ask_human` event.
- **Budget caps** per invocation (`--max-budget-usd` on the Claude side) as cost protection.

The old mechanisms this replaces: severity-label parsing (never built), `disagree.point` string-matching across rounds (the orchestrator now *reads* the disagreement and judges whether it's persistent and substantive — flagging via `ask_human` when it is), and fixed caps as the primary exit rule.

The midpoint checkpoint is orchestrator judgment too (invoke for large implementations, skip for small — per the user's 2026-06-11 decision it is *not* a mandatory human gate); if the midpoint triage surfaces a product question, that flags like any other.

## Worker structured output — demoted, not removed

The 2026-05-26 design made `schemas/agent-response.json` the protocol contract: `needs_human` and `disagree` were how a judgment-free router detected exceptions. With an orchestrator that reads prose, the schema is not load-bearing — workers currently run schema-free and the orchestrator reads their final messages. Whether a minimal `{response_text}` envelope earns its way back is Q16, decided from dogfooding evidence. Two operational notes if it does: the schema must remain OpenAI-strict-compliant, and `--output-schema` on `codex exec resume` works on the pinned CLI (verified — see Q16's resolution note).

## Invocation and lifecycle

CLI surface (implemented in `src/cli.ts` through the PLANNING and AFK IMPLEMENTATION phases; approving the Ship gate ends the run while FINAL REVIEW remains unbuilt):

| Command | What it does |
|---|---|
| `duet new --spec <draft-path> [--framing <file>] [--orchestrator …] [--impl …] [--reviewer …]` | Starts a run at the spec review rounds; `--framing` supplies the project briefing alongside. Runs the current phase to its next gate or queued flag, then exits. (A framing-only entry that runs PLANNING's onboard/frame/synthesize front half is designed but not built.) |
| `duet continue [run_id] [--approve \| --reject "…" \| --answer "…"]` | Resumes past the current gate or answers a queued `ask_human` flag; defaults to the latest run. With no flags, re-enters a run that stopped mid-phase (crash recovery — the driver re-derives position from the transcripts). |
| `duet status [run_id]` | Current state, queued flags, phase summaries, round counts vs. caps, costs, queued snippet proposals, next command. |
| `duet runs` | Lists known runs in the project. |

The framing input is a single markdown file sent verbatim, structure by convention not contract. The framing is also the orchestrator's project briefing — it is the only place project knowledge enters the system.

State persistence: the run dir `.duet/runs/<run_id>/` holds `state.json` (the human-readable hint: state value, session ids, queued flags, rounds, costs, proposals), `machine.json` (the statechart snapshot, written **only at quiescent states** — gates, flag-waits, done), one append-only log per voice, and `notes.md`. All three JSONL transcripts are the source of truth.

### Visualization: tmux is a viewer, never the runtime

Settled 2026-06-11. Duet owns its subprocesses and writes **one append-only log file per voice** (orchestrator, implementer, reviewer) under `.duet/runs/<run_id>/`. Without tmux, the same lines stream to duet's stdout with colored `[voice]` prefixes (the concurrently/turbo idiom). With `--tmux`, duet shells out (~5 tmux commands via execa, no library) to open panes each running `tail -n +1 -F` on a voice's log file — `-n +1` so a late-opened pane replays the full transcript.

The properties this buys: killing tmux doesn't kill agents; killing duet doesn't corrupt tmux; one code path produces lines and two dumb sinks consume them; and the log files are themselves inspectable-without-duet artifacts. The rejected alternative is the claude-squad architecture (agents live *inside* tmux sessions, state read back by `capture-pane` screen-scraping) — vendored as the anti-model at `references/claude-squad/` (AGPL — read-only inspiration, no code reuse).

Separately from the viewer, every quiescent stop fires a best-effort macOS notification (`src/notify.ts`) — gate reached, question queued, or run complete — because the AFK phase's whole point is that the human is elsewhere when those land. Notification failure is silently swallowed; `duet status` carries the same information.

## What the MVP should *not* do

- **Auto-merge or auto-open the PR.** Never. The Open PR gate is the handoff to human product judgment.
- **Let the orchestrator write.** No write/edit/bash tools in its surface — a property of the harness. It commands workers; it never touches artifact content. The single, deliberate exception is `create_branch` (§"Branch policy"): a harness-executed ref creation before any work exists — the orchestrator supplies the judgment and the name, the harness runs the git command, and the tool is structurally unavailable once a worker has been prompted.
- **Let the orchestrator answer substance.** Triage only. Product, environment → human; tactical → bounced to the worker.
- **Apply snippet-library edits mid-run.** Proposals queue to the end-of-run gate.
- **Run a daemon or concurrent runs per repo.** The process lives through a phase, exits at gates; runs stay serial.
- **Support more than two providers.** *(Reworded 2026-06-11 from "be agent-agnostic" — roles are now provider-decoupled by design, but the provider set is exactly {claude, codex}.)* A third provider still means forking the code — an explicit choice, not a gap. No vendor-abstraction layer general enough for OpenRouter/AI-SDK/etc.
- **Bundle project conventions in config.** *(Amended 2026-06-11.)* One config file now exists — the role-bindings file (§"Roles are decoupled from providers") — and it is scoped to role→provider/model bindings only. Spec paths, skill names, branch conventions, doc-update rules: still framing-turn territory, never config. If a key that isn't a role binding is about to land in the config file, that's the design failing.

(Removed from this list, by reversal: "Use an LLM as the routing judge" — see §"Design history".)

## Success criteria

1. **Planning:** a full attended PLANNING phase where the human's only keyboard touches are the framing, the gates, and `ask_human` answers — zero copy-paste routing.
2. **AFK:** an IMPLEMENTATION phase the human leaves for 1–3 hours, returning to either a Ship-gate packet (CEO summary on top) or a well-formed queued question — never a silently stuck or runaway loop.
3. **Auditability:** for any routed turn, the orchestrator's transcript answers "why this snippet, why this adaptation" without asking anyone.

If duet achieves that on three features of varying size in the user's own projects, the design has earned further investment.
