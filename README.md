# duet

**A semi-AFK orchestrator for a two-agent AI coding workflow — one agent implements, another reviews, and an LLM routes between them while you stay the editor-in-chief.**

If you already run two coding agents in parallel — one writing specs/plans/code, one critiquing them — and you spend your day copy-pasting between them and nudging each one along, that's the workflow duet automates. A read-only **orchestrator** drives the hand-offs (picks the right prompt, routes each agent's output to the other, decides when a review loop has converged) and pauses at **human gates** that no agent can cross. You approve the direction, walk away at the handoff gate (plan approval on the full arc, the Direction gate on the lighter rir arc), and come back to a finished pull request or a verified ship — or a well-formed question waiting for you.

It's a personal tool, built for one developer's workflow across their own projects. It's published in case the shape is useful to you, not as a polished product.

## How it works

Three roles, each bound to a provider (`claude` or `codex`):

| Role | Does | Default |
|---|---|---|
| **Orchestrator** | Routes the protocol — never writes code, only triages and decides who answers what | `claude` (Opus) |
| **Implementer** | Writes specs, plans, code, the PR | `claude` (Opus) |
| **Reviewer** | Critiques each artifact (review-only — never edits) | `codex` |

A run moves through an arc you pick at the start (`--workflow`). Each `→` is a phase the agents work through; each **GATE** is a stop where the run waits for you:

```
full  frame → DIRECTION → spec → COMMIT-SPEC → plan → PLAN (walk away)
        → implementation (AFK, often hours) → SHIP → docs → DOCS-PLAN → pr → OPEN-PR → done

rir   research → DIRECTION (walk away) → implementation (AFK) → SHIP → done
```

**full** is the thorough arc — settle the design on paper, end in a pull request. **rir** (Research → Implement → Review) is lighter: the research decisions are the design, so it skips the spec, plan, docs, and PR and ends at a verified Ship. Use full when the work is epic-shaped; rir for small, well-understood changes.

The gates are enforced in code (an XState statechart) — they aren't a prompt the orchestrator could be talked out of. Between stops a detached background process drives the phase; nothing runs while a run is parked, and you get a desktop notification at every stop. The final **OPEN-PR** gate opens the PR for you by default — list `pr` in `--gates-at` if you want a pre-open stop to read the description first; the merge is always yours.

## What it is — and isn't

Four ideas shape every design choice:

- **Augment, don't replace.** duet drives the same `claude` and `codex` CLIs you already use, with the same prompts, against the same repo. Every artifact it produces — transcripts, branches, commits — is something you could have made by hand. There's no "duet mode" you get locked into.
- **You own the substance.** The orchestrator does triage, never opinions. Product, direction, and environment questions always reach you; it only decides *who* should answer. The gates are structural, not a promise in a prompt.
- **Stop anytime.** A run can be paused indefinitely. The state file is a hint; the agents' transcripts are the truth. Drop out to drive `claude --resume` / `codex resume` by hand, add turns, and pick duet back up later — or never.
- **Not a daemon, not an app.** A small CLI you invoke per gate. No GUI, no background service, no webhooks. Use it today, walk away, pick it up the day after.

**It is not** a general orchestration framework, not multi-user, and not provider-agnostic — exactly two providers exist by design. It ships with no project conventions: which skills to run, where specs go, what context to seed all come from a **framing turn** you write at the start of each run.

## Status

Early and experimental. The full arc is implemented; the framing-through-ship path has been driven end-to-end on real features. The later phases (docs, PR) and overnight gate pre-authorization are built but not yet battle-tested. A second, lighter arc — **rir** (research → implement → ship, no spec/plan/docs/PR), selectable with `--workflow rir` — is implemented and unit/integration-verified (594 tests), but has not had a live end-to-end run (deferred to the same auth gate as the interactive orchestrator) and the environment smoke tests are still pending. An opt-in interactive-Claude transport for the implementer (which bills the flat subscription quota) is built as a spike, pending one live-auth check — [`docs/interactive-transport.md`](docs/interactive-transport.md). Running Claude Code itself as the orchestrator — your own interactive session driving a run over framing, spec, and planning while you steer in chat, before it hands off to the headless driver for implementation — is now built (`duet orchestrate` / `duet new --interactive`) and verified by the test suite; worker turns there are asynchronous, so a worker running for minutes no longer freezes your session (it dispatches and you collect the result when it lands). But no real Claude Code session has driven a live run yet (that end-to-end check is deferred to its auth gate) and the environment smoke tests are still pending ([`docs/future-directions.md`](docs/future-directions.md) §A). Supervising a run from outside it — a `duet doctor` health view, machine-readable triage signals, a lean `status --brief`, a hardened headless write path, and opt-in bounded retry of transient infra failures — is implemented and test-verified, its first live end-to-end run and the environment smoke tests still pending (one residual gap: the codex error-envelope classification is checked synthetically only, with no real codex error transcript yet). The latest work — the rails-and-UX bundle — makes duet's rails opt-in with friction-free defaults: the full arc's PR auto-opens by default (an opt-in pre-open stop), `duet afk` hands a run off mid-session from any gate, and per-turn budget caps are opt-in and degrade to a resumable checkpoint instead of crashing — implemented and unit/integration-verified (594 tests), with the environment smoke tests and a live interactive→headless `duet afk` handoff still pending (auth-gated). Expect rough edges. See [`docs/open-questions.md`](docs/open-questions.md) for what's verified versus still open.

## Requirements

