---
name: update-docs
description: Use when finishing a feature or fix, before opening a PR, or when the user says "update docs" / "sync docs". Keeps duet's docs aligned with the code — architecture, intent, conventions — never duplicating code. Reads docs/documentation-standards.md first.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git status:*), Bash(git merge-base:*), Read, Write, Edit, Glob, Grep, Agent
---

# Update documentation from the working diff

You're the documentation maintainer for duet. Before any assessment or writing, read `docs/documentation-standards.md` — it defines the doc shape, significance tiers, writing standards, consolidation principles, and the onboarding-skill maintenance rules that govern all doc work here.

## Workflow

```
Gather diff
  → Read standards + existing docs
  → Assess significance
  → Propose plan ──→ [user confirms] ──→ Update docs ──→ Verify
       │                    │
       ↓                    ↓
  "No changes needed"   User adjusts scope
   (exit early)
```

Three exit points: (1) the changes are purely implementation-level and need no doc update, (2) the user rejects or defers the proposal, (3) updates are written and verified.

## Step 1 — Gather the diff

duet's default branch is `main`, and feature work often lands as uncommitted edits in the working tree (changes are folded in rather than always committed first). So diff the working tree against the merge-base — `git diff $BASE` (no `..HEAD`) deliberately includes staged and unstaged work:

```bash
BASE=$(git merge-base HEAD main)

git diff --stat $BASE
git diff $BASE -- '*.ts' '*.md' '*.toml' ':!*lock*' ':!node_modules'
git log --oneline $BASE..HEAD   # committed intent, if any
git status --short              # what's still uncommitted
```

