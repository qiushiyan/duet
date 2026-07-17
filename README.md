# greenflag

**Describe a ticket, walk away, come back to a pull request — with nothing crossing a gate without your green flag.**

Your AI agents draft, critique, and build it: greenflag runs a spec loop, an adversarial review, and an AFK build on your existing `claude` and `codex` CLIs, then opens a real pull request. You approve direction at a few gates and stay away from the keyboard for the rest.

Hence the name: the run drives itself, at speed, for hours — and the gates are enforced in code, not by a prompt an agent can be talked out of.

> Early and personal — built for one developer's workflow, published in case the shape is useful. Expect rough edges. [What's verified](docs/status.md).

## Install

Needs **Node 24+** and the **`claude`** and **`codex`** CLIs, installed and authenticated — greenflag drives your existing setup.

```bash
npm install -g greenflag
```

Optional, but the smoothest path — the companion Claude Code skills:

```bash
npx skills add qiushiyan/greenflag   # greenflag-frame + greenflag-concierge
```

## Quickstart

```bash
# 1. Write a framing: what to build, plus project context.
#    Opens your editor — or run /greenflag-frame in Claude Code to draft it for you.
greenflag new

# 2. Act at the early gates. Then walk away — the build runs AFK, often for hours.
greenflag status                 # where the run is + the exact command to act next
greenflag continue --approve     # cross the current gate

# 3. Come back to an opened PR, or a well-formed question waiting for you.
```

Starting a run, other ways:

```bash
greenflag new --workflow blueprint     # one document, one attended gate
greenflag new --workflow short         # no documents — fastest path to a PR
greenflag new --spec spec.md           # start from a draft spec you already wrote
greenflag new --template bug           # seed from .greenflag/templates/bug.md
greenflag new --gateless               # walk away from the START — every gate pre-authorized
greenflag new --no-interactive         # drive from the background instead of your CC session
```

On a live terminal `greenflag new` is **interactive**: your own Claude Code session becomes the orchestrator and you act at the early gates in chat. At the planning stage's last gate it hands off to a background driver and goes AFK.

## Workflows

A run executes one **workflow**. Each `→` is a phase; each **GATE** is a stop where the run waits for you.

```
full       frame → DIRECTION → spec → COMMIT-SPEC → plan → PLAN (walk away)
             → implement (AFK, often hours) → SHIP → finish (open the PR) → OPEN-PR → done

blueprint  frame → DIRECTION (auto) → spec → COMMIT-SPEC (your one stop — then walk away)
             → implement (AFK) → SHIP → finish → OPEN-PR → done

relay      frame → DIRECTION (auto) → spec → COMMIT-SPEC (your one stop)
             → implement (AFK: a fresh builder implements; the judge reviews AND fixes)
             → SHIP → finish (the judge opens the PR) → OPEN-PR → done

short      research → DIRECTION (walk away) → implement (AFK) → SHIP → finish → OPEN-PR → done
```

| Workflow | Documents | Pick it when |
| --- | --- | --- |
| **full** | spec + plan | Unfamiliar or risky work — the product spec and the technical plan each deserve their own review. |
| **blueprint** | spec | Serious work on a builder you trust. Read one document, tap once, walk away. |
| **relay** | spec | The spec is strong enough that the build is labor, not judgment. A cheap builder implements; a strong **judge** fixes findings in place and opens the PR. Bind the pair: `--bind builder=… --bind judge=…` |
| **short** | none | Small, well-understood changes — the research decisions are the design. |

Every workflow shares the same AFK implementation phase and ends by opening a real PR. Each has a hands-off default: full attends the spec; blueprint and relay attend only their spec gate; short only its Direction gate.

`--gates-at` names the **complete** set of gates you attend, not a delta — `--gates-at finish` attends *only* the Open-PR gate. To keep the usual stops and add one, list them all.

## Everyday commands

