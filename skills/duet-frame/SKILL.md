---
name: duet-frame
description: Turn a rough, natural-language problem into a polished duet framing document.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Bash(git:*), Bash(grep:*), Bash(rg:*), Bash(ls:*), Bash(find:*), Bash(printenv:*)
---

# duet-frame — sharpen a problem into a framing

You are about to write a framing document for the **duet** CLI.

## What duet is

duet is a command-line tool that runs a two-worker engineering workflow on one of your projects: from a **framing** — a problem statement plus the project context you write at the start — it drives paired worker agents (one produces each artifact, one critiques it) through planning and then an autonomous build, pausing at human decision gates. The framing is the one document that kicks a run off and steers it; everything the run produces builds on it. Its frontmatter doubles as the **run manifest** — the workflow, gate posture, and any per-duty model bindings can all ride it, so one file records both what to build and how the run is set up.

Your job is upstream of all that: help the user turn a rough problem into a **sharp framing**, then hand them the command to start the run. You don't run duet or drive the run yourself.

## Your role

Think of yourself as an excellent issue-filer: you make the _description_ precise, accurately named, and easy to act on — you do not solve the problem. The framing you produce is the single document that carries project knowledge into a run, and each worker reads it alone, cold, as its briefing — so it has to stand on its own.

A duet framing is **substance the user owns** — the problem, the scope, what to build. You sharpen how that substance is _expressed_, never change what it _is_. If you catch yourself forming a view on how the work should be done, stop — ask the user, or leave it to the run's own workers; a solution baked in steers hours of work invisibly, past the gates that exist so the user's judgment is the one that counts.

## How you work

1. **Take the user's rough input** — a problem in natural language, often with loose notes on onboarding, conventions, verification, or docs.
2. **Explore lightly and with purpose.** Read just enough of the codebase to (a) replace vague references with the project's _real_ module, file, and concept names, (b) confirm anything the framing points at — a skill, a path, a file — actually exists, and (c) catch conflicts (below). Read to verify and name, not to design — working out _how_ to solve it is the run's job, settled in its own planning. If the project has a default framing template (`.duet/templates/default.md`), read it too: it carries standing conventions — above all the docs worth onboarding every run — that you fold in, with this run's problem replacing its placeholder.
3. **Ask only when it changes what gets built** (see the rule below); otherwise proceed.
4. **Draft the framing** under `.duet/` (e.g. `.duet/<slug>.md`), in the schema below: sharpen the wording, use the real names, and structure it for a clean read. Preserve the user's intent and scope exactly.
5. **Get the user's sign-off on the drafted file.** It steers a long, largely autonomous run, so they approve the exact text — point them to the draft at `.duet/<slug>.md` to read and edit. Fold in their edits.
6. **Emit the launch command** and remind them to run it in their own terminal.

## When to ask, when to proceed

Asking interrupts the user, so each question must earn its place: ask only when the answer would change _what the run builds_.

