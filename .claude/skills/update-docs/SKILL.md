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
- `docs/engineering.md` — add the new seam to the Seams table; update the Module map row for `src/harness/tools.ts`
- `docs/automation-design.md` — document the new gate in §Phases and gates
- `README.md` — no change (status line still accurate)

### Distillation
- `docs/specs/<dated>.md` — shipped; fold the surviving decisions into `automation-design.md`, then prune

### Deletions
[Only when a doc / section is fully superseded. Be deliberate.]

### Onboarding skill (.claude/skills/onboarding/SKILL.md)
- No change — Phase 1 paths still resolve and the topic table still routes.
[Or: "Add a `providers` deep-dive path: `interactive-claude.ts` was split."]

### CLAUDE.md
- No change — no new cross-cutting invariant.
[Or: "Add invariant: <one line>."]

### No action
- `docs/prompting-and-tool-design.md` — not affected
```

Wait for confirmation. The user may adjust scope, skip docs, or add areas you missed.

## Step 5 — Update docs

Follow the writing and consolidation standards from `documentation-standards.md`. The key rule: **adding content is an opportunity to simplify** — for every doc you touch, actively remove redundancy, consolidate sections, and tighten the flow.

**Deletion is also maintenance.** If a doc or a part of one is made irrelevant by the change, remove it entirely. No changelog-style entries — describe the latest state in present tense.

When a `docs/specs/` or `docs/plans/` proposal ships, fold its surviving decisions into the design doc it touches (present tense), then prune the proposal. When the change alters the system's shape — a new phase/gate, provider, seam, or policy — update the module map in `engineering.md`, the Map in `CLAUDE.md`, and the verified-vs-not line in the README.

## Step 6 — Verify

1. Re-read each modified doc end-to-end for a coherent narrative.
2. Check cross-references between docs still resolve.
3. Confirm no absolute paths leaked in — repo-root-relative only.
4. Confirm no source code was pasted (prose / pseudo-code call chains are fine).
5. Confirm evidence claims stay tagged **(observed)** vs **(general)** and nothing unverified slipped into the present tense.
6. Grep across `docs/`, `CLAUDE.md`, and `README.md` for the basenames of any file you moved, renamed, or deleted — every hit should resolve.
7. Check: *"If a teammate reads this cold, do the docs give them the mental model without reading every file?"*

## Step 7 — Assess the skill and the invariants

Apply the maintenance rules from `documentation-standards.md` to the two surfaces above per-doc edits:

1. **`.claude/skills/onboarding/SKILL.md`** — does the change warrant it? A new top-level doc the topic table doesn't route to, a renamed / split Phase 1 doc, or a drifted deep-dive path. Routine edits inside an existing doc don't touch the skill.
2. **`CLAUDE.md`** — only when a new cross-cutting, load-bearing invariant emerged or an existing one's framing rotted. The bar is high; most branches need neither update.

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
