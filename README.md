# duet

**A semi-AFK orchestrator for a two-agent AI coding workflow — one agent implements, another reviews, and an LLM routes between them while you stay the editor-in-chief.**

If you already run two coding agents in parallel — one writing specs/plans/code, one critiquing them — and spend your day copy-pasting between them and nudging each along, that's the workflow duet automates. A read-only **orchestrator** drives the hand-offs — it picks the right prompt, routes each agent's output to the other, and decides when a review loop has converged — and pauses at **human gates** that no agent can cross. You approve the direction and the spec, walk away, and come back to an opened pull request or a well-formed question waiting for you.

It's a personal tool, built for one developer's workflow across their own projects, and published in case the shape is useful to you — not a polished product. Expect rough edges.

## How it works

Three roles. The two **workers** can each run on either provider (`claude` or `codex`); the **orchestrator** must be `claude` in v1 — Codex-as-orchestrator is designed but unbuilt:

| Role | Does | Default |
|---|---|---|
| **Orchestrator** | Routes the protocol — never writes code, only triages and decides who answers what | `claude` (Opus) |
| **Implementer** | Writes specs, plans, code, the PR | `claude` (Opus) |
| **Reviewer** | Critiques each artifact (review-only) | `codex` |

A run moves through an arc you pick at the start (`--workflow`). Each `→` is a phase the agents work through; each **GATE** is a stop where the run waits for you:

```
full  frame → DIRECTION → spec → COMMIT-SPEC → plan → PLAN (walk away)
        → implementation (AFK, often hours) → SHIP → finish (reconcile docs → PR) → OPEN-PR → done

rir   research → DIRECTION (walk away) → implementation (AFK) → SHIP
        → publish (reconcile docs → PR) → OPEN-PR → done
```

**full** is the thorough arc — settle the design on paper, end in a pull request. **rir** (Research → Implement → Review) is lighter: the research decisions are the design, so it skips spec and plan. Use full for epic-shaped work, rir for small, well-understood changes. Both end in a PR — rir's `publish` phase mirrors full's `finish`.

