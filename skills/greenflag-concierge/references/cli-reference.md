# greenflag CLI companion (for the concierge)

The CLI documents itself: `greenflag --help` prints the run model and every command, and `greenflag <command> --help` prints that command's flags, defaults, and gotchas. Read the help **just-in-time** — before an unfamiliar invocation, not from memory — and treat it as the source of truth for anything flag-shaped; this file deliberately re-documents none of it. What it carries is the concierge's own layer, the three things the help cannot say: which verbs are yours, the `status --json` schema you read, and the framing skeleton for run starts from dictation.

## The verb map — whose verb is it?

Every command defaults to the project's latest run; pass the run id explicitly (before any flag) once more than one exists.

**Yours, pre-approved** — read-only, run freely: `greenflag status` · `greenflag logs` · `greenflag runs`.

**Yours, prompt-normally** — read-only and safe whenever the human's question needs them; the permission prompt is routine, not a warning:

- `greenflag doctor` — per-voice health plus a connectivity probe; the answer to "is it stuck or thinking?"
- `greenflag stats` — effort per phase from the voice logs (`--trace` adds the interleaved turn timeline)
- `greenflag graph` — the pipeline drawn as a workflow blueprint (`--workflow <name>`) or the live run view
- `greenflag grade --list` — the reconstructed decision points, read-only; records nothing
- `greenflag framings` — archived framings; `greenflag workflows` — available workflow definitions; `greenflag snippets` — the prompt library

**The human's decisions, relayed verbatim** — the ask-rule permission prompt is the deliberate second gate, never friction to engineer around: `greenflag continue` (approve / reject / answer), `greenflag steer` (a mid-phase note).

**Run lifecycle, only on their explicit word**: `greenflag new` (start a run), `greenflag abandon` (stop one — destructive, though revivable; `--purge` also deletes the session transcripts, irreversible), and `greenflag grade` with `--set` / `--note` / `--missed` (records the human's verdicts — never write one they didn't utter).

**Never yours — they take the human's keyboard**: `greenflag takeover`, `greenflag orchestrate`, `greenflag afk`, `greenflag view`. Worth knowing what two of them mean for you: a run driven by the human's interactive orchestrator session hands off to the headless driver at planning's last gate, and `greenflag afk` is their one-tap version of that handoff — after either, it is an ordinary headless run you supervise like any other.

## Defaults that shape your suggestions

The few resolved defaults worth holding when translating intent (anything else: read the help):

- **Gate posture** (`--gates-at` / a `gates_at:` framing key): **full** defaults to `overnight` — attend frame and spec, hands-off after the spec; its other presets are `skip-plan` (return at the Ship gate to verify before it ships) and `afk` (attend none). **blueprint** and **relay** attend `spec` only; **short** attends `research` only — so every default run continues to an auto-opened PR. Add `finish` to a gates list for a post-open review stop on the PR; `--gateless` is attend-none *plus* narrowing a bound consultant to its non-holding work.
- **Infra auto-retry**: `greenflag new --retry-infra <n>` — default 3 for a new run, `0` disables; exhaustion still stops on a flag.
- **From your shell, `greenflag new` runs headless.** Interactive orchestration is a live-terminal default; your Bash session is not a terminal, so runs you start are the detached-driver runs SKILL.md describes.

## `greenflag status --json` — the StatusModel

The schema is **additive-only** — fields are never renamed or removed, new ones may appear; present what serves the human and ignore what you don't recognize. The load-bearing fields:

| Field | Meaning |
|---|---|
| `stop` | The discriminated stop (below): what the run is waiting on, with the exact command that acts there. Act on this, not on `machineState` (a display hint). |
| `gatesAt` | Phases whose gates the human attends. Absent = every gate attended; `[]` = attend none (every gate pre-authorized). |
| `autoApprovals` | Gates auto-crossed under pre-authorization: `{ gate, at, headline }` — surface as "while you were away". |
| `awayRetries` | Transient infra failures the headless driver retried through: `{ phase, errorClass, attempt, at }` — not a stop, but a degradation signal; call out a high or rising count. |
| `rounds` | Review rounds per phase against their caps: `{ phase, used, cap }`. |
| `costs` | `{ orchestratorUsd, claudeWorkersUsd, codexTokens: { input, output } }`. |
| `context` | Context-window fill per voice: `{ voice, percent, … }` — a worker near its window is worth mentioning. |
| `sessions` | Session slots: `{ key, provider, sessionId }`, keyed `orchestrator`, `stage.duty` (e.g. `delivery.builder`), or `consultant`. |
| `pendingSteers` | Staged steers not yet delivered — surface them so the human knows their note is still in flight. |
| `snippetProposals` | Queued prompt-library edits awaiting the human's end-of-run review. |

