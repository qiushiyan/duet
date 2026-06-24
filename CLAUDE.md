# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What

`duet` — personal semi-AFK orchestrator for one developer's two-agent workflow: a read-only LLM **orchestrator** routes a snippet protocol between an **implementer** and a **reviewer**, inside a code-enforced statechart whose human gates agents cannot cross. Workflow-aware: a run picks one arc — the thorough `full` (spec → plan → … → PR) or the lighter `rir` (research → implement → ship). Repo = design docs (authoritative for _what_ to build) + implementation at root (pnpm + TS, no build step in dev).

Product goals — the bar every change is measured against:

- **Augment, never lock in.** Same CLIs, same snippets, standard transcripts and normal branches; manual takeover and resume must always work; the state file is a hint, never an obstacle.
- **The human owns substance.** The orchestrator does triage, never opinions; product/direction/environment questions always reach the human; gates are structural (statechart), not prompt-enforced.
- **Semi-AFK.** Walk away at the workflow's handoff gate (full: plan approval; rir: Direction); return to a ship packet or a well-formed queued question. Nothing runs between quiescent stops — no daemon.
- **Personal tool first, publish-ready.** Project knowledge enters only via the framing turn; the only config is role→provider bindings; exactly two providers. Shipped artifacts (`skills/`, README) are written for any user.

**Status** (detail in `README.md`). Both arcs, both orchestrator hosts (headless + interactive), the concierge package, the optional consultant + its acceptance contract, run-supervision (`duet doctor`, opt-in infra retry), and the interactive-Claude transport are built and test-verified (~800 tests). What's *not* done is live verification: only FRAME→Ship has run end-to-end against real workers; the interactive orchestrator, RIR, the consultant, and the `duet afk` handoff await their first live (auth-gated) runs, and the human's environment smoke tests are pending. Codex-as-orchestrator is deliberately unbuilt (Q17).

## Map — docs and code by topic

Each cluster pairs the doc that explains a subsystem with the code that implements it. Read the doc before redesigning; the code lines are locators, not descriptions — the deep per-module detail lives in `docs/engineering.md`, not here.

**The design, top to bottom** (read these first)
- `docs/automation-design.md` — THE design: the three roles, the three layers, phases/gates, question triage, branch policy, lifecycle, what-not-to-build.
- `docs/engineering.md` — the codebase's mental model: module map, the six seams, the patterns, XState usage, testing strategy. **Read before moving code.**

**Workflow, phases & the statechart**
- `src/phases.ts` — the workflow registry (`WORKFLOWS`): the arcs as data (ordered phases, gates + copy, round caps, budgets, snippet sets, consultant checkpoints, the acceptance-contract pair); `validateRegistry` guards the flat-vs-scoped derivation at load.
- `src/harness/machine.ts` — the per-arc statechart (`machineFor`); `interactiveMachineFor` is the inert-driver variant the interactive host rests on.
- `src/harness/phase-events.ts` — the disjoint `phase.*` (internal) / `human.*` (authority) vocabularies + the persisted marker→event read.

**The run loop & its hosts**
- `src/harness/driver.ts` — the in-process host: one Agent SDK orchestrator session per phase; infra classify + opt-in retry; honors the terminal marker.
- `src/harness/lifecycle.ts` — the detached `_drive` process: pid guard, `gates_at` auto-cross, the spent-marker guard, `probeRunPosition` (where a run is), `crossInteractive`, `enterAfk`, `freezeContractAt`.
- `src/harness/stdio-host.ts` + `src/harness/mcp-server.ts` — the out-of-process and interactive hosts: the same kernel over stdio MCP; the run-scoped server holds the single-writer lease (`mcp-owner.json`).
- `src/harness/turn-dispatcher.ts` — the interactive host's pending-turn engine (dispatch → settle → collect), non-throwing/total, lease-fenced.