The gates are enforced in code (an XState statechart), not a prompt the orchestrator could be talked out of. Between stops a detached background process drives the phase; nothing runs while a run is parked, and you get a desktop notification at every stop. The `finish` phase (rir's `publish` mirrors it) reconciles the docs, writes the description, and opens the PR; the final **OPEN-PR** gate sits *after* the open. On full it auto-crosses to done under the default `overnight` posture; on rir it auto-crosses only under `--gates-at afk` — a bare rir run attends all of its gates. To stop for a post-open review of the opened PR, attend that gate — list `finish` on full or `publish` on rir in `--gates-at` (rejecting there amends the open PR in place). A pre-authorized gate auto-crosses only on a clean packet: a `high` human-decision in the packet holds it for you instead, and an `ask_human` question stops the run under any posture. The merge is always yours.

Each phase runs a handful of prompt templates — **snippets** — that carry the workflow's conventions. The implementer drafts each artifact from one — [`write-spec`](docs/snippets.md#write-spec) in spec, [`start-plan`](docs/snippets.md#start-plan) in plan, [`implement-direct`](docs/snippets.md#implement-direct) on the lighter rir arc — and the reviewer critiques through altitude-tuned lenses like [`review-spec`](docs/snippets.md#review-spec) and [`review-plan`](docs/snippets.md#review-plan). The snippets are the substance of the workflow, and the part you can reshape to your own methodology — see [Customizing the snippets](#customizing-the-snippets), or the full [snippet reference](docs/snippets.md).

## What it is — and isn't

Four ideas shape every design choice:

- **Augment, don't replace.** duet drives the same `claude` and `codex` CLIs you already use, with the same prompts, against the same repo. Every artifact — transcripts, branches, commits — is something you could have made by hand. There's no "duet mode" you get locked into.
- **You own the substance.** The orchestrator does triage, never opinions. Product, direction, and environment questions always reach you; it only decides *who* answers. The gates are structural, not a promise in a prompt.
- **Stop anytime.** A run can be paused indefinitely. The state file is a hint; the agents' transcripts are the truth. Drop out to drive `claude --resume` / `codex resume` by hand, then pick duet back up later — or never.
- **Not a daemon, not an app.** A small CLI you invoke per gate. No GUI, no background service, no webhooks.

**It is not** a general orchestration framework, not multi-user, and not provider-agnostic — exactly two providers exist by design. It ships with no project conventions: which skills to run, where specs go, what context to seed all come from a **framing** you write at the start of each run.

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
   Your own Claude Code session becomes the orchestrator: you approve the direction (and, on the full arc, the spec and plan) right in the chat.
4. **Walk away.** The interactive session hands the run off to a background driver at the handoff gate — plan approval (full) or the Direction gate (rir) — and it implements semi-AFK, often for an hour or more. Under the default `overnight` posture (full) it then auto-crosses the Ship gate and opens the PR, so you return to an opened pull request (with the Ship packet — a CEO-style summary — recorded for your morning review) — or a well-formed question waiting for you. The rir `afk` posture is the same shape. Prefer to verify the build before it ships? Attend the Ship gate (`--gates-at skip-plan` on full).

> **Prefer the terminal?** Skip `--interactive` and run a headless framing turn instead — `duet new` opens your editor on a framing draft, then the orchestrator runs in the background and you act at each gate with `duet continue`.

Common ways to start a run:

```bash
duet new                       # editor on a framing draft (issue, context, scope)
duet new --template bug        # seed the draft from .duet/templates/bug.md
duet new --spec spec.md        # start from a spec you already wrote (full arc)
duet new --workflow rir        # the lighter arc (add --gates-at afk to run unattended → PR open)
duet new --gates-at skip-plan  # default is hands-off after the spec; this returns you at the Ship gate
duet new --budget default      # opt in to per-turn cost caps (off by default)
duet new --gateless            # walk away from the START — every gate pre-authorized; with a consultant bound, its bet-audits are off but the contract/verify backstop remains; still stoppable by ask_human / a correctness hold (conflicts with --interactive)
duet new --retry-infra 2       # opt in to bounded auto-retry of transient infra errors (off by default)
```

full's default posture is `overnight` — you approve the spec, then walk away for the rest (plan, Ship, and the Open-PR gate all auto-cross). `--gates-at` names the *complete* set of gates you attend, not a delta: `--gates-at finish` attends **only** the Open-PR gate — even Direction and Commit-spec then auto-cross; to keep the usual stops *and* add a post-open review of the opened PR, list them all.

## Everyday commands

Once a run is going, you mostly watch and decide:

```bash
duet status                    # where the run is, and the exact command to act next
duet status --brief            # lean digest: position, stop kind, headline, next command (drops the full packet)
duet status --json --wait      # block until the next stop, then print (scripting/supervision)
duet doctor                    # per-role health: working / thinking / retrying / stuck / crashed
duet stats                     # effort per phase — each phase's elapsed window and worker-turn time, from the logs

duet continue --approve        # cross the current gate (optionally: --approve "a rider with tweaks")
duet continue --reject "..."   # send the artifact back; your words reach the orchestrator verbatim
duet continue --answer "..."   # answer a queued question

duet steer "..."               # nudge the orchestrator mid-phase, without pausing the run
duet afk                       # from an interactive gate, hand the rest to the headless driver
duet takeover reviewer         # drop into the raw CLI session yourself; resume duet after
duet abandon                   # stop a run for good; --purge also deletes its sessions

duet orchestrate               # reconnect the interactive orchestrator after a dropped session
duet logs                      # stream the orchestrator's narration inline
duet view                      # tmux panes, one per voice (or pass --tmux to new/continue)
duet runs                      # list runs in this project
```

Run state lives under `.duet/runs/<id>/` (self-ignored from git). `state.json` is a convenience hint; the three agent transcripts are the source of truth.

When most of a framing repeats run to run, save the common part as a template under `.duet/templates/<name>.md` and seed each draft from it (`duet new --template <name>`); how to author them is in [`docs/automation-design.md`](docs/automation-design.md).

A framing (and a template) may open with a small machine-readable **frontmatter** block — fixed-value knobs the harness acts on without judgment (`workflow`, `gates_at`, `gateless`, `interactive`, `consultant`, `spec`, `retry_infra`) — above the prose body, where all project judgment lives. Unknown keys fail loudly. Here `consultant` is an `on`/`off` toggle only — it flips a consultant on or off for the run; the provider/model binding stays in config or `--consultant`. The frontmatter is only for values with a deterministic consumer; anything the orchestrator should weigh stays prose. The authoritative key reference lives in [`docs/automation-design.md`](docs/automation-design.md).

## Configure

duet's one config file binds each role to a provider and model, plus your billing posture — and nothing else. It's optional: the defaults work out of the box. Reach for it when you want a different provider or model behind a role, or a different billing setup — create `~/.config/duet/config.toml`:

```toml
budget = "off"              # opt-in per-turn cost caps: "off" (default), "default", or a multiplier like 0.5/2

[roles.orchestrator]
provider = "claude"         # must be claude in v1 — codex-as-orchestrator is designed but unbuilt
model = "claude-opus-4-8"   # any Anthropic model id

[roles.implementer]
provider = "claude"
model = "claude-opus-4-8"

[roles.reviewer]
provider = "codex"          # no model key — your ~/.codex/config.toml governs
```

That's the only config duet has — role-to-provider bindings plus billing posture (`transport`, `budget`), nothing else. Project knowledge never lives here; it goes in the framing.

- **Consultant (optional, off by default).** Add `[roles.consultant]`, or pass `--consultant <provider[:model]>` per run, for a second, read-only reviewer that questions the *bet* (assumptions, product fit) rather than the build — ideally on a different model family from your reviewer, which is the point. `--no-consultant` disables a configured one for a single run. On the full arc it also authors an **acceptance contract** — a short, frozen list of falsifiable assertions of what success means, written blind to the plan, which you ratify at the plan gate and a fresh session verifies against the built system before the Ship gate. A failed assertion routes to the implementer to fix and re-verify first, holding the gate for you only if it stays broken after a bounded loop — you see a summary of what self-healed, not every fix.
- **Interactive implementer transport (advanced, experimental).** Add `transport = "interactive"` under `[roles.implementer]` to drive the interactive `claude` TUI instead of headless `claude -p`, so its turns bill your flat subscription quota rather than the metered credit pool. tmux-driven, implementer-only, pending one live-auth check — see [`docs/interactive-transport.md`](docs/interactive-transport.md).

## Customizing the snippets

**What they are.** The snippets are the prompt templates the orchestrator sends the workers — they *are* the workflow, and duet ships an opinionated set: leader-facing specs, TDD-shaped vertical-slice planning, altitude-tuned review lenses. The catalog of the ones worth customizing, with their full bodies, is the [snippet reference](docs/snippets.md).

**Why you'd change one.** To make duet work *your* way without forking it — plan to a different methodology, write specs in a different shape, dial your reviewer's altitude up or down. The biggest levers are the **generative drafts** — [`write-spec`](docs/snippets.md#write-spec), [`start-plan`](docs/snippets.md#start-plan), [`implement-direct`](docs/snippets.md#implement-direct) — which write the *first* artifact of each phase, so reshaping one reshapes everything downstream.

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
3. [`docs/automation-design.md`](docs/automation-design.md) — the design: roles, layers, gates, policies
4. [`docs/open-questions.md`](docs/open-questions.md) — what's decided, what's open, and the evidence
5. [`docs/engineering.md`](docs/engineering.md) — how the code is shaped (read before changing it)

Two Claude Code skills ship with duet (installed with `npx skills add` above): **duet-frame** authors a run's framing — the workflow above — and **duet-concierge** lets you start and supervise a run from a chat session, duet's "remote control" from your phone, without duet building any remote infrastructure of its own.

## Development & status

**Status.** Early and personal, but the whole workflow is now live-verified end to end: both the **full** and **rir** arcs, the headless and interactive orchestrator hosts, the optional **consultant** and its full-arc **acceptance contract** (a frozen list of falsifiable success assertions, authored blind to the plan and verified against the built system, with a failed assertion self-healing through the implementer before it holds), the **gateless** walk-away-from-the-start posture, run supervision (`duet doctor`, opt-in infra retry), the full arc's **`finish` phase** that collapsed the docs/pr/open tail (open-then-review, PR auto-open by default, `overnight` as full's default posture), **rir's `publish` phase** (its parallel finishing tail), and the `duet stats` verb have all run on real work. The one piece not yet proven on real work is the experimental **interactive-Claude implementer transport** (bill the implementer's turns to your flat subscription quota): built and green over fakes, but still pending its single live-auth check — see [`docs/interactive-transport.md`](docs/interactive-transport.md). Codex-as-orchestrator remains deliberately unbuilt. Expect rough edges — the open *design* questions and their evidence live in [`docs/open-questions.md`](docs/open-questions.md).

No build step in dev — Node 24 runs the TypeScript directly:

```bash
pnpm typecheck
pnpm test
```

The codebase's mental model lives in [`docs/engineering.md`](docs/engineering.md) — read it before changing code.

## License

[MIT](LICENSE)
