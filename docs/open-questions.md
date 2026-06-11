# Open questions

Things to validate before implementing the MVP orchestrator. Each question records what we currently believe, what evidence supports it, and what new evidence would change the answer. Answering these is cheaper than building against assumptions and rebuilding later.

> **2026-06-11 pivot.** The design changed structurally: the orchestrator is now an intelligent, read-only LLM agent inside a code-enforced phase-and-gate skeleton, not a dumb state-machine router (see `docs/automation-design.md` §"Design history"). This **reverses Q10**, **amends Q7 and Q8**, and raises **Q11–Q16** below. Q1, Q2, Q9's empirical findings (CLI resume, skill drivability, schema enforcement) remain valid as facts about the CLIs; how much the design still leans on them is per-question.

## ~~Q1. Does `claude -p` (and `codex exec`) resume the same session, or spawn a new one?~~

**Answered (2026-05-26).** Yes — both CLIs persist transcripts by default and append on resume. Verified via `--help` against installed versions on this machine.

- **Claude Code:** `claude -p --resume <uuid> "prompt"` resumes by id; `claude -p --continue "prompt"` resumes the most recent in the cwd; `claude --session-id <uuid>` lets the orchestrator pre-allocate the id. Transcripts at `~/.claude/projects/<slug>/<uuid>.jsonl`. Opt-out: `--no-session-persistence`.
- **Codex:** `codex exec resume <SESSION_ID> "prompt"` (resume is a subcommand of `exec`, not a flag). Rollouts at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Opt-out: `--ephemeral`.

**Bonus findings that change the design (favorably):**

- **Structured output is the primary read path, not JSONL grepping.** Codex `--output-last-message <FILE>` writes the final assistant message atomically; Claude `--output-format json` returns a `{result, session_id, ...}` envelope. The JSONL is kept as audit trail. The "JSONL flush race" worry from the original Q1 is moot — these are synchronous on subprocess exit.
- **JSON Schema enforcement is available on both CLIs.** Claude `--json-schema '<schema>'` and Codex `--output-schema <FILE>` validate the agent's final response. This is the better mechanism for Q9 (structural markers) than free-text tag grepping — see Q9 for the rewritten plan.
- **Cost ceiling per invocation.** Claude `--max-budget-usd <N>` — a safety rail worth turning on in MVP runs.
- **Real-time streaming.** `--output-format stream-json` (Claude) / `--json` (Codex) emit events on stdout for live progress display.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** The whole router design rests on reading JSONL transcripts and feeding the *other* agent. If non-interactive invocations create a fresh session each time, the JSONL fragments are disjoint and the agent loses prior context — which the workflow assumes carries forward (the spec context informs the plan, the plan informs the implementation, etc.).

**Current belief.** Unknown. The example session was entirely interactive. The CC `--continue` and `--resume` flags exist; need to check whether `--print` (`-p`) honors them and whether the appended turns go into the existing JSONL or a new one. Codex has `codex exec` and `codex resume`; same question.

**What would change the answer.** A 5-minute test: run `claude --resume <id> -p "hello"` against a known session, then check whether the JSONL file grew or a new file appeared.

**Fallback if it doesn't work.** Build an explicit-context-recap turn into each phase: prepend a short summary of prior phases to each prompt. More tokens, but agent-agnostic.

## ~~Q2. Does `/update-docs` (and `/onboarding`) work non-interactively?~~

**Answered (2026-05-26).** Mixed, with a clean resolution. Verified by reading the actual skill files (copies preserved at `examples/skills/onboarding/SKILL.md` and `examples/skills/update-docs/SKILL.md`).

- **`/onboarding` — drivable headless.** No `AskUserQuestion` calls. The skill has one *conditional* clarifying question that only triggers when `$ARGUMENTS` is empty or ambiguous; the orchestrator avoids it by passing a concrete topic (which is part of the framing turn collected at `duet new`). Ship as-is.

- **`/update-docs` — has a structural human gate at Step 4 ("Propose Plan"), not an `AskUserQuestion` call.** The observed `/update-docs`-invoked-three-times friction was the human accidentally re-running the skill from Step 1 instead of resuming past the gate. The fix is structural, not behavioral: the skill's internal gate maps to a phase boundary in the orchestrator's state machine.

