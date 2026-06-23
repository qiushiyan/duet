# Workflow model

This document abstracts the workflow into a model an orchestrator can implement, while preserving the parts that depend on human judgment. As of the **2026-06-11 pivot** (see `docs/automation-design.md` §"Design history"), the model has two levels: a deterministic **phase-and-gate skeleton** enforced in code, and a **protocol** (the snippet vocabulary and its usage rules) applied with judgment by an LLM orchestrator inside each phase.

## The three roles

- **Orchestrator** — read-only LLM agent. Drives the protocol: chooses and adapts snippets, routes each worker's output to the other worker, judges loop exits, triages questions (flag to human vs. bounce to worker — never answers substance itself). Added in the 2026-06-11 pivot; previously this role was split between a planned dumb router and the human.
- **Implementer** — produces specs, plans, code, handoffs, summaries. Claude Code in the observed sessions.
- **Reviewer** — critiques specs, plans, and committed code at the right altitude. Codex in the observed sessions.

**Roles are decoupled from providers** (2026-06-11): each role binds to a provider (`claude` — with a per-role Anthropic model ID — or `codex` — no model key; the user's own codex config governs) via the role-bindings config file, with per-run CLI overrides. The shipped default: orchestrator on claude/Opus 4.8, implementer on claude/Opus 4.8, reviewer on codex. See `docs/automation-design.md` §"Roles are decoupled from providers" for the config format and the per-role capability contract (the orchestrator role is claude-only in v1; codex-as-orchestrator is a designed extension, Q17).

## The phases

Three top-level phases; the previously nine-phase machine survives as nested steps. Gates (──) are states where no agent runs and only human events transition; `ask_human` flags can interrupt any phase.

```
PLANNING (attended — orchestrator drives, human acts at gates and flags)
  ONBOARD            both agents, project skill or framing-directed reading
  FRAME              both agents analyze independently (think-holistic)
  SYNTHESIZE         implementer eats reviewer's analysis (compare-notes)
    ── Direction gate ──
  SPEC ⇄ review/update rounds          loop exit: orchestrator judgment
    ── Commit-spec gate ──
  PLAN ⇄ review/update rounds          planning keeps full spec-exploration context
    ── Plan-approval gate ──            ← human walks away

IMPLEMENTATION (AFK — flags queue, process exits on them)
  COMPACT            compact-for-impl, then re-anchor read (plan→impl boundary)
  IMPLEMENT          vertical slices, one commit per slice
  (MIDPOINT)         orchestrator judgment for large implementations:
                     midpoint-status → review-midpoint → respond-midpoint
  (COMPACT)          compact-for-review when context is heavy
  HANDOFF            implementation-handoff
  REVIEW ⇄ respond/fix rounds          loop exit: orchestrator judgment,
                                       hard backstop caps in the harness
  CEO-SUMMARY        implementer drafts; last act of the phase
    ── Ship gate ──                     ← human returns; verifies (migrations, smoke tests) + reads packet

FINAL REVIEW (finishing — unattended by default)
  UPDATE_DOCS        skill; one pass — update and commit, no gate
  PR_DESCRIPTION     implementer drafts for the PR body
    ── Open-PR gate ──                  ← auto-opens by default; gates_at: pr adds a pre-open stop
```

Observed round counts: spec 2, plan 1, impl review 1 in the original example session; the user's general description says impl review runs 2–3. Under the pivot these inform the orchestrator's judgment and the sizing of the harness's runaway backstops (see `docs/automation-design.md` §"Loop semantics"), not a fixed exit rule.

Gates may be **pre-authorized per run** (`gates_at`, 2026-06-12 — `docs/automation-design.md` §"Gate pre-authorization"): the harness auto-crosses them on the human's standing approval, packet recorded and notification fired, and the orchestrator carries the would-be gate questions forward as encoded recommendations (with an `ask_human` escape hatch for calls that would make downstream work throwaway). The Open-PR gate is pre-authorized by default (the PR auto-opens; reversed 2026-06-22) — list `pr` in `gates_at` for a pre-open stop. The orchestrator's posture instructions are rendered deterministically from the parsed value, never inferred from framing prose.

## The snippet vocabulary

The protocol substance is the snippets — they encode the altitude lenses, the reflect-before-change gates, and the compaction discipline. The orchestrator selects them by tag via `send_prompt(role, tag, body)` and may adapt the body per turn (logged); persistent library edits are human-gated proposals. Core vocabulary, from `examples/tabtype-snippets.json` and the user's tabtype `WORKFLOW.md`:

| Snippet | Direction | Phase step | What it asks |
|---|---|---|---|
| `think-holistic` | → both | FRAME | "Don't change code. Reason from first principles; 2–3 approaches with tradeoffs." |
| `compare-notes` | reviewer → implementer | SYNTHESIZE | "Another engineer's analysis; critique, synthesize, don't capitulate." |
| `write-spec` | → implementer | SPEC | Draft the spec, opening with a leader-facing summary (what/approach/scope/deferred); defer line-level detail, test design, doc plans. |
| `review-spec` / `review-spec-again` | implementer → reviewer | SPEC rounds | Critique at spec altitude / verify round-1 feedback was integrated. |
| `update-spec` / `update-spec-again` | reviewer → implementer | SPEC rounds | Assess validity, revise or push back / apply round-2 inline, converge. |
| `compact-for-impl` | → implementer | COMPACT (plan→impl) | Context reset for the slice phase: keep the committed spec + plan, drop the planning journey. (`compact-for-plan` is the manual after-spec variant, kept in the library; duet compacts after the plan instead — `docs/automation-design.md` §"Worker compaction".) |
| `tdd-plan` | → implementer | PLAN | Vertical slices, test cases, fixtures; stop short of code bodies. |
| `review-plan` / `update-plan` (+ `-again`) | ⇄ | PLAN rounds | Plan-altitude critique and revision. |
| `midpoint-status` / `review-midpoint` / `respond-midpoint` | ⇄ | MIDPOINT | Status snapshot → review weighting compounding issues → triage, no code yet. |
| `compact-for-review` | → implementer | COMPACT | Context reset shaped for review: keep decisions + why, drop build process. |
| `implementation-handoff` | → implementer | HANDOFF | Review-aligned map: change map, decisions, deviations, where to look hardest. |
| `review-implementation` / `review-implementation-again` | implementer → reviewer | REVIEW rounds | Severity-rated code review / "was the feedback actually addressed?" |
| `respond-review` / `respond-review-again` | reviewer → implementer | REVIEW rounds | Analyze each point first, no code changes / apply inline, converge. |
| `ceo-summary` | → implementer | CEO-SUMMARY | Product-first summary for the Ship gate. **Proposed — body below, not yet in tabtype.** |
| `pr-description` | → implementer | PR_DESCRIPTION | PR body for a technical colleague who won't read the diff. |

Plus user-invoked project skills at ONBOARD and UPDATE_DOCS (duet doesn't bundle or assume these; the framing turn names them), and `/compact` fired with the compaction snippets as its argument.

## Proposed snippet: `ceo-summary`

Mandated 2026-06-11. Fired by the orchestrator as the last act of the IMPLEMENTATION phase, once implementation and follow-up reviews are done; its output leads the Ship-gate packet. The audience is the user first and a colleague second — semi-developer-facing, so non-technical aspects lead and technology comes last, at CEO/CTO altitude. Documented here ahead of being added to the tabtype library (duet owns `snippets.toml`; porting to the tabtype config is a manual human step).

```toml
[[snippets]]
key = "ceo-summary"
expand = '''Implementation and follow-up reviews are done. Write a CEO-facing summary of this PR — for me, and for explaining the work to a colleague without walking them through the diff.

Start non-technical, in this order:

1. What the PR does, from a product perspective
2. Bugs fixed
3. Features added
4. What problems it solves

Then the technical side at a very high level — the approach and the one or two decisions a CTO would care about. No file paths, no function names, no implementation play-by-play.

This is CEO/CTO altitude: outcomes first, technology last. Drop any section that's empty. Tight prose beats exhaustive sections.'''
```

Evidence for the move: the user repeatedly makes a free-form "CEO-reframe" request in real sessions ("Can you step back and give me a more CEO-facing description of how we plan to design this…" — planlab `b7487993` 07:22:37Z, `a463ad80` 07:12:21Z, `e9607005` 05:12:52Z **(observed)**), and the original example session ended with a "CEO-readable" PR description (`docs/observed-pattern.md`). The planning-stage reframe and this final-stage summary are the same move at two altitudes; the planning-stage variant is folded into `write-spec` as its mandatory leader-facing opening section (2026-06-12), the final-stage one is this snippet. `ceo-summary` and `pr-description` both run — the former feeds the human gate, the latter feeds the PR body.

## What each phase produces

- **PLANNING** → a committed spec file (path per project convention, e.g. `docs/superpowers/specs/YYYY-MM-DD-<slug>.md` **(observed)**) and an approved plan file (path named by the framing; a repo file rather than in-conversation, because implementation-phase compaction re-anchors on it — the orchestrator flags the human if the framing names no plan location).
- **IMPLEMENTATION** → commits (one per slice, plus review-fix commits), the implementation handoff, the review history, and the CEO summary.
- **FINAL REVIEW** → doc updates, the PR description, a pushed branch, and an opened PR.

## Loop semantics

Each review loop has the same shape: artifact → reviewer critique → implementer revision-or-pushback → *another round?* The "another round?" decision is the orchestrator's judgment — the same call the human currently makes by reading whether remaining points are substantive. The harness keeps hard per-phase round caps purely as runaway backstops; hitting one raises an `ask_human` flag. Disagreement handling is judgment too: the orchestrator reads pushback and flags the human when a disagreement is persistent and substantive, replacing the old `disagree.point` string-matching across rounds.

## Branch discipline

One branch per run, fixed before the first worker prompt. Either the human creates it before starting, or the orchestrator does (by judging whether the current branch already fits the problem — `docs/automation-design.md` §"Branch policy"). The workers are takers, not deciders: every first prompt to a worker names the working branch and states that branch management is settled outside their sessions. All commits of a run — spec, plan, slices, fixes, docs — land on that one branch, which is what the `open` step eventually pushes and turns into the PR.

## What's not in the protocol

- Tactical mid-implementation clarifications — bounced back to the worker by the orchestrator's triage rule (process, not substance).
- Human convenience moves from the manual workflow (`/copy`, clipboard, tabtype expansion) — these *are* the routing tax; they disappear by construction.
- Re-tries from context confusion (the double `tdd-implementation` in the example session) — the orchestrator fires each step once after its prerequisite is met.

## Symmetry and reversibility

Nothing in the protocol assumes which provider holds which role — the snippets are phrased generically ("the engineering team reviewed…", "a senior engineer reviewed…"), so any role→provider binding the config expresses is protocol-valid. The practical asymmetry is the capability contract, not the protocol: the orchestrator role needs custom harness tools and pause/resume, which only the claude provider implements in v1 (Q17 covers the codex path). Whatever the binding, all three transcripts land in their providers' standard locations, so a run remains fully reconstructable without duet.
