# duet

**A semi-AFK orchestrator for a two-agent AI coding workflow — one agent makes each artifact, another checks it, and an LLM routes between them while you stay the editor-in-chief.**

If you already run two coding agents in parallel — one writing specs/plans/code, one critiquing them — and spend your day copy-pasting between them and nudging each along, that's the workflow duet automates. A read-only **orchestrator** drives the hand-offs — it picks the right prompt, routes each agent's output to the other, and decides when a review loop has converged — and pauses at **human gates** that no agent can cross. You approve the early decisions, walk away, and come back to an opened pull request or a well-formed question waiting for you.

It's a personal tool, built for one developer's workflow across their own projects, and published in case the shape is useful to you — not a polished product. Expect rough edges.

## How it works

A run executes one **workflow** in two **stages** — an attended **planning** stage and an AFK **delivery** stage — and each stage pairs two **workers**, identified by **duty**: planning's **architect** drafts the documents and its **analyst** critiques them; delivery's **builder** writes the code and its **critic** reviews it (on the relay workflow the checker is a **judge**, which also fixes what it finds). Every duty can bind to either provider (`claude` or `codex`); the **orchestrator** must be `claude` in v1 — Codex-as-orchestrator is designed but unbuilt:

| Voice | Does | Default |
|---|---|---|
| **Orchestrator** | Routes the protocol — never writes code, only triages and decides who answers what | `claude` (Opus) |
| **architect** · **builder** — the makers | The architect writes the spec, plan, or design doc; the builder writes the code and the PR | `claude` (Opus) |
| **analyst** · **critic** / **judge** — the checkers | Critique each artifact — read-only, except relay's judge, which fixes findings directly and owns the docs + PR | `codex` |

You pick the workflow at the start (`--workflow`). Under the hood the workflows aren't four hand-built pipelines — each is composed from the same few **phase blocks** (a framing analysis, a document loop, the AFK build, a finishing phase that opens the PR) with named knobs: which document the loop produces, whether the delivery checker critiques or fixes, who owns the finishing steps, which sessions carry across the stage boundary. duet ships four compositions as its standard library; the vocabulary is how the set grows. Each `→` is a phase the agents work through; each **GATE** is a stop where the run waits for you:

```
full       frame → DIRECTION → spec → COMMIT-SPEC → plan → PLAN (walk away)
             → implement (AFK, often hours) → SHIP → finish (open the PR) → OPEN-PR → done

blueprint  frame → DIRECTION (auto-crosses) → design → DESIGN (your one stop — then walk away)
             → implement (AFK) → SHIP → finish (open the PR) → OPEN-PR → done

relay      frame → DIRECTION (auto-crosses) → design → DESIGN (your one stop)
             → implement (AFK: a fresh builder implements the doc; the judge reviews AND fixes)
             → SHIP → finish (the judge opens the PR) → OPEN-PR → done

short      research → DIRECTION (walk away) → implement (AFK) → SHIP
             → finish (open the PR) → OPEN-PR → done
```