**Recommended approach.** Treat the skill gate as another orchestrator gate. To make the skill cleanly resumable past Step 4, add an "orchestrator resume" path that skips Step 4 when invoked with a marker token. A proposed modification lives at `examples/skills/update-docs/SKILL.orchestrator.md`; the verbatim original is preserved at `examples/skills/update-docs/SKILL.md` for falsifiable comparison. The modification is a single conditional in Step 4 that recognizes the token `ORCHESTRATOR_RESUME_FROM_PROPOSAL`. Interactive behavior is unchanged.

**Implication for the orchestrator design.** Skills with built-in human gates are orchestrator-friendly, not orchestrator-hostile. The state machine should accept skill gates as a category of phase boundary. Other skills the workflow uses (`/onboarding` at the start; the TDD skill *read* by the agent inside `tdd-implementation`, not invoked via slash command) need no orchestrator handling.

**What still needs empirical verification (deferred to first MVP run).** That `claude -p --resume <id> "ORCHESTRATOR_RESUME_FROM_PROPOSAL — proceed to Step 5."` actually reaches the modified Step 4 logic and skips correctly. The risk is low (the conditional is plain text in the skill, agents follow conditionals reliably), but worth confirming in the spike.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** The example session shows `/update-docs` invoked three times in three minutes (`observed-pattern.md` turn 14). Most plausible explanation: the skill paused to ask a question and the human re-invoked. If skills are interactive by default, the orchestrator either needs to pre-answer their questions or run them in interactive mode at the gates.

**Current belief.** Likely interactive. The CC slash-command/skill model includes `AskUserQuestion`-style prompts.

**What would change the answer.** Inspect the `update-docs` and `onboarding` skill definitions in `~/.claude/skills/`. If they don't use `AskUserQuestion`, they should be drivable headless. If they do, list which questions they ask so the orchestrator can pre-answer.

## ~~Q3. Is the seven-snippet protocol stable across feature types?~~

**Answered (2026-05-26).** Deferred to post-Slice-1 with a concrete sampling plan when revisited.