### `stop`, by `kind`

**`running`** — a phase is live; nothing is owed. `greenflag steer` is the channel for guidance.

```json
{ "kind": "running", "pid": 4242, "phase": "implement" }
```

**`gate`** — a decision is waiting. Present `packet.summary` (it is written to be decided from), then act with one of `commands`. Scan `packet.humanDecisions` first: empty or all-`severity:"low"` is safe to relay an approve; any `"high"` is a genuine product decision — hold and put it to the human. It is **signal-only**; nothing crosses the gate but the human's command.

```json
{
  "kind": "gate",
  "phase": "implement",
  "heading": "SHIP gate — the orchestrator's packet (CEO summary first)",
  "packet": {
    "summary": "…",
    "artifacts": ["docs/specs/feature.md"],
    "humanDecisions": [{ "title": "Billing-gate the export?", "severity": "high" }]
  },
  "commands": {
    "approve": "greenflag continue <run-id> --approve",
    "reject": "greenflag continue <run-id> --reject \"<feedback>\""
  }
}
```

**`flag`** — the run is paused on a queued question. Present `question` and `context` whole. `cause` routes your handling: `human` (a real product/environment call — relay it), `budget` (a cost cap was hit — resumable: raise the budget or resume, not an outage), or `infra` (an environment failure, with an `errorClass` like `network` / `auth` / `quota-billing` — report it as broken, not as a question; `greenflag doctor` shows what).

```json
{
  "kind": "flag",
  "question": "Should the export be billing-gated?",
  "context": "The analyst flagged it as a product call.",
  "cause": "human",
  "command": "greenflag continue <run-id> --answer \"<your answer>\""
}
```

**`crashed`** — the phase died mid-flight (infrastructure, not content). Report it; on the human's go-ahead, `command` re-enters from the transcripts.

**`abandoned`** — stopped on purpose with `greenflag abandon`, not failed; `revive` names the resume command, `purge` the irreversible cleanup.

**`done`** — complete; `summary` leads with the PR URL (every workflow opens a PR).

## The framing skeleton (run starts from dictation)

A framing is one markdown file: an optional machine-parsed frontmatter block, then prose each worker reads alone, cold, as its own briefing. The frontmatter keys mirror `greenflag new`'s flags — `workflow`, `gates_at`, `spec`, `gateless`, `interactive`, a `consultant` on/off toggle, and `bind.<duty>` binding keys — so `greenflag new --help` is their reference; a flag wins over its key, and an omitted key takes the workflow's default. Everything judgment-weighed belongs in the prose, never the frontmatter.

Write the prose to its single reader: speak as "you" and pair each action with the knowledge behind it ("read X to understand Y, then build Z"), the way good onboarding does. Draft from this skeleton, filling what the human's dictation gives you and asking for what it doesn't — a thin framing produces hours of misdirected autonomous work:

```markdown
---
workflow: blueprint
---

# Problem
<what to build or change, why, and the scope boundaries — what's explicitly out>

# Onboarding
<what to read first to get oriented, and what each source gives you — e.g.
 "Read CLAUDE.md for the architecture, then the design docs it points to";
 name skill files by path (a worker cannot expand a /command)>

# Conventions
- Specs live at: <path convention>
- Plans live at: <path convention — full only; drop on other workflows>
- Branch: <"this branch is the run's branch", or a naming convention>
- Commit style: <conventional commits / the project's norm>

# Verification
- Typecheck / tests: <commands>
- Environment-only actions (migrations, deploys): flag the human — never attempt.

# Docs
<how docs get reconciled at the end of the implement phase: a docs-update
 skill's file path if one exists, else where docs live and what a change
 like this should update>
```
