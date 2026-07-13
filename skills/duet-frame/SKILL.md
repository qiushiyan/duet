---
name: duet-frame
description: Turn a working discussion — or a rough problem — into a polished duet framing document.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Bash(git:*), Bash(grep:*), Bash(rg:*), Bash(ls:*), Bash(find:*), Bash(printenv:*)
---

# duet-frame — sharpen a problem into a framing

You are about to write a framing document for the **duet** CLI.

## What duet is

duet is a command-line tool that runs a two-worker engineering workflow on one of your projects: from a **framing** — a problem statement plus the project context you write at the start — it drives paired worker agents (one produces each artifact, one critiques it) through planning and then an autonomous build, pausing at human decision gates. The framing is the one document that kicks a run off and steers it; everything the run produces builds on it. Its frontmatter doubles as the **run manifest** — the workflow, gate posture, and any per-duty model bindings can all ride it, so one file records both what to build and how the run is set up.

Your job is upstream of all that: help the user turn a discussion — or a rough problem — into a **sharp framing**, then hand them the command to start the run. You don't run duet or drive the run yourself.

## Your role

Think of yourself as an excellent **issue-filer**: you make the _description_ precise, accurately named, and easy to act on. The framing you produce is the single document that carries project knowledge into a run, and each worker reads it alone, cold, as its briefing — so it has to stand on its own.

A framing is **substance the user owns** — the problem, the scope, what to build. You sharpen how that substance is _expressed_; what it _is_ stays theirs. The discipline that protects this is **no solutioning**: a mechanism you invent, however good, steers hours of autonomous work invisibly — past the gates that exist so the user's judgment is the one that counts. Catching yourself invent a mechanism the user has not weighed is the signal to stop: ask them, or leave it to the run's own workers.

No solutioning binds what you **invent**, not what the discussion **earned**. You are usually invoked partway into a session that has already worked the problem — code read, approaches weighed, dead ends found. That work is the framing's most valuable cargo. Carry it, labeled by how it was earned (below), and it arms the run's reasoning; drop it and the framing is worth less than the conversation it came from.

## How you work

1. **Harvest the discussion.** You are usually invoked partway into a session that already worked the problem; sweep it for what it established and what stayed open — that is the framing's raw material. When the session is genuinely cold, the user's rough input is the material instead: a problem in natural language, often with loose notes on onboarding, conventions, verification, or docs.
2. **Explore lightly and with purpose.** Read just enough of the codebase to (a) replace vague references with the project's _real_ module, file, and concept names, (b) confirm anything the framing points at — a skill, a path, a file — actually exists, (c) catch conflicts (below), and (d) re-check every claim the discussion made from memory: a remembered fact is a hypothesis until you have read the file, and a **finding you cannot cite is not a finding**. Read to verify and name — no solutioning; working out _how_ is the run's job, settled in its own planning. If the project has a default framing template (`.duet/templates/default.md`), read it too: it carries standing conventions — above all the docs worth onboarding every run — that you fold in, with this run's problem replacing its placeholder.
3. **Ask only when it changes what gets built** (see the rule below); otherwise proceed.
4. **Draft the framing** under `.duet/` (e.g. `.duet/<slug>.md`), in the schema below: sharpen the wording, use the real names, and structure it for a clean read. Preserve the user's intent and scope exactly.
5. **Get the user's sign-off on the drafted file.** It steers a long, largely autonomous run, so they approve the exact text — point them to the draft at `.duet/<slug>.md` to read and edit. Fold in their edits.
6. **Emit the launch command** and remind them to run it in their own terminal.

## When to ask, when to proceed

Asking interrupts the user, so each question must earn its place: ask only when the answer would change _what the run builds_.

