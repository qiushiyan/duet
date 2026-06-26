# Collapse the PR phase and auto-open — is the Open-PR gate earning its keep?

> **Historical (pre-`finish`).** Dated record from before the 2026-06-26 collapse of the `docs`/`pr`/`open` tail into one `finish` phase (open-then-review, PR-auto-open-by-default, `overnight` as full's default posture). It explored merging the PR phases and auto-opening; the shipped change went further — full collapse with the Open-PR gate *after* the open. Its arc / tail / gate-posture descriptions are the topology of their time; the current arc lives in [`../automation-design.md`](../automation-design.md).

**Status:** Problem definition (real-observation-driven; not a full spec). **Date:** 2026-06-21. Sibling to `2026-06-21-afk-handoff.md` and `2026-06-21-worker-budget-policy.md` — the third instance of one pattern (below). Revisits the "Open-PR non-negotiable" product goal.

## The observation

Written watching run `20260620-1655-be66` (the first real workflow-aware/RIR build) reach its end. After the docs phase, the **Full** arc does: `pr` phase (write the PR description) → **Open-PR gate** (force-attended — the one gate even pre-authorization can't skip) → `open` phase (`gh pr create`). The run parked at Open-PR, presented the verbatim title + description, waited for a human tap, and on approval pushed the branch and opened [PR #10](https://github.com/qiushiyan/duet/pull/10).

By that point the run had 7 implementation slices committed and green, 3 review rounds (a clean cross-review plus round-2 verification), all narrative docs updated, 494 tests passing — and it had already weathered three infra events cleanly (a 529 retry, a per-turn budget cutoff recovered via per-slice commits, a Codex stdin hang). Confidence at the gate was high, and the gate's only job was *"tap to open a non-destructive, fully-editable artifact."*

## The problem

Two pieces of avoidable ceremony:

1. **The PR description and the PR creation are two phases with a gate between them.** The description is just the *body* for `gh pr create` — no reason it is a separate phase (`pr`) from the creation (`open`), nor that a gate sits between them.

2. **Opening a PR is gated as if it were destructive.** `forceAttend: ['pr']` makes Open-PR the single non-pre-authorizable stop, encoding the old "Open-PR is non-negotiable" goal. But opening a PR is **not destructive and is fully reversible**: it merges nothing, deploys nothing, touches no production; you can edit the title/body, push more commits, request/withdraw reviewers, or close it. The gate conflates *outward-facing* with *irreversible* — only the latter earns a mandatory stop. And the human's review naturally belongs *after* opening — on GitHub, with the diff, CI status, and description together — a better surface than a terminal packet read before the PR exists.

## The change (sketch — to settle later)

- **Merge `pr` + Open-PR gate + `open` into a single `create-pr` step.** One step writes the description (still following the PR-description guidelines — `pr-description`'s content folds into the step's prompt) and runs `gh pr create`. The Full tail becomes `… docs → Docs-plan → create-pr → done`. Trims a phase, a gate, and a standalone snippet.
- **Auto-open by default.** Drop `pr` from `forceAttend`; opening needs no tap. The ship "return" relocates to the opened PR itself (review on GitHub; iterate by pushing to the branch).
- **Keep an opt-in stop for the cases that want it** (open question below) rather than deleting the ability outright — cheap to retain (one gate field), and it serves a user who wants to read before the PR goes public.

## Open questions (deliberately unresolved)

- **Opt-in stop, or none at all?** A PR has real outward side effects (CI runs, reviewer notifications, team visibility) — negligible on the maintainer's own repo, possibly not for the audience. So: default auto-open with an *optional* pre-open stop (a gate that defaults to auto-cross but can be made attended), or genuinely no gate? *Lean: keep it as an optional, default-off stop — the same posture the AFK-handoff doc gives `forceAttend`.*
- **What does "return" mean for a fully-AFK Full run** once Open-PR no longer stops? The run reaches `done` at an opened PR with no terminal human stop — the human returns to a GitHub PR, not a gate packet. Arguably the better artifact, but a deliberate change to "return to a ship packet."

## Interaction with the sibling docs

- **AFK-handoff (`2026-06-21-afk-handoff.md`)** keeps `forceAttend: ['pr']` as the reason a fully-AFK *Full* run still stops at Open-PR. This change *removes* that stop — so the two are complementary: together they let a Full run go from the handoff gate straight to an opened PR unattended, the same full-AFK completion the RIR arc already has (RIR has no PR tail at all).
- **The pattern across all three docs.** AFK-handoff (the mandatory per-gate tap), worker-budget (the mandatory per-turn cost cap), and this (the mandatory Open-PR stop) are the same shape: **a hardcoded mandatory rail the maintainer experience wants relaxed, while the audience may want it available.** The principle that falls out: *duet's rails should be opt-in controls with friction-free defaults, not mandatory stops.* `forceAttend`, the budget caps, and the per-gate tap are all candidates to become defaults-not-mandates — worth naming as a cross-cutting direction, not three unrelated point fixes.

## Non-goals

- Removing the *ability* to review before opening (keep it opt-in).
- Touching the RIR arc (it has no PR tail).
- Changing what goes *into* the PR description (the guidelines stay; only the step/gate structure changes).

## Evidence / sessions

Grounded in run `20260620-1655-be66` (→ PR #10). Transcripts for later reference, in project dir `~/.claude/projects/-Users-qiushi-dev--worktrees-duet-feat-alternative-workflow/`:

- **Interactive orchestrator** (the session that produced this doc + the two sibling problem-definitions, and observed the whole run): `05c7c1cd-4197-4f38-b888-d433d26f57ed.jsonl`
- **Headless AFK-tail orchestrator** (impl → docs → pr; the budget-cutoff + Codex-hang recovery reasoning): `37d5e9f1-38f0-4cdd-8f51-31c56ace2fde.jsonl`
- **Implementer worker** (the build; the budget-cutoff resume): `dfb317d0-e4c8-4c3b-b124-a5372084f1e5.jsonl`
- **Reviewer (codex)** sessionId `019ee5fa-5865-70e3-9fe4-8f8795bc5f7e` (stored under Codex's own transcript dir, not the claude projects dir)
- Run directory: `.duet/runs/20260620-1655-be66/` (`driver.log`, `state.json`)
