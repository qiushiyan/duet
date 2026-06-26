# Open questions

Design decisions and their evidence. **Open** questions carry their full reasoning — what we believe, what supports it, what would change the answer. **Resolved** questions (struck-through headings) are compressed to their dated verdict plus a pointer to where the substance now lives; the full deliberations and the original analyses are in this file's git history. Q numbers are stable — docs and source comments cite them; never renumber.

Numbering note: Q1–Q10 predate the 2026-06-11 pivot to an intelligent orchestrator (`docs/automation-design.md` §"Design history" — the pivot reversed Q10 and amended Q7/Q8); Q11–Q17 are the pivot's questions; Q18+ came from running the thing.

## ~~Q1. Does `claude -p` (and `codex exec`) resume the same session?~~

**Yes (2026-05-26, verified against the installed CLIs).** Both persist transcripts and append on resume: `claude -p --resume <uuid>` (transcripts in `~/.claude/projects/<slug>/`), `codex exec resume <id>` (rollouts in `~/.codex/sessions/`). Bonus findings that shaped the design: structured output at the CLI boundary (`--output-format json` / `--output-last-message`), JSON Schema enforcement on both CLIs, and per-invocation budget caps (`--max-budget-usd`). The mechanics live in `src/providers/`.

## ~~Q2. Does `/update-docs` (and `/onboarding`) work non-interactively?~~

**Yes (2026-05-26; docs gate removed 2026-06-23; docs phase folded into `finish` 2026-06-26).** `/onboarding` is drivable headless when given a concrete topic. `/update-docs` has a human approval step at its propose-plan stage; duet originally surfaced that as the **Docs-plan gate**, but **2026-06-23 the docs phase became gate-less**, and **2026-06-26 it folded into the single `finish` phase** (the docs/pr/open tail collapse — see Q20) as its `reconcile-docs` step. The gate never earned its cost: a doc commit on an unmerged branch rides into the PR where the human reviews it like any other diff, the orchestrator's "approval" of a docs plan was pure routing (no review-round signal — observed in both runs that reached the phase, `20260618-0148-1e14` / `20260619-1354-70b2`), and every overnight run auto-crossed it unattended anyway. Genuine doc-scope product calls — deleting a documented concept, rewriting a design claim, pruning a superseded spec/plan — still flag via `ask_human`, which pauses the run; that is where the substance always lived, not the gate. This is the precedent the `finish` collapse extends: the same reasoning that retired the docs gate retired the whole finishing tail's interposed stops. The example skill (`examples/skills/update-docs/SKILL.orchestrator.md`, verbatim original beside it) demonstrates an `ORCHESTRATOR_RUN_TO_COMPLETION` marker that runs such a skill's internal approval step straight through; the `finish` phase's `reconcile-docs` step has the framing name that marker.

## ~~Q3. Is the snippet protocol stable across feature types?~~

**Deferred (2026-05-26), still unsampled.** Working assumption: the full protocol is the upper bound and smaller tasks shed phases from the front (a spec-entry run skips FRAME; a task that wouldn't want a spec just doesn't get a duet run). If runs of varied shape surface protocol friction, sample the session corpus for a phase-presence matrix then.

## ~~Q4. What does "convergence" look like in the reviewer's output?~~

**Superseded by the pivot.** Loop exit is orchestrator judgment, not severity-label parsing; backstop caps are runaway protection, not the exit mechanism (`docs/automation-design.md` §"Loop semantics").

## ~~Q5. How does the user behave when the two agents disagree?~~

**Superseded.** A disagreement that persists across rounds with substantive arguments on both sides is flagged via `ask_human`; how the human resolves it is theirs — duet doesn't predict it.

## ~~Q6. Is the implementer/reviewer role binding ever swapped?~~

**Generalized into role–provider decoupling (2026-06-11).** Any role binds to any capable provider via `~/.config/duet/config.toml` plus per-run flags (`docs/automation-design.md` §"Roles are decoupled from providers").

## ~~Q7. Daemon or one-shot CLI?~~

**One-shot, alive through a phase (2026-05-26; lifetime amended 2026-06-11 from per-gate to per-phase).** Detached per-phase driver, exits at quiescent stops, no resident daemon (`docs/automation-design.md` §"Not a daemon — but alive through a phase"; `src/harness/lifecycle.ts`).

## ~~Q8. What's the smallest vertical slice worth implementing first?~~