**Tools, prompts & snippets**
- `docs/prompting-and-tool-design.md` — the 5 binding conventions + house patterns. **Consult for any agent prompt, tool description, tool result, or error message.**
- `src/harness/tools.ts` — the 8 host-neutral orchestrator tools + every protocol rail (the deepest module); `send_prompt` is host-switched (blocking headless / dispatch interactive).
- `src/harness/orchestrator-prompts.ts` — the system prompt + per-phase entry/resume briefs + the steer block.
- `snippets.toml` — the orchestrator's *default* snippet library (tabtype schema; guarded by `tests/snippets.test.ts`; porting edits back to tabtype is a manual human step). Users may layer per-key overrides over it — a user `~/.config/duet/snippets.toml` and a project `.duet/snippets.toml`, merged into the *effective* library `list_snippets` serves (pure `mergeSnippetLayers`, fail-closed on an unknown key, byte-identical when absent; `runtimeLibraryContext` is the one OS-home read; `duet snippets` shows each key's resolved layer). The two PLAN snippets cite duet's vendored methodology in `skills/internal/` (the TDD + architecture skills), resolved from a `{{skills_dir}}` token to `SKILLS_DIR` at serve time; `scripts/vendor-skills.mjs` (`pnpm vendor-skills`) is the manual re-vendor seam from `~/.claude/skills`.

**Workers, providers & transports**
- `docs/interactive-transport.md` — the opt-in interactive-Claude transport (flat-quota billing): direction, spike status, the `PaneController` seam, path to production.
- `src/providers/` — the worker seam: claude + codex adapters + factory; the claude provider's two transports (headless `claude -p`, interactive TUI via `interactive-claude.ts` + `pane.ts`).
- `src/roles.ts` — the role-policy table: the consultant's asymmetries as data (ephemeral / read-only / discard-and-reseed); a pure runtime leaf. `workerRolesFor` vs `voicesFor` is the worker-vs-voice split.

**CLI surface & supervision**
- `src/cli.ts` — command wiring only (parses under `import.meta.main`, so the table is importable); the hidden `_drive` / `_mcp` harnesses.
- `src/orchestrate.ts` — the `duet orchestrate` launcher: the `claude` argv (run-scoped `_mcp`, the identity system prompt, the gate-safety `ask` rule, a seeded kickoff).
- `src/framing.ts` — framing seed/editor flow + the frontmatter↔prose boundary rule.
- `src/run-store.ts` — `.duet/runs/<id>/` persistence (atomic): the state hint, the input-staging handshake, the steer store, interactive markers + lease, the `gateAttended`/`budgetFor` resolvers.
- `src/status.ts` — the status model + two renderers (text, `--json` verbatim, additive-only) + `--brief`.
- `src/sessions.ts` — locating provider transcripts by id (the one module reaching outside `.duet/`, what `--purge` deletes).
- `src/worker-health.ts` / `src/doctor.ts` — the pure health substrate (taxonomy, `probeRole`, `retryDecision`) and `duet doctor`'s composer + connectivity probe.
- view glue: `src/colorize.ts`, `src/timefmt.ts`, `src/tmux-view.ts`, `src/notify.ts` — best-effort, never allowed to affect a run.

**Shipped skills** (prompts, not code; all pinned to the CLI by `tests/skill.test.ts`)
- `skills/duet-concierge/` — a Claude Code session as duet's remote layer. `skills/duet-frame/` — the framing-author skill (sharpen a problem into a framing, then emit `duet new --interactive`). `prompts/orchestrator-identity.md` — the interactive orchestrator's identity, fed as the launcher's system prompt.

**Rationale, direction & process**
- `docs/open-questions.md` — why each decision is what it is (strike-through = resolved; Q numbers stable, never renumber). Open: Q13 (triage precision), Q16 (worker schema), Q19 (run-level budget), Q20 (pre-auth precision).
- `docs/future-directions.md` — the product-direction ledger (active direction, shelved + revisit triggers, declined candidates). Check before proposing a new direction.
- `docs/workflow-model.md` / `docs/observed-pattern.md` — the abstracted protocol / the evidence sessions it's drawn from.
- `docs/documentation-standards.md` — how docs are kept; the `/onboarding` ↔ `/update-docs` skill cadence.
- `README.md` — orientation + the verified-vs-not status line.

