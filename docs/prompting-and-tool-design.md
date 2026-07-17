# Prompting and tool design

greenflag's **house layer** for prompt and tool work: the binding conventions, the house patterns, and the observed evidence behind them. The general rulebook is deliberately not duplicated here — it lives in the author's `/prompt-engineering` skill and, publicly, in the Anthropic guidance below, which this doc assumes and only extends. Consult this file when writing or revising any orchestrator/worker prompt, tool definition, or tool result — the governed surfaces live in `src/orchestrator/briefs.ts` (the system prompt and phase briefs), `src/orchestrator/tools.ts` (tool descriptions, results, errors), the block-named `snippets/` files, and the shipped `skills/`.

Two maintenance rules keep the layer split honest:

- **General lessons graduate up.** A greenflag lesson that stops being greenflag-specific moves into the rulebook in general form (one-world rendering, error truthfulness, and durable-prompt-vs-result placement all did); this doc keeps the greenflag instance and the evidence.
- **The binding-conventions list at the end intentionally duplicates the rulebook's core rules.** A checklist restatement of the highest-stakes rules improves instruction-following; it is this doc's one sanctioned overlap, and everything else defers.

Sources (re-check when models change — guidance is versioned to model generations):

- [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (platform docs)
- [Writing effective tools for agents — using agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (engineering blog)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (engineering blog)
- [Building effective agents](https://www.anthropic.com/research/building-effective-agents) (research blog)

## Part 1 — Prompt design

### Structure: the house layout

Longform content rides at the top in a `<documents>` wrapper, one named `<document>` per content type, with the instruction in a `<task>` block at the end:

```xml
<documents>
  <document name="snippet-template: review-spec">…</document>
  <document name="draft-spec" source="path/to/spec.md">…</document>
</documents>

<task>
1. Send the analyst …
</task>
```

For a long prompt, carry the section hierarchy in **Markdown headers (`##`/`###`) and bullet lists** — they read more naturally than deep tag nesting — and reserve XML tags for where separating data from instructions is the point: `<documents>` and the individual `<example>` cases. The orchestrator system prompt and the interactive identity are built this way.

### Thinking framework over prohibition — the house case

The canonical greenflag example is the orchestrator's `<division_of_labor>` block. Instead of "never answer a technical question yourself":

> Three parties answer three kinds of questions … You answer neither kind. Your judgments are about process: who speaks next, whether a loop has converged, what to flag. If you notice yourself forming an opinion about an artifact's content, treat that as a signal to route or flag — an orchestrator opinion would influence the work invisibly, bypassing the human's gates.

Observed effect in the spike: with the prohibition phrasing, the orchestrator complied; with the framework phrasing, it *applied* the rule in novel territory — its final report routed two design-level disagreements "to you, not the workers," unprompted.

### Snippet adaptation: collapse generality, preserve discipline

The orchestrator's snippet templates are two layers, and its adaptation instruction (the `<protocol>` block in `src/orchestrator/briefs.ts`) is built on the split:

- **Discipline** — the altitude lens, the ordering, the guardrails. Hard-won, durable across runs. Specialize, never subtract; a genuinely misfitting guardrail is `propose_snippet_edit` territory, not a per-turn drop.
- **Generality** — either/or hedges ("the feature added or bug fixed"), generic examples, open formats. Deliberate: one template covers many runs, while a turn faces exactly one. Adaptation = collapsing the generality onto the actual task — the real bug named, the project's modules swapped in, inapplicable branches dropped, gate decisions folded in.

The motivation attached (framework-with-why): a worker reading a concretized template starts at the task; a verbatim-generic one spends part of a slow turn deriving the template-to-task mapping itself. The boundary attached: concretize the task, never the solution — adaptation is the channel through which an orchestrator opinion could reach an artifact invisibly, so the division-of-labor rule extends explicitly to prompt composition.

A second boundary, the mirror of the first: **relay the framing's references, never resolve or substitute them.** The orchestrator's tool surface has no read or search, so a project-knowledge reference the framing names — an onboarding path, a doc-update skill — is relayed to the worker that *can* resolve it, never replaced by the orchestrator's own discovery, and an explicit framing instruction outranks any generic fallback. Where the first boundary guards against the orchestrator *adding* an opinion, this one guards against it *dropping* the human's instruction. **(observed:** a run whose framing named a `pl-loopy-infra-handoff` doc skill shipped docs via the generic survey path — the orchestrator reasoned "no named skill → survey" and the named skill reached no worker; fixed by having `reconcile-docs` choose its method by precedence (framing-named → project skill → by-hand) and the finish brief relay the framing's named method as authoritative.**)**

The behavior predates its design: the first real run collapsed write-spec's ~2k-char generic template into a 4.3k-char run-specific prompt — actual workstreams, file/line anchors, run-specific non-goals, gate-approved decisions folded in — with every guardrail intact (planlab run `20260611-1542-aeca`, implementer voice log) **(observed)**. The framework's job is making that designed rather than borrowed from one model's judgment.

Authoring corollary for the snippet library (the `snippets/` files): hedged generality in a template is load-bearing, not vagueness to fix — write what varies between runs as the hedge, hard-code only the discipline, and let the orchestrator collapse the rest.

### One world per rendered prompt

The general form is now a rulebook rule (branch in the composer, never in the prose); greenflag is where it was learned, and the house depth is the knob/hedge distinction. Workflow knobs (the composition vocabulary, `docs/automation-design.md` §"The workflow vocabulary") must never leak into what a model reads. **Every rendered prompt describes exactly one world**: the model sees only the instructions that apply to this run's actual configuration, and could not tell from its prompt that other blocks, postures, or workflows exist. Two binding principles:

1. **Never encode knob-conditionals in prose.** No rendered brief or snippet says "if the review posture is fixer, …; otherwise …". Conditional prose makes the model parse configuration state, hedges the instruction, and spends attention on branches that don't apply — it is a patch, not an instruction. The compiled semantics decide; the prose asserts.
2. **Branch in the composer, not the prompt.** All conditioning happens at render time: the statechart knows the phase, the compiled workflow carries the semantics, and the renderer selects a dedicated fragment for the branch. Where knob values diverge in what the worker should *do*, each value gets its own hand-written fragment or snippet — `review-and-fix` is a dedicated snippet, not `review-direct` plus a conditional paragraph — and prose is shared only when genuinely identical across values. Prefer forking a fragment over parameterizing it into hedged generality; the closed vocabulary keeps the fork count bounded.

The distinction from the adaptation hedges just above: a hedge covers what varies **between runs of the same configuration** (the orchestrator collapses it per turn); a knob covers what varies **between configurations** (the renderer forks it per value). The test-side enforcement is the parity harness's fixture rule — one pinned fixture per conditional branch (`docs/engineering.md` §"Patterns that carry the design").

The send boundary carries the rulebook's "self-check before finishing" at the moment it matters: `send_prompt` is framed as a commit (the body persists in the worker's session; there is no unsend), and the orchestrator is told to read its composed body once against the template's discipline and the run's specifics before calling. No preview tool exists by design — the harness sends the body verbatim, so a preview would echo what the orchestrator just composed; its own context is the draft surface, and the post-send corrective is the delta mechanics, not a re-send.

### Examples: the two-tier house application

Applied in `src/orchestrator/briefs.ts` as **two tiers, each labeled by the judgment it teaches** — not a flat list, because the point is to teach the model to *judge and adapt*, and it has to see what each example is for:

- **Cross-cutting reasoning** lives in the system prompt's *Judgment calls* section, co-located with the rules it illustrates (*Division of labor*, *Protocol*) and grouped under a `### <kind>` heading per judgment, the `<example>` cases kept in tags: triage (who answers — flag vs bounce), review-loop convergence (another round vs converged vs flag the tie), snippet adaptation (concretize the task, never the solution), and the first worker prompt (orient before you assign). These are the calls made in every phase.
- **Phase-level judgment** lives in each phase's entry prompt under a `## <phase> phase examples` markdown heading led by a line naming that phase's call (markdown reads more naturally inline than a nested `<examples>` wrapper; the individual cases keep their `<example name=…>` / `type="avoid"` tags): frame synthesis (synthesize, don't capitulate), the spec→plan altitude shift (deferred detail vs a real gap; the plan owes what the spec could defer), and the impl size/risk call (single pass vs one midpoint, with the chunking anti-pattern).

Each group carries an anti-example, and the mechanical phases (docs, pr, open) carry none — an example there would only restate the steps. The bar: an example earns its tokens only if the orchestrator could *not* derive its lesson from the adjacent rule, and each is framed by the signal to apply (not the surface to match). The cross-cutting examples sit in the system prompt rather than on the `ask_human`/`send_prompt` surfaces so the teaching is grouped and discoverable; the moment-precise nudges those surfaces already carry (e.g. the one-round-from-cap reminder) stay as the complement that fires at the exact moment. Triage flag-precision remains an open evidence loop (open-questions.md §"Triage precision"). Reasoning models need few examples, so each group is two or three short cases.

### Write for the cold reader

The rulebook's cold-reader test (anchor identity, then the familiar-term test) is greenflag's most repeatedly-earned rule, in both directions:

**Under-supply — the missing identity anchor.** Every surface greenflag ships is read standalone; the shipped skills bite hardest, since a Claude Code session loads one with nothing else around it. **(observed:** the `greenflag-frame` skill's first draft opened "a greenflag framing is…" and never said greenflag is a CLI that orchestrates a pair of worker agents from a framing — obvious to the author mid-build, opaque to the cold reader; fixed with a one-line "what greenflag is" anchor.**)**

**Over-supply — familiar-term leak.** The developer-facing convention alone did not catch it, because you apply that convention by *recognizing* a term as jargon, and your own jargon never feels like jargon. `cross-family voice` and `rir arc` shipped anyway — nobody had run the term-by-term test on the comfortable words. Hence binding convention 7 below: the test is deliberate and per-term, not a recognition rule.

**The orchestrator is itself a runtime prompt-author**, so this rule governs its output, not just greenflag's shipped surfaces — every `send_prompt` body is a prompt it composes for a worker that reads it cold. Its standing instructions carry the rule explicitly (the *A worker's first prompt* section in both the system prompt and the interactive identity, the `send_prompt` `body` description, and the `frame`/`research` onboard steps): a worker's first prompt of a phase **orients before it assigns** — one line on what the project is, the onboarding that grounds it, then the change and the goal — and only then the worker's job and the task, carrying none of greenflag's own vocabulary (workflow, duty, gate, and checkpoint names; "how a voice fits the architecture" framing) that orients the orchestrator but is noise to the worker. The workflow's *shape* in plain words can help a worker ("we settle a direction, then you build it"); its internal *names* cannot. **(observed:** run `20260623-0416-dac8` opened the consultant's first prompt with "you are this run's independent cross-family voice at the framing stage of a greenflag run on the **rir** arc" and the workers' with "an analysis pass for a greenflag run on the **rir** arc … **Don't change any code**" — developer-facing framing and a bare leading prohibition, propagated verbatim from the snippet templates and echoed from the phase briefs into sessions that had none of that context. Fixed at three layers: the first-contact templates (`think-holistic`, `consultant-frame`/`-spec`/`-impl`) reshaped to orient before assigning with the read-only constraint stated as the worker's job rather than a shout, the briefs de-jargoned ("RIR arc", "build-analysts" → plain words), and the rule added to the orchestrator's own authoring instructions and tool surface.**)**

### Presenting to the human: decidable from the text alone

The human decides at gates and queued questions from the orchestrator's text alone — the worker logs and artifacts are structurally out of their loop (the interactive chat is their whole view of the run; during AFK the queued question reaches a phone, hours later) — so presentation quality is round-trip economics: a stop whose question needs a follow-up question spends the pause without buying the decision. The standing rule (the *Presenting to the human* section in both the system prompt and the interactive identity, compact-echoed on `ask_human` and `advance_phase.summary`): every surfaced decision carries **why it matters** in product terms, **what it asks** in plain words, **the options each with its consequence**, and **an attributed recommendation** — with the substance sourced from the workers, never invented. A worker's bare question is bounced back for options + trade-offs + its recommendation before it is flagged (the worker reads the code the orchestrator can't; its turn costs minutes where a malformed stop costs hours), and the orchestrator never fills a missing option itself — an invented option presented with the orchestrator's authority is an artifact opinion in disguise, the division-of-labor rule at the presentation surface. Triage decides *whether* a question reaches the human; this rule governs *what they read when it does*.

**(observed:** the two shaping cases, one lesson from each direction. Run `20260630-1515-ec57`'s Direction-gate packet surfaced "defer D2" with its consequence compressed to "re-drives your interactive work headless" — the human had to reply "explain what you mean … before you approve it", a round-trip before the gate could cross. Run `20260707-0647-0dbb`'s PR-base question is the wanted shape working: the blocker, options (a)/(b)/(c) each with its trade-off, an attributed recommendation — answered in one reply and graded `right` at `greenflag grade`.**)**

### Long-horizon: the greenflag defaults

Of the rulebook's long-horizon rules, two have fixed greenflag answers: the orchestrator takes the **conservative action posture** (route, don't act — never the act-then-report end of the dial), and the **context-management contract is stated** to every persistent worker (compaction is metered and instructed; the committed plan/spec on disk, not the session, is the re-anchor — §"Worker compaction" in `docs/automation-design.md`).

## Part 2 — Tool design

The through-line: **everything the agent sees through a tool — name, description, parameter docs, results, errors — is prompt surface.** Engineer it like prompt text, because it is.

### Few thoughtful tools

Greenflag's orchestrator surface follows the few-tools rule — `send_prompt` hides spawn/resume/stream/persist behind one verb, and `get_task` is the single way in to a phase (the brief, plus any staged human input folded once), so the interactive host re-anchors through one call rather than several.

### Descriptions surface the implicit

House examples of load-bearing implicit facts moved into descriptions:

- `send_prompt`: each duty is **one persistent session** — a later call continues that worker's conversation, so don't re-send context the worker has seen; worker turns take **minutes**, so prefer one composed prompt over several small ones.
- `ask_human`: the description carries the triage rule itself (product/direction/environment → human; technical → worker; "the human is the editor-in-chief, not a third engineer").

### Return meaningful context

**Progressive disclosure, the house instance.** `list_snippets` shows the current phase's templates and the anytime helpers in full and indexes the rest by key — in the spec phase, say, the spec templates come back whole while later phases read as `plan: start-plan, …`; `all: true` fetches any body on demand. It is "load on demand, keep identifiers for the rest" applied to a tool *result*, so the system-prompt cache prefix stays frozen. The cost it buys down is focus, not tokens — the orchestrator is a few % of run spend; a phase-scoped menu is just a sharper one.

### Errors prescribe the recovery path

Greenflag's `send_prompt` failure message is the house pattern:

> The {duty} worker's turn failed at the infrastructure layer ({detail}). The worker never saw your prompt, so this is not a content problem. Retry this same send_prompt call once; if the retry also fails, stop routing and report the failure to the human via ask_human instead of continuing the round.

The corollary the house pattern needs: the `{detail}` slot must itself be concise. A `claude -p` failure dumps its whole stdout stream — the init payload, every message event, their ids — around a one-line reason; left raw, that detail buries the signal and burns the orchestrator's context. So the claude provider extracts the CLI's own failure reason (or, with no parseable envelope, exit code + stderr), never the raw stream, and `check_turns` projects any residual dump to its high-value fields (a `raw` arg returns the full text).

**No false certainty about what the worker did** (the rulebook's error-truthfulness rule, learned here). The house pattern's "the worker never saw your prompt, retry" is the right message only when it is *true* — and the original catch-all said it after every failure, including a 117-min turn that committed work and got killed at its cap (the `7447` lie). So the failure result splits on whether *this turn's* prompt was accepted into the session (a transcript record at/after the turn start, never a minted id or a whole-transcript scan): an accepted-then-aborted turn renders a resumable checkpoint ("the worker saw your prompt and committed work may be on disk — resume that session, do NOT re-send, a re-send would duplicate the conversation"), and only a genuinely never-accepted (pre-flight) failure keeps the "retry verbatim" envelope. A failed `/compact` is the one accepted-abort that prescribes *neither* resume nor retry — its session is reset, so the result points at `recover-context` (a fresh-session re-anchor). The discriminator is the action the message licenses (resume / retry / re-anchor); getting it wrong corrupts the worker's session, which is why the proof is the prompt's acceptance and never the error wording.

Validation errors communicate the specific fix ("expected `duty` to be one of this phase's live duties"), never opaque codes or tracebacks.

### Results nudge the next step

Greenflag's `ask_human` queued-response is the house mini-context:

> The human is away, so your question has been queued and the run is pausing. End your turn with a one-line status — anything you do past this point happens without the answer you just asked for. The run resumes with the human's answer.

This is what makes the cooperative pause reliable without any mechanical enforcement. Backstop-cap hits and `advance_phase` acknowledgements get the same treatment. The interactive host leans on it harder still: once a phase is parked, `get_task` reports the park and the post-terminal rail refuses further worker turns — each a prescribed says-what-happens-next result ("present the packet, propose `greenflag continue`"), so a long-lived session never silently no-ops past a gate.

**Warn-once-then-allow, and its complement.** Greenflag's soft-constraint case is re-sending a full snippet template to a worker that already holds it: the first attempt returns a steering error naming the why and the alternatives; repeating the identical call passes — judgment keeps the override, the harness makes it deliberate, and both calls stay in the transcript. Prefer this over hard blocks whenever the rule has legitimate exceptions — a hard block is the dumb-router trap of approximating judgment with mechanism. The complement holds too: when a rule has *no* legitimate exception, the hard block is the honest form — the context-pressure rail refuses a non-compact send to a worker past 85% of its window outright (warn-once governs only its sub-85% caution band), because no override can conjure headroom the session doesn't have; the refusal still prescribes the one legal move (a `/compact` body passes).

**Reactive state-triggered nudges.** greenflag's instance: a `send_prompt` result one review round short of the cap appends a one-time reminder that the cap is protection, not a target. Discipline: fire once at the threshold, on the existing result surface (system prompt untouched), and give the *reason* the threshold matters, not just the count.

**Invariant procedure lives in the durable prompt** (the rulebook's placement rule, learned here). A repeated result is friction only when it is *automatic* (the caller didn't opt into it) **and** *invariant* (the same text every call) — that pair is the discriminator, and it spares the deliberate repeats: `get_task`'s full brief (caller-chosen re-anchoring — the repetition is the feature) and the per-turn `[context · cost · round]` footer (automatic but varying). When a result fails the test, **relocate** the procedure to the system prompt — never dedupe it inside the result with a first-call-vs-rest register, because the orchestrator compacts, and teaching carried only in a tool result is discarded with the turn that carried it. **(observed:** a live interactive run had every `send_prompt` return the full fire-and-collect coaching tail — keep the session live, fire the other duty in parallel, arm `greenflag status --wait` before idling — which duplicated the orchestrator identity's §"Fire-and-collect" verbatim; trimmed to a terse `Dispatched to the <duty> — running in the background; collect it with check_turns when it settles`, the contract left to the compaction-proof system prompt, the idle-risk `status --wait` reminder kept on `check_turns`' conditional "still running" branch where it actually fires.**)**

### Concurrency is opt-in for MCP tools (CLI quirk)

The claude CLI's tool scheduler batches and parallelizes only tools it considers concurrency-safe, and for MCP tools that test is `annotations.readOnlyHint ?? false` — a custom tool without the annotation executes strictly serially even when the model emits parallel `tool_use` blocks in one message. Verified against CLI 2.1.175 (undocumented internals — re-verify on CLI upgrades), and observed live before the fix: the frame phase's two `think-holistic` sends, emitted in one orchestrator turn, ran one whole minutes-long worker turn after the other (planlab run `20260612-1254-a575`).

Greenflag's `send_prompt` therefore carries `readOnlyHint: true` as a deliberate **concurrency hint, not a purity claim** — the tool plainly has side effects, but in this closed surface the annotation's only consumer is the scheduler (`allowedTools` already pre-approves every tool, so no permission UX reads it). The frame analyses don't lean on it any more, though: they fan out through a single `send_prompt` whose `duty` is an array, and the handler runs the turns concurrently itself (headless `Promise.all`; interactive, two background dispatches). So `readOnlyHint` now serves the residual cases — independent single-duty turns issued in parallel, or a read like `list_snippets` batched alongside a send. The general rule holds: when a tool's calls should overlap, the annotation is the knob; when overlap is genuinely unsafe, enforce it in the handler (greenflag's same-duty in-flight rail — one session is one conversation) rather than relying on the scheduler's serial default.

### Evaluation

Tool design is eval-driven; greenflag's analogue of an eval is the spike/live runs plus each run's notes file (the triage-precision review is exactly this loop, `open-questions.md`).

## Binding conventions for greenflag

The rules every greenflag prompt and tool must follow. **This list intentionally duplicates the rulebook's core rules** — the checklist form of the highest-stakes principles, deliberately repeated. This is the one home: `docs/automation-design.md` points here rather than carrying a copy.

1. Artifacts first, task last, XML-tagged.
2. Thinking framework with motivation over bare prohibition; no aggressive emphasis.
3. Tool descriptions surface the implicit, load-bearing facts.
4. Errors name the failure layer and prescribe the recovery path — and may only prescribe what they can prove.
5. Results that change the agent's next step say so explicitly, with the reason.
6. One world per rendered prompt — no knob-conditionals in prose; branch in the composer, dedicated fragments per knob value.
7. Model-facing text carries none of greenflag's internal vocabulary — run the familiar-term test on every workflow, duty, gate, and checkpoint name before it ships; the process's *shape* in plain words helps a worker, its internal *names* do not.