- **full** — the thorough workflow: a spec and a plan, each drafted and reviewed on paper before any code. Pick it for unfamiliar or risky work, where the product spec and the technical plan each deserve their own review.
- **blueprint** — the middle workflow: one committed **design doc** replaces the spec + plan pair — product goals and behaviors on top, module boundaries and test standards below — reviewed in a single loop. Pick it for serious work on a builder model you trust: by default you read one document, tap once, and walk away.
- **relay** — blueprint's shape with the delivery **criss-crossed**: after the design doc commits, a fresh **builder** on a fast, cheaper binding implements the doc, while the checking duty goes to a **judge** on a strong model that doesn't just file critiques — it fixes ordinary findings in place, owns the docs pass, and opens the PR, escalating anything that smells like a design change instead of patching over it. Pick it when the doc is strong enough that the build is labor, not judgment. The model pairing is yours to bind (`--bind builder=… --bind judge=…` — see [Configure](#configure)); the workflow supplies the shape.
- **short** — the fast workflow: no documents at all; the research decisions are the design. Pick it for small, well-understood changes.

Every workflow shares the same AFK implementation phase and ends by opening a real pull request. Composing your *own* workflow from the blocks isn't exposed yet — the vocabulary is internal today, and external workflow definitions are a documented direction, deliberately gated on a real composition the shipped set doesn't cover ([`docs/future-directions.md`](docs/future-directions.md)).

The gates are enforced in code (a statechart), not by a prompt an agent could be talked out of. Between stops a detached background process drives the phase; nothing runs while a run is parked, and you get a desktop notification at every stop. Three things worth knowing about how a run ends:

- Docs are reconciled as the last step of implementation, so the **SHIP** gate reviews code and docs together; `finish` just writes the description and opens the PR.
- The **OPEN-PR** gate sits *after* the PR opens. Under the hands-off defaults it auto-crosses to done; to stop and review the opened PR, list `finish` in `--gates-at` (rejecting there amends the PR in place). A bare short run still attends all of its gates.
- A pre-authorized gate auto-crosses only on a clean packet: a `high`-severity decision in it holds the run for you instead, and an `ask_human` question stops the run under any posture. The merge is always yours.

Each phase runs a handful of prompt templates — **snippets** — that carry the workflow's conventions. The stage's maker drafts each artifact from one — the architect from [`write-spec`](docs/snippets.md#write-spec) in spec, [`start-plan`](docs/snippets.md#start-plan) in plan, and [`write-design`](docs/snippets.md#the-blueprint-snippets) on blueprint and relay; the builder from [`implement-direct`](docs/snippets.md#implement-direct) on short — and the checker critiques through altitude-tuned lenses like [`review-spec`](docs/snippets.md#review-spec) (the analyst) and [`review-implementation`](docs/snippets.md#review-implementation) (the critic). Relay's judge works from [`review-and-fix`](docs/snippets.md#review-and-fix) — the same lens, plus the authority to fix what it finds. The snippets are the substance of the workflow, and the part you can reshape to your own methodology — see [Customizing the snippets](#customizing-the-snippets), or the full [snippet reference](docs/snippets.md).

## What it is — and isn't

Four ideas shape every design choice:

- **Augment, don't replace.** duet drives the same `claude` and `codex` CLIs you already use, with the same prompts, against the same repo. Every artifact — transcripts, branches, commits — is something you could have made by hand. There's no "duet mode" you get locked into.
- **You own the substance.** The orchestrator does triage, never opinions. Product, direction, and environment questions always reach you; it only decides *who* answers. The gates are structural, not a promise in a prompt.
- **Stop anytime.** A run can be paused indefinitely. The state file is a hint; the agents' transcripts are the truth. Drop out to drive `claude --resume` / `codex resume` by hand, then pick duet back up later — or never.
- **Not a daemon, not an app.** A small CLI you invoke per gate. No GUI, no background service, no webhooks.

**It is not** a general orchestration framework — the workflows compose from a small internal vocabulary, but a neutral engine would be a commodity; what duet actually ships is the opinions (the snippets, the altitude-tuned review lenses, the gate discipline), and a knob exists only when a shipped workflow exercises it. Not multi-user, and not provider-agnostic — exactly two providers exist by design. It ships with no project conventions: which skills to run, where specs go, what context to seed all come from a **framing** you write at the start of each run.

## Install

Requirements: **Node 24+**, **pnpm**, and the **`claude`** and **`codex`** CLIs installed and authenticated (duet drives your existing setup).

duet isn't on npm yet — install from source:

```bash
git clone https://github.com/qiushiyan/duet
cd duet
pnpm install
pnpm add -g .   # links the global `duet` command
```

Then add the companion Claude Code skills used below:

```bash
npx skills add qiushiyan/duet                    # duet-frame + duet-concierge → ~/.claude/skills
npx skills add qiushiyan/duet --skill duet-frame # or just the one you need
```

## Getting started: the framing workflow

The smoothest way to run duet is to let a Claude Code session sharpen your problem, then drive the run from your own interactive session:

1. **Start with the problem.** A rough description in plain language — what to build or fix, plus any project context (which docs to read first, where specs live, how you verify).
2. **Shape it with `/duet-frame`.** In a Claude Code session, run `/duet-frame`. It turns the rough problem into a sharp **framing** — using your project's real names, structure, and gate posture — without changing what you asked for or proposing how to build it, and hands you the launch command.
3. **Launch the interactive run** in your terminal:
   ```bash
   duet new --interactive --framing .duet/<your-framing>.md
   ```
   Your own Claude Code session becomes the orchestrator: you act at the early gates right in the chat — the spec and plan on full, the design doc on blueprint, the direction on short.
4. **Walk away.** At the planning stage's last gate — plan approval (full), the Design gate (blueprint and relay), or Direction (short) — the session hands the run to a background driver, which implements semi-AFK, often for an hour or more. Under the hands-off defaults it then crosses the Ship gate and opens the PR, so you return to an opened pull request (with a CEO-style summary recorded for your morning review) — or a well-formed question waiting for you. Prefer to verify the build before it ships? Attend the Ship gate (`--gates-at skip-plan` on full).

> **Prefer the terminal?** Skip `--interactive` and run a headless framing turn instead — `duet new` opens your editor on a framing draft, then the orchestrator runs in the background and you act at each gate with `duet continue`.

Common ways to start a run:

```bash
duet new                       # editor on a framing draft (issue, context, scope)
duet new --template bug        # seed the draft from .duet/templates/bug.md
duet new --spec spec.md        # start from a draft you already wrote (full: a spec; blueprint: a design doc)
duet new --workflow blueprint  # the one-doc middle workflow — one attended gate by default
duet new --workflow relay      # blueprint criss-crossed — bind the delivery pair: --bind builder=… --bind judge=…
duet new --workflow short      # the fast workflow (add --gates-at afk to run unattended → PR open)
duet new --gates-at skip-plan  # full's default is hands-off after the spec; this returns you at the Ship gate
duet new --budget default      # opt in to per-turn cost caps (off by default)
duet new --gateless            # walk away from the START — every gate pre-authorized; with a consultant bound, its bet-audits are off but its framing read and the contract/verify backstop remain; still stoppable by ask_human / a correctness hold (conflicts with --interactive)
duet new --retry-infra 2       # tune the bounded infra auto-retry budget (default 3 for new runs; 0 disables)
```

Each workflow has a sensible hands-off default: **full** is `overnight` — approve the spec, then walk away (plan, Ship, and the Open-PR gate all auto-cross); **blueprint** and **relay** attend only their Design gate — one interruption for the whole run; **short** attends all three of its gates unless you say `afk`. `--gates-at` names the *complete* set of gates you attend, not a delta: `--gates-at finish` attends **only** the Open-PR gate — everything else auto-crosses; to keep the usual stops *and* add a post-open review, list them all.

## Everyday commands

Once a run is going, you mostly watch and decide:

```bash
duet status                    # where the run is, and the exact command to act next
duet status --brief            # lean digest: position, stop kind, headline, next command (drops the full packet)
duet status --json --wait      # block until the next stop, then print (scripting/supervision)
duet doctor                    # per-voice health: working / thinking / retrying / stuck / crashed
duet stats                     # effort per phase — each phase's elapsed window and worker-turn time, from the logs

duet continue --approve        # cross the current gate (optionally: --approve "a rider with tweaks")
duet continue --reject "..."   # send the artifact back; your words reach the orchestrator verbatim
duet continue --answer "..."   # answer a queued question

duet steer "..."               # nudge the orchestrator mid-phase, without pausing the run
duet afk                       # from an interactive gate, hand the rest to the headless driver
duet takeover critic           # drop into a duty's raw CLI session yourself; resume duet after
duet abandon                   # stop a run for good; --purge also deletes its sessions

duet orchestrate               # reconnect the interactive orchestrator after a dropped session
duet logs                      # stream the orchestrator's narration inline
duet view                      # tmux panes, one per voice (or pass --tmux to new/continue)
duet runs                      # list runs in this project
```

Run state lives under `.duet/runs/<id>/` (self-ignored from git). `state.json` is a convenience hint; the voices' provider transcripts are the source of truth.

When most of a framing repeats run to run, save the common part as a template under `.duet/templates/<name>.md` and seed each draft from it (`duet new --template <name>`); how to author them is in [`docs/automation-design.md`](docs/automation-design.md).

A framing (and a template) may open with a small machine-readable **frontmatter** block — the run's **manifest**: fixed-value knobs the harness acts on without judgment (`workflow`, `gates_at`, `gateless`, `interactive`, `consultant`, `spec`, `retry_infra`, and `bind.<duty>` binding keys) — above the prose body, where all project judgment lives. Unknown keys fail loudly. Each knob resolves per key — flags > framing > config > shipped defaults — once at run creation, is frozen on the run, and is echoed back by `duet new`. Here `consultant` is an `on`/`off` toggle; the provider/model binding rides `bind.consultant:` (or config / `--bind consultant=…`), and setting a binding alone implies `on`. The frontmatter is only for values with a deterministic consumer; anything the orchestrator should weigh stays prose. The authoritative key reference lives in [`docs/automation-design.md`](docs/automation-design.md).

## Configure

duet's one config file holds account-level defaults — which provider (and model) each voice runs on, plus your billing posture — and nothing else. It's optional: the defaults work out of the box (the orchestrator and the maker duties on claude/Opus, the checker duties on codex — the cross-family review is the shipped posture). Reach for it when you want a different provider or model behind a duty, or a different billing setup — create `~/.config/duet/config.toml`:

```toml
budget = "off"              # opt-in per-turn cost caps: "off" (default), "default", or a multiplier like 0.5/2

[orchestrator]
provider = "claude"         # must be claude in v1 — codex-as-orchestrator is designed but unbuilt
model = "claude-opus-4-8"   # any Anthropic model id

[duties.architect]          # planning's maker — drafts the spec / plan / design doc
provider = "claude"
model = "claude-opus-4-8"

[duties.analyst]            # planning's checker — critiques the documents
provider = "codex"          # no model key — your ~/.codex/config.toml governs

[duties.builder]            # delivery's maker — writes the code and the PR
provider = "claude"
model = "claude-opus-4-8"

[duties.critic]             # delivery's checker on full/blueprint/short — read-only review
provider = "codex"

[duties.judge]              # delivery's checker on relay — reviews with write access
provider = "claude"
model = "claude-opus-4-8"
```

That's the only config duet has — per-duty (and orchestrator/consultant) provider bindings plus billing posture (`transport`, `budget`), nothing else. Project knowledge never lives here; it goes in the framing.

- **Bindings are per duty; a run overrides them per key.** Config is the account-level default tier; a single run rebinds any duty with the repeatable `--bind <duty>=<provider[:model]>` flag or a framing `bind.<duty>:` key — a duty alone names its stage, so relay's criss-cross is just two flags (`--bind builder=codex --bind judge=claude:claude-opus-4-8`: plan strong, build cheap, judge strong). On full, blueprint, and short the delivery duties *continue* the planning sessions (builder ← architect, critic ← analyst — declared continuity edges); relay's delivery starts fresh by design. An edge whose two duties' frozen bindings cross providers degrades to a fresh session at run creation — echoed by `duet new` and ledgered, never an error — with the committed document as the build's context.
- **Consultant (optional, off by default).** Add a `[consultant]` table (or `--bind consultant=<provider[:model]>` per run — a binding alone implies it's on) for a second, read-only advisor voice that questions the *bet* (assumptions, product fit) rather than the build — ideally on a different model family from your checkers, which is the point. `--no-consultant` disables a configured one for a single run. On the document-bearing workflows (full, blueprint, relay) it also authors an **acceptance contract** — a short, frozen list of falsifiable assertions of what success means, written before any code — which you ratify at the last gate before the build and a fresh session verifies against the built system before the Ship gate. A failed assertion routes back to the workflow's fixer — the builder; relay's judge — to fix and re-verify first, holding the gate for you only if it stays broken after a bounded loop — you see a summary of what self-healed, not every fix. On relay the verify earns extra weight: the judge both grades and edits the build there, so the consultant's fresh session is the one fully independent pass.
- **Interactive worker transport (advanced, experimental).** Add `transport = "interactive"` under a claude maker duty (`[duties.builder]` or `[duties.architect]`) to drive the interactive `claude` TUI instead of headless `claude -p`, so those turns bill your flat subscription quota rather than the metered credit pool. tmux-driven, maker-duties only, pending one live-auth check — see [`docs/interactive-transport.md`](docs/interactive-transport.md).

## Customizing the snippets

**What they are.** The snippets are the prompt templates the orchestrator sends the workers — they *are* the workflow, and duet ships an opinionated set: leader-facing specs, TDD-shaped vertical-slice planning, altitude-tuned review lenses. The catalog of the ones worth customizing, with their full bodies, is the [snippet reference](docs/snippets.md).

**Why you'd change one.** To make duet work *your* way without forking it — plan to a different methodology, write specs in a different shape, dial your checkers' altitude up or down. The biggest levers are the **generative drafts** — [`write-spec`](docs/snippets.md#write-spec), [`start-plan`](docs/snippets.md#start-plan), [`implement-direct`](docs/snippets.md#implement-direct) — which write the *first* artifact of each phase, so reshaping one reshapes everything downstream.

**How — two grains.**

- **Coarse: swap the methodology.** The planning snippets cite duet's vendored design and testing lessons through a `{{lessons_dir}}` token. Point it at your own methodology and one swap shifts how the whole plan phase reasons — without editing individual prompts.
- **Fine: override a snippet.** Replace any single snippet's body, by key, from two optional files layered over the shipped defaults:

  | Layer | File | Scope |
  |---|---|---|
  | user | `~/.config/duet/snippets.toml` | you, every project |
  | project | `<repo>/.duet/snippets.toml` | one repo |

  Both use the shipped library's `[[snippets]]` schema (`key` + `expand`). Precedence is **shipped → user → project**, last-wins per key; an override replaces a snippet's *whole* body (no partial patching). The reference doc has a [worked example](docs/snippets.md#worked-example-overriding-start-plan-to-a-non-tdd-methodology) — overriding `start-plan` to a walking-skeleton (non-TDD) methodology, with the actual `[[snippets]]` block.

Mechanics:

- **Fail-closed.** An override naming a key that isn't in the shipped library is a hard error — naming the file and the bad key, so a typo can't silently vanish.
- **Invisible when unused.** With no override files present, the served library is byte-for-byte the shipped one; overriding is opt-out, and a run with no overrides behaves exactly as before.
- **Inspect it.** `duet snippets` lists every key and the layer it resolves from; `duet snippets show <key>` prints the effective body.
- **Commit a project override** by carving `!/snippets.toml` into the repo's `.duet/.gitignore` (the same move `.duet/templates/` uses); without that line, `.duet/` ignores it like other run artifacts.

**Override at your own cost.** The surface is unrestricted on purpose — every key is overridable, including the ones below — but a few snippets are load-bearing for duet's safety machinery, and a weaker version quietly weakens the guardrail:

- `consultant-contract` / `consultant-verify` carry the acceptance-contract pair; softening them degrades the falsifiable-success check a fresh session runs before the Ship gate.
- The gate-adjacent prompts — the severity wording the consultant assigns, the `implementation-handoff` that frames the final review — shape what reaches a human gate.

The *structural* gates are code and can't be forged from a prompt; what an override can erode is the *quality of the signal* feeding a gate decision. Override these knowingly.

**Framing stays primary.** A snippet override customizes the *tool* — it's the same kind of artifact as duet's own shipped library — not your project. It is **not** the place to tell duet about your codebase; that is the framing's job, the single project-knowledge seam. The project layer is a deliberate, opt-in, at-your-own-cost secondary channel, nothing more.

## Going deeper

The `docs/` folder is the real design record. Suggested reading order:

1. [`docs/observed-pattern.md`](docs/observed-pattern.md) — the manual workflow this automates, from a real session
2. [`docs/workflow-model.md`](docs/workflow-model.md) — that pattern abstracted into phases and vocabulary
3. [`docs/automation-design.md`](docs/automation-design.md) — the design: voices, layers, gates, policies
4. [`docs/open-questions.md`](docs/open-questions.md) — what's decided, what's open, and the evidence
5. [`docs/engineering.md`](docs/engineering.md) — how the code is shaped (read before changing it)

Two Claude Code skills ship with duet (installed with `npx skills add` above): **duet-frame** authors a run's framing — the workflow above — and **duet-concierge** lets you start and supervise a run from a chat session, duet's "remote control" from your phone, without duet building any remote infrastructure of its own.

## Development & status

**Status.** Early and personal. Live-verified end to end, on real work (pre-remodel — the 2026-07-04 duty-keyed domain remodel itself is test-verified, awaiting its first live run):

- the **full** and **short** workflows, on both orchestrator hosts (headless and interactive)
- the optional **consultant** and the **acceptance contract** (frozen success assertions, verified against the built system, self-healing through the workflow's fixer before they hold a gate)
- the **gateless** walk-away posture, run supervision (`duet doctor`, default-on infra retry), the shared PR-only **`finish`** tail, and `duet stats`

Built and test-verified, awaiting a first live run:

- the **blueprint** workflow — the one-doc middle workflow above
- the **relay** workflow and the **workflow vocabulary** beneath it (workflows as compositions of phase blocks with knobs; [`docs/automation-design.md`](docs/automation-design.md) §"The workflow vocabulary") — relay plans on a strong model, builds on a cheap one via per-duty `--bind` bindings, and checks with a writing **judge** that fixes findings directly and owns the docs + PR
- the experimental **interactive-Claude worker transport** (bill a maker duty's turns to your flat subscription quota) — pending one live-auth check; see [`docs/interactive-transport.md`](docs/interactive-transport.md)
- **warm-starting** the interactive orchestrator from an existing session (`--resume-session`)
- the **AFK-resilience hardening** (stream watchdog, wall-clock caps, compaction recovery, context-pressure guards) — test-verified at the seams and probed against real transcripts; the induced-failure checks (a stalled stream, a real suspend) are still manual

Codex-as-orchestrator is deliberately unbuilt. Expect rough edges — the open *design* questions and their evidence live in [`docs/open-questions.md`](docs/open-questions.md).

No build step in dev — Node 24 runs the TypeScript directly:

```bash
pnpm typecheck
pnpm test
```

The codebase's mental model lives in [`docs/engineering.md`](docs/engineering.md) — read it before changing code.

## License

[MIT](LICENSE)
