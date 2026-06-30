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

For a long prompt, carry the section hierarchy in **Markdown headers (`##`/`###`) and bullet lists** — they read more naturally than deep tag nesting, and well-structured, scannable instructions land more reliably — and reserve XML tags for where separating data from instructions is the point: wrapping `<documents>` and individual `<example>` cases. The orchestrator system prompt and the interactive identity are built this way (Markdown sections throughout; `<example>` tags only for the few-shot cases).

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

A second boundary, the mirror of the first: **relay the framing's references, never resolve or substitute them.** The orchestrator's tool surface has no read or search, so a project-knowledge reference the framing names — an onboarding path, a doc-update skill — is relayed to the worker that *can* resolve it, never replaced by the orchestrator's own discovery, and an explicit framing instruction outranks any generic fallback. Where the first boundary guards against the orchestrator *adding* an opinion, this one guards against it *dropping* the human's instruction. **(observed:** a run whose framing named a `pl-loopy-infra-handoff` doc skill shipped docs via the generic survey path — the orchestrator reasoned "no named skill → survey" and the named skill reached no worker; fixed by having `reconcile-docs` choose its method by precedence (framing-named → project skill → by-hand) and the finish brief relay the framing's named method as authoritative.**)**

The behavior predates its design: the first real run collapsed write-spec's ~2k-char generic template into a 4.3k-char run-specific prompt — actual workstreams, file/line anchors, run-specific non-goals, gate-approved decisions folded in — with every guardrail intact (planlab run `20260611-1542-aeca`, implementer voice log) **(observed)**. The framework's job is making that designed rather than borrowed from one model's judgment.

Authoring corollary for `snippets.toml`: hedged generality in a template is load-bearing, not vagueness to fix — write what varies between runs as the hedge, hard-code only the discipline, and let the orchestrator collapse the rest.

The send boundary carries the "self-check before finishing" rule at the moment it matters: send_prompt is framed as a commit (the body persists in the worker's session; there is no unsend), and the orchestrator is told to read its composed body once against the template's discipline and the run's specifics before calling. No preview tool exists by design — the harness sends the body verbatim, so a preview would echo what the orchestrator just composed; its own context is the draft surface, and the post-send corrective is the delta mechanics, not a re-send.

### Examples

Few-shot examples are the most reliable way to steer format, tone, and the judgment rules alone struggle to pin down. Make them relevant (mirror the real use case), diverse (cover edge cases, vary enough to avoid unintended pattern-matching), and clearly delimited — `<example>` tags for the individual cases, with a markdown heading or grouping tag to label what a set teaches (the source guidance treats markdown and XML as equally good delimiters; clarity matters more than the characters). 3–5 examples is the sweet spot. Curate canonical examples rather than enumerating exhaustive edge-case rules — "examples are the pictures worth a thousand words."

Applied in `src/harness/orchestrator-prompts.ts` as **two tiers, each labeled by the judgment it teaches** — not a flat list, because the point is to teach the model to *judge and adapt*, and it has to see what each example is for:

- **Cross-cutting reasoning** lives in the system prompt's *Judgment calls* section, co-located with the rules it illustrates (*Division of labor*, *Protocol*) and grouped under a `### <kind>` heading per judgment, the `<example>` cases kept in tags: triage (who answers — flag vs bounce), review-loop convergence (another round vs converged vs flag the tie), snippet adaptation (concretize the task, never the solution), and the first worker prompt (orient before you assign). These are the calls made in every phase.
- **Phase-level judgment** lives in each phase's entry prompt under a `## <phase> phase examples` markdown heading led by a line naming that phase's call (markdown reads more naturally inline than a nested `<examples>` wrapper; the individual cases keep their `<example name=…>` / `type="avoid"` tags): frame synthesis (synthesize, don't capitulate), the spec→plan altitude shift (deferred detail vs a real gap; the plan owes what the spec could defer), and the impl size/risk call (single pass vs one midpoint, with the chunking anti-pattern).

Each group carries an anti-example, and the mechanical phases (docs, pr, open) carry none — an example there would only restate the steps. The bar: an example earns its tokens only if the orchestrator could *not* derive its lesson from the adjacent rule, and each is framed by the signal to apply (not the surface to match). The cross-cutting examples sit in the system prompt rather than on the `ask_human`/`send_prompt` surfaces so the teaching is grouped and discoverable; the moment-precise nudges those surfaces already carry (e.g. the one-round-from-cap reminder) stay as the complement that fires at the exact moment. Triage flag-precision remains an open evidence loop (open-questions.md §"Triage precision"). Reasoning models need few examples, so each group is two or three short cases.

### Roles and altitude

A role sentence in the system prompt focuses behavior — even one line helps. For agent system prompts, aim for the "Goldilocks zone": specific enough to guide behavior, flexible enough to be heuristics rather than brittle hardcoded logic. Strive for the **minimal set of information that fully outlines expected behavior** — minimal does not mean short; it means nothing redundant, nothing missing.

### Write for the cold reader

Every surface duet ships — the orchestrator and worker prompts, tool descriptions, and the `skills/` skills — is read *standalone*, by a session that holds none of your context: not this codebase, not the conversation you wrote it in, not the duet mental model you carry while authoring. That context is yours, not the surface's, and the gap is invisible precisely when your own context is fullest — which is exactly when you're authoring one. So anchor the basics before the specifics — what the thing is and the system it belongs to — then read it cold: if a fresh session saw *only* this, would it know what it is and what to do? The shipped skills bite hardest, since a Claude Code session loads one with nothing else around it. **(observed:** the `duet-frame` skill's first draft opened "a duet framing is…" and never said duet is a CLI that orchestrates an implementer and a reviewer from a framing — obvious to the author mid-build, opaque to the cold reader; fixed with a one-line "what duet is" anchor.**)** This is the standalone-surface form of the golden rule (§"Thinking framework over prohibition"): here the colleague has *zero* shared context, not merely minimal — so the failure is under-supplying the thing's identity, the mirror image of over-supplying mechanism.

Over-supply has a second form, subtler than mechanism and the one that actually bit us: **familiar-term leak.** An internal name or product concept that is load-bearing in your head reads as precise and necessary, so the developer-facing convention above — which you apply by *recognizing* a term as jargon — slides right past it; recognition can't catch your own blind spot. Make it a deliberate **self-calibration check** instead, run on every domain term, internal name, or mental-model label before it ships: *does this help the model do the task in front of it, or understand the problem it's solving — or am I keeping it only because I know what it means?* Familiarity is not value; when a term fails, replace it with the plain thing it stands for. The orchestrator's own prompts are why the test earns its place and the rule alone didn't: the developer-facing convention was already written, and `cross-family voice` / `rir arc` shipped anyway — because nobody had run the term-by-term test on the comfortable words.

**The orchestrator is itself a runtime prompt-author**, so this rule governs its output, not just duet's shipped surfaces — every `send_prompt` body is a prompt it composes for a worker that reads it cold. Its standing instructions carry the rule explicitly (the *A worker's first prompt* section in both the system prompt and the interactive identity, the `send_prompt` `body` description, and the `frame`/`research` onboard steps): a worker's first prompt of a phase **orients before it assigns** — one line on what the project is, the onboarding that grounds it, then the change and the goal — and only then the role and the task, carrying none of duet's own vocabulary (arc, gate, and checkpoint names; "how a role fits the architecture" framing) that orients the orchestrator but is noise to the worker. The workflow's *shape* in plain words can help a worker ("we settle a direction, then you build it"); its internal *names* cannot. **(observed:** run `20260623-0416-dac8` opened the consultant's first prompt with "you are this run's independent cross-family voice at the framing stage of a duet run on the **rir** arc" and the workers' with "an analysis pass for a duet run on the **rir** arc … **Don't change any code**" — developer-facing framing and a bare leading prohibition (the defects conventions 1–2 name), propagated verbatim from the snippet templates and echoed from the phase briefs into sessions that had none of that context. Fixed at three layers: the first-contact templates (`think-holistic`, `consultant-frame`/`-spec`/`-impl`) reshaped to orient before assigning with the read-only constraint stated as the role's job rather than a shout, the briefs de-jargoned ("RIR arc", "build-analysts" → plain words), and the rule added to the orchestrator's own authoring instructions and tool surface.**)**

### Agentic / long-horizon specifics

- **State the context-management contract.** If the harness compacts or resumes, say so ("your context will be compacted; don't stop early for budget reasons") — otherwise the model wraps up prematurely near its limit.
- **Structured state in structured formats** (JSON for test status, run state), freeform notes for progress prose, git for checkpoints. The model reads filesystem state on a fresh window very well — being prescriptive about *what to read first* beats compaction in some cases.
- **Action defaults are steerable in both directions** — `<default_to_action>` vs. `<do_not_act_before_instructions>` style blocks. Duet's orchestrator wants the conservative variant (route, don't act).
- **Self-check before finishing** ("verify your answer against X") reliably catches errors.

## Part 2 — Tool design

The through-line: **everything the agent sees through a tool — name, description, parameter docs, results, errors — is prompt surface.** Engineer it like prompt text, because it is.

### Few thoughtful tools, not API wrappers

More tools don't lead to better outcomes; ambiguous overlap between tools actively hurts. Build a few tools targeting whole workflows, consolidating multiple operations behind one call (`schedule_event` instead of `list_users` + `list_events` + `create_event`). Duet's eight-tool orchestrator surface follows this — `send_prompt` hides spawn/resume/stream/persist behind one verb, and `get_task` is the single way in to a phase (the brief, plus any staged human input folded once), so the interactive host re-anchors through one call rather than several.

### Descriptions are prompts: surface the implicit

Write the description as if onboarding a new teammate, and make implicit context explicit — query formats, niche terminology, resource relationships, lifecycle facts the agent cannot discover on its own. Unambiguous parameter names (`user_id`, not `user`); enforce with strict schemas.

Duet examples of load-bearing implicit facts moved into descriptions:

- `send_prompt`: each role is **one persistent session** — a later call continues that worker's conversation, so don't re-send context the worker has seen; worker turns take **minutes**, so prefer one composed prompt over several small ones.
- `ask_human`: the description carries the triage rule itself (product/direction/environment → human; technical → worker; "the human is the editor-in-chief, not a third engineer").

### Return meaningful context

Prefer semantic, human-legible fields over low-level identifiers (`name`/`file_type`, not `uuid`/`mime_type`) — semantic content informs the agent's next action; opaque IDs don't. Be token-efficient: pagination, filtering, truncation with sensible defaults; encourage efficient agent strategies outright ("make several targeted searches rather than one broad one"). No universal response format — pick XML/JSON/Markdown per task and evaluate.

**Progressive disclosure (the house instance).** `list_snippets` shows the current phase's templates and the anytime helpers in full and indexes the rest by key — in the spec phase, say, the spec templates come back whole while later phases read as `plan: start-plan, …`; `all: true` fetches any body on demand. It is "load on demand, keep identifiers for the rest" ([context-engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)) applied to a tool *result*, so the system-prompt cache prefix stays frozen. The cost it buys down is focus, not tokens — the orchestrator is a few % of run spend; a phase-scoped menu is just a sharper one.

### Errors prescribe the recovery path

An error result is a steering opportunity, not a stack trace. Name the failure layer, say what it implies, and prescribe the next action — so the agent doesn't improvise recovery. Duet's `send_prompt` failure message is the house pattern:

> The {role} worker's turn failed at the infrastructure layer ({detail}). The worker never saw your prompt, so this is not a content problem. Retry this same send_prompt call once; if the retry also fails, stop routing and report the failure to the human via ask_human instead of continuing the round.

The corollary the house pattern needs: the `{detail}` slot must itself be concise. A `claude -p` failure dumps its whole stdout stream — the init payload, every message event, their ids — around a one-line reason; left raw, that detail buries the signal and burns the orchestrator's context. So the claude provider extracts the CLI's own failure reason (or, with no parseable envelope, exit code + stderr), never the raw stream, and `check_turns` projects any residual dump to its high-value fields (a `raw` arg returns the full text). An error that prescribes recovery in a 30KB blob has defeated its own purpose.

Validation errors should communicate the specific fix ("expected `role` to be implementer|reviewer"), never opaque codes or tracebacks.

### Results nudge the next step

When a tool result changes what the agent should do next, the result text says so explicitly, with the reason — a "mini-context" that steers the agent down the intended path at exactly the moment it matters. Duet's `ask_human` queued-response is the house pattern:

> The human is away, so your question has been queued and the run is pausing. End your turn with a one-line status — anything you do past this point happens without the answer you just asked for. The run resumes with the human's answer.

This is what makes the cooperative pause reliable without any mechanical enforcement. Backstop-cap hits and `advance_phase` acknowledgements get the same treatment. The interactive host leans on it harder still: once a phase is parked, `get_task` reports the park and the post-terminal rail refuses further worker turns — each a prescribed says-what-happens-next result ("present the packet, propose `duet continue`"), so a long-lived session never silently no-ops past a gate.

A house variant for soft constraints: **warn-once-then-allow**. When the agent attempts something usually-but-not-always wrong (duet's case: re-sending a full snippet template to a worker that already holds it), the first attempt returns a steering error naming the why and the alternatives; repeating the identical call passes. Judgment keeps the override; the harness makes the override deliberate and leaves both calls in the transcript. Prefer this over hard blocks whenever the rule has legitimate exceptions — a hard block is the dumb-router trap of approximating judgment with mechanism.

A second variant — **reactive state-triggered nudges** — fires on a state threshold, not periodically (Claude Code's `<system-reminder>`s work this way). duet's instance: a `send_prompt` result one review round short of the cap appends a one-time reminder that the cap is protection, not a target. Discipline: fire once at the threshold, on the existing result surface (system prompt untouched), and give the *reason* the threshold matters, not just the count.

The complement that bounds both variants: **a result carries per-call state and the next action; invariant procedure belongs in the durable prompt, not the result.** A repeated result is friction only when it is *automatic* (the caller didn't opt into it) **and** *invariant* (the same text every call) — that pair is the discriminator, and it spares the deliberate repeats: `get_task`'s full brief (caller-chosen re-anchoring — the repetition is the feature) and the per-turn `[context · cost · round]` footer (automatic but varying). When a result fails the test, the fix is to **relocate** the procedure to the system prompt, never to dedupe the procedure inside the result with a first-call-vs-rest register — because the orchestrator compacts, and teaching carried only in a tool result is discarded with the turn that carried it, leaving every later terse message referencing a procedure the model no longer holds. The durable prompt is the only compaction-proof home for an always-true contract; a register would be the right tool only for *conditional* guidance the prompt can't pre-state, which is already what the two variants above cover. **(observed:** a live interactive run had every `send_prompt` return the full fire-and-collect coaching tail — keep the session live, fire the other role in parallel, arm `duet status --wait` before idling — which duplicated the orchestrator identity's §"Fire-and-collect" verbatim; trimmed to a terse `Dispatched to the <role> — running in the background; collect it with check_turns when it settles`, the contract left to the compaction-proof system prompt, the idle-risk `status --wait` reminder kept on `check_turns`' conditional "still running" branch where it actually fires.**)**

### Concurrency is opt-in for MCP tools (CLI quirk)

The claude CLI's tool scheduler batches and parallelizes only tools it considers concurrency-safe, and for MCP tools that test is `annotations.readOnlyHint ?? false` — a custom tool without the annotation executes strictly serially even when the model emits parallel `tool_use` blocks in one message. Verified against CLI 2.1.175 (undocumented internals — re-verify on CLI upgrades), and observed live before the fix: the frame phase's two `think-holistic` sends, emitted in one orchestrator turn, ran one whole minutes-long worker turn after the other (planlab run `20260612-1254-a575`).

Duet's `send_prompt` therefore carries `readOnlyHint: true` as a deliberate **concurrency hint, not a purity claim** — the tool plainly has side effects, but in this closed surface the annotation's only consumer is the scheduler (`allowedTools` already pre-approves every tool, so no permission UX reads it). The frame analyses don't lean on it any more, though: they fan out through a single `send_prompt` whose `role` is an array, and the handler runs the turns concurrently itself (headless `Promise.all`; interactive, two background dispatches). So `readOnlyHint` now serves the residual cases — independent single-role turns issued in parallel, or a read like `list_snippets` batched alongside a send. The general rule holds: when a tool's calls should overlap, the annotation is the knob; when overlap is genuinely unsafe, enforce it in the handler (duet's same-role in-flight rail — one session is one conversation) rather than relying on the scheduler's serial default.

### Namespacing and evaluation

Prefix-group related tools for clear boundaries (`asana_projects_search`-style); the prefix-vs-suffix choice measurably affects tool-use behavior, so don't bikeshed it without an eval. More broadly: tool design is iterative and evaluation-driven — prototype, run realistic scenarios, analyze failures, refine. Duet's analogue of an eval is the spike/Slice-1 runs plus the notes file (the triage-precision review is exactly this loop).

## Binding conventions for duet

The binding rules every duet prompt and tool must follow (the condensed form lives in `docs/automation-design.md` §"Prompting and tool-surface conventions"):

1. Artifacts first, task last, XML-tagged.
2. Thinking framework with motivation over bare prohibition; no aggressive emphasis.
3. Tool descriptions surface the implicit, load-bearing facts.
4. Errors name the failure layer and prescribe the recovery path.
5. Results that change the agent's next step say so explicitly, with the reason.
