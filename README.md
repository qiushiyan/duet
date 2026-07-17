# greenflag

**Compose the way you build software from opinionated building blocks — spec loops, technical plans, adversarial review, an AFK build — and greenflag runs it: one AI agent makes each artifact, another checks it, an LLM orchestrator routes between them, and human gates only you can cross.**

greenflag is built around one process shape: every artifact — a spec, a plan, the code — is drafted by one agent and critiqued by another, phase after phase, while you approve direction at a few gates and stay away from the keyboard for the rest. What that process _is_ is yours to say: greenflag ships four ready workflows (from a thorough spec → plan → implement pipeline down to a research → implement quickie) and the vocabulary they're built from — pick one, or compose your own in a few lines of TypeScript. Either way the same runtime drives it, and you come back to an opened pull request or a well-formed question waiting for you.

Hence the name: the run drives itself, at speed, for hours — and nothing crosses a gate without your green flag.

It's a personal tool, built for one developer's workflow across their own projects, and published in case the shape is useful to you — not a polished product. Expect rough edges.

## How it works

The process greenflag automates is one you may already run by hand: two coding agents in parallel — one writing the specs, plans, and code, the other critiquing them — with you copy-pasting between them and nudging each along. In greenflag, a run executes one **workflow** in two **stages** — an attended **planning** stage and an AFK **delivery** stage — and each stage pairs two **workers**, identified by **duty**: planning's **architect** drafts the documents and its **analyst** critiques them; delivery's **builder** writes the code and its **critic** reviews it (on the relay workflow the checker is a **judge**, which also fixes what it finds). Every duty can bind to either provider (`claude` or `codex`); the **orchestrator** must be `claude` in v1 — Codex-as-orchestrator is designed but unbuilt:

| Voice                                               | Does                                                                                                           | Default         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------- |
| **Orchestrator**                                    | Routes the protocol — never writes code, only triages and decides who answers what                             | `claude` (Opus) |
| **architect** · **builder** — the makers            | The architect writes the spec and the plan; the builder writes the code and the PR                             | `claude` (Opus) |
| **analyst** · **critic** / **judge** — the checkers | Critique each artifact — read-only, except relay's judge, which fixes findings directly and owns the docs + PR | `codex`         |

You pick the workflow at the start (`--workflow`). Under the hood the workflows aren't four hand-built pipelines — each is composed from the same few **phase blocks** (a framing analysis, a document loop, the AFK build, a finishing phase that opens the PR) with named knobs: which document the loop produces, whether the delivery checker critiques or fixes, who owns the finishing steps, which sessions carry across the stage boundary. greenflag ships four compositions as its standard library, and the same blocks are yours to compose ([below](#compose-your-own-workflow)). Each `→` is a phase the agents work through; each **GATE** is a stop where the run waits for you:

```
full       frame → DIRECTION → spec → COMMIT-SPEC → plan → PLAN (walk away)
             → implement (AFK, often hours) → SHIP → finish (open the PR) → OPEN-PR → done

blueprint  frame → DIRECTION (auto-crosses) → spec → COMMIT-SPEC (your one stop — then walk away)
             → implement (AFK) → SHIP → finish (open the PR) → OPEN-PR → done

relay      frame → DIRECTION (auto-crosses) → spec → COMMIT-SPEC (your one stop)
             → implement (AFK: a fresh builder implements the spec; the judge reviews AND fixes)
             → SHIP → finish (the judge opens the PR) → OPEN-PR → done

short      research → DIRECTION (walk away) → implement (AFK) → SHIP
             → finish (open the PR) → OPEN-PR → done
```

