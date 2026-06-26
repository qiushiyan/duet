# Observed pattern: one session, end-to-end

This document describes one real two-agent session: implementing the GitHub issue "additional permissions for org admins" in the `itell/apps/platform` codebase, with Claude Code as implementer and Codex as reviewer. Total wall time was ~14 hours (with a long overnight gap before doc-update and PR creation). Active interactive time was much smaller.

Source evidence:
- `examples/claude-code-session.jsonl` (1758 JSONL lines)
- `examples/codex-session.jsonl` (452 JSONL lines)
- `examples/tabtype-snippets.json` (the snippet expansions used in user turns)

## Turn-by-turn timeline

Times are UTC. "CC" = Claude Code. "CX" = Codex. Snippet names refer to keys in `tabtype-snippets.json`.

| # | Time | Agent | What the human did | Snippet | Role of turn |
|---|---|---|---|---|---|
| 0 | 13:53 | CC | invoked `/onboarding` skill with topic `auth, roles, billing` | — | seed mental model |
| 0' | (same) | CX | same onboarding question framed as "follow .claude/skills/onboarding/skill.md to learn about…" | — | mirror onboarding into the other agent |
| 1 | 14:09 | CC | pasted the GitHub issue text + product context (TA-vs-professor analogy, customer scale, scope decision) | `think-holistic` | independent analysis |
| 1' | (same) | CX | same paste | `think-holistic` | parallel independent analysis |
| 2 | 14:23 | CC | pasted CX's analysis | `compare-notes` | synthesis |
| 3 | 14:26 | CC | "switch to a new branch and write a finalized spec at docs/superpowers/specs/" | — | human approval to commit direction |
| 3' | (after CC writes spec) | CX | pasted CC's spec | `review-spec` | first spec review |
| 4 | 14:36 | CC | pasted CX's review | `update-spec` | spec revision round 1 |
| 4' | (after CC updates) | CX | pasted CC's updated spec summary | `review-updates` | second spec review |
| 5 | 14:46 | CC | pasted CX's second review | `update-spec` | spec revision round 2 |
| 6 | 14:54 | CC | "commit the spec first" | — | human checkpoint |
| 7 | 14:55, 14:58 | CC | `tdd-implementation` snippet (initial planning attempt; tried twice) | `tdd-implementation` | planning attempt |
| 8 | 14:59 | CC | `/compact` | — | context cleanup |
| 9 | 15:01 | CC | re-issued plan request after compact | `tdd-implementation` | plan in plan mode |
| 9' | (after CC plans) | CX | pasted CC's plan | `review-spec` (re-used for plan) | plan review |
| 10 | 15:13 | CC | pasted CX's plan review | `update-plan` | plan revision (1 round only) |
| 11 | (after plan approval) | CC | implementation proceeded autonomously, with one mid-flight Q ("do i need to run any migration") at 15:53 | — | implementation |
| 11' | (after impl) | CX | pasted CC's commit summary | `review-implementation` | code review |
| 12 | 15:59 | CC | pasted CX's review | `review-reflect` | analyze without acting |
| 13 | 16:02 | CC | "go ahead and proceed" | — | human approval to apply fixes |
| 14 | 03:09–03:10 (next day) | CC | `/update-docs` invoked three times in three minutes | docs skill | wrap-up (with friction — see Notes) |
| 15 | 03:12 | CC | "go ahead" | — | resume docs work |
| 16 | 03:18 | CC | "commit push and open a pr" | — | merge gate |

(Times 14–16 reflect a long overnight gap. The substance ends around turn 13.)

## How turns get routed today

The human is the router. The mechanics observed:

1. CC produces an assistant message.
2. Human runs `/copy` (a CC slash command that writes the last assistant message to `/tmp/claude-501/response.md` and the clipboard). Six `/copy` invocations are visible in `examples/claude-code-session.jsonl`.
3. Human switches to the Codex terminal, types `;;<snippet-key>` (tabtype trigger) which expands to the snippet body, then pastes CC's response in the `$0` placeholder.
4. CX produces a review.
5. Human selects CX's text, pastes back into CC with another snippet wrapper.