**Why defer:** Slice 1 itself produces a new data point (the orchestrator's first managed run). Mining past sessions doesn't block any design decision Slice 1 needs, and we don't want to over-fit the slice to evidence we haven't seen.

**Sampling plan when ready:**
- Source: `~/.claude/projects/-Users-qiushi-dev-itell-apps-platform/*.jsonl`
- Filter: sessions that use 2+ workflow snippets from `examples/tabtype-snippets.json`
- Variety target: include at least one each of bugfix, feature, refactor, spike (if available)
- Output: a phase-presence matrix appended to `docs/observed-pattern.md`

**Slice 1 assumption:** the full SPEC-review protocol applies. If a smaller task type wouldn't naturally invoke SPEC, the user just doesn't call `duet new --spec` on it — no design accommodation needed.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** The example session is one feature: a permissions/role refactor with both backend and UI surface area. Different feature shapes might compress or skip phases:

- A typo / one-line bugfix probably doesn't need a spec or plan phase.
- A pure refactor probably skips the FRAME / SYNTHESIZE step (the problem is already understood).
- A spike / research task might never reach IMPLEMENT.

**Current belief.** The full protocol is the *upper bound*. Smaller tasks shed phases from the front. But we have one data point.

**What would change the answer.** Sample 3–5 more sessions of varying sizes from `~/.claude/projects/-Users-qiushi-dev-itell-apps-platform/`. Look for which snippets are used vs. skipped. Build a phase-presence matrix.

## ~~Q4. What does "convergence" look like in the reviewer's output?~~

**Answered (2026-05-26).** Stays post-MVP, gated on Q10. The MVP loop-exit rule is the fixed iteration cap (`docs/automation-design.md` §"Loop-exit rule") — no severity parsing. Revisit only if running Slice 1+ surfaces a specific pain that severity-driven exits would fix.

If the answer eventually turns out to be "yes, severity helps," the upgrade path is clean: add an optional `severity_summary` field to `schemas/agent-response.json` (e.g., `{critical: number, moderate: number, minor: number, nit: number}`). The schema's OpenAI-strict-compliance rules require it to be in `required` with a nullable union, but that's a small edit. No new infrastructure.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** The severity-threshold loop-exit rule (`docs/automation-design.md` §"Loop semantics") only works if reviewer responses reliably use `critical / moderate / minor / nit` labels and the orchestrator can parse them.

**Current belief.** The `review-implementation` snippet explicitly asks for severity ratings. The `review-spec` and `update-spec` snippets do not — they ask for "agree/disagree + structural alternative". So the parsing rule is per-phase.

**What would change the answer.** Read all reviewer responses in `examples/codex-session.jsonl` and confirm (a) impl reviews use the severity vocabulary consistently, (b) spec reviews use a different but parseable structure. If parsing is unreliable, fall back to "show the human the raw review + a count of paragraphs" and let them call it.

## ~~Q5. How does the user behave when the two agents disagree?~~

**Answered (2026-05-26).** Subsumed by mechanisms already in place; no Slice 1 work needed.

The `disagree` field in `schemas/agent-response.json` surfaces disagreements deterministically. The orchestrator halts at the disagreement gate when a `point` string persists across two consecutive rounds in the same phase (`docs/automation-design.md` §"Structured response schema"). The human resolves however they want — the orchestrator has no business predicting that.

The Q3 sampling will incidentally reveal divergence patterns (how often impl rejects reviewer points, what kinds), which informs future features (Q10 territory), not Slice 1.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** In the example session the two agents *converged* — implementer mostly accepted reviewer's critiques. A divergent session (implementer pushes back hard, reviewer doubles down) needs different handling: more human intervention, or a third-party tiebreaker, or just "ship anyway with disagreement noted".

**Current belief.** Untested. The `update-spec` / `update-plan` / `review-reflect` snippets explicitly invite pushback ("don't agree just to agree", "explain from first principles why the original is correct"). So divergence is *allowed*; we don't know how it's *resolved* in practice.

**What would change the answer.** Same as Q3 — sample more sessions and look for cases where the implementer rejected ≥1 reviewer point on first principles. See whether the human acted as tiebreaker or just deferred to one side.

## ~~Q6. Is the implementer / reviewer role binding ever swapped?~~

> **Generalized 2026-06-11:** the impl/reviewer swap this question established is now subsumed by full role–provider decoupling across all three roles, configured via the role-bindings file (`[roles.<role>] provider/model`) with per-run CLI overrides. The claude provider takes a per-role Anthropic model ID; the codex provider deliberately takes none (the user's `~/.codex/config.toml` governs). Default binding unchanged in spirit: orchestrator + implementer on claude/Opus, reviewer on codex. See `docs/automation-design.md` §"Roles are decoupled from providers"; the orchestrator role's claude-only v1 status is Q17.

**Answered (2026-05-26).** Configurable per task type, with `{impl: claude, reviewer: codex}` as the universal MVP default. The user's lived experience: "basically always Claude=impl, Codex=reviewer" today — but the cost of supporting the swap is one config field and zero branching code, so it's worth designing in.

**MVP shape:**
- CLI flags: `duet new <input> [--impl <claude|codex>] [--reviewer <claude|codex>]`
- Universal default: `{impl: claude, reviewer: codex}`. Matches the observed session and matches the verified token-cost profile (Codex at default reasoning effort is ~15x the per-turn token cost of Claude Haiku; assigning it to the rarer reviewer role is the cheaper allocation).
- Same-vendor configs (both Claude or both Codex) work mechanically — the schema + resume primitives are identical across roles — but are not actively documented per `docs/automation-design.md`'s "wire it for {claude-code, codex} first" non-goal.
- Other agents (AMP, etc.) are out of scope for MVP. The orchestrator state's `{implementer, reviewer}` struct is extensible when that day comes — `cli` is a per-agent field.

**Task-type-based defaults — deferred.** The user wants the orchestrator to eventually pick role binding per task type, but we don't yet have evidence about which task types want which binding. Q3 (protocol stability across feature types) is the natural place to gather that evidence — once 3–5 more sessions are sampled, we can see if any patterns emerge.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** The workflow-model claims the role binding is symmetric (`docs/workflow-model.md` §"Symmetry"). If in practice the user always uses CC as implementer and CX as reviewer, hardcoding that asymmetry simplifies the MVP. If they swap based on the task, the orchestrator needs first-class agent role config.

**Current belief.** User says they sometimes swap. Not exercised in this session. Worth keeping the design symmetric anyway because the cost is small.

**What would change the answer.** Ask the user; or scan their codex session directory for sessions where Codex received `tdd-implementation` snippets.

## ~~Q7. Does the human want the orchestrator to be a long-running daemon or a one-shot CLI?~~

> **Amended 2026-06-11:** still one-shot, still no daemon — but the process lifetime is now **per-phase, not per-gate**. An intelligent orchestrator holds its session open across the many routed turns inside a phase (an AFK implementation phase may run 1–3 hours); gates and queued `ask_human` flags remain process exits. See `docs/automation-design.md` §"Not a daemon — but alive through a phase".

**Answered (2026-05-26).** One-shot CLI. The orchestrator is a batch process: human-initiated via `duet new <issue-or-text>`, terminates after the human approves the Open PR gate. Within "one-shot," the process lifetime is **per-gate, not per-run** — each `duet new` / `duet continue` invocation drives the state machine to the next gate, persists state to disk, and exits. The human resumes by re-invoking. Nothing holds a terminal between gates, which is what makes the semi-AFK shape work. See `docs/automation-design.md` §"Invocation and lifecycle" for the CLI surface and non-goals.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** Affects UX, error handling, and resumability.

- **Daemon-style**: `duet start`; emits progress; pauses at gates; resumes on `duet approve <gate-id>`. Better for true semi-AFK use because the human can step away and return to a still-running process.
- **One-shot**: `duet run --until <gate>`; runs to the next gate, then exits. Re-invoke to continue. Simpler to build; loses no state because everything is in JSONL + a small state file.

**Current belief.** One-shot is simpler and probably sufficient. Most "AFK" tasks are bounded by the next gate anyway.

**What would change the answer.** Try a one-shot prototype first. If the user finds themselves re-invoking it in a tight loop, escalate to daemon.

## ~~Q8. What's the smallest "vertical slice" of the workflow worth implementing first?~~

> **Amended 2026-06-11:** the slice *choice* (SPEC review loop first) stands, but its scope is superseded — Slice 1 now validates the orchestrator agent's tool surface and gate interception, not dumb routing. Re-scoped as **Q14**.

**Answered (2026-05-26).** Slice 1 is the **SPEC review-loop spike**, scoped tightly.

**CLI:**
```
duet new --spec <draft-path> [--impl claude] [--reviewer codex] [--rounds N]
duet continue <run_id> [--approve | --reject "..." | --answer "..."]
duet status <run_id>
```

**Workflow:**
1. Read draft spec from `<draft-path>` (user wrote it by hand or with CC interactively — *not* automated in this slice).
2. Create `run_id`, write state to `.duet/runs/<run_id>.json`.
3. Spawn reviewer (Codex) with the `review-spec` snippet wrapping the spec + the schema at `schemas/agent-response.json`.
4. Read structured output; if `needs_human` is non-null, exit at the exception gate.
5. Spawn implementer (Claude) with the `update-spec` snippet wrapping the reviewer's `response_text` + the schema.
6. Track new `disagree` entries; if a `point` string recurs from the prior round, exit at the disagreement gate.
7. If `iteration < cap` and no exception, loop to step 3 with the implementer's revised spec.
8. On cap hit, exit at the "Commit spec" phase boundary; print the resume command.
9. `duet continue <run_id> --approve` writes the final spec back to `<draft-path>` (overwriting the draft) and marks the run complete. No git operation in this slice.

**Validation surface:** per-gate process model, JSON Schema enforcement on both CLIs, cross-CLI routing, loop cap, state file persistence, `needs_human` halt, `disagree` persistence detection.

**Deferred for later slices:** ONBOARD skill, FRAME parallel dispatch, initial spec drafting from a framing turn, `/compact`, PLAN loop, IMPLEMENT (the risky tool-use-vs-schema slice), IMPL review loop, UPDATE_DOCS skill with internal gate, PR opening.

**Effort estimate:** ~3–5 days of focused work — mostly subprocess management, state I/O, CLI parsing, schema bundling, and snippet loading from `examples/tabtype-snippets.json`. The agent interactions are already proven (Q1/Q9).

**Future slices** (sketched, not committed; refine as Slice 1 ships):
- Slice 2 — PLAN loop. Same routing mechanics, different snippets.
- Slice 3 — IMPLEMENT phase. Tests tool-use under schema constraint. Highest-risk single slice.
- Slice 4 — IMPL review loop. Reuses Slice 1/2 code.
- Slice 5 — ONBOARD, FRAME, `/compact`. End-to-end except PR.
- Slice 6 — UPDATE_DOCS, PR opening. End-to-end.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** Building the full state machine in one go is over-committing on an unvalidated design.

**Current belief.** The most leveraged slice is **automated routing for one review loop** — pick the SPEC loop, since it ran 2 iterations in the example. Concretely: human writes the spec by hand (or via CC), then `duet review-spec --rounds 2` runs the cross-review until either rounds exhaust or human approves.

If that single phase feels right, layer on PLAN, then IMPL, then the surrounding phases.

**What would change the answer.** Realizing during the spike that the JSONL-ingest or CLI-resume primitives don't behave as expected. In which case Q1 / Q2 dominate this question.

## ~~Q9. Will agents reliably honor structural markers (`<NEEDS-HUMAN>`, `<DISAGREE>`)?~~

**Answered (2026-05-26).** Replaced by a stronger mechanism: **CLI-level JSON Schema enforcement**, not free-text tag grepping. Verified empirically against both CLIs.

**The upgrade.** Both `claude --json-schema '<schema>'` and `codex exec --output-schema <FILE>` validate the agent's final response against a JSON Schema at the CLI boundary — invalid output fails the invocation before reaching the orchestrator. Instead of asking agents to emit `<NEEDS-HUMAN>` / `<DISAGREE>` text tags, the schema requires `needs_human` and `disagree` fields directly. The canonical schema is in `schemas/agent-response.json`.

**Empirical verification (2026-05-26).**
- Claude Haiku (`claude -p --json-schema "$(cat schema.json)" --output-format json "..."`): valid structured output; `response_text` prose quality matches non-schema output. Cost ~$0.05/turn at Haiku, mostly cache-creation; subsequent turns much cheaper.
- Codex gpt-5.5 (`codex exec --output-schema schema.json "..."`): valid structured output after the schema was made OpenAI-strict-compliant (every property in `required`, optionals via `anyOf null`). Token usage ~12k for one turn at high reasoning effort — meaningful cost factor for budgeting.

**The strict-compliance gotcha.** OpenAI rejects schemas where `properties` keys are absent from `required`. The schema in `schemas/agent-response.json` is written to OpenAI's stricter rules; Anthropic accepts it as a superset. Future schema edits must keep strict compliance to remain dual-target.

**How each CLI surfaces the output.**
- Claude invokes an internal `StructuredOutput` tool with the schema fields; the prose is also emitted as a normal assistant text message. The CLI's `--output-format json` envelope exposes `structured_output` as a top-level field. Both forms in the JSONL — human-readable transcripts stay debuggable.
- Codex writes the structured JSON as the final response on stdout (and to `--output-last-message <FILE>`).

**Composition with `examples/skills/update-docs/SKILL.orchestrator.md`.** The resume marker (`ORCHESTRATOR_RESUME_FROM_PROPOSAL`) tells the skill *where to start within its workflow*. The schema tells the orchestrator *whether the turn ended in a gate*. They compose cleanly; both stay.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** The MVP detects in-phase exceptions via tags emitted by the agents, not by interpreting their prose (`docs/automation-design.md` §"Structural markers"). If agents paraphrase the tags, omit them when they should appear, or emit them when they shouldn't, the orchestrator either misses signals (silently shipping disagreement) or halts spuriously (defeating AFK).

**Current belief.** Tags should be more reliable than asking for `critical / moderate / minor / nit` severity labels because they're binary (present / absent), not semantic. Modern coding agents follow concrete, exemplified structural-output instructions reasonably well. But this is an assumption, not yet evidence.

**What would change the answer.** A 1-hour spike. Add the marker instructions to `update-spec` and `review-reflect`. Run them on contrived prompts that should trigger each tag (a "you need a product decision" scenario, a "the reviewer is wrong about X" scenario) plus controls that shouldn't. Aim for 5–10 trials per agent (CC + Codex). Measure false-negative and false-positive rates. If FN > 10% on either agent, fall back to one of: (a) sharper instructions ("emit the tag as the literal first line; nothing before it"), (b) human review at every loop round (less AFK), (c) accept the FN risk and surface raw transcripts to the human at each phase boundary.

## ~~Q10. Where does the dumb router actually fall short in practice, and which gaps justify an LLM judgment call?~~

> **Reversed 2026-06-11.** The question assumed the dumb router ships first and LLM judgment gets added per documented pain point. The pivot answered it the other way and earlier than planned: the planlab corpus scan (22 sessions — see `docs/observed-pattern.md` §"Corpus scan: planlab") supplied the evidence three runs of Slice 1 were meant to gather. The router-vs-judgment gaps it predicted (pre-gate digests, stuck detection, conflict framing) are all subsumed by the orchestrator role. The **notes-file convention survives** — `.duet/runs/<run_id>.notes.md`, now written by both the human and the orchestrator's `write_note` tool. Rationale and costs of the reversal: `docs/automation-design.md` §"Design history".

**Answered (2026-05-26).** Answered by running Slice 1, not by speculation. To make the eventual answer extractable, adopt this convention starting with the first Slice 1 run:

**Notes file per run.** A `.duet/runs/<run_id>.notes.md` file the user writes to during/after each run, capturing friction observations:
- Where did the orchestrator route something the user would have flagged?
- Where did `response_text` content under-deliver (sparse summary, missing detail)?
- Did `needs_human` false-trigger or fail to trigger when it should have?
- Did `disagree` persistence detection feel right, too aggressive, or too lax?

After ~3 real Slice 1 runs, review notes; each recurring pain point becomes a candidate for a narrow LLM call (function, not agent). Speculating about candidates now is wasted motion.

The original analysis is preserved below as the record of what we considered.

---

**Why it matters.** The MVP intentionally defers an LLM-as-judge orchestrator. The right time to add narrow LLM calls is when running the dumb router reveals a specific pain — sparse implementer summaries, ambiguous reviewer reactions, disagreements the tag mechanism didn't catch, stalled loops. Speculating before running the MVP risks building intelligence where it isn't needed.

**Current belief.** Plausible candidates after MVP runs:
- **Pre-gate digest.** At phase boundaries, a short LLM-generated "here's what changed, here are open points" beats dumping raw transcripts.
- **Stuck detection.** Long time-in-phase + no new commits → "implementer might be stuck."
- **Conflict framing.** When `<DISAGREE>` blocks accumulate, an LLM-generated "here's what they actually disagree about" beats dumping both transcripts.

But these are guesses. The discipline is: run MVP first, watch where the human reaches for help the router didn't provide, then add one narrow LLM call per documented pain point — function, not agent.

**What would change the answer.** Three real MVP runs on `itell/apps/platform` features of varying shape. For each run, note: where did the human want more than the router provided? Where did the router route something that should have been flagged? Each pain point becomes a candidate; only ones that recur across runs justify a permanent LLM call.

## Q11. What substrate runs the orchestrator?

> **Scope note (2026-06-11):** with role–provider decoupling, this question is about the **claude provider's** implementation of the orchestrator role — the default and only orchestrator-capable provider in v1. The codex provider's path to the same contract is Q17.

**Why it matters.** The orchestrator is now an LLM agent that must be read-only (by tool surface), hold a session across a multi-hour phase, pause-and-resume at `ask_human` flags with the process exiting in between, and leave an inspectable transcript per the augmentation principle.

**Current belief.** The **Claude Agent SDK** fits all four requirements (verified against official docs 2026-06-11): tool allowlisting gives read-only by construction (`tools: []` hides all built-ins; custom tools via `tool()` + `createSdkMcpServer()`, auto-approved with `allowedTools: ["mcp__orchestrator__*"]`); sessions persist to JSONL on disk in the standard `~/.claude/projects/` location, so the orchestrator's session stays manually resumable with `claude --resume` (the augmentation argument); and the `canUseTool` callback lets the harness intercept `ask_human`, persist state, exit cleanly, and resume the session later — on resume the pending tool call is re-prompted and answered then (note: the TS SDK has no literal "defer" decision; the pattern is intercept → persist → deny/exit → resume → answer, and its exact round-trip semantics are the first thing the spike verifies). The alternative substrates — `claude -p` with MCP-exposed tools, a hand-rolled API loop, or harness frameworks like pi (`references/pi-mono/`) — either complicate the pause-and-resume mechanics or forfeit the free transcript, and none escapes the subscription credit metering below. SDK source vendored for API study at `references/claude-agent-sdk-typescript/` (proprietary — dependency, not copy source; see `references/README.md`).

**Economics (verified 2026-06-11 against the official support article).** From **2026-06-15**, Agent SDK *and* `claude -p` usage on subscription plans draws from a separate monthly credit pool — Pro $20 / Max 5x $100 / Max 20x $200 — consumed at standard API rates, no rollover, no automatic overflow. Interactive sessions are unaffected. Every duet run (orchestrator + claude worker) is metered this way regardless of framework choice; raw-API alternatives would forfeit the included credit entirely. Consequences: `maxBudgetUsd` per invocation from day one, `total_cost_usd` tracked per run as a gate-time soft signal, and "what does one full run cost" is an explicit spike measurement.

**Operational facts to verify at spike time:**
- Agent SDK / `claude -p` usage moves to a separate subscription credit pool on **2026-06-15** — confirm the cost model before committing.
- The `defer` → exit → resume → answer round-trip mechanics, end to end.
- Phone-reachable gates exist as a later layer (Claude Code Remote Control + PushNotification, v2.1.110+); the MVP queue-and-`duet continue --answer` path needs none of it.

**What would change the answer.** The credit change making SDK-based orchestration uneconomical for multi-hour phases, or `defer`/resume proving unreliable in the spike.

## Q12. Where does duet's snippet library live, and how do edits flow back to tabtype?

**Why it matters.** The orchestrator needs `list_snippets()` to see the library and `propose_snippet_edit` to evolve it — so the library must be machine-readable files duet owns, while the human's manual workflow keeps using the tabtype config. Two copies of the same protocol now exist. This also covers the `ceo-summary` snippet, which is documented in `docs/workflow-model.md` ahead of existing in tabtype at all.

**Current belief.** Duet keeps its own snippet files (likely one file per snippet or a single TOML mirroring tabtype's schema), seeded from the tabtype config. Approved `propose_snippet_edit` diffs apply to duet's copy; porting them back to tabtype stays a manual human step (the user is editor-in-chief of their daily-driver prompts). No automatic sync — augmentation, not lock-in.

**What would change the answer.** The copies drifting enough in practice to cause confusion — which would argue for tabtype's config becoming the single source duet reads directly.

## Q13. Will the triage rules over-flag or under-flag?

**Why it matters.** The orchestrator's value during AFK depends on flag precision: under-flagging silently absorbs product decisions the human owns (the worst failure); over-flagging turns AFK into a pager. The rules (product/direction → always flag; environment → always flag; tactical → bounce to worker with process-not-substance) are instructions, not mechanisms.

**Current belief.** Modern models follow concrete triage instructions with examples well, and the failure mode is asymmetric by design — when in doubt the instructions say flag, because a spurious flag costs minutes while an absorbed product decision costs trust. Expect over-flagging first; tighten wording from observed false positives.

**What would change the answer.** Slice 1+ runs. Every flag and every bounce gets reviewed afterward via the notes file: should this have been flagged? Should that have been? Recurring misses become instruction edits or, if instructions can't fix it, a harness-level rule.

## Q14. What is the new Slice 1?

**Why it matters.** The old Slice 1 (Q8) validated dumb routing: subprocess management, schema enforcement, string-match exception detection. The pivot's risky surface is different: the orchestrator's tool loop, per-turn prompt adaptation quality, gate interception, and `defer`-based pause/resume.

**Current belief.** Same entry point, new substance: **the orchestrator-driven SPEC review loop.** `duet new --spec <draft-path>` starts an orchestrator session whose tools are wired for two workers; it runs `review-spec` / `update-spec` rounds with judgment-based loop exit, flags via `ask_human` when warranted, and lands on the Commit-spec gate. Validates, in one slice: the harness statechart with one phase + one gate, all six orchestrator tools, per-turn adaptation logging, judgment loop-exit against the backstop cap, and the queued-flag round-trip. Deliberately excluded: PLANNING's front half (onboard/frame/synthesize), IMPLEMENTATION, FINAL REVIEW, notifications, snippet-edit proposals (the tool can exist and queue; the end-of-run gate UI can be `duet status` output).

**What would change the answer.** The spike revealing the orchestrator substrate (Q11) is the actual risk — in which case shrink further to a single-tool spike: orchestrator + `send_prompt` + one worker, no loop.

## Q15. XState or a hand-rolled transition table for the harness statechart?

> **Decided 2026-06-11: XState** (v5, added as a dependency at project init — the user's call at implementation kickoff). The caveats below remain the implementation guardrails: persist snapshots **only at gate states** (in-flight invoked actors restart blind on restore — the JSONL transcripts are the real resume state), keep the human-readable `.duet/runs/<run_id>.json` hint file alongside the machine snapshot, and treat `@statelyai/agent` as read-only inspiration (dormant, and architecturally inverse to this design).

**Why it matters.** The skeleton's one hard guarantee — gates transition only on human events; agent events at a gate are no-ops — must be structural, not conventional.

**Current belief.** The *semantics* are settled (XState v5's model is the reference: phases as states invoking a long-running actor, gates as actor-less states, persistence only at quiescent gate states). The *library* is genuinely optional for ~3 phases and ~7 gates: a ~100-line transition table (`{state, event} → {nextState, guard?}`, unhandled events logged as no-ops) gives the same guarantee with a human-readable JSON state file, which fits the state-file-is-a-hint principle better than XState's logic-version-coupled snapshots. Verified caveats if XState is chosen anyway: in-flight invoked actors restart blind on snapshot restore (the real resume state is the JSONL transcripts regardless), and `@statelyai/agent` is dormant and architecturally inverse to this design (LLM picks machine events; we want the machine constraining the LLM) — inspiration only. Decide at implementation time; leaning hand-rolled.

**What would change the answer.** Phases gaining genuinely concurrent regions, loop nesting deepening past two levels, or wanting the Stately visualizer as living documentation.

## Q16. Does the worker structured-output schema survive, and in what form?

**Why it matters.** `schemas/agent-response.json` was the dumb router's protocol contract — `needs_human` and `disagree` were how judgment-free code detected exceptions. The orchestrator reads prose, so the schema is no longer load-bearing. But a minimal envelope might still make routing mechanically cleaner than scraping final messages.

**Current belief.** Demote, don't delete. Try Slice 1 both ways: workers schema-free (orchestrator reads the raw final message) vs. a minimal `{response_text}` envelope. Drop `needs_human`/`disagree` from the worker schema either way — exception detection is the orchestrator's job now. Schema edits, if any survive, must preserve OpenAI-strict compliance.

> **Resolved 2026-06-11:** the upstream `codex exec resume` + `--output-schema` concern (openai/codex#14343) is fixed — closed as duplicate of #22998, fixed by PR #23123 (merged 2026-05-18), and **live-verified on the locally installed codex-cli 0.133.0** with a two-turn schema-enforced resume smoke test (context preserved, schema enforced on the resumed turn, same `thread_id` re-emitted). Schema-on-resume is available if Q16 decides to keep an envelope; it no longer constrains the decision. Codex SDK source + docs: `references/codex/`.

**What would change the answer.** Slice 1 showing the orchestrator reliably extracts what it needs from prose (drop the schema), or showing routing breaks on chatty final messages (keep the envelope).

## Q17. How does the codex provider serve the orchestrator role?

**Why it matters.** Role–provider decoupling (2026-06-11) makes orchestrator-on-codex a legal configuration, but the orchestrator's capability contract — custom harness tools, read-only enforcement, pause/resume at a tool call — is only implemented by the claude provider in v1. This question records the designed path so the decoupling isn't an empty promise.

**Current belief.** The bridge is a **local MCP server**: the harness exposes `send_prompt` / `ask_human` / `advance_phase` / `propose_snippet_edit` / `write_note` as MCP tools, and the codex orchestrator session is launched with that server in its MCP config (`-c`-injected per invocation, not written into the user's `~/.codex/config.toml`) plus `-s read-only`. Two things are unverified and gate the feature:

1. **Pause/resume at a tool call.** The claude provider pauses via `canUseTool` interception and re-prompts the pending call on resume. Codex has no equivalent callback — the MCP tool handler would have to block, return a sentinel, or fail the turn, and what `codex exec resume` does with a turn that ended mid-tool-call is unknown. This is the hard part.
2. **Tool-call faithfulness under codex's MCP client** — schema adherence, parallel-call behavior, retry semantics.

**What would change the answer.** Actually wanting the configuration (the user today runs orchestrator-on-claude). Until then this is deliberately unbuilt — the provider interface allows it; nobody pays for it. If/when wanted: a half-day spike mirroring Q11's, against the same harness tools.

## Suggested order of attack

Q1–Q10 resolved 2026-05-26 (Q7/Q8/Q10 carry 2026-06-11 amendment/reversal notes). The pivot's questions:

1. **Q11 (orchestrator substrate)** — a half-day spike: Agent SDK, read-only tool surface, one `send_prompt`, one `ask_human` with `defer` → exit → resume. Everything else depends on this.
2. **Q14 (new Slice 1)** — the orchestrator-driven SPEC loop, once Q11's spike passes.
3. **Q15 (statechart implementation)** — decided while building Slice 1's harness.
4. **Q16 (worker schema)** — tested empirically inside Slice 1.
5. **Q12 (snippet library home)** — settled when wiring `list_snippets()`; the convention can start simple (one TOML seeded from tabtype).
6. **Q13 (triage precision)** — answered by running Slice 1+ and reviewing flags via the notes file, same discipline Q10 originally prescribed.
7. **Q17 (codex-as-orchestrator)** — deferred until the configuration is actually wanted; the role-bindings design keeps the door open at zero cost.

When Slice 1 starts producing notes, further questions (Q18+) land here.