- **full** — the thorough workflow: a spec and a plan, each drafted and reviewed on paper before any code. Pick it for unfamiliar or risky work, where the product spec and the technical plan each deserve their own review.
- **blueprint** — the middle workflow: full minus the plan phase. Its one committed **spec** carries the whole design — product goals and behaviors on top, module boundaries, the target shape, and test standards below — reviewed in a single loop. Pick it for serious work on a builder model you trust: by default you read one document, tap once, and walk away.
- **relay** — blueprint's shape with the delivery **criss-crossed**: after the spec commits, a fresh **builder** on a fast, cheaper binding implements it cold, while the checking duty goes to a **judge** on a strong model that doesn't just file critiques — it fixes ordinary findings in place, owns the docs pass, and opens the PR, escalating anything that smells like a design change instead of patching over it. Pick it when the spec is strong enough that the build is labor, not judgment. The model pairing is yours to bind (`--bind builder=… --bind judge=…` — see [Configure](#configure)); the workflow supplies the shape.
- **short** — the fast workflow: no documents at all; the research decisions are the design. Pick it for small, well-understood changes.

Every workflow shares the same AFK implementation phase and ends by opening a real pull request.

The gates are enforced in code (a statechart), not by a prompt an agent could be talked out of. Between stops a detached background process drives the phase; nothing runs while a run is parked, and you get a desktop notification at every stop. Three things worth knowing about how a run ends:

- Docs are reconciled as the last step of implementation, so the **SHIP** gate reviews code and docs together; `finish` just writes the description and opens the PR.
- The **OPEN-PR** gate sits _after_ the PR opens. Under the hands-off defaults it auto-crosses to done; to stop and review the opened PR, list `finish` in `--gates-at` (rejecting there amends the PR in place).
- A pre-authorized gate auto-crosses only on a clean packet: a `high`-severity decision in it holds the run for you instead, and an `ask_human` question stops the run under any posture. The merge is always yours.

Each phase runs a handful of prompt templates — **snippets** — that carry the workflow's conventions. The stage's maker drafts each artifact from one: the architect from `write-spec` in spec and `start-plan` in plan; the builder from `implement-spec` on blueprint and relay, or `implement-direct` on short. The checker critiques through altitude-tuned lenses like `review-spec` (the analyst) and `review-implementation` (the critic), while relay's judge works from `review-and-fix` — the same lens, plus the authority to fix what it finds. Read any of them with `greenflag snippets show <key>`. The snippets are the substance of the workflow, and the part you can reshape to your own methodology — see [Customizing the snippets](#customizing-the-snippets), or the [snippet reference](docs/snippets.md).

### Compose your own workflow

When no shipped shape says what you mean — say a hotfix lane that triages once, patches once, and opens the PR — `greenflag workflows init hotfix` scaffolds a typed, minimal-compiling definition under `.greenflag/workflows/` (or write the file by hand; `~/.config/greenflag/workflows/` holds one shared across your repos). A definition is a `defineWorkflow` expression — the hotfix lane in full:

```ts
// .greenflag/workflows/hotfix.ts
import { build, defineWorkflow, finish, frame } from "greenflag/workflows";

export default defineWorkflow({
  name: "hotfix",
  title: "Hotfix (triage → patch → PR)",
  attend: ["triage"],
  phases: [
    frame({ name: "triage" }),
    build({ name: "patch", review: "writable", audit: true }),
    finish(),
  ],
});
```

`greenflag workflows check hotfix` compiles it and prints the shape greenflag derives — phases in order, the stage duty-pairs, the default gates, the acceptance-contract placement — so you validate a definition (and read what it became) without starting a run; `greenflag new --workflow hotfix` then runs it. You state the phase list and the gate posture; greenflag derives the rest — the stages, the duty pairs, session continuity, the gate copy. The vocabulary is deliberately **closed**: a composition compiles only where greenflag ships prompt support (the compiler rejects anything else, naming the valid combinations), so a workflow you compose gets the same quality of briefing as a shipped one. And the shipped four are themselves `defineWorkflow` expressions, pinned byte-identical to their in-repo rebuilds by the test suite — you compose in exactly the grammar the standard library is written in.

Mechanics worth knowing: no npm install — the workflow directory is provisioned with a `tsconfig.json` and a typed stub (by `init`, or on first use), so your editor typechecks the file as-is; the definition is compiled once at `greenflag new` and frozen into the run, so editing or deleting the file never affects a live run. Running `greenflag workflows` bare lists every definition it sees — shipped, project, and user — and surfaces any name defined in more than one layer as a **collision** (greenflag refuses to shadow, so a collided name is unusable until you rename). To commit a project workflow, carve `!/workflows/` into the repo's `.greenflag/.gitignore` (`.greenflag/` self-ignores everything by default). Worked examples — the shipped relay and full rebuilt from the blocks, plus the hotfix lane above — ship with the greenflag-frame skill ([`skills/greenflag-frame/references/workflow-definitions.md`](skills/greenflag-frame/references/workflow-definitions.md)).

## What it is — and isn't

Four ideas shape every design choice:

- **Augment, don't replace.** greenflag drives the same `claude` and `codex` CLIs you already use, with the same prompts, against the same repo. Every artifact — transcripts, branches, commits — is something you could have made by hand. There's no "greenflag mode" you get locked into.
- **You own the substance.** The orchestrator does triage, never opinions. Product, direction, and environment questions always reach you; it only decides _who_ answers. The gates are structural, not a promise in a prompt.
- **Stop anytime.** A run can be paused indefinitely. The state file is a hint; the agents' transcripts are the truth. Drop out to drive `claude --resume` / `codex resume` by hand, then pick greenflag back up later — or never.
- **Not a daemon, not an app.** A small CLI you invoke per gate. No GUI, no background service, no webhooks.

**It is not** a general orchestration framework — the workflows compose from a small, deliberately **closed** vocabulary (you can define your own, but only from blocks and knobs greenflag ships prompts for), because a neutral engine would be a commodity; what greenflag actually ships is the opinions (the snippets, the altitude-tuned review lenses, the gate discipline), and a knob exists only when a shipped workflow exercises it. Not multi-user, and not provider-agnostic — exactly two providers exist by design. It ships with no project conventions: which skills to run, where specs go, what context to seed all come from a **framing** you write at the start of each run.

## Install

Requirements: **Node 24+**, and the **`claude`** and **`codex`** CLIs installed and authenticated (greenflag drives your existing setup).

```bash
npm install -g greenflag
```

Or run it without installing: `npx greenflag new`.

To hack on it instead, work from source — Node 24 runs the TypeScript directly, so every edit is live in the global command (this needs **pnpm**):

```bash
git clone https://github.com/qiushiyan/greenflag
cd greenflag
pnpm install
pnpm add -g .   # links the global `greenflag` command at src/, not dist/
```

Then add the companion Claude Code skills used below:

```bash
npx skills add qiushiyan/greenflag                    # greenflag-frame + greenflag-concierge → ~/.claude/skills
npx skills add qiushiyan/greenflag --skill greenflag-frame # or just the one you need
```

## Getting started: the framing workflow

The smoothest way to run greenflag is to let a Claude Code session sharpen your problem, then drive the run from your own interactive session:

1. **Start with the problem.** A rough description in plain language — what to build or fix, plus any project context (which docs to read first, where specs live, how you verify).
2. **Shape it with `/greenflag-frame`.** In a Claude Code session, run `/greenflag-frame`. It turns the rough problem into a sharp **framing** — using your project's real names, structure, and gate posture — without changing what you asked for or proposing how to build it, and hands you the launch command.
3. **Launch the interactive run** in your terminal:
   ```bash
   greenflag new --framing .greenflag/<your-framing>.md
   ```
   Your own Claude Code session becomes the orchestrator: you act at the early gates right in the chat — the spec and plan on full, the spec on blueprint, the direction on short.
4. **Walk away.** At the planning stage's last gate — plan approval (full), spec approval (blueprint and relay), or Direction (short) — the session hands the run to a background driver, which implements semi-AFK, often for an hour or more. Under the hands-off defaults it then crosses the Ship gate and opens the PR, so you return to an opened pull request (with a CEO-style summary recorded for your morning review) — or a well-formed question waiting for you. Prefer to verify the build before it ships? Attend the Ship gate (`--gates-at skip-plan` on full).

> **Prefer headless?** Interactive is the default on a live terminal (a gateless or non-TTY launch stays headless) — pass `--no-interactive` for the background posture instead: `greenflag new` opens your editor on a framing draft, then the orchestrator runs detached and you act at each gate with `greenflag continue`.

Common ways to start a run:

```bash
greenflag new                       # editor on a framing draft (issue, context, scope)
greenflag new --template bug        # seed the draft from .greenflag/templates/bug.md
greenflag new --spec spec.md        # start from a draft spec you already wrote (every document-bearing workflow)
greenflag new --workflow blueprint  # the one-doc middle workflow — one attended gate by default
greenflag new --workflow relay      # blueprint criss-crossed — bind the delivery pair: --bind builder=… --bind judge=…
greenflag new --workflow short      # the fast workflow (add --gates-at afk to run unattended → PR open)
greenflag new --gates-at skip-plan  # full's default is hands-off after the spec; this returns you at the Ship gate
greenflag new --budget default      # opt in to per-turn cost caps (off by default)
greenflag new --gateless            # walk away from the START — every gate pre-authorized; with a consultant bound, its bet-audits are off but its framing read and the contract/verify backstop remain; still stoppable by ask_human / a correctness hold (conflicts with --interactive)
greenflag new --retry-infra 2       # tune the bounded infra auto-retry budget (default 3 for new runs; 0 disables)
```

Each workflow has a sensible hands-off default: **full** is `overnight` — approve the spec, then walk away (plan, Ship, and the Open-PR gate all auto-cross); **blueprint** and **relay** attend only their spec gate — one interruption for the whole run; **short** attends only its Direction gate — approve the research direction and the rest runs to the open PR. `--gates-at` names the _complete_ set of gates you attend, not a delta: `--gates-at finish` attends **only** the Open-PR gate — everything else auto-crosses; to keep the usual stops _and_ add a post-open review, list them all.

## Everyday commands

Once a run is going, you mostly watch and decide:

```bash
greenflag status                    # where the run is, and the exact command to act next
greenflag status --brief            # lean digest: position, stop kind, headline, next command (drops the full packet)
greenflag status --json --wait      # block until the next stop, then print (scripting/supervision)
greenflag doctor                    # per-voice health: working / thinking / retrying / stuck / crashed
greenflag stats                     # effort per phase — each phase's elapsed window and worker-turn time, from the logs
greenflag stats --trace             # the interleaved turn-by-turn timeline (with interventions and ordering drift)
greenflag graph                     # see it: the run's whole arc with the live cursor, gate outcomes, and drift flags
greenflag graph --workflow <name>   # ...or a workflow's shape before any run (--mermaid for a docs diagram)
greenflag grade                     # end-of-run: verdict each reconstructed decision point right/wrong (calibration); --list previews

greenflag continue --approve        # cross the current gate (optionally: --approve "a rider with tweaks")
greenflag continue --reject "..."   # send the artifact back; your words reach the orchestrator verbatim
greenflag continue --answer "..."   # answer a queued question

greenflag steer "..."               # nudge the orchestrator mid-phase, without pausing the run
greenflag afk                       # from an interactive gate, hand the rest to the headless driver
greenflag takeover critic           # drop into a duty's raw CLI session yourself; resume greenflag after
greenflag abandon                   # stop a run for good; --purge also deletes its sessions

greenflag orchestrate               # reconnect the interactive orchestrator after a dropped session
greenflag logs                      # stream the orchestrator's narration inline
greenflag view                      # tmux panes, one per voice (or pass --tmux to new/continue)
greenflag runs                      # list runs in this project
greenflag framings                  # browse archived run framings — corpus archive + this repo's runs; show <id> reprints one
greenflag workflows                 # list/check/scaffold workflow definitions (before a run)
```

Run state lives under `.greenflag/runs/<id>/` (self-ignored from git). `state.json` is a convenience hint; the voices' provider transcripts are the source of truth.

When most of a framing repeats run to run, save the common part as a template under `.greenflag/templates/<name>.md` and seed each draft from it (`greenflag new --template <name>`); how to author them is in [`docs/automation-design.md`](docs/automation-design.md).

A framing (and a template) may open with a small machine-readable **frontmatter** block — the run's **manifest**: fixed-value knobs the harness acts on without judgment (`workflow`, `gates_at`, `gateless`, `interactive`, `consultant`, `spec`, `retry_infra`, and `bind.<duty>` binding keys) — above the prose body, where all project judgment lives. Unknown keys fail loudly. Each knob resolves per key — flags > framing > config > shipped defaults — once at run creation, is frozen on the run, and is echoed back by `greenflag new`. Here `consultant` is an `on`/`off` toggle; the provider/model binding rides `bind.consultant:` (or config / `--bind consultant=…`), and setting a binding alone implies `on`. The frontmatter is only for values with a deterministic consumer; anything the orchestrator should weigh stays prose. The authoritative key reference lives in [`docs/automation-design.md`](docs/automation-design.md).

## Configure

greenflag's one config file holds account-level defaults — which provider (and model, effort, or native args) each voice runs on, plus your billing posture — and nothing else. It's optional: the defaults work out of the box (the orchestrator and the maker duties on claude/Opus, the checker duties on codex — the cross-family review is the shipped posture). Reach for it when you want a different provider or model behind a duty, or a different billing setup — create `~/.config/greenflag/config.toml`:

```toml
budget = "off"              # opt-in per-turn cost caps: "off" (default), "default", or a multiplier like 0.5/2

[orchestrator]
provider = "claude"         # must be claude in v1 — codex-as-orchestrator is designed but unbuilt
model = "claude-opus-4-8"   # any Anthropic model id

[duties.architect]          # planning's maker — drafts the spec and the plan
provider = "claude"
model = "claude-opus-4-8"
effort = "high"             # normalized: low|medium|high|xhigh (+ claude's max)

[duties.analyst]            # planning's checker — critiques the documents
provider = "codex"          # model/effort/native optional; absent ⇒ your ~/.codex/config.toml governs

[duties.builder]            # delivery's maker — writes the code and the PR
provider = "claude"
model = "claude-opus-4-8"
# claude_args = ["--fallback-model", "claude-opus-4-6"]     # native passthrough (claude only)

[duties.critic]             # delivery's checker on full/blueprint/short — read-only review
provider = "codex"
# model = "gpt-5-codex"     # optional inline codex model (else your ~/.codex/config.toml)
# codex_config = { model_reasoning_summary = "detailed" }   # native passthrough (codex only)

[duties.judge]              # delivery's checker on relay — reviews with write access
provider = "claude"
model = "claude-opus-4-8"
```

That's the only config greenflag has — per-duty (and orchestrator/consultant) provider bindings plus billing posture (`transport`, `budget`), nothing else. Project knowledge never lives here; it goes in the framing.

- **Bindings are per duty; a run overrides them per key.** Config is the account-level default tier; a single run rebinds any duty with the repeatable `--bind <duty>=<provider[:model][@effort]>` flag or a framing `bind.<duty>:` key — a duty alone names its stage, so relay's criss-cross is just two flags (`--bind builder=codex --bind judge=claude:claude-opus-4-8`: plan strong, build cheap, judge strong). On full, blueprint, and short the delivery duties _continue_ the planning sessions (builder ← architect, critic ← analyst — declared continuity edges); relay's delivery starts fresh by design. An edge whose two duties' frozen bindings cross providers degrades to a fresh session at run creation — echoed by `greenflag new` and ledgered, never an error — with the committed document as the build's context.
- **Tune a binding: model, effort, native args.** Any binding also takes an inline **model** (`--bind analyst=codex:gpt-5-codex`, or `model =` in config — codex included now, not just claude; absent, codex still defers to your `~/.codex/config.toml`), a normalized **effort** (`--bind builder=claude:claude-opus-4-8@high`, or `effort =` — `low`/`medium`/`high`/`xhigh`, plus claude's `max` and codex's `minimal`), and a config-only **native passthrough** for anything greenflag doesn't model (`claude_args = [...]` appended to the `claude` argv; `codex_config = {...}` fed to codex's `-c` overrides). greenflag validates its _own_ knobs — an effort illegal for the provider is rejected up front — but never second-guesses your native args. Instead, a binding carrying an explicit model or native override is **preflighted at `greenflag new`**: greenflag runs one throwaway turn through it, so a bad argument fails at creation with the provider's own error, not hours later mid-build.
- **Consultant (optional, off by default).** Add a `[consultant]` table (or `--bind consultant=<provider[:model]>` per run — a binding alone implies it's on) for a second, read-only advisor voice that questions the _bet_ (assumptions, product fit) rather than the build — ideally on a different model family from your checkers, which is the point. `--no-consultant` disables a configured one for a single run. On the document-bearing workflows (full, blueprint, relay) it also authors an **acceptance contract** — a short, frozen list of falsifiable assertions of what success means, written before any code — which you ratify at the last gate before the build and a fresh session verifies against the built system before the Ship gate. A failed assertion routes back to the workflow's fixer — the builder; relay's judge — to fix and re-verify first, holding the gate for you only if it stays broken after a bounded loop — you see a summary of what self-healed, not every fix. On relay the verify earns extra weight: the judge both grades and edits the build there, so the consultant's fresh session is the one fully independent pass.
- **Interactive worker transport (advanced, experimental).** Add `transport = "interactive"` under a claude maker duty (`[duties.builder]` or `[duties.architect]`) to drive the interactive `claude` TUI instead of headless `claude -p`, so those turns bill your flat subscription quota rather than the metered credit pool. tmux-driven, maker-duties only, pending one live-auth check — see [`docs/interactive-transport.md`](docs/interactive-transport.md).

## Customizing the snippets

**What they are.** The snippets are the prompt templates the orchestrator sends the workers — they _are_ the workflow, and greenflag ships an opinionated set: leader-facing specs, TDD-shaped vertical-slice planning, altitude-tuned review lenses. The catalog of the ones worth customizing, with their full bodies, is the [snippet reference](docs/snippets.md).

**Why you'd change one.** To make greenflag work _your_ way without forking it — plan to a different methodology, write specs in a different shape, dial your checkers' altitude up or down. The biggest levers are the **generative drafts** — `write-spec`, `start-plan`, `implement-direct` — which write the _first_ artifact of each phase, so reshaping one reshapes everything downstream.

**How — two grains.**

- **Coarse: swap the methodology.** The planning snippets cite greenflag's vendored design and testing lessons through a `{{lessons_dir}}` token. Point it at your own methodology and one swap shifts how the whole plan phase reasons — without editing individual prompts.
- **Fine: override a snippet.** Replace any single snippet's body, by key, from two optional files layered over the shipped defaults:

  | Layer   | File                           | Scope              |
  | ------- | ------------------------------ | ------------------ |
  | user    | `~/.config/greenflag/snippets.toml` | you, every project |
  | project | `<repo>/.greenflag/snippets.toml`   | one repo           |

  Both use the shipped library's `[[snippets]]` schema (`key` + `expand`). Precedence is **shipped → user → project**, last-wins per key; an override replaces a snippet's _whole_ body (no partial patching). The reference doc has a [worked example](docs/snippets.md#worked-example-overriding-start-plan-to-a-non-tdd-methodology) — overriding `start-plan` to a walking-skeleton (non-TDD) methodology, with the actual `[[snippets]]` block.

Mechanics:

- **Fail-closed.** An override naming a key that isn't in the shipped library is a hard error — naming the file and the bad key, so a typo can't silently vanish.
- **Invisible when unused.** With no override files present, the served library is byte-for-byte the shipped one; overriding is opt-out, and a run with no overrides behaves exactly as before.
- **Inspect it.** `greenflag snippets` lists every key and the layer it resolves from; `greenflag snippets show <key>` prints the effective body.
- **Commit a project override** by carving `!/snippets.toml` into the repo's `.greenflag/.gitignore` (the same move `.greenflag/templates/` uses); without that line, `.greenflag/` ignores it like other run artifacts.

**Override at your own cost.** The surface is unrestricted on purpose — every key is overridable, including the ones below — but a few snippets are load-bearing for greenflag's safety machinery, and a weaker version quietly weakens the guardrail:

- `consultant-contract` / `consultant-verify` carry the acceptance-contract pair; softening them degrades the falsifiable-success check a fresh session runs before the Ship gate.
- The gate-adjacent prompts — the severity wording the consultant assigns, the `implementation-handoff` that frames the final review — shape what reaches a human gate.

The _structural_ gates are code and can't be forged from a prompt; what an override can erode is the _quality of the signal_ feeding a gate decision. Override these knowingly.

**Framing stays primary.** A snippet override customizes the _tool_ — it's the same kind of artifact as greenflag's own shipped library — not your project. It is **not** the place to tell greenflag about your codebase; that is the framing's job, the single project-knowledge seam. The project layer is a deliberate, opt-in, at-your-own-cost secondary channel, nothing more.

## Going deeper

The `docs/` folder is the real design record. Suggested reading order:

1. [`docs/observed-pattern.md`](docs/observed-pattern.md) — the manual workflow this automates, from a real session
2. [`docs/automation-design.md`](docs/automation-design.md) — the design spine: voices, layers, workflows, gates, policies (mechanism satellites: `run-operations`, `afk-resilience`, `consultant`, `voices-and-providers`)
3. [`docs/open-questions.md`](docs/open-questions.md) — what's decided, what's open, and the evidence
4. [`docs/engineering.md`](docs/engineering.md) — how the code is shaped (read before changing it)

Two Claude Code skills ship with greenflag (installed with `npx skills add` above): **greenflag-frame** authors a run's framing — the workflow above — and **greenflag-concierge** lets you start and supervise a run from a chat session, greenflag's "remote control" from your phone, without greenflag building any remote infrastructure of its own.

## Development & status

**Status.** Early and personal. Live-verified end to end, on real work:

- **all four shipped workflows** — full and short on both orchestrator hosts (headless and interactive), and **blueprint** + **relay** via the 2026-07-07 three-run series on greenflag itself ([findings](docs/researches/2026-07-07-live-run-series-findings.md)): three framings → three AFK deliveries → three merged PRs, every human stop graded
- **composing your own workflow** — the `greenflag/workflows` SDK end to end (an authored `deep-relay` definition → compile-and-freeze → gateless run → open PR; run `20260705-1731-58a5`), which also gave the 2026-07-04 duty-keyed remodel its first live run and live-exercised the **fixer** (judge) delivery posture, the severity holds (two mid-run holds, both genuine catches), and the pre-run `greenflag workflows` inspector
- the optional **consultant** and the **acceptance contract** (frozen success assertions, verified against the built system, self-healing through the workflow's fixer before they hold a gate) — the hold path included: a mis-authored frozen assertion failed verify and held the Ship gate rather than shipping past it
- the **gateless** walk-away posture, run supervision (`greenflag doctor`, default-on infra retry), the shared PR-only **`finish`** tail, and `greenflag stats`

- the **evaluation loop, end to end** — the **run corpus** (the series' three records mirrored live, transcripts captured gzipped), **decision grading** (`greenflag grade`'s first real sessions produced the first instrumented triage-precision numbers — over-flag 0%, under-flag 14% — and caught a real classification bug the same day, PR #39), the **`greenflag graph`** / **`greenflag stats --trace`** views pointed at live runs, **inline provider tuning** (every series framing carried explicit per-binding models + efforts, preflighted at creation), and corpus **replay**'s first slice reconstructing a real record dry-run — the method lives in [`docs/corpus-runbook.md`](docs/corpus-runbook.md)

Built and test-verified, awaiting a first live run:

- the **live driven-replay diff** — replay's fresh-vs-original routing diff needs API-key/Bedrock/Vertex auth (the record-isolation contract correctly fails closed on OAuth Claude Code); the dry-run reconstruction already ran on a real record, so this is a one-command re-run once auth is set
- the experimental **interactive-Claude worker transport** (bill a maker duty's turns to your flat subscription quota) — pending one live-auth check; see [`docs/interactive-transport.md`](docs/interactive-transport.md)

Codex-as-orchestrator is deliberately unbuilt. Expect rough edges — the open _design_ questions and their evidence live in [`docs/open-questions.md`](docs/open-questions.md).

No build step in dev — Node 24 runs the TypeScript directly:

```bash
pnpm typecheck
pnpm test
```

Releases run on [changesets](https://github.com/changesets/changesets) and publish through pnpm (`npm publish` is refused) — the commands are in [`docs/publish-runbook.md`](docs/publish-runbook.md).

The codebase's mental model lives in [`docs/engineering.md`](docs/engineering.md) — read it before changing code.

## License

[MIT](LICENSE)