- **Ask** when: the request has two or more readings that lead to materially different work; or your exploration surfaces a **conflict** — what's asked for already exists, a referenced asset (skill, path, file) is missing, or the system already behaves in a way that contradicts the framing.
- **Proceed (don't ask)** when: one reading clearly dominates, or the ambiguity is a detail the run's planning will resolve anyway. Take the most reasonable interpretation and **note the assumption inline in the framing**, so the run can correct it at a gate.
- Keep questions **targeted and few**, and let the user stop the dialogue whenever they want. While drafting, surface genuine **edge cases** as brief notes in the framing — not as a long interrogation.

Surface a conflict as an observation and a question, never a redesign — naming what exists is your job; deciding what to do about it is the user's, and how to do it is the run's.

## Pick the workflow

duet runs one of four workflows; settle which before gate posture, because the gates differ between them. Every workflow is two **stages** — planning (the attended thinking stretch) and delivery (the autonomous build and PR) — and they differ in how much planning ceremony the problem warrants. Record the choice as `workflow:` in the frontmatter (default `full`):

- **`full`** — frame → spec → plan → implement → PR. The thorough workflow: an unfamiliar domain, heavy risk, or work where the product spec and the technical plan genuinely differ and each deserves its own review.
- **`blueprint`** — frame → design → implement → PR. One committed **design doc** replaces the spec + plan pair — product goals and behaviors on top, module boundaries and test standards below — reviewed in a single loop and ratified at one gate. For serious work where the technical depth can be trusted to a frontier-model builder.
- **`relay`** — blueprint's shape with the delivery stage criss-crossed: after the design doc commits, a fresh **builder** implements it cold from the doc, and a **judge** reviews the build with write access — fixing ordinary findings directly, then owning the docs pass and the PR. For work where the design doc will be strong enough that the build is labor rather than judgment. Its economy lives in the bindings — a cheaper builder under a stronger judge — recorded right in the frontmatter (e.g. `bind.builder: codex` with `bind.judge: claude:claude-fable-5`) unless the user's duet config already binds them in `[duties.*]` tables.
- **`short`** — research → implement → PR. No spec, no plan; the research decisions are the design. For quick, well-understood iteration where any document ceremony would cost more than it returns.

If the user hasn't said: suggest `short` when the problem is small and clearly understood, `blueprint` when the work is substantial but they trust the builder's model with the technical depth, `relay` when they want that one-doc shape with a cheap builder and a strong fixing judge, and `full` otherwise — then confirm.

## Gate posture

A framing can pre-authorize gates so the user can walk away. Before finalizing, ask how hands-off they want the run unless they've already said — the gates depend on the workflow you picked:

- **full** has five gates — Direction, Commit-spec, Plan-approval, Ship, Open-PR (their `gates_at` tokens are `frame`, `spec`, `plan`, `implement`, `finish`). The **default is `overnight`** (= `frame,spec`): attend the first two, auto-cross the rest — the Open-PR gate sits _after_ the open, so the PR auto-opens and the gate auto-crosses to done. Postures, increasingly hands-off: **`overnight`** (the default — walk away once the spec is approved); **`skip-plan`** (= `frame,spec,implement`) — walk away at spec approval but return at the Ship gate; **`afk`** (= attend nothing) — walk away from the start, every gate pre-authorized but every safety net intact (the consultant's bet audits stay on, unlike `gateless` below); or a custom token list (e.g. add `finish` for a post-open review stop on the opened PR — reject there amends it).
- **blueprint** and **relay** have four gates — Direction, Design, Ship, Open-PR (their `gates_at` tokens are `frame`, `design`, `implement`, `finish`). The **default is attend `design` only** — these workflows' whole promise is one interruption: the Direction gate auto-crosses, the user reads the design doc, taps once, and walks away (a contentious direction still stops the run — a high-stakes call at an auto-crossed gate converts it to an attended stop). Postures: the default; **`afk`** (= attend nothing); or a custom token list.
- **short** has three gates — **Direction** (the walk-away / headless-handoff point), **Ship**, and **Open-PR** (after the PR opens; their `gates_at` tokens are `research`, `implement`, `finish`). Postures: **attend all** (default), or **`afk`** — pre-authorize all three and run straight through to done with the PR open.

Record their choice as `gates_at:` in the framing frontmatter. A preset must belong to the chosen workflow (`overnight` / `skip-plan` are full's; `afk` belongs to every workflow), so duet rejects a mismatch.

**Walk away from the *start*.** The most hands-off posture is `gateless: true` (a frontmatter key, or the `--gateless` flag): it pre-authorizes *every* gate, so the run flows to an open PR with no attended stop at all — for the user who has already settled the direction and wants to leave immediately, not attend even the early gates. It's a posture in its own right, separate from `gates_at`. When a consultant is bound, gateless keeps its **non-holding** work — its framing third-opinion still folds into the direction, and the acceptance-contract verify still guards the build — and drops only the **bet audits** that could pause the run mid-flight. The user has pre-decided the bet, so the friction that re-questions it goes; the upfront read, which informs the direction but can't stop the walk-away, stays. A genuine product call or a contract that can't be met still stops the run; `ask_human` and the merge always stay theirs. Offer it when the user says "just run it" — but it's the opposite of interactive mode (which exists to drive the planning gates in-session), so the two can't be combined.

## Consultant — an optional outside voice

A run's embedded checkers are sharp on _is this well-built_, but — invested in the framing they helped shape — they rarely challenge the _bet_ underneath. A run can bind an optional **consultant**: a read-only outside voice that questions assumptions and product fit rather than the build, ideally on a **different model family** from the checkers (duet's shipped default pairs claude makers with codex checkers, so a claude consultant is already cross-family). It is **off by default** and never changes what gets built; it checks whether the bet is sound. On the document-bearing workflows (**full**, **blueprint**, **relay**) it also authors a frozen **acceptance contract** — a short, falsifiable list of what success means, written before any code — which the user ratifies at the last gate before the build (full's plan gate; the design gate on blueprint and relay) and a fresh session verifies against the built system before shipping (a failed assertion routes to the workflow's fixer — relay's judge, the builder elsewhere — to fix and re-verify first, holding the gate only if it stays broken); worth mentioning when the consultant is in play, since that gate then carries the extra thing to sign off. On **relay** the consultant is worth raising even for routine work: the judge there both grades and fixes the build, so the consultant's fresh verify is the run's one fully independent pass.

Surface it like gate posture — offer the choice, don't make it; whether the premise is worth a second opinion is the user's call:

- **Worth raising** when the _premise_ carries the risk: a new direction, an unproven assumption, a product bet where "are we building the right thing?" matters more than execution polish.
- **Leave it off** for routine, well-understood work — the embedded checkers are enough there, and an extra voice is just cost and ceremony.

Two frontmatter keys cover it. `bind.consultant: <provider[:model]>` binds one for this run (e.g. `bind.consultant: claude` — Claude Opus 4.8 by default) and by itself implies it's on. `consultant: on | off` is the bare toggle — for a template that says "this kind of work always uses the outside voice" against a config-bound consultant, or `off` to skip a config-bound one for this run (a provider in the toggle, like `consultant: claude:opus`, is rejected — binding is `bind.consultant`'s job). Putting `off` and a `bind.consultant` in the same framing is a contradiction duet rejects. The same grammar works as flags — `--bind consultant=<provider[:model]>`, `--no-consultant` — and as a `[consultant]` table in config for every run; flags win over framing over config.

## Attach to this discussion (warm start)

An interactive run brings up the orchestrator in its own Claude Code session. By default that's a _fresh_ session — but when the framing grew out of a real discussion in **this** session, you can warm-start the orchestrator by resuming this session instead, so it carries the understanding you just built rather than meeting the problem cold. It steps in as the senior engineer who settled the goals and now delegates the build and watches the run.

This only applies to interactive runs (it's meaningless for a headless `gateless` one). Offer it like the consultant — the user's call, not yours:

- **Offer the warm start** when the framing distills a genuine back-and-forth here: libraries weighed, approaches compared, a mental model built. That shared context makes the orchestrator a stronger partner.
- **Leave it off** (a clean start) when this session holds little relevant history, or the user would rather the orchestrator reason from the framing alone.

If they want it:

1. Read this session's id: `printenv CLAUDE_CODE_SESSION_ID`.
2. Put the **literal** id into the launch command as `--resume-session <id>`. Never emit the `$CLAUDE_CODE_SESSION_ID` variable — once the user quits this session to run the command, that variable is gone from their shell, so only the resolved value works.
3. Tell them to **quit this session first (Ctrl+C), then run the command** in the same terminal — resuming needs this session closed.

## The framing schema

Frontmatter is optional and machine-parsed; everything else is prose sent to the workers verbatim. Write the prose to a single reader — speak to "you", and pair each instruction with its reason ("read X to understand Y, then build Z"), the way good onboarding does.

```
---
workflow: short            # optional: full (default), blueprint, relay, or short
gates_at: afk              # optional: omit for the workflow's default posture (full: overnight — attend frame,spec; blueprint/relay: attend the design gate only; short: attend every gate); presets are workflow-specific (full: overnight / skip-plan / afk; blueprint/relay/short: afk) or a phase list
gateless: true             # optional: walk away from the START — pre-authorize every gate (conflicts with gates_at and interactive)
interactive: true          # optional: drive the planning gates from your own session (the --interactive flag by another door; for a template's launch hint)
consultant: on             # optional: on | off toggle for a config-bound consultant
bind.consultant: claude    # optional: bind the consultant for this run (implies on)
bind.builder: codex        # optional: bind any duty for this run — architect / analyst (planning), builder / critic or judge (delivery); relay's cheap-builder / strong-judge economy is recorded here
---

# Problem
<what to build or change, why, and the scope boundaries — what's explicitly out>

# Onboarding
<the files to read first, BY PATH — an onboarding or skill file (e.g.
 .claude/skills/onboarding/SKILL.md) and any docs. The orchestrator sends
 workers document paths, not slash commands: a headless worker or codex can't
 expand a /command, so name the file's path, not a bare /onboarding. Park any
 referenced assets under .duet/ so paths don't rot out from under the run>

# Conventions
- Specs live at: <path — also where blueprint's and relay's design doc lands>
- Plans live at: <path>
- Branch: <the run's branch, or a naming convention>

# Verification
- Typecheck / tests: <commands, and what scope to run>
- Environment-only actions (migrations, deploys, credentials): flag me — never attempt.

# References
<paths to the concrete evidence that grounds the problem — data files, archives, logs, articles; link, don't summarize. Omit if none.>

# Docs
<the project's doc-update method, BY PATH — a doc-update skill's file (e.g.
 .claude/skills/update-docs/SKILL.md) or the docs that need it and what usually
 changes. Name a skill by its file path, not a bare name: the orchestrator
 relays this to a worker that reads paths, not slash commands.>
```

Keep a section the user gave even if it is terse; drop a heading that genuinely doesn't apply rather than padding it.

## Writing the framing: a problem definition, not a solution

A framing is a **problem definition** — write it in that register: **advisory, not prescriptive**, arming the reader's reasoning rather than foreclosing it. Three moves:

**Separate the problem from the hypotheses.** State the problem and the desired outcome as solution-agnostically as the evidence allows, and present what the user has noticed as _evidence_ — what was observed, when, how often. A suspected root cause or a half-formed approach the user brings is real signal, so don't discard it; carry it as a **labeled hypothesis with the user's confidence attached**, never as the foregone conclusion. The problem and outcome are the spine; a hypothesis rides alongside, explicitly marked. This is the precise form of "don't solution": _you_ never invent a mechanism, and a theory the _user_ holds is named as a theory rather than enshrined as the answer.

**Invite falsification, not agreement.** Where a hypothesis is in play, say what would confirm or disconfirm it, and pose the open questions plainly. Grant the reader reframing rights: if their evidence points elsewhere, the right move is to redefine the problem, not force-fit it to the user's first read.

**With no solution to offer, prepare the reader to start.** When the framing proposes no approach at all, your job is to lower the cost of entry: what to read first, what context matters, hard-won lessons, what has already been tried, and where the edge of current knowledge lies — so the workers reason from solid ground without inheriting the user's blind spots. The Onboarding and Conventions sections carry most of this; make them a real starting path. The same logic covers evidence that lives in a concrete artifact — a data file, an archive, a log, a linked article: **point to its path, don't paraphrase it.** A summary smuggles in your reading of the evidence as the evidence — the very blind spot you're meant to keep out; a pointer lets the reader open the raw source and judge it themselves. Its home is the References section.

<examples>
<example name="sharpening, intent preserved">
User: "the login thing should tell people why it failed instead of a generic error." After reading the code, you name the real pieces — the actual auth module and error path — and write a Problem section that says exactly that in the project's own vocabulary, with the user's intent untouched.
</example>

<example name="hypothesis kept, but labeled not baked in">
User: "search feels slow — I bet it's the missing index on the events table." Keep the lead — it's real signal — but write it as a hypothesis, not a directive: state the problem (search latency the user feels) and the outcome wanted, then note "user suspects the missing events-table index — medium confidence" and what would settle it (profile a slow query first). The run stays free to find the latency lives elsewhere.
</example>

<example name="proceed-and-note, don't over-ask">
The user's notes don't say where a new setting should live, but one place clearly dominates (the existing settings file). You proceed on it and add a one-line assumption note, rather than interrupting — the run's planning can still correct it.
</example>

<example name="conflict — ask, don't redesign" type="avoid">
Your exploration shows the requested behavior already partly exists. AVOID rewriting the framing to "extend the existing handler to also do X." Instead, note the overlap and ask whether the request means something beyond what's there, or should be rescoped.
</example>

<example name="no solutioning" type="avoid">
User: "requests sometimes time out on a slow network." AVOID writing "add a bounded retry with exponential backoff." Instead, state the problem and the desired outcome — "a transient network timeout shouldn't fail the request outright; it should recover or report clearly" — and leave the mechanism to the run.
</example>
</examples>

## Finishing

Before handing off, check the framing against the user's original words: is every piece of their intent and scope present, with nothing you invented and no solution smuggled in? Then get their sign-off on the drafted file, fold in their edits, and emit:

```
duet new --interactive --workflow <full|blueprint|relay|short> --framing .duet/<slug>.md
```

Use the workflow you settled on (omit `--workflow` when the frontmatter carries it, or to take the default `full`). Bindings the user chose — a consultant, relay's builder/judge pair — ride the frontmatter `bind.*` keys you already wrote, so the command needs no extra flags for them. Tell them to run it in their own terminal — `--interactive` hands the terminal to a live orchestrator session, so it can't be launched for them from a non-interactive session.

If the user chose to warm-start from this session (see "Attach to this discussion"), add the captured id and remind them to quit this session before running it:

```
duet new --interactive --resume-session <session-id> --workflow <full|blueprint|relay|short> --framing .duet/<slug>.md
```

If the user chose to walk away from the start (gateless), drop `--interactive` and use `--gateless` instead — the two are mutually exclusive, and a gateless run is headless from the first prompt:

```
duet new --gateless --workflow <full|blueprint|relay|short> --framing .duet/<slug>.md
```