If `BASE` equals `HEAD` (you're on `main`), `git diff $BASE` is just the working-tree diff — exactly what you want. Identify:

- **New modules, tools, snippets, phases, gates, providers** — may need a doc section or a Map / phase-table mention.
- **Changed interfaces or control flow** — the orchestrator tool surface, the worker provider contract, the statechart arc, the steer / staging paths.
- **Removed or renamed concepts** — need doc cleanup or deletion.
- **Policy or behavioral changes** — triage rules, gate policy, branch policy, budgets / caps.
- **New user-facing capability** — a `duet new` flag, a setup / gate-posture choice, a run-management verb — may need a shipped skill (`skills/duet-frame` composes run setup; `skills/duet-concierge` starts / supervises runs) to surface it, not just a design-doc mention. A flag can land without touching any `.md`, and `tests/skill.test.ts` checks coherence (named things exist), not completeness (whether a skill *should* name a new capability) — so this one is caught by asking, not by a test.

Asked to update docs more than once in a session? Don't re-diff the whole range — start from the first commit (or change) after the previous update-docs pass.

## Step 2 — Read existing docs

Read `docs/documentation-standards.md` first, then read every doc that overlaps the changed areas end-to-end — usually a subset of `automation-design.md`, `engineering.md`, `prompting-and-tool-design.md`, `workflow-model.md`, and `CLAUDE.md`. Understand the current narrative before modifying it.

Also scan for **stale content** the change may have outdated: a verified-vs-not status line in the README that should flip, an `open-questions.md` entry a run just resolved, a `docs/specs/` or `docs/plans/` proposal that shipped and should distill into a design doc.

## Step 3 — Assess significance

Use the significance tiers from `documentation-standards.md`. If the changes are implementation-level, stop here and tell the user: *"These changes are implementation-level — no documentation updates needed."*

## Step 4 — Propose plan

**Do not start writing yet.** Present a concrete proposal:

```
## Proposed documentation updates

### Scope
[One sentence: what the work does at a high level]

### Changes
- `docs/engineering.md` — add the new seam to the Seams table *only if a reader must grasp it to navigate*; fold the `src/harness/tools.ts` change into its existing Module-map entry, not a new row
- `docs/automation-design.md` — document the new gate in §Phases and gates
- `README.md` — no change (status line still accurate)

### Distillation
- `docs/specs/<dated>.md` — shipped; fold the surviving decisions into `automation-design.md`, then prune

### Deletions
[Only when a doc / section is fully superseded. Be deliberate.]

### Onboarding skill (.claude/skills/onboarding/SKILL.md)
- No change — Phase 1 reads still resolve and the topic table still routes.
[Or: "Route a new top-level doc in the topic table," or "repoint a moved focus anchor."]

### Shipped skills (skills/duet-frame, skills/duet-concierge)
- No change — the change added no user-facing flag/verb/setup-choice these surface.
[Or: "duet-frame: surface the new `--consultant` setup choice in the launch command."]

### CLAUDE.md
- No change — no new cross-cutting invariant.
[Or: "Add invariant: <one line>."]

### No action
- `docs/prompting-and-tool-design.md` — not affected
```

Wait for confirmation. The user may adjust scope, skip docs, or add areas you missed.

## Step 5 — Update docs

Write to the standards in `documentation-standards.md` rather than restating them here. The four that bind at write-time:

- **Every edit nets tighter.** Adding content is the moment to cut redundancy — a doc that gains 10 lines should shed 5–10 (§"Consolidation principles").
- **Spotlight the load-bearing; don't inventory** (§"Spotlight the load-bearing"). The reader reads the code, so don't enumerate every interface, add a row per new thing, or hardcode a count ("seven seams"); draw a flow as a tree or arrow chain instead of threading it through a long sentence.
- **Deletion is maintenance.** Remove what the change made irrelevant; describe the latest state in present tense, never a changelog entry.
- **Distill, then thread.** When a `docs/specs/` or `docs/plans/` proposal ships, fold its surviving decisions into the design doc and prune it. When the system's shape changes, thread it into the `engineering.md` module map (grow an existing entry; add a row only when load-bearing) and the README status line. Touch the `CLAUDE.md` Map only for a new top-level doc or a new cross-cutting invariant (standards §"Authoring CLAUDE.md").

## Step 6 — Verify

1. Re-read each modified doc end-to-end for a coherent narrative.
2. Check cross-references between docs still resolve.
3. Confirm no absolute paths leaked in — repo-root-relative only.
4. Confirm no source code was pasted (prose / pseudo-code call chains are fine).
5. Confirm evidence claims stay tagged **(observed)** vs **(general)** and nothing unverified slipped into the present tense.
6. Grep across `docs/`, `CLAUDE.md`, and `README.md` for the basenames of any file you moved, renamed, or deleted — every hit should resolve.
7. Spotlight check: no new live count ("N seams"), and any new table row or list item is load-bearing — a secondary change folded into an existing entry instead of growing the table.
8. Check: *"If a teammate reads this cold, do the docs give them the mental model without reading every file?"*

## Step 7 — Assess the skills and the invariants

Beyond per-doc edits, run the maintenance checks from `documentation-standards.md` — each fires only on a real trigger, and most branches trip none:

- **Onboarding skill** (`.claude/skills/onboarding/SKILL.md`) — only if a new top-level doc isn't routed by the topic table, or a Phase 1 doc / deep-dive anchor moved (§"Onboarding skill maintenance").
- **Shipped skills** (`skills/duet-frame`, `skills/duet-concierge`) — only if the change added a user-facing capability (a flag, gate-posture choice, or run verb) one should surface. They're prompts: edit in their own voice per `prompting-and-tool-design.md`. `tests/skill.test.ts` guards coherence, not completeness, so this is your call (§"Shipped skill maintenance").
- **CLAUDE.md** — only when a new cross-cutting invariant emerged or one's framing rotted; the bar is high.

## Output

```
## Docs updated
- `docs/engineering.md` — added the new seam to the Seams table; tightened the Module map note

## Deleted
- (none this round)

## No changes needed
- `README.md` — status line still accurate
- onboarding skill — Phase 1 paths still resolve

## Why
[Brief explanation of what drove the updates]
```
