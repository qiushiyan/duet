---
name: update-docs
description: Use when finishing a feature branch, before creating a PR, or when the user says "update docs", "sync docs", or "document changes". Keeps docs focused on architecture, design intent, and module relationships — never duplicates code.
user-invocable: true
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git merge-base:*), Read, Write, Edit, Glob, Grep, Agent
---

# Update Documentation from Branch Diffs

You are a documentation maintainer for the iTELL Platform. Before doing any assessment or writing, read `docs/documentation-standards.md` — it defines the assessment criteria, writing standards, consolidation principles, and onboarding skill maintenance rules that govern all documentation work.

## Workflow

```
Gather diff
  → Read existing docs + standards
  → Assess significance
  → Propose plan ──→ [user confirms] ──→ Update docs ──→ Verify
       │                    │
       ↓                    ↓
  "No changes needed"   User modifies scope
   (exit early)
```

Three exit points: (1) the changes are purely implementation-level and need no doc update, (2) the user rejects or defers the proposal, (3) updates are written and verified.

## Step 1 — Gather the Diff

```bash
# Find the merge base with main
BASE=$(git merge-base HEAD main)

# Summary of changed files
git diff --stat $BASE..HEAD

# Full diff (source files only, skip lockfiles/generated)
git diff $BASE..HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.md' \
  ':!*lock*' ':!*generated*' ':!node_modules'

# Commit log for intent
git log --oneline $BASE..HEAD
```

Read the diff carefully. Identify:
- **New modules or files** — may need new doc sections or pages
- **Changed interfaces between modules** — need relationship updates
- **New or altered control flow** — need call chain diagrams
- **Removed or renamed concepts** — need doc cleanup or deletion
- **Configuration or behavioral changes** — need updated descriptions

## Step 2 — Read Existing Docs

Read `docs/documentation-standards.md` first, then read every doc that overlaps with the changed areas end-to-end. Understand the current narrative before modifying it.

Also scan for **stale docs** — files that the current changes may have rendered outdated or contradictory. Common examples: old plan files that describe a design that has since been superseded, docs that reference removed action clients or renamed route groups.

## Step 3 — Assess Significance

Use the significance tiers from `docs/documentation-standards.md` to determine the scope of impact. If the changes are implementation-level, stop here and tell the user: *"These changes are implementation-level — no documentation updates needed."*

## Step 4 — Propose Plan

**Do not start writing yet.** Present the user with a concrete proposal:

```
## Proposed Documentation Updates

### Scope
[One sentence: what the branch does at a high level]

### Changes
- `docs/organization.md` — Add new "Foo" section under Access Control; update invitation flow
- `docs/action.md` — Add new action client to middleware chain table
- `docs/README.md` — No changes (project structure still accurate)

### Deletions
- `docs/plans/old-foo-design.md` — Superseded by the implementation

### Onboarding Skill (`.claude/skills/onboarding/SKILL.md`)
- Add "new-cluster" row to the topic-to-cluster table
- Update Phase 1 path: `docs/foo.md` was renamed to `docs/bar.md`
[Or: "No changes needed — skill still routes correctly."]

### Invariants (`CLAUDE.md`)
- Add invariant #9: <one-line statement>
[Or: "No changes needed — existing invariants still cover this."]

### No Action
- `docs/chat.md` — Not affected by these changes
```

Wait for user confirmation before proceeding. The user may adjust scope, skip certain docs, or add areas you missed.

## Step 5 — Update Docs

Follow the writing standards and consolidation principles from `docs/documentation-standards.md`. The key rule: **adding content is an opportunity to simplify**. For every doc you touch, actively remove redundancies, consolidate sections, and simplify the flow.

Deletion is also maintainance. If a doc/part of the doc are made irrelevant by our chnages, consider removing it entirely, do not include changelog style of writing. Focus on describing the latest state.

When changes affect the top-level system shape — new route groups, new external integrations, new middleware layers — update the project structure and route group table in `docs/README.md`.

## Step 6 — Verify

After making changes:

1. Re-read each modified doc file end-to-end for coherent narrative flow
2. Check that cross-references between docs are still valid
3. Verify no absolute file paths leaked in — use relative paths from repo root
4. Confirm no source code was pasted (call chains in pseudo-code are fine)
5. Check: *"If I'm a senior engineer reading this for the first time, do the docs give me the mental model without reading every file?"*

## Step 7 — Assess Onboarding Skill and Invariants

Apply the maintenance rules from `docs/documentation-standards.md` to two surfaces that sit above per-doc edits:

1. **`.claude/skills/onboarding/SKILL.md`** — the user-invocable bootstrap for new sessions. Check whether the branch warrants updating: a new top-level cluster in `docs/README.md` that the topic-to-cluster table doesn't cover, a renamed/moved Phase 1 doc, or a drifted file path in the general-onboarding fallback agent prompts.

2. **`CLAUDE.md` invariants** — the always-loaded mental model. Only touch this when a new cross-cutting, load-bearing rule has emerged (bar is high; eight is already a lot) or an existing invariant's framing has rotted. Implementation-level changes never warrant edits here.

Most branches need neither update. If the routing logic still works and the invariants still hold, move on.

## Output

Summarize what you updated and why:

```
## Docs Updated

- `docs/organization.md` — Added volume access delegation section with flow diagram
- `docs/action.md` — Added new action client; removed stale middleware description

## Deleted

- `docs/plans/old-access-design.md` — Stale; superseded by organization.md

## No Changes Needed

- `docs/chat.md` — Not affected by these changes

## Why

[Brief explanation of what drove the updates]
```
