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

- `docs/observed-pattern.md` — turn-by-turn breakdown of one real session, with timestamps and the snippet used at each turn.
- `docs/workflow-model.md` — the abstracted state machine. Phases, snippet vocabulary, loop semantics, what's stable vs. what's variable.
- `docs/automation-design.md` — what to automate (router), what to keep human-gated (editor-in-chief), and a sketch of a minimal orchestrator architecture.
- `docs/open-questions.md` — things to verify before writing the orchestrator. Each question lists what we currently believe and what would change the answer.
- `docs/prompting-and-tool-design.md` — the prompt-design and tool-design reference (distilled from Anthropic's published guidance), with duet's five binding conventions and house patterns. Consult when designing any agent prompt or tool.
- `examples/` — verbatim copies of the source session files (Claude Code + Codex), the snippet config, and the two project skills (`/onboarding`, `/update-docs`) the workflow invokes — plus an orchestrator-aware variant of `/update-docs` proposed in `docs/open-questions.md` Q2. All kept here so the docs are self-contained even if the originals get rotated or deleted.
- `schemas/agent-response.json` — the JSON Schema from the pre-pivot design, empirically verified against both CLIs on 2026-05-26. **Demoted by the 2026-06-11 pivot** — no longer the protocol contract; whether a minimal envelope survives is `docs/open-questions.md` Q16.
- `references/` — shallow clones of external repos studied for the MVP design (sandcastle, claude-squad, the Claude Agent SDK, the Codex SDK, pi). Read-only study material, not dependencies. `references/README.md` records what each is for and — since licenses range from MIT to AGPL to proprietary — what may be copied versus only read.

## Status

- Pattern analysis: drafted from one full session (`examples/claude-code-session.jsonl` + `examples/codex-session.jsonl`), corroborated by a 22-session corpus scan of the user's planlab history (`docs/observed-pattern.md` §"Corpus scan: planlab", 2026-06-11).
- Design: **pivoted 2026-06-11** from a dumb state-machine router to the three-role architecture above. The pivot's rationale, costs, and what survived are in `docs/automation-design.md` §"Design history"; the phase/gate model and snippet vocabulary (including the proposed `ceo-summary` snippet) are in `docs/workflow-model.md`.
- Implementation: **started 2026-06-11** at the repo root — flat structure, `src/` for source, no separate `mvp/` directory. Stack: XState v5 (Q15 decided), execa, zod, commander, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`; Node 24 runs the TypeScript directly. The **Q11 substrate spike passed** the same day (`src/spike/q11.ts` — read-only SDK orchestrator, cross-provider routing through `src/providers/`, cooperative ask_human pause + resume; findings in `docs/open-questions.md` Q11), and **Slice 1 shipped and passed live** the same day too: the complete attended PLANNING phase (`duet new --spec` → SPEC loop → gate → PLAN loop → gate, all six orchestrator tools, XState harness, run state under `.duet/runs/`; Q14 records the verifying run). Next milestone: dogfooding on real features, then the AFK IMPLEMENTATION phase.

## Reading order

1. `docs/observed-pattern.md` — what actually happened.
2. `docs/workflow-model.md` — what the pattern *is*.
3. `docs/automation-design.md` — what to do about it.
4. `docs/open-questions.md` — what we still don't know.

## Convention

When a doc claim is supported by the evidence files, it cites a line/turn (e.g. "turn 4 in `examples/claude-code-session.jsonl`"). When a claim comes from the user's general description of their workflow rather than from this specific session, it is labeled **(general)** vs. **(observed)**. The split matters: the orchestrator must serve both.