**Run state** — `.duet/runs/<id>/`: `state.json` is a hint, the 3 provider JSONL transcripts are truth; `steers/` holds staged mid-phase notes (`delivered/` = consumed); `notes.md` = the dogfooding journal (Q13/Q19/Q20 evidence).

## Invariants that bite if forgotten

Cross-cutting rules; full reasoning in `docs/engineering.md` and `docs/open-questions.md`.

- **Cooperative pause.** `ask_human`/`advance_phase` persist a marker and end the turn; mechanical SDK pauses corrupt resume (repros in `src/spike/`).
- **Gate-crossing is un-forgeable by vocabulary.** A phase emits `phase.*`; only `human.*` crosses a gate; no tool emits `human.*` (in-process, over MCP, or from a Bash-equipped interactive session), so `advance_phase` only ever parks.
- **The terminal marker** is the cross-process phase decision — cleared deliver-before-clear, guarded by the spent-marker check (keyed off the *restored snapshot*), so a crash can't replay a stale decision over a human's answer/reject.
- **Compaction:** claude workers compact via a literal `/compact` prompt; codex auto-compacts and must never be sent a command.
- **One branch per run,** fixed before the first worker prompt.
- **Worker budget is per-turn, opt-in, off by default** (off ≡ absent, never `0`); it must never shape scope (Q19); a hit cap is a resumable checkpoint, not an infra crash.
- **`gates_at` is the complete attend set, not a delta** (so `--gates-at pr` attends only the Open-PR gate). The full arc's Open-PR gate auto-opens by default; an attended gate still takes a human tap, as does the interactive orchestrator's one `ask` rule on `duet continue`.
- **A `high` `human_decisions` entry** holds a non-explicit crossing (`gates_at` auto-cross, `duet afk`) but never an explicit `--approve`.
- **Steers live in `steers/`, never `state.json`** (a CLI write there would race the live driver's saves); deliver-then-consume, so a crash redelivers a steer rather than loses one.
- **Runtime artifacts under self-ignored `.duet/`, never the repo root; log files stay plain text** — color and local time are view-time only (`--json` and stored logs stay raw UTC).
- **The health substrate stays pure** — `worker-health.ts` imports no fs/lifecycle/status, or a `status → worker-health → lifecycle → status` value cycle closes (the fs tail-read lives in `sessions.ts`, the lifecycle-needing composition in `doctor.ts`). Infra classifies on every surface but auto-retries only on the headless driver (a human is present on the interactive host).
- **The interactive host's `send_prompt` is fire-and-collect,** fenced by the single-writer lease at the tool gate and the background settle; its turn lifecycle is non-throwing/total (a faulting turn flips to a collectible `failed`, never strands a role `running`); a turn orphaned by a session quit is a durable on-disk record that blocks phase-exit until `duet takeover` clears it.
- **The consultant is default-off byte-for-byte** — absent its binding, config / tool schema / snippet library / phase briefs read exactly as before. Its asymmetries live as data in `src/roles.ts` (never scattered `role === 'reviewer'` checks); worker surfaces enumerate `workerRolesFor`, voice surfaces `voicesFor` (and must keep the orchestrator).
- **The acceptance contract is consultant-authored but never consultant-committed** — duet commits it path-scoped at the plan-gate crossing (`freezeContractAt`); the author→verify chain is enforced mechanically (this-run markers + `advance_phase` rails, not prompts), and it is arc-scoped (rir authors none and stays byte-for-byte unchanged).

## Conventions

- **Docs lead, code follows.** A code/docs disagreement is a doc bug or a design regression; resolve it explicitly, never silently. How docs are kept: `docs/documentation-standards.md`.
- **Evidence-backed claims.** Workflow claims cite `examples/*.jsonl` turns or run logs; tag **(observed)** vs **(general)**.
- **Tests are behavior-through-interface.** Fake only at the six seams (`docs/engineering.md` §Seams); never mock our own modules.
- **Personal tool / augmentation** — the product goals above are conventions too.