```bash
greenflag status                    # where the run is, and the exact command to act next
greenflag status --json --wait      # block until the next stop, then print (scripting)
greenflag doctor                    # per-voice health: working / thinking / retrying / stuck / crashed
greenflag graph                     # the run's whole arc with a live cursor and gate outcomes
greenflag stats                     # effort per phase; --trace for a turn-by-turn timeline

greenflag continue --approve        # cross the gate (--approve "rider" to add tweaks)
greenflag continue --reject "..."   # send the artifact back; your words reach the orchestrator verbatim
greenflag continue --answer "..."   # answer a queued question

greenflag steer "..."               # nudge the orchestrator mid-phase, without pausing
greenflag afk                       # hand the rest to the headless driver
greenflag takeover critic           # drop into a duty's raw CLI session; resume greenflag after
greenflag abandon                   # stop a run for good (--purge also deletes its sessions)

greenflag runs                      # list runs in this project
greenflag view                      # tmux panes, one per voice
greenflag snippets                  # list the prompt templates (show <key> prints one)
greenflag workflows                 # list / check / scaffold workflow definitions
greenflag grade                     # end-of-run: verdict each decision point right/wrong
```

Run state lives in `.greenflag/runs/<id>/` (self-ignored from git). `state.json` is a convenience hint — the provider transcripts are the source of truth.

## Configure

Optional. The defaults work out of the box: makers and the orchestrator on claude/Opus, checkers on codex — cross-family review is the shipped posture. Reach for `~/.config/greenflag/config.toml` when you want a different model behind a duty:

```toml
budget = "off"              # per-turn cost caps: "off" (default), "default", or a multiplier like 0.5/2

[orchestrator]
provider = "claude"         # must be claude in v1
model = "claude-opus-4-8"

[duties.architect]          # planning's maker — drafts the spec and plan
provider = "claude"
model = "claude-opus-4-8"
effort = "high"             # low | medium | high | xhigh (+ claude's max, codex's minimal)

[duties.analyst]            # planning's checker — critiques the documents
provider = "codex"          # absent model/effort ⇒ your ~/.codex/config.toml governs

[duties.builder]            # delivery's maker — writes the code and the PR
provider = "claude"
model = "claude-opus-4-8"
# claude_args = ["--fallback-model", "claude-opus-4-6"]   # native passthrough, unparsed

[duties.critic]             # delivery's checker (full/blueprint/short) — read-only
provider = "codex"
# codex_config = { model_reasoning_summary = "detailed" } # native passthrough, unparsed

[duties.judge]              # delivery's checker on relay — reviews WITH write access
provider = "claude"
model = "claude-opus-4-8"

# [consultant]              # optional advisor — off by default; see below
# provider = "codex"
```

The non-obvious parts:

- **Bindings are per duty, and a run overrides them per key** — `--bind <duty>=<provider[:model][@effort]>`, or a `bind.<duty>:` framing key. A duty names its own stage, so relay's criss-cross is two flags.
- **Sessions carry across the stage boundary** on full, blueprint, and short (builder ← architect, critic ← analyst); relay's delivery starts fresh by design. A binding that crosses providers degrades that to a fresh session at creation — echoed, never an error.
- **greenflag validates its own knobs, never your native args** — a bad `effort` is rejected up front; `claude_args`/`codex_config` pass through untouched. Any binding with an explicit model or native override is **preflighted at `greenflag new`**, so a bad argument fails at creation, not hours into a build.
- **The consultant** (optional) is a read-only advisor on a different model family that questions the *bet*, not the build. On document-bearing workflows it also authors an **acceptance contract** — falsifiable assertions of what success means, written before any code and verified against the built system before the Ship gate.

That's the whole config surface: provider bindings plus billing posture. Project knowledge never goes here — it goes in the framing. Details: [`docs/voices-and-providers.md`](docs/voices-and-providers.md).

## Make it yours

**Snippets** are the prompt templates the orchestrator sends the workers — they *are* the workflow. Override any of them by key, without forking:

| Layer | File |
| --- | --- |
| user | `~/.config/greenflag/snippets.toml` |
| project | `<repo>/.greenflag/snippets.toml` |

Precedence is shipped → user → project, last wins. An unknown key is a hard error, and with no override files the library is byte-for-byte the shipped one. The biggest levers are the generative drafts — `write-spec`, `start-plan`, `implement-direct` — which write the first artifact of each phase. Catalog and a worked example: [`docs/snippets.md`](docs/snippets.md).