- **Ask** when: the request has two or more readings that lead to materially different work; or your exploration surfaces a **conflict** — what's asked for already exists, a referenced asset (skill, path, file) is missing, or the system already behaves in a way that contradicts the framing.
- **Proceed (don't ask)** when: one reading clearly dominates, or the ambiguity is a detail the run's planning will resolve anyway. Take the most reasonable interpretation and **note the assumption inline in the framing**, so the run can correct it at a gate.
- While drafting, surface genuine **edge cases** as brief notes in the framing rather than as another round of questions. The user can stop the dialogue whenever they want.

Surface a conflict as an observation and a question: naming what exists is your job, deciding what to do about it is the user's, and how to do it is the run's.

## Pick the workflow

duet ships four workflows (a project can define more — see "Custom workflow definitions" below); settle which before gate posture, because the gates differ between them. Every workflow is two **stages** — planning (the attended thinking stretch) and delivery (the autonomous build and PR) — and they differ in how much planning ceremony the problem warrants. Record the choice as `workflow:` in the frontmatter (default `full`):

- **`full`** — frame → spec → plan → implement → PR. The thorough workflow: an unfamiliar domain, heavy risk, or work where the product spec and the technical plan genuinely differ and each deserves its own review.
- **`blueprint`** — frame → spec → implement → PR: full minus the plan phase. One committed **spec** carries the whole design — product goals and behaviors on top, module boundaries, the target shape, and test standards below — reviewed in a single loop and ratified at one gate. For serious work where the technical depth can be trusted to a frontier-model builder.
- **`relay`** — blueprint's shape with the delivery stage criss-crossed: after the spec commits, a fresh **builder** implements it cold from the document, and a **judge** reviews the build with write access — fixing ordinary findings directly, then owning the docs pass and the PR. For work where the spec will be strong enough that the build is labor rather than judgment. Its economy lives in the frontmatter bindings — a cheaper builder under a stronger judge.
- **`short`** — research → implement → PR. No spec, no plan; the research decisions are the design. For quick, well-understood iteration where any document ceremony would cost more than it returns.

If the user hasn't said: suggest `short` when the problem is small and clearly understood, `blueprint` when the work is substantial but they trust the builder's model with the technical depth, `relay` when they want that one-doc shape with a cheap builder and a strong fixing judge, and `full` otherwise — then confirm.

**Before writing any frontmatter, read `references/manifest-examples.md`** — five worked intent → manifest translations: the common shipped shapes plus the custom-workflow case. They demonstrate the grammar better than rules can, and — just as important — what to *omit*: every key has a workflow default, and a manifest that says less is usually the better one.

## Custom workflow definitions

If no shipped workflow says what the user means, define a project workflow rather than stretching the framing prose. **Before writing one, read `references/workflow-definitions.md`** — the SDK grammar plus three worked definitions: the shipped `relay` and `full` rebuilt from the blocks (pinned byte-identical to the registry — the standard library is the same grammar you'd be writing) and a novel hotfix lane. Ground rules:

- Shipped blocks and knobs only (`frame`, `doc`, `build`, `finish`); never invent prose, duties, or gate names. If the compiler rejects a composition, report the missing world to the user instead of working around it in the framing.
- Prefer the project layer (`.duet/workflows/<name>.ts`); use the user layer (`~/.config/duet/workflows/`) only when the user explicitly wants that shape across repos.
- The file is compiled once at run creation and frozen into the run — editing or deleting it later never affects a live run.

Before emitting the launch command, validate the file with `duet workflows check <name>` — it compiles the definition and prints the derived shape (phases, gates, contract placement) without starting a run, so a missing-world rejection surfaces here instead of at `duet new`. The user still launches with `workflow: <name>` in frontmatter or `duet new --workflow <name>`.

## Gate posture

A framing can pre-authorize gates so the user can walk away. Before finalizing, ask how hands-off they want the run unless they've already said, then record the choice as `gates_at:` — or omit the key to take the workflow's default (usually right; the examples file shows the defaults speaking). The tokens are the gate phases of the chosen workflow, and a preset must belong to it:

- **full** — tokens `frame, spec, plan, implement, finish`. Default **`overnight`** (= `frame,spec`): attend the first two, the rest auto-cross and the PR opens itself (the Open-PR gate sits _after_ the open). Also **`skip-plan`** (= `frame,spec,implement` — return for the Ship gate), **`afk`** (attend nothing, every safety net intact — the consultant's bet audits stay on, unlike `gateless` below), or a custom list (add `finish` for a post-open review stop; reject there amends the open PR).
- **blueprint / relay** — tokens `frame, spec, implement, finish`. Default: **attend `spec` only** — the one-interruption promise (a contentious direction still stops the run: a high-stakes call at an auto-crossed gate converts it to an attended stop). Also `afk` or a custom list.
- **short** — tokens `research, implement, finish`. Default: **attend `research` only** — approve the direction, then the build, Ship, and Open-PR auto-cross to a finished run (the same one-interruption shape as blueprint); `afk` auto-crosses Direction too, or a custom list (e.g. `research,implement` to return for the Ship gate).

**Walk away from the *start*:** `gateless: true` pre-authorizes *every* gate AND narrows a bound consultant to its non-holding work — the bet audits that could pause the run mid-flight drop, while its framing third-opinion and the acceptance-contract verify survive (a contract that can't be met still stops the run; `ask_human` and the merge always stay theirs). Offer it when the user says "just run it". It answers the posture question by itself — duet rejects it beside `gates_at`, and it runs headless from the first prompt (overriding the terminal's interactive default; an explicit `interactive: true` beside it is rejected). The worked full-send is example 4 in the examples file.

## Consultant — an optional outside voice

A run's embedded checkers are sharp on _is this well-built_, but — invested in the framing they helped shape — they rarely challenge the _bet_ underneath. A run can bind an optional **consultant**: a read-only outside voice that questions assumptions and product fit rather than the build, ideally on a **different model family** from the checkers (duet's shipped default pairs claude makers with codex checkers, so a claude consultant is already cross-family). It is **off by default** and never changes what gets built.

On the document-bearing workflows (**full**, **blueprint**, **relay**) it also authors a frozen **acceptance contract** — a short, falsifiable list of what success means, written before any code. The user ratifies it at the last gate before the build (full's plan gate; the spec gate on blueprint and relay), and a fresh session verifies it against the built system before shipping; a failed assertion routes to the workflow's fixer — relay's judge, the builder elsewhere — to fix and re-verify, holding the gate only if it stays broken. Mention this when the consultant is in play: that gate then carries an extra thing to sign off.

On **relay** it is worth raising even for routine work — the judge there both grades and fixes the build, so the consultant's fresh verify is the run's one fully independent pass.

Surface it like gate posture — offer the choice, don't make it; whether the premise is worth a second opinion is the user's call:

- **Worth raising** when the _premise_ carries the risk: a new direction, an unproven assumption, a product bet where "are we building the right thing?" matters more than execution polish.
- **Leave it off** for routine, well-understood work — the embedded checkers are enough there, and an extra voice is just cost and ceremony.

Two frontmatter keys cover it: `bind.consultant: <provider[:model]>` binds one for this run and by itself implies it's on (example 4 in the examples file); `consultant: on | off` is the bare toggle against a config-bound consultant — the toggle carries no provider, `off` beside a `bind.consultant` is a contradiction duet rejects, and flags (`--bind consultant=…`, `--no-consultant`) win over framing over config.

## Attach to this discussion (warm start)

A terminal-launched run brings up the orchestrator in its own Claude Code session (the interactive default). Normally that's a _fresh_ session — but when the framing grew out of a real discussion in **this** session, you can warm-start the orchestrator by resuming this session instead, so it carries the understanding you just built rather than meeting the problem cold. It steps in as the senior engineer who settled the goals and now delegates the build and watches the run.

This only applies to interactive runs (it's meaningless for a headless `gateless` one). Offer it like the consultant — the user's call, not yours:

- **Offer the warm start** when the framing distills a genuine back-and-forth here: libraries weighed, approaches compared, a mental model built. That shared context makes the orchestrator a stronger partner.
- **Leave it off** (a clean start) when this session holds little relevant history, or the user would rather the orchestrator reason from the framing alone.

If they want it:

1. Read this session's id: `printenv CLAUDE_CODE_SESSION_ID`.
2. Put the **literal** id into the launch command as `--resume-session <id>`. Never emit the `$CLAUDE_CODE_SESSION_ID` variable — once the user quits this session to run the command, that variable is gone from their shell, so only the resolved value works.
3. Tell them to **quit this session first (Ctrl+C), then run the command** in the same terminal — resuming needs this session closed.

## The framing schema

Frontmatter is optional and machine-parsed; everything else is prose sent to the workers verbatim. Write the prose to a single reader — speak to "you", and pair each instruction with its reason ("read X to understand Y, then build Z"), the way good onboarding does.

**Name every asset by its file path.** The orchestrator relays paths to workers that read files; a headless worker or codex cannot expand a `/command`, so `.claude/skills/onboarding/SKILL.md` reaches a worker where `/onboarding` does not. Park referenced assets under `.duet/` so the paths cannot rot out from under the run.

```
---
workflow: short            # optional: full (default), blueprint, relay, short, or a .duet/workflows/<name>.ts definition
gates_at: afk              # optional: omit for the workflow's default posture; a workflow-specific preset or a phase list (see Gate posture above)
gateless: true             # optional: walk away from the START — pre-authorize every gate (conflicts with gates_at and interactive)
interactive: false         # optional: force headless orchestration — a live terminal already defaults to interactive, so only the opt-out earns a line
consultant: on             # optional: on | off toggle for a config-bound consultant
bind.consultant: claude    # optional: bind the consultant for this run (implies on)
bind.builder: codex        # optional: bind any duty as provider[:model][@effort] — e.g. codex:gpt-5-codex@high (codex takes an inline model; effort low|medium|high|xhigh, +claude max / codex minimal). architect / analyst (planning), builder / critic or judge (delivery); a duty names its stage. Native args (claude_args / codex_config) are config-only, not a bind.* key
---

# Problem
<what to build or change, why, and the scope boundaries — what's explicitly out>

# Groundwork
<what the discussion already established, each piece labeled: Finding (with a
 code anchor), Proposal (with its reasoning and the alternatives it beat),
 Hypothesis (with the user's confidence). Omit when the problem is fresh.>

# Onboarding
<the files to read first — an onboarding or skill file
 (e.g. .claude/skills/onboarding/SKILL.md) and any docs>

# Conventions
- Specs live at: <path — every workflow's document lands here>
- Plans live at: <path — full only; drop this line on the other workflows>
- Branch: <the run's branch, or a naming convention>

# Verification
- Typecheck / tests: <commands, and what scope to run>
- Environment-only actions (migrations, deploys, credentials): flag me — never attempt.

# References
<paths to the concrete evidence that grounds the problem — data files, archives, logs, articles; link, don't summarize. Omit if none.>

# Docs
<the project's doc-update method — a doc-update skill's file
 (e.g. .claude/skills/update-docs/SKILL.md), or the docs that need
 it and what usually changes>
```

Keep a section the user gave even if it is terse; drop a heading that genuinely doesn't apply rather than padding it.

## Writing the framing

A framing is a **problem definition** — write it in that register: **advisory, not prescriptive**, arming the reader's reasoning rather than foreclosing it. Three moves:

**Keep the problem separate from what you concluded about it.** State the problem and the desired outcome as solution-agnostically as the evidence allows, so a conclusion that turns out wrong doesn't take the problem statement down with it. Everything the discussion produced then rides alongside, each piece labeled by how it was earned — the label tells the run how hard to lean on it:

- **Finding** — verified against the code. Cite the anchor (`src/foo.ts:42`) so a worker re-checks it in seconds instead of re-deriving it. A worker that contradicts a finding has found something; leave that door open.
- **Proposal** — an approach you and the user weighed. Give the reasoning *and* the alternatives it beat, and mark it as a direction the run may overturn with cause.
- **Hypothesis** — a hunch the user brought, with their confidence attached and what would settle it. A hunch of *yours* gets no rung: that is solutioning.

Why a proposal must carry its reasoning: the framing goes to **both** planning workers, who read it independently and in parallel so neither anchors the other. A bare proposal anchors both at once, and the run's first phase — which exists to produce two genuinely different bets — collapses into agreement. A proposal carrying its reasoning and its rejected alternatives gives them something to stress-test instead of something to ratify.

**Invite falsification, not agreement.** Where a hypothesis or a proposal is in play, say what would confirm or disconfirm it, and pose the open questions plainly. Grant the reader reframing rights: if their evidence points elsewhere, the right move is to redefine the problem, not force-fit it to the user's first read.

**State the ambition and the constraint strength you mean.** A run treats unstated ambition as optional: when the user wants all of it, write that into the framing — "all three pieces are v1 intent" — and add the cut rule: any descope is argued at a gate with rationale, never silently dropped. Constraints carry a strength too: a hard boundary reads as a rule ("never a server or watcher"), while a preference reads as one — "prefer an established package; argued exceptions welcome" — which licenses the better alternative a worker can defend. Runs honor the distinction; a preference stated as law forecloses exactly the judgment the run exists to apply.

**Prepare the reader to start.** With no approach proposed, your job is to lower the cost of entry: what to read first, what context matters, hard-won lessons, what has already been tried, and where the edge of current knowledge lies — so the workers reason from solid ground without inheriting the user's blind spots. The Onboarding and Conventions sections carry most of this; make them a real starting path. The same logic covers evidence that lives in a concrete artifact — a data file, an archive, a log, a linked article: **point to its path, don't paraphrase it.** A summary smuggles in your reading of the evidence as the evidence — the very blind spot you're meant to keep out; a pointer lets the reader open the raw source and judge it themselves. Its home is the References section.

<examples>
<example name="sharpening, intent preserved">
User: "the login thing should tell people why it failed instead of a generic error." After reading the code, you name the real pieces — the actual auth module and error path — and write a Problem section that says exactly that in the project's own vocabulary, with the user's intent untouched.
</example>

<example name="hypothesis kept, but labeled not baked in">
User: "search feels slow — I bet it's the missing index on the events table." Keep the lead — it's real signal — but write it as a hypothesis, not a directive: state the problem (search latency the user feels) and the outcome wanted, then note "user suspects the missing events-table index — medium confidence" and what would settle it (profile a slow query first). The run stays free to find the latency lives elsewhere.
</example>

<example name="a proposal carried, not baked in">
The session compared three cache strategies and settled on a write-through cache in the repository layer, because the read path already funnels through `src/data/repo.ts`. Write it as a **Proposal** with that reasoning and the two alternatives it beat (a route-level cache; a decorator on the client) and why each lost. The workers can now attack the reasoning. A bare "use a write-through cache in the repo layer" gives them nothing to attack and only invites agreement.
</example>

<example name="proceed-and-note, don't over-ask">
The user's notes don't say where a new setting should live, but one place clearly dominates (the existing settings file). You proceed on it and add a one-line assumption note, rather than interrupting — the run's planning can still correct it.
</example>

<example name="conflict — ask, don't redesign" type="avoid">
Your exploration shows the requested behavior already partly exists. AVOID rewriting the framing to "extend the existing handler to also do X." Instead, note the overlap and ask whether the request means something beyond what's there, or should be rescoped.
</example>

<example name="no solutioning" type="avoid">
User: "requests sometimes time out on a slow network." AVOID writing "add a bounded retry with exponential backoff." Instead, state the problem and the desired outcome — "a transient network timeout shouldn't fail the request outright; it should recover or report clearly" — and leave the mechanism to the run. Had the session actually weighed backoff against the alternatives with the user, it would ride as a **Proposal** carrying that reasoning; invented at writing time, it is solutioning.
</example>
</examples>

## Finishing

Before handing off, check the framing against the user's original words: **every** piece of their intent and scope present, nothing invented, no solutioning, and **every Finding citing something you actually read**. Then get their sign-off on the drafted file, fold in their edits, and emit:

```
duet new --workflow <workflow-name> --framing .duet/<slug>.md
```

Use the workflow you settled on (omit `--workflow` when the frontmatter carries it, or to take the default `full`). Bindings the user chose — a consultant, relay's builder/judge pair — ride the frontmatter `bind.*` keys you already wrote, so the command needs no extra flags for them. Tell them to run it in their own terminal: launched from a live terminal, the command hands it to an interactive orchestrator session by default (the reason it can't be launched for them from here), and the planning gates happen in that chat.

If the user chose to warm-start from this session (see "Attach to this discussion"), add the captured id and remind them to quit this session before running it:

```
duet new --resume-session <session-id> --workflow <workflow-name> --framing .duet/<slug>.md
```

If the user chose to walk away from the start (gateless), use `--gateless` — a gateless run is headless from the first prompt, overriding the terminal's interactive default:

```
duet new --gateless --workflow <workflow-name> --framing .duet/<slug>.md
```
