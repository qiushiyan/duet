# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What

`duet` — personal semi-AFK orchestrator for one developer's two-agent workflow: a read-only LLM **orchestrator** routes a snippet protocol between an **implementer** and a **reviewer**, inside a code-enforced statechart whose human gates agents cannot cross. Repo = design docs (authoritative for *what* to build) + implementation at root (pnpm + TS, no build step).

Product goals — the bar every change is measured against:

- **Augment, never lock in.** Same CLIs, same snippets, standard transcripts and normal branches; manual takeover and resume must always work; the state file is a hint, never an obstacle.
- **The human owns substance.** The orchestrator does triage, never opinions; product/direction/environment questions always reach the human; gates are structural (statechart), not prompt-enforced.
- **Semi-AFK.** Walk away at plan approval; return to a ship packet or a well-formed queued question. Nothing runs between quiescent stops — no daemon.
- **Personal tool, not OSS.** Project knowledge enters only via the framing turn; the only config is role→provider bindings; exactly two providers.

Status: full arc implemented (`new` → FRAME → SPEC → PLAN → AFK IMPL → Ship gate → DOCS → PR → opened PR). FRAME→Ship live-verified (Q14 scratch run + first real planlab run, ~$93 claude-side); docs/pr/open phases uncrossed; gate pre-authorization awaits its first overnight run (Q20). Q17 (codex-as-orchestrator) deliberately unbuilt.

## Commands

- `pnpm typecheck` — checker-only tsc. No build: Node 24 runs `.ts` directly. Erasable syntax only (no enum/namespace/param-properties); explicit `.ts` import extensions.
- `pnpm test` — the Vitest behavior suite (`tests/`, standalone; fixtures in `tests/helpers/`).
- `node src/cli.ts` — the CLI: `new [--spec][--framing][--gates-at <phases|overnight>][--tmux]` (bare = $EDITOR on template `.duet/framing-draft.md`) / `continue [--approve|--reject "…"|--answer "…"]` / `status` / `runs` / `view` / `logs` / `takeover <role>`. Commands return immediately; phases run in a detached `_drive` child (stdout → `.duet/runs/<id>/driver.log`, pid-guarded); with pre-authorized gates the driver lives through the whole stretch to the next attended stop.

## Map

- `src/phases.ts` — **the phase table**: arc order + every per-phase fact (gate names/copy, round caps, budgets, timeouts). The statechart and all consumers derive from it.
- `src/harness/` — `machine.ts` (statechart: gates cross only on `human.*` events), `tools.ts` (the 7 orchestrator tools + protocol rails), `driver.ts` (SDK session per phase, outcome mapping), `lifecycle.ts` (detached driver + `gates_at` auto-cross), `orchestrator-prompts.ts`.
- `src/providers/` — the worker seam: contract, claude + codex adapters, factory. `src/run-store.ts` — run-dir persistence (atomic) + the CLI↔driver input-staging handshake. `src/framing.ts` — template, editor flow, frontmatter boundary. `src/status.ts` — pure rendering. `src/cli.ts` — wiring only. View glue: `colorize.ts`, `tmux-view.ts`, `notify.ts`.
- Run state `.duet/runs/<id>/`: `state.json` is a hint — the 3 provider JSONL transcripts are truth. `notes.md` = dogfooding journal (Q13/Q19/Q20 evidence).

Invariants that bite if forgotten (full reasoning: `docs/engineering.md`, `docs/open-questions.md`): the `ask_human` pause is cooperative — mechanical SDK pauses corrupt resume (Q11, repros in `src/spike/`); claude workers compact via a literal `/compact` prompt, codex auto-compacts and must never be sent a command (Q18); one branch per run, fixed before the first worker prompt; worker budget is per-turn and must never shape scope (Q19); log files stay plain text — color is view-time only; runtime artifacts live under self-ignored `.duet/`, never the repo root.

## Docs (read before redesigning anything)

- `README.md` — orientation + verified-vs-not status.
- `docs/automation-design.md` — THE design: roles, layers, phases/gates, triage rules, branch policy, lifecycle, what-not-to-build.
- `docs/engineering.md` — the codebase's mental model: module map, seams, patterns, XState usage, testing strategy, condensed lessons. **Read before moving code.**
- `docs/open-questions.md` — why each decision is what it is; strike-through = resolved, history intentional. Open: Q13 (triage precision), Q16 (worker schema), Q19 (run-level budget), Q20 (pre-auth precision) — all await more runs.
- `docs/prompting-and-tool-design.md` — **consult whenever touching any agent prompt, tool description, tool result, or error message**; carries the 5 binding conventions + house patterns.
- `docs/workflow-model.md` / `docs/observed-pattern.md` — the abstracted protocol / the evidence sessions.
- `snippets.toml` — the orchestrator's snippet library (tabtype schema; guarded by `tests/snippets.test.ts`; porting edits back to tabtype is manual, Q12).
- `references/` — external repo clones; **check `references/README.md` license boundaries before copying anything** (claude-squad AGPL = read-only; Agent SDK proprietary = dependency only).

## Conventions

- **Docs lead, code follows.** Code/docs disagreement = doc bug or design regression; resolve explicitly, never silently.
- **Evidence-backed claims.** Workflow claims cite `examples/*.jsonl` turns or run logs; tag **(observed)** vs **(general)**.
- **Tests are behavior-through-interface.** Fake only at the four seams (`docs/engineering.md` §Seams); never mock our own modules.
- **Personal tool / augmentation** — see the product goals above; they are conventions too.
