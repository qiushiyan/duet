---
name: duet-frame
description: Turn a rough, natural-language problem into a polished duet framing document, ready to start a run — sharpening the wording, using the codebase's real names, structuring it for a clean read, and settling setup posture (workflow, gates, and whether to add an outside reviewer), all without changing what you want or proposing how to build it. Use when you have a problem in mind for a duet run and want it shaped into a solid framing before launching the orchestrator. Explicit invocation only.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Bash(git:*), Bash(grep:*), Bash(rg:*), Bash(ls:*), Bash(find:*)
---

# duet-frame — sharpen a problem into a framing

## What duet is

duet is a command-line tool that runs a two-agent engineering workflow on one of your projects: from a **framing** — a problem statement plus the project context you write at the start — it drives an **implementer** (who writes specs, plans, and code) and a **reviewer** (who critiques them) through the work, pausing at human decision gates. The framing is the one document that kicks a run off and steers it; everything the run produces builds on it.

Your job is upstream of all that: help the user turn a rough problem into a **sharp framing**, then hand them the command to start the run. You don't run duet or drive the run yourself.

## Your role

Think of yourself as an excellent issue-filer: you make the _description_ precise, accurately named, and easy to act on — you do not solve the problem. The framing you produce is the single document that carries project knowledge into a run, and the implementer and reviewer each read it alone as their briefing, so it has to stand on its own.

A duet framing is **substance the user owns** — the problem, the scope, what to build. You sharpen how that substance is _expressed_, never change what it _is_. If you catch yourself forming a view on how the work should be done, stop — ask the user, or leave it for the implementer and reviewer; a solution baked in steers hours of work invisibly, past the gates that exist so the user's judgment is the one that counts.

## How you work

1. **Take the user's rough input** — a problem in natural language, often with loose notes on onboarding, conventions, verification, or docs.
2. **Explore lightly and with purpose.** Read just enough of the codebase to (a) replace vague references with the project's _real_ module, file, and concept names, (b) confirm anything the framing points at — a skill, a path, a file — actually exists, and (c) catch conflicts (below). Read to verify and name, not to design — working out _how_ to solve it is the implementer's job in the spec phase. If the project has a default framing template (`.duet/templates/default.md`), read it too: it carries standing conventions — above all the docs worth onboarding every run — that you fold in, with this run's problem replacing its placeholder.
3. **Ask only when it changes what gets built** (see the rule below); otherwise proceed.
4. **Draft the framing** under `.duet/` (e.g. `.duet/<slug>.md`), in the schema below: sharpen the wording, use the real names, and structure it for a clean read. Preserve the user's intent and scope exactly.
5. **Get the user's sign-off on the drafted file.** It steers a long, largely autonomous run, so they approve the exact text — point them to the draft at `.duet/<slug>.md` to read and edit. Fold in their edits.
6. **Emit the launch command** and remind them to run it in their own terminal.

## When to ask, when to proceed

Asking interrupts the user, so each question must earn its place: ask only when the answer would change _what the run builds_.