The clipboard is the transport. The snippet vocabulary is the protocol.

## Snippet vocabulary actually used in this session

Drawn from `examples/tabtype-snippets.json`. The session exercised exactly seven snippets:

- `think-holistic` — kick off independent analysis on a problem statement.
- `compare-notes` — feed the second agent's analysis into the first for synthesis.
- `review-spec` — ask the reviewer to critique a draft spec.
- `update-spec` — feed reviewer's critique back to implementer; revise spec.
- `tdd-implementation` — ask implementer to draft a plan (vertical slices + commits).
- `update-plan` — feed reviewer's plan critique back; revise plan.
- `review-implementation` — ask reviewer to code-review committed implementation.
- `review-reflect` — feed reviewer's critique back; *analyze without changing code yet*.
- `review-updates` — re-review after implementer applied fixes. (Reused once on the spec; not used on the implementation in this session because the loop ended after one round.)

Other snippets in the config (`refactor-guidelines`, `pr-description`, `find-similar-bugs`, etc.) were not used in this session.

## Stable vs. variable

**Stable (the protocol):**
- The seven-snippet vocabulary.
- The phase order: onboard → frame → spec → plan → implement → review → docs → PR. (This is the *observed human* flow — the evidence duet was drawn from. duet's shipped `full` arc since collapsed the docs→PR tail into one `finish` phase, 2026-06-26; the current arc is in `docs/automation-design.md`.)
- The cross-agent ping-pong inside each spec/plan/review phase.
- `/compact` after the spec is committed (preserves implementation context).

**Variable (human judgment):**
- The opening framing turn — contains product context the agents cannot infer.
- The number of review iterations: spec ran 2 rounds, plan ran 1, implementation review ran 1. The user's general description of the workflow says 2–3 for implementation review; the actual count is severity-driven, not fixed.
- Mid-flight tactical questions ("do I need migration"). Not part of the protocol.
- Ship gates: "commit the spec first", "go ahead and proceed", "commit push and open a pr".

## Notes / friction points worth flagging

1. **`/copy` is purely an artifact of the manual clipboard transport.** If the orchestrator reads JSONL directly, this disappears.
2. **`/compact` happens once, between spec and plan.** This is a deliberate context-reset, not a workaround. Any orchestrator needs to preserve this.
3. **`/update-docs` was invoked three times in three minutes** (turns 14a-c). The skill paused at Step 4 ("Propose Plan") and the human re-invoked the slash command instead of resuming past the gate. The skill is drivable headless when the orchestrator handles the gate explicitly — see `examples/skills/update-docs/SKILL.orchestrator.md` for the orchestrator-aware variant.
4. **The implementation review loop ran only once** in this session ("go ahead and proceed" at turn 13). The user's general description says 2–3 rounds. The human stopped early because remaining points were minor. The orchestrator handles this with a fixed per-phase cap (3 for SPEC, PLAN, and IMPL review) that surfaces to the human at the next phase boundary for the ship/another-round decision — see `docs/automation-design.md` §"Loop-exit rule".
5. **First `tdd-implementation` attempt at 14:55 happened *before* `/compact`**, then was abandoned and re-issued after compaction (14:58 attempt, then 15:01 final). The intent — "plan after spec is committed, with a clean context" — is the stable rule. The double-attempt is just feeling-out.

## What this session does *not* tell us

- Whether the same shape holds for smaller/simpler features (a one-file fix probably skips spec; a refactor might loop more).
- Whether onboarding-before-everything is universal or specific to "new feature in a moderately-understood area."
- How the user behaves when CC and CX *disagree strongly* — in this session they converged, with the implementer mostly accepting reviewer critiques.

These are noted in `docs/open-questions.md` as things to validate by sampling more sessions. The design accommodates the unknowns: Slice 1 doesn't presume the full protocol applies to all feature types (it only runs the SPEC review loop), and divergence handling is the orchestrator's judgment whenever it appears, regardless of frequency.

## Corpus scan: planlab (2026-06-11)

A second, much larger evidence source: the user's planlab project history — **22 sessions, 2026-05-29 → 2026-06-11**, at `~/.claude/projects/-Users-qiushi-dev-planlab-main/` (plus one parallel worktree session at `-Users-qiushi-dev-planlab-code-review-bash/`). Six are full-arc "epic" sessions (8–17 MB, 6–34 h wall clock): `b7487993`, `a463ad80`, `e9607005`, `d7e3acbb`, `adc2aa8c`, `2c6a7f46`. Unlike the iTELL session above, these files are **not copied into `examples/`** (~93 MB); claims below cite `(session-id, timestamp)` and are verifiable with `jq 'select(.timestamp=="…")' <file>`. All findings **(observed)** across this corpus.

This scan is what moved the 2026-06-11 pivot from speculation to evidence (it delivered, early, the router-gap evidence the pre-pivot plan expected to gather from three dogfood runs):

1. **The phase arc replicates.** All six epic sessions follow onboard → adversarial cross-review → spec (rounds) → boundary `/compact` → plan (rounds) → sliced implementation (midpoint checkpoint when large) → handoff → review rounds → docs/PR. Snippet usage counts across the corpus: `compare-notes`-style ×15, `respond-review` ×10, `update-plan` ×7, `update-spec` ×5 + `update-spec-again` ×5, `tdd-plan` ×5, `write-spec` ×4, `respond-review-again` ×3, `implementation-handoff` ×1, `respond-midpoint` ×1.
2. **The routing tax is concentrated and real.** `/copy` ×41; ~84 sub-60-char glue messages ("go ahead", "continue with the rest"); ~36 reviewer outputs pasted raw without a snippet header; spec/plan loops demand a human touch every 7–15 minutes, implementation stretches 1–3 h punctuated only by "continue" nudges.
3. **Variance a fixed state machine can't absorb.** Multi-PR pivots inside one session (`d7e3acbb` finishes one fix, compacts, starts a second full arc); a concurrent worktree session (Jun 10, `2c6a7f46` + `d531410e`); `/pl-handle-code-review` polling started and stopped by hand ("You can stop polling now" — `2c6a7f46` 10:57:12Z); ×17 manual `/compact` calls with hand-written phase-shaped arguments matching the `compact-for-*` trio, each followed by an explicit re-anchor read.
4. **Human as environment proxy.** The agent can't touch DB/Slack/Vercel; the user runs migrations and smoke tests and pastes terminal output back ("Do you need me to run the migration?" — `b7487993` 12:10:23Z; `e9607005` 10:34:53Z). This loop is why environment questions are an always-flag triage category.
5. **Snippet evolution is live workflow behavior.** The midpoint checkpoint was free-form on Jun 1 (`a463ad80` 09:42:51Z) and a formal snippet by Jun 2; at `b7487993` 08:10–08:28Z the user has the implementer revise the tabtype snippets themselves. This is the observed basis for the two-tier prompt-agency rule.
6. **A recurring CEO-reframe move, previously in nobody's library.** "Can you step back and give me a more CEO-facing description of how we plan to design this…" — `b7487993` 07:22:37Z, `a463ad80` 07:12:21Z, `e9607005` 05:12:52Z. Formalized 2026-06-11 as the proposed `ceo-summary` snippet (final-stage variant; see `docs/workflow-model.md`).
7. **Conventions confirmed:** specs at `docs/superpowers/specs/YYYY-MM-DD-<slug>.md` with plans folded into the same dir; typed branch prefixes off `develop` (`feat/`, `fix/`, `eval/`); spec committed to the branch *before* implementation (`b7487993` 04:17:26Z); one commit per slice.
