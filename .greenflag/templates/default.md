---
workflow: full
# gates_at: skip-plan      # optional posture; omit to attend every gate
---

# Problem

<!-- Replace with this run's problem: what to build or change, why, and what is
     explicitly out of scope. Everything below is project-stable and rarely changes. -->

# Onboarding

Onboard by reading these documents **at their paths** — do not use slash commands (Codex has none, and headless Claude workers don't expand them). These are worth reading at the start of every run on this project:

- `CLAUDE.md` — the what/how summary, the module Map, and the invariants that bite if forgotten.
- `docs/automation-design.md` — the design: roles, phases/gates, the arcs, branch policy, what-not-to-build.
- `docs/engineering.md` — the codebase's mental model and the engineering guidance to follow when moving code.
- `docs/prompting-and-tool-design.md` — the binding conventions for any prompt, tool description, tool result, or error message.
- `docs.local/prompt-engineering/skill.md` — the broader prompt-engineering guidance, applied alongside the doc above whenever writing or revising a prompt/tool/result/error. (`docs.local/` is gitignored and local-only, so if this path is absent in a worktree, read it at `/Users/qiushi/dotfiles/claude/.claude/skills/prompt-engineering/skill.md`.)

Then read the specific docs and code for the problem at hand.

# Conventions

- Specs live at: `docs/specs/<date>-<slug>.md`
- Plans live at: `docs/plans/<date>-<slug>.md`
- Branch: a feature branch fitting the work.

# Verification

- Typecheck: `pnpm typecheck`. Tests: `pnpm test` (the Vitest behavior suite); add tests at the seams, never mock our own modules.
- Environment-only actions (deploys, credentials, migrations): flag me — never attempt.

# Docs

Docs lead, code follows — `docs/documentation-standards.md` governs how docs are kept. Surface the docs-update plan at the Docs-plan gate.