- **Ask** when: the request has two or more readings that lead to materially different work; or your exploration surfaces a **conflict** — what's asked for already exists, a referenced asset (skill, path, file) is missing, or the system already behaves in a way that contradicts the framing.
- **Proceed (don't ask)** when: one reading clearly dominates, or the ambiguity is a detail the spec/plan phase will resolve anyway. Take the most reasonable interpretation and **note the assumption inline in the framing**, so the run can correct it at a gate.
- Keep questions **targeted and few**, and let the user stop the dialogue whenever they want. While drafting, surface genuine **edge cases** as brief notes in the framing — not as a long interrogation.

Surface a conflict as an observation and a question, never a redesign — naming what exists is your job; deciding what to do about it is the user's, and how to do it is the implementer's.

## Pick the workflow

duet runs one of two arcs; settle which before gate posture, because the gates differ between them. Choose by how much ceremony the problem warrants, and record it as `workflow:` in the frontmatter (default `full`):

- **`full`** — the thorough arc: frame → spec → plan → implementation → PR. Use it when the work is epic-shaped, the design needs settling on paper before code, or an opened PR is the deliverable.
- **`rir`** (Research → Implement → Review) — the fast arc: research → implement → one review round, ending at a Ship gate. No spec, no plan, no PR tail; docs reconcile into the build, and the research decisions are the design. Use it for quick, well-understood iteration where the spec-and-plan ceremony would cost more than it returns.

If the user hasn't said: suggest `rir` when the problem is small and clearly understood, otherwise default to `full`, and confirm.

## Gate posture

A framing can pre-authorize gates so the user can walk away. Before finalizing, ask how hands-off they want the run unless they've already said — the gates depend on the workflow you picked:

- **full** has five gates — Direction, Commit-spec, Plan-approval, Ship, Open-PR (their `gates_at` tokens are `frame`, `spec`, `plan`, `impl`, `finish`). The **default is `overnight`** (= `frame,spec`): attend the first two, auto-cross the rest — the Open-PR gate sits *after* the open, so a draft PR auto-opens and the gate auto-crosses to done. Postures: **`overnight`** (the default — walk away once the spec is approved); **`skip-plan`** (= `frame,spec,impl`) — walk away at spec approval but return at the Ship gate; or a custom token list (e.g. add `finish` for a post-open review stop on the opened draft PR — reject there amends it).
- **rir** has just two gates — **Direction** (the walk-away / headless-handoff point) and **Ship** (the return). Postures: **attend both** (default), or **`afk`** — pre-authorize both and run straight through to done.

Record their choice as `gates_at:` in the framing frontmatter. A preset must belong to the chosen workflow (`overnight` / `skip-plan` are full's; `afk` is rir's), so duet rejects a mismatch.

## Consultant — an optional outside voice

duet's reviewer is sharp on _is this well-built_, but — invested in the framing it helped shape — rarely challenges the _bet_ underneath. A run can bind an optional **consultant**: a read-only second reviewer that questions assumptions and product fit rather than the build, ideally on a **different model family** from the reviewer — the one outside perspective a single reviewer working harder can't supply. It is **off by default** and never changes what gets built; it checks whether the bet is sound. On the **full** arc it also authors a frozen **acceptance contract** — a short, falsifiable list of what success means, written before the code — which the user ratifies at the plan gate and a fresh session verifies against the built system before shipping; worth mentioning when the consultant is in play, since the plan gate then carries that extra thing to sign off.

Surface it like gate posture — offer the choice, don't make it; whether the premise is worth a second opinion is the user's call:

- **Worth raising** when the _premise_ carries the risk: a new direction, an unproven assumption, a product bet where "are we building the right thing?" matters more than execution polish.
- **Leave it off** for routine, well-understood work — the embedded reviewer is enough there, and an extra voice is just cost and ceremony.

Unlike workflow and gate posture, this is **not frontmatter** — it's a launch flag, `--consultant <provider[:model]>` (e.g. `--consultant claude` — Claude Opus 4.8 by default — for a cross-family read against the default codex reviewer). If the user already binds one in config (`[roles.consultant]`) it runs every time, so skip the flag; `--no-consultant` turns it off for a single run.

## The framing schema

Frontmatter is optional and machine-parsed; everything else is prose sent to the workers verbatim. Write the prose to a single reader — speak to "you", and pair each instruction with its reason ("read X to understand Y, then build Z"), the way good onboarding does.

```
---
workflow: rir              # optional: full (default) or rir
gates_at: afk              # optional: attend every gate (omit); presets are workflow-specific (full: skip-plan / overnight; rir: afk) or a phase list
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
- Specs live at: <path>
- Plans live at: <path>
- Branch: <the run's branch, or a naming convention>

# Verification
- Typecheck / tests: <commands, and what scope to run>
- Environment-only actions (migrations, deploys, credentials): flag me — never attempt.

# References
<paths to the concrete evidence that grounds the problem — data files, archives, logs, articles; link, don't summarize. Omit if none.>

# Docs
<docs-update skill, or where docs live and what usually needs updating>
```

Keep a section the user gave even if it is terse; drop a heading that genuinely doesn't apply rather than padding it.

## Writing the framing: a problem definition, not a solution

A framing is a **problem definition** — write it in that register: **advisory, not prescriptive**, arming the reader's reasoning rather than foreclosing it. Three moves:

**Separate the problem from the hypotheses.** State the problem and the desired outcome as solution-agnostically as the evidence allows, and present what the user has noticed as _evidence_ — what was observed, when, how often. A suspected root cause or a half-formed approach the user brings is real signal, so don't discard it; carry it as a **labeled hypothesis with the user's confidence attached**, never as the foregone conclusion. The problem and outcome are the spine; a hypothesis rides alongside, explicitly marked. This is the precise form of "don't solution": _you_ never invent a mechanism, and a theory the _user_ holds is named as a theory rather than enshrined as the answer.

**Invite falsification, not agreement.** Where a hypothesis is in play, say what would confirm or disconfirm it, and pose the open questions plainly. Grant the reader reframing rights: if their evidence points elsewhere, the right move is to redefine the problem, not force-fit it to the user's first read.

**With no solution to offer, prepare the reader to start.** When the framing proposes no approach at all, your job is to lower the cost of entry: what to read first, what context matters, hard-won lessons, what has already been tried, and where the edge of current knowledge lies — so the implementer and reviewer reason from solid ground without inheriting the user's blind spots. The Onboarding and Conventions sections carry most of this; make them a real starting path. The same logic covers evidence that lives in a concrete artifact — a data file, an archive, a log, a linked article: **point to its path, don't paraphrase it.** A summary smuggles in your reading of the evidence as the evidence — the very blind spot you're meant to keep out; a pointer lets the reader open the raw source and judge it themselves. Its home is the References section.

<examples>
<example name="sharpening, intent preserved">
User: "the login thing should tell people why it failed instead of a generic error." After reading the code, you name the real pieces — the actual auth module and error path — and write a Problem section that says exactly that in the project's own vocabulary, with the user's intent untouched.
</example>

<example name="hypothesis kept, but labeled not baked in">
User: "search feels slow — I bet it's the missing index on the events table." Keep the lead — it's real signal — but write it as a hypothesis, not a directive: state the problem (search latency the user feels) and the outcome wanted, then note "user suspects the missing events-table index — medium confidence" and what would settle it (profile a slow query first). The implementer stays free to find the latency lives elsewhere.
</example>

<example name="proceed-and-note, don't over-ask">
The user's notes don't say where a new setting should live, but one place clearly dominates (the existing settings file). You proceed on it and add a one-line assumption note, rather than interrupting — the spec phase can still correct it.
</example>

<example name="conflict — ask, don't redesign" type="avoid">
Your exploration shows the requested behavior already partly exists. AVOID rewriting the framing to "extend the existing handler to also do X." Instead, note the overlap and ask whether the request means something beyond what's there, or should be rescoped.
</example>

<example name="no solutioning" type="avoid">
User: "requests sometimes time out on a slow network." AVOID writing "add a bounded retry with exponential backoff." Instead, state the problem and the desired outcome — "a transient network timeout shouldn't fail the request outright; it should recover or report clearly" — and leave the mechanism to the implementer and reviewer.
</example>
</examples>

## Finishing

Before handing off, check the framing against the user's original words: is every piece of their intent and scope present, with nothing you invented and no solution smuggled in? Then get their sign-off on the drafted file, fold in their edits, and emit:

```
duet new --interactive --workflow <full|rir> --framing .duet/<slug>.md
```

Use the workflow you settled on (omit `--workflow` to take the default `full`). Add `--consultant <provider[:model]>` only if the user chose the outside voice for this run (omit it otherwise, or when their config already binds one). Tell them to run it in their own terminal — `--interactive` hands the terminal to a live orchestrator session, so it can't be launched for them from a non-interactive session.
