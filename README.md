# duet

**A semi-AFK orchestrator for a two-agent AI coding workflow — one agent implements, another reviews, and an LLM routes between them while you stay the editor-in-chief.**

If you already run two coding agents in parallel — one writing specs/plans/code, one critiquing them — and spend your day copy-pasting between them and nudging each along, that's the workflow duet automates. A read-only **orchestrator** drives the hand-offs — it picks the right prompt, routes each agent's output to the other, and decides when a review loop has converged — and pauses at **human gates** that no agent can cross. You approve the direction, walk away at the handoff gate, and come back to a finished pull request or a verified ship — or a well-formed question waiting for you.

It's a personal tool, built for one developer's workflow across their own projects, and published in case the shape is useful to you — not a polished product. Expect rough edges.

## How it works

Three roles, each bound to a provider (`claude` or `codex`):

| Role | Does | Default |
|---|---|---|
| **Orchestrator** | Routes the protocol — never writes code, only triages and decides who answers what | `claude` (Opus) |
| **Implementer** | Writes specs, plans, code, the PR | `claude` (Opus) |
| **Reviewer** | Critiques each artifact (review-only) | `codex` |

A run moves through an arc you pick at the start (`--workflow`). Each `→` is a phase the agents work through; each **GATE** is a stop where the run waits for you:

```
full  frame → DIRECTION → spec → COMMIT-SPEC → plan → PLAN (walk away)
        → implementation (AFK, often hours) → SHIP → docs (one pass) → pr → OPEN-PR → done

rir   research → DIRECTION (walk away) → implementation (AFK) → SHIP → done
```

**full** is the thorough arc — settle the design on paper, end in a pull request. **rir** (Research → Implement → Review) is lighter: the research decisions are the design, so it skips spec, plan, and PR — its docs update folds into the build before a verified Ship. Use full for epic-shaped work, rir for small, well-understood changes.

The gates are enforced in code (an XState statechart), not a prompt the orchestrator could be talked out of. Between stops a detached background process drives the phase; nothing runs while a run is parked, and you get a desktop notification at every stop. The final **OPEN-PR** gate opens the PR for you by default — list `pr` in `--gates-at` for a pre-open stop to read the description first; the merge is always yours.

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
4. **Walk away.** At the handoff gate — plan approval (full) or the Direction gate (rir) — the run hands off to a background driver and implements semi-AFK, often for an hour or more. You return to a Ship-gate packet (a CEO-style summary on top) and, on the full arc, an opened pull request — or a well-formed question waiting for you.

> **Prefer the terminal?** Skip `--interactive` and run a headless framing turn instead — `duet new` opens your editor on a framing draft, then the orchestrator runs in the background and you act at each gate with `duet continue`.

Common ways to start a run:

```bash
duet new                       # editor on a framing draft (issue, context, scope)
duet new --template bug        # seed the draft from .duet/templates/bug.md
duet new --spec spec.md        # start from a spec you already wrote (full arc)
duet new --workflow rir        # the lighter arc (add --gates-at afk to run unattended)
duet new --gates-at overnight  # approve the spec, then walk away for the rest
duet new --budget default      # opt in to per-turn cost caps (off by default)
```

`--gates-at` names the *complete* set of gates you attend, not a delta on the default. Since the PR auto-opens, `--gates-at pr` attends **only** the Open-PR gate; to keep the usual stops *and* add a pre-open PR stop, list them all.

## Everyday commands

Once a run is going, you mostly watch and decide:

```bash
duet status                    # where the run is, and the exact command to act next
duet status --json --wait      # block until the next stop, then print (scripting/supervision)
duet doctor                    # per-role health: working / thinking / retrying / stuck / crashed

duet continue --approve        # cross the current gate (optionally: --approve "a rider with tweaks")
duet continue --reject "..."   # send the artifact back; your words reach the orchestrator verbatim
duet continue --answer "..."   # answer a queued question

duet steer "..."               # nudge the orchestrator mid-phase, without pausing the run
duet afk                       # from an interactive gate, hand the rest to the headless driver
duet takeover reviewer         # drop into the raw CLI session yourself; resume duet after
duet abandon                   # stop a run for good; --purge also deletes its sessions

duet logs                      # stream the orchestrator's narration inline
duet view                      # tmux panes, one per voice (or pass --tmux to new/continue)
duet runs                      # list runs in this project
```

Run state lives under `.duet/runs/<id>/` (self-ignored from git). `state.json` is a convenience hint; the three agent transcripts are the source of truth.

When most of a framing repeats run to run, save the common part as a template under `.duet/templates/<name>.md` and seed each draft from it (`duet new --template <name>`); how to author them is in [`docs/automation-design.md`](docs/automation-design.md).

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

That's the only config duet has — role-to-provider bindings plus billing posture (`transport`, `budget`), nothing else. Project knowledge never lives here; it goes in the framing.

- **Consultant (optional, off by default).** Add `[roles.consultant]`, or pass `--consultant <provider[:model]>` per run, for a second, read-only reviewer that questions the *bet* (assumptions, product fit) rather than the build — ideally on a different model family from your reviewer, which is the point. `--no-consultant` disables a configured one for a single run. On the full arc it also authors an **acceptance contract** — a short, frozen list of falsifiable assertions of what success means, written blind to the plan, which you ratify at the plan gate and a fresh session verifies against the built system before the Ship gate.
- **Interactive implementer transport (advanced, experimental).** Add `transport = "interactive"` under `[roles.implementer]` to drive the interactive `claude` TUI instead of headless `claude -p`, so its turns bill your flat subscription quota rather than the metered credit pool. tmux-driven, implementer-only, pending one live-auth check — see [`docs/interactive-transport.md`](docs/interactive-transport.md).

## Going deeper

The `docs/` folder is the real design record. Suggested reading order:

1. [`docs/observed-pattern.md`](docs/observed-pattern.md) — the manual workflow this automates, from a real session
2. [`docs/workflow-model.md`](docs/workflow-model.md) — that pattern abstracted into phases and vocabulary
3. [`docs/automation-design.md`](docs/automation-design.md) — the design: roles, layers, gates, policies
4. [`docs/open-questions.md`](docs/open-questions.md) — what's decided, what's open, and the evidence
5. [`docs/engineering.md`](docs/engineering.md) — how the code is shaped (read before changing it)

Two Claude Code skills ship with duet (installed with `npx skills add` above): **duet-frame** authors a run's framing — the workflow above — and **duet-concierge** lets you start and supervise a run from a chat session, duet's "remote control" from your phone, without duet building any remote infrastructure of its own.

## Development & status

**Status.** Early and personal, but the whole workflow is now live-verified end to end: both the **full** and **rir** arcs, the headless and interactive orchestrator hosts, the optional **consultant**, run supervision (`duet doctor`, opt-in infra retry), and the interactive-Claude implementer transport have all run on real work. The consultant's **acceptance contract** (full arc) is built and test-verified but has not yet run live. Expect rough edges — the open *design* questions and their evidence live in [`docs/open-questions.md`](docs/open-questions.md).

No build step in dev — Node 24 runs the TypeScript directly:

```bash
pnpm typecheck
pnpm test
```

The codebase's mental model lives in [`docs/engineering.md`](docs/engineering.md) — read it before changing code.

## License

[MIT](LICENSE)
