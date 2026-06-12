# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What

`duet` — personal semi-AFK orchestrator for one developer's two-agent workflow: a read-only LLM **orchestrator** routes a snippet protocol between an **implementer** and a **reviewer**, inside a code-enforced skeleton whose human gates agents cannot cross. Repo = design docs (authoritative for *what* to build) + implementation at root (pnpm + TS, no build step).

Status: full arc implemented (`new` → FRAME → SPEC → PLAN → AFK IMPL → Ship gate → DOCS → PR → opened PR). FRAME→Ship live-verified (Q14 scratch run + first real planlab run, ~$93 claude-side); docs/pr/open phases uncrossed. Q17 (codex-as-orchestrator) deliberately unbuilt.

## Commands

- `pnpm typecheck` — checker-only tsc. No build: Node 24 runs `.ts` directly. Erasable syntax only (no enum/namespace/param-properties); explicit `.ts` import extensions.
- `node src/harness/machine.smoke.ts` — offline statechart assertions.
- `node src/cli.ts` — the CLI: `new [--spec][--framing][--gates-at <phases|overnight>][--tmux]` (bare = $EDITOR on template `.duet/framing-draft.md`, archived into the run dir) / `continue [--approve|--reject "…"|--answer "…"]` / `status` / `runs` / `view` / `logs` / `takeover <role>`. Phases run in a detached `_drive` child (stdout → `.duet/runs/<id>/driver.log`, pid guard against concurrent drivers); commands return immediately; with pre-authorized gates the driver lives through the whole stretch to the next attended stop.

## Architecture (3 layers)

1. **Harness** — `src/harness/machine.ts`: XState statechart frame→spec→plan→impl→docs→pr→open, each = loop + flag-wait + gate. Gates/flag-waits are actor-less `quiescent`-tagged states; only `human.*` events cross; snapshots persist only at quiescence. Gate-skipping structurally unrepresentable.
2. **Orchestrator** — `src/harness/driver.ts`: Agent SDK session, one phase per invocation, 7 SDK-MCP tools (`list_snippets`, `send_prompt`, `ask_human`, `advance_phase`, `create_branch`, `propose_snippet_edit`, `write_note`). Entry prompts in `src/harness/orchestrator-prompts.ts`.
3. **Workers** — `src/providers/`: claude (`claude -p --resume`, implementer runs `bypassPermissions`) + codex (SDK pinned to local CLI version). Roles decoupled from providers via `~/.config/duet/config.toml`; defaults orchestrator=claude-opus-4-8, implementer=claude-fable-5, reviewer=codex.

Run state `.duet/runs/<id>/`: `state.json` is a hint — the 3 provider JSONL transcripts are truth. `notes.md` = dogfooding journal (Q13 evidence).

Load-bearing mechanics (evidence: `docs/open-questions.md`):
- `ask_human` pause is **cooperative** (handler persists question, orchestrator ends turn, process exits) — SDK mechanical pauses corrupt resume; executable repros in `src/spike/` (Q11).
- Worker compaction per provider (Q18): claude = literal `/compact <instructions>` prompt via send_prompt; codex = built-in auto-compaction, never send it a command.
- Template economy: full snippet once per phase per worker, deltas/-again after; warn-once-then-allow rail in send_prompt.
- One branch per run, fixed before first worker prompt; `create_branch` = the only orchestrator repo side effect (refs, never artifacts).
- Gate pre-authorization (Q20): `--gates-at` / framing frontmatter (`src/framing-frontmatter.ts` — parsed deterministically by the CLI, stripped before the orchestrator sees the framing; `pr` always attended); auto-cross loop in `driveToQuiescence`, posture rendered into entry prompts + advance_phase result. Frontmatter boundary rule: fixed value + harness consumer, else prose.
- Worker budget caps are per-turn (fresh ceiling each send_prompt) and the prompts say so (Q19) — the rail must never shape scope.
- Logs are plain text; color is view-time only (`duet _colorize`, picocolors). Runtime artifacts live under self-ignored `.duet/`, never the repo root.

## Docs (read before redesigning anything)

- `README.md` — orientation + verified-vs-not status.
- `docs/automation-design.md` — THE design: layers, tool surface, triage rules, gates, branch policy, lifecycle, what-not-to-build.
- `docs/open-questions.md` — why each decision is what it is; strike-through = resolved, history intentional. Open: Q13 (triage precision), Q16 (worker schema), Q19 (run-level budget model), Q20 (pre-auth precision) — all await more runs.
- `docs/prompting-and-tool-design.md` — **consult whenever touching any agent prompt, tool description, tool result, or error message**; carries the 5 binding conventions + house patterns.
- `docs/workflow-model.md` / `docs/observed-pattern.md` — the abstracted protocol / the evidence sessions.
- `snippets.toml` — the orchestrator's snippet library (tabtype schema; porting edits back to tabtype is manual, Q12).
- `references/` — external repo clones; **check `references/README.md` license boundaries before copying anything** (claude-squad AGPL = read-only; Agent SDK proprietary = dependency only).

## Conventions

- **Docs lead, code follows.** Code/docs disagreement = doc bug or design regression; resolve explicitly, never silently.
- **Evidence-backed claims.** Workflow claims cite `examples/*.jsonl` turns or snippets; tag **(observed)** vs **(general)**.
- **Personal tool, not OSS.** Project knowledge enters only via the framing turn. No fallbacks, no project detection, no config beyond role bindings.
- **Augmentation, never lock-in.** Every artifact usable without duet (standard transcript locations, normal branches/commits); manual takeover and resume must always work; state file never an obstacle.