> Every key is overridable, including the load-bearing ones (`consultant-contract`, `consultant-verify`, the gate-adjacent prompts). The *structural* gates are code and can't be forged from a prompt — but a weaker snippet quietly weakens the *signal* reaching a gate. Override those knowingly.

**Compose your own workflow** when no shipped shape fits — say a hotfix lane that triages once, patches once, opens the PR:

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

```bash
greenflag workflows init hotfix    # scaffold it (typed; your editor checks it, no npm install)
greenflag workflows check hotfix   # compile it and print the shape greenflag derives
greenflag new --workflow hotfix    # run it
```

You state the phase list and the gate posture; greenflag derives the stages, duty pairs, session continuity, and gate copy. The vocabulary is deliberately **closed** — a composition compiles only where greenflag ships prompt support, and the compiler names the valid combinations when it rejects one — so a workflow you compose is briefed as well as a shipped one. The shipped four are themselves `defineWorkflow` expressions, pinned byte-identical to their rebuilds by the test suite.

## How it works

Each stage pairs two **workers**, identified by **duty**, with a read-only **orchestrator** routing between them:

| Voice | Does | Default |
| --- | --- | --- |
| **Orchestrator** | Routes the protocol — never writes code; triages and decides who answers what | `claude` (Opus) |
| **architect** · **builder** — the makers | The architect writes the spec and plan; the builder writes the code and the PR | `claude` (Opus) |
| **analyst** · **critic** / **judge** — the checkers | Critique each artifact — read-only, except relay's judge, which fixes what it finds | `codex` |

Between stops a detached process drives the phase; nothing runs while a run is parked. Docs are reconciled as the last step of implementation, so the **SHIP** gate reviews code and docs together. The **OPEN-PR** gate sits *after* the PR opens — it auto-crosses by default, since opening is non-destructive. A pre-authorized gate auto-crosses only on a clean packet: a `high`-severity decision holds the run for you instead, and an `ask_human` question stops it under any posture. **The merge is always yours.**

## Design principles

- **Augment, don't replace.** Same `claude` and `codex` CLIs, same repo, standard transcripts and normal branches. Every artifact is one you could have made by hand. There's no "greenflag mode" to get locked into.
- **You own the substance.** The orchestrator does triage, never opinions — product, direction, and environment questions always reach you. The gates are structural, not a promise in a prompt.
- **Stop anytime.** Pause indefinitely. The state file is a hint; the transcripts are truth. Drop out to `claude --resume` by hand, then pick greenflag back up — or never.
- **Not a daemon, not an app.** A small CLI you invoke per gate. No GUI, no background service, no webhooks.

**It is not** a general orchestration framework. The workflows compose from a small, deliberately closed vocabulary, because a neutral engine would be a commodity — what greenflag ships is the opinions: the snippets, the altitude-tuned review lenses, the gate discipline. Not multi-user, not provider-agnostic (exactly two providers, by design), and it carries no project conventions — those come from the framing you write per run.

## Docs

- [`docs/status.md`](docs/status.md) — what's verified on real work, and what isn't
- [`docs/observed-pattern.md`](docs/observed-pattern.md) — the manual workflow this automates, from a real session
- [`docs/automation-design.md`](docs/automation-design.md) — the design spine: voices, layers, workflows, gates, policies
- [`docs/open-questions.md`](docs/open-questions.md) — what's decided, what's open, and the evidence
- [`docs/engineering.md`](docs/engineering.md) — how the code is shaped (read before changing it)

Two Claude Code skills ship with greenflag: **greenflag-frame** authors a run's framing, and **greenflag-concierge** starts and supervises runs from a chat session — greenflag's "remote control" from your phone, without building any remote infrastructure of its own.

Contributing: no build step in dev — Node 24 runs the TypeScript directly (`pnpm typecheck`, `pnpm test`). Releases run on [changesets](https://github.com/changesets/changesets) and publish through pnpm — [`docs/publish-runbook.md`](docs/publish-runbook.md).

## License

[MIT](LICENSE)
