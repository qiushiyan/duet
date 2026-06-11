# duet

Research notes toward a semi-AFK orchestrator for the **two-agent cross-review workflow**: one agent implements, the other reviews, and a human acts as router and editor-in-chief.

The design (as of the 2026-06-11 pivot) has **three roles**: a read-only, intelligent LLM **orchestrator** that drives the snippet protocol — choosing prompts, routing each worker's output to the other, judging loop exits, and flagging anything that needs the human — plus the **implementer** and **reviewer** agents it commands. The orchestrator runs inside a deterministic phase-and-gate skeleton enforced in code: three phases (attended PLANNING → AFK IMPLEMENTATION → attended FINAL REVIEW) whose human gates cannot be crossed by any agent. Roles are decoupled from model providers — each role binds to the `claude` or `codex` provider via a minimal config file (default: orchestrator and implementer on claude/Opus, reviewer on codex).

The repository holds both halves: the research docs that captured the manual pattern precisely enough to build against (with evidence sitting next to the analysis, so conclusions stay re-derivable), and — since 2026-06-11 — the implementation itself at the repo root (`src/`, pnpm + TypeScript, no build step).

## What duet is — and isn't

A personal augmentation tool for one developer's workflow, used across that developer's own projects. Not a general-purpose orchestration framework, not a product for thousands of users. The CLI itself is project-agnostic — it doesn't ship with skills, doesn't bundle conventions, doesn't introspect codebases. The user supplies project-specific knowledge (which skills to invoke, where artifacts go, what context to seed) in the framing turn for each run. The design assumes things — that the user knows their projects, that `claude` and `codex` are configured, that they bring the right context. The opposite of robust; the right amount of assuming.

Three principles shape every other choice:

- **Augment, don't replace.** Duet drives the same `claude` and `codex` CLIs you already use, with the same snippets, against the same codebase. Every artifact it produces — JSONL transcripts, branches, commits — is also producible by the manual workflow. There is no "duet mode" you get locked into.
- **Stop anytime.** A run can be paused indefinitely. The state file is a fast-access hint; the JSONL transcripts are the real source of truth. You can stop calling `duet continue`, switch to manual `claude --resume <id>` / `codex exec resume <id>`, add turns by hand, and either pick duet back up later or never — all without coordination.
- **Not a desktop app, not a daemon.** A small one-shot CLI you invoke per gate. No GUI, no background process. Use it today, not tomorrow, pick it up the day after.

If duet ever starts to feel like it's *requiring* you to use it, the design has failed. It should feel like a clipboard shortcut, not a wrapper around your tools.

## What's here

- `src/` — the implementation. `cli.ts` (the `duet` command: `new`, `continue`, `status`, `runs`); `harness/` (the XState statechart whose gates only human events can cross, and the orchestrator phase driver hosting the six harness tools); `providers/` (the minimal worker interface with `claude` and `codex` implementations); `run-state.ts`, `config.ts`, `snippets.ts`; `spike/` (the Q11 substrate spike and the SDK-behavior repros it produced — kept as executable evidence).
- `snippets.toml` — duet's snippet library, mirroring tabtype's schema (seeded from the user's live config plus `ceo-summary`). The orchestrator reads it via `list_snippets`; approved `propose_snippet_edit` diffs apply here; porting back to tabtype is a manual human step.
- `docs/observed-pattern.md` — turn-by-turn breakdown of one real session, with timestamps and the snippet used at each turn.
- `docs/workflow-model.md` — the abstracted state machine. Phases, snippet vocabulary, loop semantics, what's stable vs. what's variable.
- `docs/automation-design.md` — the design: three layers, tool surface, triage rules, phases and gates, loop semantics, role–provider config, worker compaction, and the as-implemented CLI lifecycle.
- `docs/open-questions.md` — the design decisions and their evidence. Resolved questions stay in place with strike-through headings (the reasoning is the point); open ones (Q13 triage precision, Q16 worker schema, Q17 codex-as-orchestrator) list what would settle them.
- `docs/prompting-and-tool-design.md` — the prompt-design and tool-design reference (distilled from Anthropic's published guidance), with duet's five binding conventions and house patterns. Consult when designing any agent prompt or tool.
- `examples/` — verbatim copies of the source session files (Claude Code + Codex), the snippet config, and the two project skills (`/onboarding`, `/update-docs`) the workflow invokes — plus an orchestrator-aware variant of `/update-docs` proposed in `docs/open-questions.md` Q2. All kept here so the docs are self-contained even if the originals get rotated or deleted.
- `schemas/agent-response.json` — the JSON Schema from the pre-pivot design, empirically verified against both CLIs on 2026-05-26. **Demoted by the 2026-06-11 pivot** — no longer the protocol contract; whether a minimal envelope survives is `docs/open-questions.md` Q16.
- `references/` — shallow clones of external repos studied for the MVP design (sandcastle, claude-squad, the Claude Agent SDK, the Codex SDK, pi). Read-only study material, not dependencies. `references/README.md` records what each is for and — since licenses range from MIT to AGPL to proprietary — what may be copied versus only read.

## Status

**Working today — the full arc.** In a project repo, `duet new --framing <briefing>` (or `--spec <draft>` to skip the framing front half) starts an orchestrator-driven run; `duet continue [--approve | --reject "…" | --answer "…"]` crosses gates and answers queued flags — FRAME → Direction gate → SPEC → Commit-spec gate → PLAN → Plan-approval gate (the walk-away point) → AFK IMPLEMENTATION (one branch, slices, midpoint checkpoint and compaction at orchestrator judgment, handoff, review rounds, CEO summary) → Ship gate → docs proposal → Docs-plan gate → PR description → Open-PR gate → push + `gh pr create`, ending with the PR URL; `duet status` / `duet runs` inspect. Every quiescent stop pings a macOS notification. Run state lives under `.duet/runs/<id>/` (state hint, machine snapshot, one log per voice, notes file). The SPEC/PLAN half is live-verified (`docs/open-questions.md` Q14, ~$4 claude-side per planning run at Opus); the frame, implementation, and final-review phases are smoke-tested and await their first real runs.

**Not built yet:** `--tmux` viewing and codex-as-orchestrator (Q17).

**Underneath:** pattern analysis from one fully-annotated session corroborated by a 22-session corpus scan (`docs/observed-pattern.md`); the three-role design with its rationale and history (`docs/automation-design.md`); resolved and open design questions (`docs/open-questions.md` — Q1–Q12, Q14–Q15, Q18 resolved; Q13 triage precision, Q16 worker schema, and Q17 are open, the first two awaiting dogfooding evidence). Stack: Node 24 running TypeScript directly (no build step), XState v5, execa, zod, commander, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` pinned to the local CLI version. Checks: `pnpm typecheck` and `node src/harness/machine.smoke.ts`.

## Reading order

1. `docs/observed-pattern.md` — what actually happened.
2. `docs/workflow-model.md` — what the pattern *is*.
3. `docs/automation-design.md` — what to do about it.
4. `docs/open-questions.md` — what we still don't know.

## Convention

When a doc claim is supported by the evidence files, it cites a line/turn (e.g. "turn 4 in `examples/claude-code-session.jsonl`"). When a claim comes from the user's general description of their workflow rather than from this specific session, it is labeled **(general)** vs. **(observed)**. The split matters: the orchestrator must serve both.
