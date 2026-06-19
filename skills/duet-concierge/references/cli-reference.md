# duet CLI reference (for the concierge)

The verbs and flags the concierge uses, and the `status --json` schema it reads. Written against the duet CLI this skill ships with; the schema's compatibility promise is additive-only — fields are never renamed or removed. The CLI is also self-documenting: `duet --help` prints the run model, and `duet <command> --help` the per-command detail.

## Commands

| Command | What it does |
|---|---|
| `duet new --framing <file>` | Start a run from a framing file (the project briefing — the only place project knowledge enters). Returns immediately; the first phase runs in a detached driver. |
| `duet new --framing <file> --gates-at <phases>` | Same, attending only the listed gates (`frame, spec, plan, impl, docs, pr` — or a preset: `skip-plan` = walk away at spec approval, return at the Ship gate; `overnight` = frame,spec). The rest are pre-authorized and auto-cross with their packets recorded. `pr` is always attended. |
| `duet new --spec <path>` | Start at the spec review loop from a draft spec (skips the FRAME phase). |
| `duet continue <run-id> --approve` | Approve the current gate. |
| `duet continue <run-id> --approve "<rider>"` | Approve with a rider: agreement with the direction plus adjustments, delivered into the next phase as gate feedback in approving form. The human's "yes, but…" in one command. |
| `duet continue <run-id> --reject "<feedback>"` | Send the gated artifact back; the feedback reaches the orchestrator verbatim, as editor-in-chief input. |
| `duet continue <run-id> --answer "<answer>"` | Answer the queued question; the run resumes with it. |
| `duet continue <run-id>` | No flags: status if waiting, crash recovery if the phase died mid-flight. Also revives an abandoned run, re-entering from where it last stopped. |
| `duet steer "<note>" [run-id]` | Stage a mid-phase note for the orchestrator — delivered on its next tool result (minutes, typically). Legal only while a phase is live or down mid-flight; at a gate or flag it refuses and names that stop's channel. |
| `duet abandon <run-id>` | Stop a run for good: kills its live driver if one is running, and marks it abandoned. Destructive and **not** pre-approved — like `continue` it needs the human's permission prompt, never the concierge alone. The session transcripts are kept, so the run stays revivable with `duet continue`. |
| `duet abandon <run-id> --purge` | The above, and also deletes the run dir and the orchestrator + worker session transcripts in `~/.claude` / `~/.codex` — **irreversible**. Only on the human's explicit say-so. |
| `duet status [run-id]` | Human-readable status: phase, stop, packet or question, rounds, costs, next command. |
| `duet status --json` | The machine-readable status model (schema below). The concierge's read surface. |
| `duet status --json --wait` | Blocks until the run reaches its next stop, then prints the model and exits. Read-only and safe to interrupt — the supervision primitive: run it in the background and report when it exits. |
| `duet runs` | List the project's runs, newest first. |
| `duet logs [run-id]` | Stream the driver narration — replays from the start, then follows. Ctrl-C detaches; the run is unaffected. |
| `duet view [run-id]` | Open a tmux viewer (one pane per voice). Terminal-side; not useful remotely. |
| `duet takeover <role> [run-id]` | Hand a role's session to the human in the provider's own interactive CLI. Terminal-only by nature — never the concierge's verb. |
| `duet orchestrate [run-id]` | Bring up the human's local interactive `/duet` orchestrator for a run (FRAME → PLAN). Terminal-only — never the concierge's verb. Relevant to know about: a run started with `duet new --interactive` is driven by that local session until the plan-gate handoff, after which AFK implementation runs headless and the concierge supervises it exactly as any other run. |

Every command defaults to the latest run in the project when `[run-id]` is omitted.

## `duet status --json` — the StatusModel

Top-level fields:

| Field | Meaning |
|---|---|
| `runId`, `createdAt` | Run identity. |
| `branch` | The run's working branch, when known. |
| `specPath` | The spec file, once one exists (absent on framing-only entry until the spec phase reports it). |
| `machineState` | The last quiescent stop's statechart state — a display hint; `stop` is what you act on. |
| `stop` | The discriminated stop (below): what the run is waiting on, with the command that acts there. |
| `gatesAt` | Phases whose gates the human attends, when gate pre-authorization is active. Absent = every gate attended. |
| `autoApprovals` | Gates auto-crossed under pre-authorization: `{ gate, at, headline }` — surface these as "while you were away". |
| `rounds` | Review rounds per phase against their backstop caps: `{ phase, used, cap }`. |
| `costs` | `{ orchestratorUsd, claudeWorkersUsd, codexTokens: { input, output } }`. |
| `context` | Context-window fill per voice, captured at turn boundaries: `{ role, usedTokens, windowTokens, percent, at }`. Surface high percentages when the human asks how the run is doing — a worker near its window is worth mentioning. |
| `pendingSteers` | Staged steers not yet delivered: `{ stagedAt, stagedDuring?, text }`. |
| `snippetProposals` | Queued snippet-library edits awaiting the human's end-of-run review: `{ snippetKey, rationale, at }`. |
| `lastActivity` | The orchestrator's most recent recorded action. |

### `stop`, by `kind`

**`running`** — a phase is live; `duet steer` is the channel.

```json
{ "kind": "running", "pid": 4242, "phase": "impl" }
```

**`gate`** — a decision is waiting. Present `packet.summary` (it is written to be decided from), then act with one of `commands`.

```json
{
  "kind": "gate",
  "phase": "impl",
  "gate": "shipGate",
  "heading": "SHIP gate — the orchestrator's packet (CEO summary first)",
  "hint": "(verify in your environment before deciding — …)",
  "packet": { "summary": "…", "artifacts": ["docs/plans/feature.md"] },
  "commands": {
    "approve": "duet continue <run-id> --approve",
    "reject": "duet continue <run-id> --reject \"<feedback>\""
  }
}
```

**`flag`** — the orchestrator queued a question and the run is paused on it. Present `question` and `context` whole.

```json
{
  "kind": "flag",
  "question": "Should the export be billing-gated?",
  "context": "The reviewer flagged it as a product call.",
  "command": "duet continue <run-id> --answer \"<your answer>\""
}
```

**`crashed`** — the phase died mid-flight (infrastructure, not content). Report it; resuming re-enters from the transcripts.

```json
{ "kind": "crashed", "phase": "impl", "command": "duet continue <run-id>" }
```

**`abandoned`** — the human stopped the run with `duet abandon`. Report it as stopped-on-purpose, not failed; it stays revivable with `revive`, or `purge` wipes it.

```json
{
  "kind": "abandoned",
  "at": "2026-06-17T09:00:00.000Z",
  "revive": "duet continue <run-id>",
  "purge": "duet abandon <run-id> --purge"
}
```

**`done`** — the run is complete; `summary` leads with the PR URL.

```json
{ "kind": "done", "summary": "PR: https://github.com/…" }
```

## The framing file (for run starts from dictation)

A markdown file: an optional `---`-fenced frontmatter block holding only fixed machine-parsed values (`gates_at`, `spec`), then prose that, at the first phase, each worker reads independently as its own briefing. Everything judgment-weighed belongs in the prose, never the frontmatter. Write that prose as the briefing it is: speak to the reader as "you" and pair each action with the knowledge behind it ("read X to understand Y, then build Z; verify with W"), so whoever opens the file reads it as onboarding written for them. Draft from this skeleton, filling what the human's dictation gives you and asking for what it doesn't — a thin framing produces hours of misdirected autonomous work:

```markdown
---
# gates_at: skip-plan       — phases whose gates the human attends; the rest
#                             auto-cross. Presets: skip-plan (walk away at spec
#                             approval, return at the Ship gate), overnight
#                             (= frame,spec). Or a list, e.g. "frame, spec".
# spec: path/to/draft.md    — enter at the spec review loop (skips FRAME).
---

# Problem
<what to build or change, why, and the scope boundaries — what's explicitly out>

# Onboarding
<what to read first to get oriented, and what each source gives you — e.g.
 "Read CLAUDE.md for the architecture, then the design docs it points to";
 name an onboarding skill to invoke if the project has one>

# Conventions
- Specs live at: <path convention>
- Plans live at: <path or directory convention — required>
- Branch: <"this branch is the run's branch", or a naming convention>
- Commit style: <conventional commits / the project's norm>

# Verification
- Typecheck: <command>
- Tests: <command>
- Environment-only actions (migrations, deploys): flag the human — never attempt.

# Docs
<for the docs phase, which runs after the implementation: a docs-update skill if
 one exists, else where docs live and what a change like this should update>
```
