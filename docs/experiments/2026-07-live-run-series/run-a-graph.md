---
workflow: blueprint
bind.architect: claude:claude-opus-4-8@high
bind.analyst: codex:gpt-5.5@high
bind.builder: claude:claude-opus-4-8@high
bind.critic: codex:gpt-5.5@high
bind.consultant: claude:claude-opus-4-8@high
---

# Problem

greenflag has no visual way to see a workflow's shape or a run's live position. `greenflag status` is line-oriented text, and the compiled workflow — stages, phases, gates and their postures, duty bindings, round caps, every materialized default — is legible only by reading JSON or source. Build a visualization surface: one on-demand CLI command (working name `greenflag graph`; a better name is a design-time call) rendering three views over one pure view model.

1. **Workflow blueprint** — `greenflag graph --workflow <name>`: the compiled workflow before any run exists. Stages and phases in order; each gate with its default posture (attended / auto-cross); each stage's duty pair with its resolved default binding (provider, model, effort); round caps; continuity edges; consultant checkpoints when a consultant would be bound. Project-composed workflows render through the same resolution `greenflag workflows` uses. The point of this view: every default made visible at a glance.

2. **Run view** — `greenflag graph [runId]`: the run's frozen workflow and manifest with live position overlaid. Completed phases marked done; the current phase highlighted in color; future phases dimmed. Gates show what actually happened or will: attended crossing, auto-cross under standing authority, a hold. Loop rounds render as used/cap. A parked question or pending gate is called out with its next command. On-demand snapshot — re-run to refresh.

3. **Execution trace** — `greenflag graph [runId] --trace`: what actually happened, from the run's logs. Per phase: the turn sequence with duty, snippet tag, and duration; compactions; retries; steers. Divergences from the expected shape are flagged — out-of-order snippet flows, rounds past the cap, unexpected phase re-entries. This is the drift detector: a planning-stage ordering bug (one snippet's results arriving gated behind another's) was once found only by hand-reading transcripts; the trace should surface that class mechanically.

Be ambitious: all three views are v1 intent, and this workflow is capable of carrying them. If the design concludes one must be cut, make that case explicitly at the design gate with rationale — never a silent descope.

# Onboarding

Read first: `CLAUDE.md`, then `docs/engineering.md` (the module map, "View-time color", "Patterns that carry the design"). Then the seams this feature composes:

- `src/registry/workflows.ts` + `src/run/workflow.ts` — the compiled-workflow resolvers; a run's frozen `workflow.json` is the run view's expectation source, never the live registry.
- `src/run/position.ts` — `probeRunPosition`, the one position truth.
- `src/run/store.ts` — the RunState ledgers (rounds, humanDecisions, contextEvents, autoRetries, pendingQuestion).
- `src/surfaces/status.ts` — the existing pattern: pure view model → renderers, `--json` additive and pinned by test. This feature should be its structural sibling.
- `src/surfaces/stats.ts` — the exported log-parsing cores. The trace view composes these and must not grow its own log regexes (`docs/corpus-runbook.md` records why: the predecessor telemetry toolkit died of exactly that).
- `src/view/colorize.ts` — the palette and glyph conventions (one hue per lane; color at view time only).

# Constraints

- Render-on-demand only: no server, no watcher, no auto-refresh. A local dashboard is an explicitly declined direction (`docs/future-directions.md`); "tmux is a viewer, never the runtime" is the precedent.
- Terminal ANSI is the primary render. A static-diagram emit (e.g. Mermaid) for docs and PRs is welcome; `--json` exposes the view model with an additive-only schema. Any file output stays plain text — color is view-time only.
- For terminal styling or layout beyond what `src/view/colorize.ts` already provides, prefer an established package over hand-rolling a color/layout module. Strong preference, argued exceptions allowed.
- greenflag workflows are linear pipelines with loops and gates — not general DAGs. Resist generic graph-layout machinery; the diagram is a pipeline with annotations.
- The command is read-only everywhere: it never mutates run state, and reading a live run's dir must be safe while a driver holds it.

# Scope boundary

In: the three views over one pure view model, CLI wiring, tests, and doc updates per `docs/documentation-standards.md`. Out: interactivity or editing, remote serving, cross-run/corpus-wide views (author-side analytics stay in `scripts/corpus/`), any change to how runs execute.

# Verification

- `pnpm typecheck && pnpm test`
- Drive it for real: `greenflag graph --workflow blueprint` and `--workflow relay`; `greenflag graph <this run's own id>` from inside this worktree mid-run (the run dir is under `.greenflag/runs/`); `--trace` against this run's own record once phases have completed. Paste a render into the PR description.
