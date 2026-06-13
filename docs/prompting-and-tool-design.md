# Prompting and tool design

Reference for designing duet's agent prompts and tool surfaces, distilled 2026-06-11 from Anthropic's published guidance and first applied in the substrate spike (`src/spike/q11.ts`). Consult this when writing or revising any orchestrator/worker prompt, tool definition, or tool result — the surfaces it governs live in `src/harness/orchestrator-prompts.ts` (prompts) and `src/harness/tools.ts` (tool descriptions, results, errors).

Sources (re-check when models change — guidance is versioned to model generations):

- [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (platform docs)
- [Writing effective tools for agents — using agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (engineering blog)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (engineering blog)
- [Building effective agents](https://www.anthropic.com/research/building-effective-agents) (research blog)

## Part 1 — Prompt design

### Structure: artifacts first, task last, XML-tagged

Put longform content (documents, templates, worker output) at the **top** of the prompt and the instructions/query in a block at the **end** — Anthropic measured up to 30% better response quality on long multi-document inputs. Wrap each content type in its own XML tag so data is unambiguous from instruction:

```xml
<documents>
  <document name="snippet-template: review-spec">…</document>
  <document name="draft-spec" source="path/to/spec.md">…</document>
</documents>

<task>
1. Send the reviewer …
</task>
```

Tag names are free-form — pick descriptive ones and use them consistently; nest when content is hierarchical. A recommended section order for system prompts: role/context first, then task, then instructions and output format.

### Thinking framework over prohibition

Tell the model what to **do**, not what to avoid, and supply the **motivation** — the model generalizes from the explanation. A constraint stated as a bare prohibition invites creative violation; the same constraint stated as a framework with a reason becomes part of how the model reasons.

The canonical duet example is the orchestrator's `<division_of_labor>` block. Instead of "never answer a technical question yourself":

> Three parties answer three kinds of questions … You answer neither kind. Your judgments are about process: who speaks next, whether a loop has converged, what to flag. If you notice yourself forming an opinion about an artifact's content, treat that as a signal to route or flag — an orchestrator opinion would influence the work invisibly, bypassing the human's gates.

Observed effect in the spike: with the prohibition phrasing, the orchestrator complied; with the framework phrasing, it *applied* the rule in novel territory — its final report routed two design-level disagreements "to you, not the workers," unprompted.

Related rules:

- **Dial back aggressive emphasis.** "CRITICAL: you MUST…", all-caps, "exactly once" — current models overtrigger on these. Write normal imperatives.
- **Be clear and specific; ask for "above and beyond" explicitly** if wanted — the model won't infer it.
- **Golden rule:** show the prompt to a colleague with minimal context; if they'd be confused, the model will be too.
- **Prefer general instructions over prescriptive step lists** for reasoning ("think thoroughly about whether the loop has converged" beats a hand-written decision tree). Use numbered steps only when order/completeness genuinely matters.

### Snippet adaptation: collapse generality, preserve discipline

The orchestrator's snippet templates are two layers, and its adaptation instruction (the `<protocol>` block in `src/harness/orchestrator-prompts.ts`) is built on the split:

- **Discipline** — the altitude lens, the ordering, the guardrails. Hard-won, durable across runs. Specialize, never subtract; a genuinely misfitting guardrail is `propose_snippet_edit` territory, not a per-turn drop.
- **Generality** — either/or hedges ("the feature added or bug fixed"), generic examples, open formats. Deliberate: one template covers many runs, while a turn faces exactly one. Adaptation = collapsing the generality onto the actual task — the real bug named, the project's modules swapped in, inapplicable branches dropped, gate decisions folded in.

The motivation attached (framework-with-why, per the rule above): a worker reading a concretized template starts at the task; a verbatim-generic one spends part of a slow turn deriving the template-to-task mapping itself. The boundary attached: concretize the task, never the solution — adaptation is the channel through which an orchestrator opinion could reach an artifact invisibly, so the division-of-labor rule extends explicitly to prompt composition.

The behavior predates its design: the first real run collapsed write-spec's ~2k-char generic template into a 4.3k-char run-specific prompt — actual workstreams, file/line anchors, run-specific non-goals, gate-approved decisions folded in — with every guardrail intact (planlab run `20260611-1542-aeca`, implementer voice log) **(observed)**. The framework's job is making that designed rather than borrowed from one model's judgment.

Authoring corollary for `snippets.toml`: hedged generality in a template is load-bearing, not vagueness to fix — write what varies between runs as the hedge, hard-code only the discipline, and let the orchestrator collapse the rest.

The send boundary carries the "self-check before finishing" rule at the moment it matters: send_prompt is framed as a commit (the body persists in the worker's session; there is no unsend), and the orchestrator is told to read its composed body once against the template's discipline and the run's specifics before calling. No preview tool exists by design — the harness sends the body verbatim, so a preview would echo what the orchestrator just composed; its own context is the draft surface, and the post-send corrective is the delta mechanics, not a re-send.

### Examples

Few-shot examples are the most reliable way to steer format, tone, and structure. Make them relevant (mirror the real use case), diverse (cover edge cases, vary enough to avoid unintended pattern-matching), and wrapped in `<example>`/`<examples>` tags. 3–5 examples is the sweet spot. Curate canonical examples rather than enumerating exhaustive edge-case rules — "examples are the pictures worth a thousand words."

(Not yet used in duet's prompts; the natural first application is example-laden triage rules if Q13 reveals flag-precision problems that instructions alone can't fix.)

### Roles and altitude

A role sentence in the system prompt focuses behavior — even one line helps. For agent system prompts, aim for the "Goldilocks zone": specific enough to guide behavior, flexible enough to be heuristics rather than brittle hardcoded logic. Strive for the **minimal set of information that fully outlines expected behavior** — minimal does not mean short; it means nothing redundant, nothing missing.

### Agentic / long-horizon specifics

- **State the context-management contract.** If the harness compacts or resumes, say so ("your context will be compacted; don't stop early for budget reasons") — otherwise the model wraps up prematurely near its limit.
- **Structured state in structured formats** (JSON for test status, run state), freeform notes for progress prose, git for checkpoints. The model reads filesystem state on a fresh window very well — being prescriptive about *what to read first* beats compaction in some cases.
- **Action defaults are steerable in both directions** — `<default_to_action>` vs. `<do_not_act_before_instructions>` style blocks. Duet's orchestrator wants the conservative variant (route, don't act).
- **Self-check before finishing** ("verify your answer against X") reliably catches errors.

## Part 2 — Tool design

The through-line: **everything the agent sees through a tool — name, description, parameter docs, results, errors — is prompt surface.** Engineer it like prompt text, because it is.

### Few thoughtful tools, not API wrappers

More tools don't lead to better outcomes; ambiguous overlap between tools actively hurts. Build a few tools targeting whole workflows, consolidating multiple operations behind one call (`schedule_event` instead of `list_users` + `list_events` + `create_event`). Duet's seven-tool orchestrator surface follows this — `send_prompt` hides spawn/resume/stream/persist behind one verb.

### Descriptions are prompts: surface the implicit

Write the description as if onboarding a new teammate, and make implicit context explicit — query formats, niche terminology, resource relationships, lifecycle facts the agent cannot discover on its own. Unambiguous parameter names (`user_id`, not `user`); enforce with strict schemas.

Duet examples of load-bearing implicit facts moved into descriptions:

- `send_prompt`: each role is **one persistent session** — a later call continues that worker's conversation, so don't re-send context the worker has seen; worker turns take **minutes**, so prefer one composed prompt over several small ones.
- `ask_human`: the description carries the triage rule itself (product/direction/environment → human; technical → worker; "the human is the editor-in-chief, not a third engineer").

### Return meaningful context

Prefer semantic, human-legible fields over low-level identifiers (`name`/`file_type`, not `uuid`/`mime_type`) — semantic content informs the agent's next action; opaque IDs don't. Be token-efficient: pagination, filtering, truncation with sensible defaults; encourage efficient agent strategies outright ("make several targeted searches rather than one broad one"). No universal response format — pick XML/JSON/Markdown per task and evaluate.

**Progressive disclosure (the house instance):** `list_snippets` returns the **current phase's** templates and the always-available helpers in full, and indexes the other phases by key in arc order — the snippets actually reached for now, not the whole 35-entry library as noise. `all: true` is the escape hatch for a cross-phase template. This is the [context-engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) "load on demand, keep lightweight identifiers for the rest" pattern, applied to a tool result (not the system prompt — so the cache prefix stays frozen). The cost it answers is *focus*, not tokens: the orchestrator is a few % of run spend, but a phase-scoped menu is a sharper menu. The phase→snippet mapping lives in the phase table (`src/phases.ts`), per "a `Record<PhaseName,…>` belongs in the table."

### Errors prescribe the recovery path

An error result is a steering opportunity, not a stack trace. Name the failure layer, say what it implies, and prescribe the next action — so the agent doesn't improvise recovery. Duet's `send_prompt` failure message is the house pattern:

> The {role} worker's turn failed at the infrastructure layer ({detail}). The worker never saw your prompt, so this is not a content problem. Retry this same send_prompt call once; if the retry also fails, stop routing and report the failure to the human via ask_human instead of continuing the round.

Validation errors should communicate the specific fix ("expected `role` to be implementer|reviewer"), never opaque codes or tracebacks.

### Results nudge the next step

When a tool result changes what the agent should do next, the result text says so explicitly, with the reason — a "mini-context" that steers the agent down the intended path at exactly the moment it matters. Duet's `ask_human` queued-response is the house pattern:

> The human is away, so your question has been queued and the run is pausing. End your turn with a one-line status — anything you do past this point happens without the answer you just asked for. The run resumes with the human's answer.

This is what makes the cooperative pause reliable without any mechanical enforcement. Backstop-cap hits and `advance_phase` acknowledgements get the same treatment.

A house variant for soft constraints: **warn-once-then-allow**. When the agent attempts something usually-but-not-always wrong (duet's case: re-sending a full snippet template to a worker that already holds it), the first attempt returns a steering error naming the why and the alternatives; repeating the identical call passes. Judgment keeps the override; the harness makes the override deliberate and leaves both calls in the transcript. Prefer this over hard blocks whenever the rule has legitimate exceptions — a hard block is the dumb-router trap of approximating judgment with mechanism.

A second variant: **reactive state-triggered nudges**. A nudge fires when the conversation crosses a state threshold — not periodically, not statically — mirroring how Claude Code's `<system-reminder>`s are reactive on state. duet's instance: a `send_prompt` result whose review round leaves exactly one before the backstop cap appends a one-time reminder that the cap is runaway protection, not a target (converge, or flag a persistent disagreement — don't spend the last round idly). It rides the existing tool-result surface (like steer delivery) and keeps the system prompt untouched. The discipline: fire once at the threshold, not every turn after it; say the *reason* the threshold matters, not just the number.

### Concurrency is opt-in for MCP tools (CLI quirk)

The claude CLI's tool scheduler batches and parallelizes only tools it considers concurrency-safe, and for MCP tools that test is `annotations.readOnlyHint ?? false` — a custom tool without the annotation executes strictly serially even when the model emits parallel `tool_use` blocks in one message. Verified against CLI 2.1.175 (undocumented internals — re-verify on CLI upgrades), and observed live before the fix: the frame phase's two `think-holistic` sends, emitted in one orchestrator turn, ran one whole minutes-long worker turn after the other (planlab run `20260612-1254-a575`).

Duet's `send_prompt` therefore carries `readOnlyHint: true` as a deliberate **concurrency hint, not a purity claim** — the tool plainly has side effects, but in this closed surface the annotation's only consumer is the scheduler (`allowedTools` already pre-approves every tool, so no permission UX reads it). The general rule: when a tool's calls should overlap, the annotation is the knob; when overlap is genuinely unsafe, enforce that in the handler (duet: the same-role in-flight rail — one session is one conversation) rather than relying on the scheduler's serial default.

### Namespacing and evaluation

Prefix-group related tools for clear boundaries (`asana_projects_search`-style); the prefix-vs-suffix choice measurably affects tool-use behavior, so don't bikeshed it without an eval. More broadly: tool design is iterative and evaluation-driven — prototype, run realistic scenarios, analyze failures, refine. Duet's analogue of an eval is the spike/Slice-1 runs plus the notes file (Q13's flag-precision review is exactly this loop).

## Binding conventions for duet

The five rules every duet prompt and tool must follow (the condensed form lives in `docs/automation-design.md` §"Prompting and tool-surface conventions"):

1. Artifacts first, task last, XML-tagged.
2. Thinking framework with motivation over bare prohibition; no aggressive emphasis.
3. Tool descriptions surface the implicit, load-bearing facts.
4. Errors name the failure layer and prescribe the recovery path.
5. Results that change the agent's next step say so explicitly, with the reason.