**Superseded by Q14** — the pivot changed what needed validating.

## ~~Q9. Will agents reliably honor structural markers?~~

**Superseded twice:** free-text tags → CLI-level JSON Schema enforcement (verified on both CLIs, 2026-05-26) → demoted entirely when the orchestrator became the reader (Q16). Still-relevant residue: any future worker schema must stay OpenAI-strict-compliant — every property in `required`, optionals as nullable unions.

## ~~Q10. Where does the dumb router actually fall short?~~

**Reversed by the 2026-06-11 pivot** — the 22-session corpus scan answered it earlier and more structurally than the planned three dogfood runs (`docs/automation-design.md` §"Design history"). What survives: the per-run `notes.md` convention, written by both the human and the orchestrator's `write_note` — it is how Q13/Q19/Q20 get their evidence.

## ~~Q11. What substrate runs the orchestrator?~~

**The Claude Agent SDK, with the cooperative pause (2026-06-11, by the spike at `src/spike/q11.ts`).** The load-bearing findings:

- Read-only by tool surface works: `tools: []` + SDK-MCP custom tools; `strictMcpConfig` required (the user's claude.ai connectors and plugins leak into the surface without it).
- **Both mechanical pause options corrupt session resume** — PreToolUse `defer` loses the SDK MCP server on resume; `canUseTool` deny+interrupt crashes the resumed session. Executable repros: `src/spike/repro-*.ts`. The working pattern is cooperative: the `ask_human` handler persists the question and instructs the orchestrator to end its turn; the process exits at quiescence; `--resume` delivers the answer.
- Session resume preserves context fully, and the transcript lands in `~/.claude/projects/` — manually resumable, so augmentation holds.
- Operational: SDK-MCP calls outliving 60s (every `send_prompt`) need `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` raised; `alwaysLoad: true` keeps tools present when a resumed session's first prompt is built.
- Economics: from 2026-06-15, Agent SDK / `claude -p` usage draws from a separate subscription credit pool at standard API rates — per-invocation `maxBudgetUsd` is a day-one rail, costs tracked per run. The opt-in interactive transport for the implementer (`docs/interactive-transport.md`) drives the interactive TUI to bill the *flat* quota instead — built and live-verified.

## ~~Q12. Where does duet's snippet library live?~~

**Duet owns `snippets.toml` at the repo root (2026-06-11),** mirroring tabtype's schema, seeded from the live tabtype config plus `ceo-summary`. Approved `propose_snippet_edit` diffs apply here; porting back to tabtype is a manual human step — no automatic sync. Guarded by `tests/snippets.test.ts`; re-seed from `~/.config/tabtype/config.toml` if the copies drift the wrong way.

**Extended 2026-06-25 — duet owns the *default* library.** Users may layer per-key overrides without forking: a user `~/.config/duet/snippets.toml` and a project `<repo>/.duet/snippets.toml` replace whole snippet bodies, shipped → user → project last-wins, fail-closed on an unknown key, byte-identical to the defaults when absent (`duet snippets` inspects provenance). These are *library* artifacts — the same kind as the shipped `snippets.toml`, customizing the tool — not config and not a project-knowledge channel; framing stays the single seam (`docs/automation-design.md` §"What the MVP should *not* do"; mechanics in README §"Customizing the snippets"). The `propose_snippet_edit` proposal path is unchanged — it still targets the shipped source.

## Q13. Will the triage rules over-flag or under-flag?

**Why it matters.** The orchestrator's value during AFK depends on flag precision: under-flagging silently absorbs product decisions the human owns (the worst failure); over-flagging turns AFK into a pager. The rules (product/direction → always flag; environment → always flag; tactical → bounce to worker with process-not-substance) are instructions, not mechanisms.

**Current belief.** Modern models follow concrete triage instructions with examples well, and the failure mode is asymmetric by design — when in doubt the instructions say flag, because a spurious flag costs minutes while an absorbed product decision costs trust. Expect over-flagging first; tighten wording from observed false positives.

**What would change the answer.** More runs. Every flag and every bounce gets reviewed afterward via the notes file: should this have been flagged? Should that have been? Recurring misses become instruction edits or, if instructions can't fix it, a harness-level rule.

> **First real evidence (2026-06-11, planlab `20260611-1542-aeca`):** triage held through a full framing-to-ship arc — product calls were held for gates (group labels, tab placement surfaced in the ship packet, not as mid-loop interrupts), environment limits were reported honestly (eslint-can't-run, no-browser-smoke), and no spurious flags interrupted the AFK phase. The run's misbehavior was elsewhere (template re-sending — fixed as the template-economy rails). Verdict still open pending more runs; review each run's `notes.md` before tuning.

## ~~Q14. What is the new Slice 1?~~

**The complete attended PLANNING phase, shipped 2026-06-11** ("Slice 1++" — the Q11 spike de-risked the substrate, so the slice grew past its scoping). Verified by a live end-to-end run on a scratch repo (`20260611-1048-4ec2`): SPEC loop 2 rounds (the reviewer read the real `.duet/runs/` layout duet had just written and caught the draft spec's fictional data model), gate, PLAN loop 2 rounds (the orchestrator drafted the plan from the framing, caught the implementer dropping a commit confirmation, ran a tight `-again` round), gate, done. Three product questions correctly **held for the gate** instead of interrupting mid-loop. Cost: $1.45 orchestrator + $2.42 claude workers + ~1.2M codex input tokens.

> **Second verification (2026-06-11, the first real-feature run).** planlab `20260611-1542-aeca` drove framing-only entry through the Ship gate on a real feature-plus-refactor: FRAME (onboard, think-holistic ×2, compare-notes) → Direction gate, where the human **inverted the scope** as gate feedback and the orchestrator re-analyzed under it → SPEC (2 rounds) → PLAN (2 rounds) → AFK IMPL with a midpoint checkpoint (two course corrections folded into the remaining slices), 3 review rounds to reviewer sign-off, a deliberate descope decision surfaced honestly, and a full ship packet led by the CEO summary. Cost of the arc: ~$8 orchestrator + ~$85 claude workers + ~82M codex input tokens. The frame/spec/plan/impl machinery is live-verified on real work; docs/pr/open await their first crossing. Operational findings folded back the same day: template economy rails, the detached phase driver, `duet logs`/`takeover`, and "silent worker turns read as hangs" (heartbeats now; a streaming sink remains the eventual fix).

## ~~Q15. XState or a hand-rolled transition table?~~

**XState v5 (2026-06-11).** Gates and flag-waits are actor-less `quiescent`-tagged states; snapshots persist only there, so no in-flight invoke is ever restored; states are built from the phase table (`src/phases.ts`); `tests/machine.test.ts` pins the guarantees and the exact quiescent tag set. Usage discipline: `docs/engineering.md` §"XState usage".

## Q16. Does the worker structured-output schema survive, and in what form?

**Why it matters.** `schemas/agent-response.json` was the dumb router's protocol contract — `needs_human` and `disagree` were how judgment-free code detected exceptions. The orchestrator reads prose, so the schema is no longer load-bearing. But a minimal envelope might still make routing mechanically cleaner than scraping final messages.

**Current belief.** Demote, don't delete. Workers currently run schema-free and the orchestrator reads their final messages — and the verified runs (Q14) routed fine on prose. A minimal `{response_text}` envelope earns its way back only if routing breaks on chatty final messages. Any surviving schema must preserve OpenAI-strict compliance (Q9 residue). Schema-on-resume is verified working on the pinned codex CLI (openai/codex#23123, live-tested) — availability no longer constrains the decision.

**What would change the answer.** Dogfooding evidence either way: the orchestrator reliably extracting what it needs from prose (delete the schema and `schemas/agent-response.json` with it), or routing failures traceable to unstructured worker output (introduce the minimal envelope).

## Q17. How does the codex provider serve the orchestrator role?

**Why it matters.** Role–provider decoupling (2026-06-11) makes orchestrator-on-codex a legal configuration, but the orchestrator's capability contract — custom harness tools, read-only enforcement, pause/resume at a tool call — is only implemented by the claude provider in v1. This question records the designed path so the decoupling isn't an empty promise.

**Current belief.** The bridge is a **local MCP server**: the harness exposes the orchestrator tools as MCP tools, and the codex orchestrator session is launched with that server `-c`-injected per invocation (never written into the user's `~/.codex/config.toml`) plus `-s read-only`. The harness-side half now **exists**: the Claude-as-orchestrator Stage-0 work (`docs/future-directions.md` §A) made the tool surface host-neutral and serves it over a standard stdio MCP server (`duet _mcp`) — the same server a codex orchestrator would connect to. Two codex-specific things remain unverified and gate the feature:

1. **Pause/resume at a tool call.** Codex has no `canUseTool`-style callback — the MCP tool handler would have to block, return a sentinel, or fail the turn, and what `codex exec resume` does with a turn that ended mid-tool-call is unknown. This is the hard part (the claude answer — the cooperative pause — may transfer, but is unproven there).
2. **Tool-call faithfulness under codex's MCP client** — schema adherence, parallel-call behavior, retry semantics.

**What would change the answer.** Actually wanting the configuration (the user today runs orchestrator-on-claude). Until then this is deliberately unbuilt — the provider interface allows it; nobody pays for it. If/when wanted: a half-day spike mirroring Q11's, against the same harness tools.

## ~~Q18. How does worker context get compacted mid-run?~~

**Per provider, asymmetrically (2026-06-11, by live probes and source reading).** claude workers: a prompt whose body is literally `/compact <instructions>` compacts the session natively in place (same id, instructions honored; the provider substitutes a synthetic confirmation for the compaction turn's empty result — `src/providers/claude.ts`). codex workers: built-in auto-compaction at ~90% of the context window, shared by every frontend — never send codex a compaction command, never touch `~/.codex/config.toml` (its context-window overrides are the one known way to break exec-mode auto-compaction). This is also why the plan must be a file in the repo: post-compaction turns re-anchor on the plan file and committed spec.

**Residual:** deliberate compaction for a codex-bound *implementer* would need the session-rotation pattern (old session writes the summary, new session seeded with it) — unbuilt, same status as Q17. And the codex evidence is source + issue-thread, not a live 230k-token run; if a reviewer ever crashes at the context ceiling, check the two config keys above first.

## Q19. Does duet need a run-level budget model?

**Why it matters.** Worker budget caps are per invocation (a per-phase profile resolved through `budgetFor`, passed as `--max-budget-usd` on each capped `claude -p` call; opt-in and off by default since 2026-06-22) — a fresh turn carries a fresh ceiling, and nothing enforces or communicates a total for the run beyond the additive `costs` display. The first real run (planlab `20260611-1542-aeca`) showed the rail leaking into product scope: the implementer descoped slice 5's modal extractions citing "~$7 of budget left" mid-turn (implementer.log:1623) and explicitly offered a fresh-turn alternative that wasn't taken; the orchestrator collapsed a `respond-review` analysis gate "given your session budget"; and the CEO summary rationalized the descope to the human as a thinning-budget tradeoff. A scope decision the human owns was shaped by an infrastructure parameter nobody in the system understood.

**Current belief.** The 2026-06-12 fix is transparency, not a model: `send_prompt`'s description and the impl entry prompt now state that budget is per-turn and that a worker running low means splitting the work across turns, never shrinking scope. That may be enough — the slice-5 descope also had a legitimate risk argument (browser-unverifiable modal work), so the rail wasn't the sole driver. If runs after the fix still show budget-shaped scope decisions, the next step is an explicit run-level budget the orchestrator can reason about; `budget_usd` is pre-approved as a framing-frontmatter key under the boundary rule (fixed value, harness-enforced). The 2026-06-22 rails bundle added the opt-in `--budget` knob (off by default; a multiplier scaling the per-phase profile) and made a hit cap a resumable checkpoint rather than a crash — but that knob is still **per-turn**, not the run-level model this question asks about, and `budget_usd` remains unshipped. Q19 stays open; the budget paths are test-verified, with no live run having exercised a real cap.

**What would change the answer.** Notes-file evidence from post-fix runs: any further scope decision that cites budget, or a run blowing materially past what the human would have authorized in advance.

## ~~Q20. Does gate pre-authorization hold up — do encoded recommendations survive the morning review?~~

**Resolved by decision (2026-06-26): `overnight` is full's default posture.** Pre-authorization is now the out-of-the-box behavior, not an opt-in — a new full run attends only `frame` and `spec`; plan, Ship, and the (post-open) Open-PR gate auto-cross unless listed. The bet: semi-AFK *is* the product, the human consciously judges a run's ambiguity at framing time, and the recorded packets plus the status while-you-were-away section keep the morning review auditable; reject-at-the-next-attended-gate plus run abandonment cover the deep-error case. The accepted cost is that the **Ship gate** — the one structural checkpoint for environment verification (migrations, smoke tests) — auto-crosses by default; that forcing function relocates into the **draft PR + its `Verification (pending)` checklist** (the human verifies before marking the draft ready / merging) — and `finish` *guarantees* that draft state on every path, forcing a pre-existing non-draft PR back to draft (`gh pr ready --undo`) before it advances, so a mergeable, env-unverified PR can never auto-cross to done. A bound consultant's `verify` checkpoint still holds the Ship auto-cross on a failed assertion (a `high`). The evidence that fed this: the human rubber-stamping plan gates (2026-06-12, second run — the `skip-plan` preset's reason for being), and the 2026-06-22 reversal that had already made the PR auto-open. Substance now lives in `docs/automation-design.md` §"Gate pre-authorization". **Still watched** in each run's `notes.md`: a morning reversal that recurs at one gate argues for restoring its attendance, and the throwaway-test escape hatch (`ask_human` when proceeding unanswered would make most downstream work throwaway) failing to fire re-opens this by a documented decision here.

## ~~Q21. Async interactive `send_prompt` — in-process fire-and-collect (A′), or detached-child-per-turn (B)?~~

**A′ — built and live-verified (2026-06-23).** On the interactive orchestrator host a blocking `send_prompt` would freeze the session for the minutes a worker runs (a CC turn can't yield with a `tool_use` outstanding), so A′ dispatches each turn as a background promise inside the run-scoped MCP server and collects it with `check_turns`, fenced by a single-writer lease with on-disk orphan / `duet takeover` recovery. B (a detached child per turn, surviving a session quit) stays unjustified for the *attended* arc — a turn lost to a deliberate quit is a re-fire, not a silent overnight failure — and C (a bounded-blocking single tool) was declined. Substance: the fire-and-collect pattern in `docs/engineering.md`; spec at `docs/specs/2026-06-21-async-interactive-send-prompt.md`. **Revisit if** mid-turn session quits become common or overnight orphans misfire — then B's survive-the-quit robustness earns its cost (transcript-tail reconstruction on reconnect is the lighter intermediate).

## Q22. Does the consultant earn its keep — does a low-context, cross-family bet-auditor surface assumptions the embedded reviewer misses, often enough to justify binding it?

**Why it matters.** The consultant (2026-06-22, `docs/automation-design.md` §"The three roles" / §"Consultant checkpoints") is a *bet* on a bet: that a deliberately low-context, ephemeral, cross-family reviewer challenges product framing where the embedded reviewer — invested in the run's accumulated context — is strong on execution and blind to premise. The mechanism is built and live-verified, but its **value is still thin on evidence**: whether its bet audits actually catch wrong premises (rather than restating the obvious, or firing `high` on non-issues and stalling an overnight run via the severity hold) needs more runs than have happened so far. Cost is real — an extra worker turn at each of three checkpoints, on a second model family.

**Current belief.** The altitude gap is real (a persistent reviewer can't be both deeply contextual and a fresh-eyes outsider), and a different model family is the one thing a single reviewer working harder can't supply — so the consultant should surface a class of finding the reviewer structurally won't. It is off by default and additive (never a review round, never substitutive), so the downside of a weak consultant is bounded: wasted turns on a run that opted in, not a worse default. The severity hold is the calibration risk to watch — a consultant too eager with `high` converts pre-authorized runs into attended stops.

**What would change the answer.** More live runs with the consultant bound, reviewed against `notes.md`: did a bet audit change a direction or catch a premise the reviewer and the human both missed — and how often versus restating known tradeoffs? Did a `high` hold ever save a wrong-subject overnight arc, or only stall good ones? Persistent low-signal audits argue for narrowing the checkpoints (or dropping framing, where there is no gate proving it ran); frequent false `high` holds argue for tightening what severity the audit step assigns. Until that evidence accumulates, the consultant stays opt-in and its value is **(general)** — not yet earned across runs.

## What remains

The whole workflow is now live-verified — both arcs, both orchestrator hosts, the consultant, run supervision, and the interactive transport have run on real work (Q21 resolved above). What stays open is **calibration, not capability**: Q13 (triage precision), Q16 (worker schema), Q19 (run-level budget), and Q22 (does the consultant earn its keep) all accrue their answer from more runs — review each run's `notes.md` against them. Q20 (pre-authorization) is resolved by decision (`overnight` is full's default) but keeps a standing `notes.md` watch for a recurring morning reversal. Q17 (codex-as-orchestrator) waits for someone to actually want the configuration. New questions land here when runs produce them.