- **Node 24+** (duet runs TypeScript directly — no build step in dev)
- **pnpm**
- The **`claude`** and **`codex`** CLIs installed and authenticated — duet drives your existing setup

## Install

Not on npm yet; install from source:

```bash
git clone https://github.com/qiushiyan/duet
cd duet
pnpm install
pnpm add -g .   # links the global `duet` command
```

## Configure

duet ships sensible defaults, so config is optional. To change which provider/model backs each role, create `~/.config/duet/config.toml`:

```toml
budget = "off"              # opt-in per-turn cost caps: "off" (default), "default", or a multiplier like 0.5/2

[roles.orchestrator]
provider = "claude"
model = "claude-opus-4-8"   # any Anthropic model id

[roles.implementer]
provider = "claude"
model = "claude-opus-4-8"

[roles.reviewer]
provider = "codex"          # no model key — your ~/.codex/config.toml governs
```

That's the only config duet has — role-to-provider bindings plus account/billing posture (`transport`, `budget`), nothing else. Project knowledge never lives here; it goes in the framing turn.

**Advanced (opt-in, experimental):** the claude implementer can drive the interactive `claude` TUI instead of headless `claude -p`, so its turns bill your **flat subscription quota** rather than the metered Agent-SDK credit pool — add `transport = "interactive"` under `[roles.implementer]`. It's a tmux-driven spike: implementer-only, requires a running tmux, and is still pending one live-auth check. See [`docs/interactive-transport.md`](docs/interactive-transport.md).

## Use

Start a run from inside your project repo:

```bash
duet new                       # opens your editor on a framing draft (the issue, context, scope)
duet new --template bug        # seed that draft from .duet/templates/bug.md, then fill in the problem
duet new --spec spec.md        # start from a spec you already wrote (full arc)
duet new --gates-at overnight  # pre-authorize later gates: approve the spec, then walk away
duet new --workflow rir        # the lighter arc: research → implement → ship (--gates-at afk to run unattended)
duet new --budget default      # opt in to per-turn cost caps (off by default); a multiplier like 0.5/2 scales them
```

The framing you write is duet's only briefing — the issue text, product context, which skills to invoke, where artifacts go. Save it and the run kicks off in the background.

`--gates-at` names the *complete* set of gates you attend — not a delta on the default. The PR now auto-opens by default, so `--gates-at pr` attends **only** the Open-PR gate (everything else auto-crosses); to keep the usual stops *and* add a pre-open PR stop, list them all.

### Templates

When most of a framing repeats run to run, save the common part as a template and seed each draft from it — one file per kind of work:

```text
.duet/templates/
├── default.md    # duet new                  (the bare default)
├── bug.md        # duet new --template bug
└── feature.md    # duet new --template feature
```

Each file is a full framing with the project-stable parts pre-filled; you fill in the problem before the run starts. How to author them: [`docs/automation-design.md`](docs/automation-design.md).

From there you mostly watch and decide:

```bash
duet status                    # where the run is, and the exact command to act next
duet status --json --wait      # block until the next stop, then print (good for scripting/supervision)
duet doctor                    # per-role health: working / thinking / retrying / stuck / crashed, + connectivity

duet continue --approve        # cross the current gate (optionally: --approve "a rider with tweaks")
duet continue --reject "..."   # send the artifact back; your words reach the orchestrator verbatim
duet continue --answer "..."   # answer a queued question

duet steer "..."               # nudge the orchestrator mid-phase, without pausing the run
duet afk                       # from an interactive gate, hand the rest of the run to the headless driver
duet takeover reviewer         # drop into the raw CLI session yourself; pick duet back up after
duet abandon                   # stop a run for good (kills its driver); --purge also deletes its sessions
```

And to follow along live:

```bash
duet logs                      # stream the orchestrator's narration inline
duet view                      # tmux panes, one per voice (or pass --tmux to new/continue)
duet runs                      # list runs in this project
```

A typical full-arc session: `duet new`, approve the direction, refine the spec and plan over a round or two of review, approve the plan — then walk away. Implementation runs AFK for an hour or more. You come back to a Ship-gate packet (a CEO-style summary on top), verify it in your environment, approve through docs and the PR description, and duet opens the pull request. A rir session is the same shape, shorter: approve the direction, walk away, return at Ship — no plan loop, no docs or PR tail.

Run state lives under `.duet/runs/<id>/` (self-ignored from git). `state.json` is a convenience hint; the three agent transcripts are the source of truth.

## Going deeper

The `docs/` folder is the real design record. Suggested reading order:

1. [`docs/observed-pattern.md`](docs/observed-pattern.md) — the manual workflow this automates, from a real session
2. [`docs/workflow-model.md`](docs/workflow-model.md) — that pattern abstracted into phases and vocabulary
3. [`docs/automation-design.md`](docs/automation-design.md) — the design: roles, layers, gates, policies
4. [`docs/open-questions.md`](docs/open-questions.md) — what's decided, what's still open, and the evidence
5. [`docs/engineering.md`](docs/engineering.md) — how the code is shaped (read before changing it)

`skills/duet-concierge/` is a Claude Code skill that lets you drive a run from your phone — duet's "remote control" without duet building any remote infrastructure of its own.

`skills/duet-frame/` is a companion skill for the other end of a run: it helps you author the framing — turning a rough problem into a clean framing document (the project's real names, structure, gate posture), without changing what you asked for or proposing how to build it — then hands you the `duet new --interactive` command to launch.

## License

[MIT](LICENSE)
