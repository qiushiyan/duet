# duet CLI reference (for the concierge)

The verbs and flags the concierge uses, and the `status --json` schema it reads. Written against the duet CLI this skill ships with; the schema's compatibility promise is additive-only — fields are never renamed or removed. The CLI is also self-documenting: `duet --help` prints the run model, and `duet <command> --help` the per-command detail.

## Commands

| Command | What it does |
|---|---|
| `duet new --framing <file>` | Start a run from a framing file (the project briefing — the only place project knowledge enters). Returns immediately; the first phase runs in a detached driver. Runs the **full** arc unless `--workflow` says otherwise. |
| `duet new --workflow <full\|rir> --framing <file>` | Pick the arc. **full** (default): frame → spec → plan → implementation → PR. **rir**: research → implement → one review round → `publish` (reconcile docs → PR), with no spec or plan — for small, well-understood work. Also settable as `workflow:` in the framing frontmatter; the flag wins. |
| `duet new --framing <file> --gates-at <phases>` | Same, attending only the listed gates; the rest are pre-authorized and auto-cross with their packets recorded. Phases and presets are **workflow-specific**. full: gates `frame, spec, plan, impl, finish` — **default `overnight` (= frame,spec)**; preset `skip-plan` (= walk away at spec approval, return at the Ship gate). The Open-PR gate (end of `finish`) sits *after* the open — the PR auto-opens and the gate auto-crosses to done; list `finish` to attend a post-open review stop. rir: gates `research, implement, publish` — or the preset `afk` (= attend none, run straight to done with the PR open). |
| `duet new --framing <file> --gateless` | Walk away from the **start**: pre-authorize every gate (the run flows to an open PR with no attended stop) and, if a consultant is bound, keep only its **non-holding** work — its framing third-opinion still folds into the direction and the acceptance-contract **verify** still guards the build, with its mid-run bet audits off. A genuine product `high` or a contract that can't be met still stops it; `ask_human` and the merge stay the human's. Conflicts with `--gates-at` and `--interactive`. Also settable as `gateless:` in the framing frontmatter (the flag wins). |
| `duet new --spec <path>` | Start at the spec review loop from a draft spec (skips the FRAME phase). **full-only** — rir has no spec phase and rejects `--spec`. |
| `duet new --framing <file> --retry-infra <n>` | Set the headless run's bounded auto-retry budget for transient infra failures (network/server/rate-limit) — **default 3** for a new run, `--retry-infra 0` disables, an old run started without the field stays off; or set `retry_infra:` in the framing frontmatter (the flag wins). `auth` retries once then escalates; login/quota/dns/unknown never retry; exhaustion flags. |
| `duet new --framing <file> --consultant <provider[:model]>` | Bind the optional **consultant** for the run — a read-only second reviewer that questions the *bet* (assumptions, product fit), ideally on a different model family from the reviewer. Off by default; relay it only when the user asks for it. Also settable for every run via `[roles.consultant]` in config; `--no-consultant` disables a config-bound one for this run. |
| `duet continue <run-id> --approve` | Approve the current gate. |
| `duet continue <run-id> --approve "<rider>"` | Approve with a rider: agreement with the direction plus adjustments, delivered into the next phase as gate feedback in approving form. The human's "yes, but…" in one command. |
| `duet continue <run-id> --reject "<feedback>"` | Send the gated artifact back; the feedback reaches the orchestrator verbatim, as editor-in-chief input. |
| `duet continue <run-id> --answer "<answer>"` | Answer the queued question; the run resumes with it. |
| `duet continue <run-id> --reject-file <path>` | Reject with feedback read from a file (or `-` for stdin), byte-for-byte — apostrophes, newlines, em-dashes survive shell quoting. Off a TTY a bare `--reject` fails fast naming this form; a bare `--approve` approves with no rider. |
| `duet continue <run-id> --answer-file <path>` | Answer from a file (or `-` for stdin), verbatim — for multi-line or punctuated answers. |
| `duet continue <run-id>` | No flags: status if waiting, crash recovery if the phase died mid-flight. Also revives an abandoned run, re-entering from where it last stopped. |
| `duet steer "<note>" [run-id]` | Stage a mid-phase note for the orchestrator — delivered on its next tool result (minutes, typically). Legal only while a phase is live or down mid-flight; at a gate or flag it refuses and names that stop's channel. |
| `duet abandon <run-id>` | Stop a run for good: kills its live driver if one is running, and marks it abandoned. Destructive and **not** pre-approved — like `continue` it needs the human's permission prompt, never the concierge alone. The session transcripts are kept, so the run stays revivable with `duet continue`. |
| `duet abandon <run-id> --purge` | The above, and also deletes the run dir and the orchestrator + worker session transcripts in `~/.claude` / `~/.codex` — **irreversible**. Only on the human's explicit say-so. |
| `duet status [run-id]` | Human-readable status: phase, stop, packet or question, rounds, costs, next command. |
| `duet status --json` | The machine-readable status model (schema below). The concierge's read surface. |
| `duet status --json --wait` | Blocks until the run reaches its next stop, then prints the model and exits. Read-only and safe to interrupt — the supervision primitive: run it in the background and report when it exits. |
| `duet status --brief` | A lean digest — position, a one-line headline, the next command, pending steers, auto-approvals, and the gate's `humanDecisions` — for fast polling. Composes with `--json` (lean JSON) and `--wait` (block, then print). |
| `duet doctor [run-id]` | Per-role health: working / long-inference / retrying / silent-stuck / crashed, with last-activity age, retry count, recent classified errors, and a connectivity probe. Reads the workers' own transcripts (heavier than `status`) — the answer to "is this run healthy, or stuck?" |
| `duet doctor [run-id] --json` | The full health model, including each role's resolved transcript path, for automation. |
| `duet stats [run-id] [--json]` | Effort per phase, derived from the voice logs at view time: each phase's elapsed window and the worker-turn time inside it, plus a per-tag breakdown. Read-only and fail-soft (a missing or interactive-only log degrades to a note); distinct from `status`, which never reads logs. |
| `duet runs` | List the project's runs, newest first. |
| `duet snippets` | List the effective snippet library and where each snippet resolves from — the shipped default, or a user (`~/.config/duet/snippets.toml`) / project (`<repo>/.duet/snippets.toml`) override. Read-only; project-independent of any run. |
| `duet snippets show <key>` | Print the full effective body of one snippet, with the layer it resolved from. |
| `duet logs [run-id]` | Stream the driver narration — replays from the start, then follows. Ctrl-C detaches; the run is unaffected. |
| `duet view [run-id]` | Open a tmux viewer (one pane per voice). Terminal-side; not useful remotely. |
| `duet takeover <role> [run-id]` | Hand a role's session to the human in the provider's own interactive CLI. Terminal-only by nature — never the concierge's verb. |
| `duet orchestrate [run-id]` | Bring up the human's local interactive `/duet` orchestrator for a run over its attended arc (full: FRAME → PLAN; rir: RESEARCH). Terminal-only — never the concierge's verb. Relevant to know about: a run started with `duet new --interactive` is driven by that local session until the handoff gate (full: plan-approval; rir: Direction), after which AFK implementation runs headless and the concierge supervises it exactly as any other run. |
| `duet afk [preset] [run-id] [--gateless]` | The human's one-tap mid-session handoff from an interactive gate: re-set the downstream gate posture (bare = attend none; a preset/list otherwise) and drop the run to the headless driver. `--gateless` narrows the consultant to its non-holding work (its framing read and the acceptance-contract verify stay; its mid-run bet audits go) and full-sends the bet/product `high`s at this gate (still preserving the contract backstop), conflicting with a posture argument. Terminal-only — never the concierge's verb. Relevant to know about: after it runs, the run is an ordinary headless run the concierge supervises like any other, auto-crossing the now-pre-authorized gates and stopping only at a still-attended gate, a queued question, or done. |

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
| `gatesAt` | Phases whose gates the human attends, when gate pre-authorization is active. Absent = every gate attended; `[]` = attend none (the rir `afk` posture — all gates pre-authorized). |
| `autoApprovals` | Gates auto-crossed under pre-authorization: `{ gate, at, headline }` — surface these as "while you were away". |
| `rounds` | Review rounds per phase against their backstop caps: `{ phase, used, cap }`. |
| `costs` | `{ orchestratorUsd, claudeWorkersUsd, codexTokens: { input, output } }`. |
| `context` | Context-window fill per voice, captured at turn boundaries: `{ role, usedTokens, windowTokens, percent, at }`. Surface high percentages when the human asks how the run is doing — a worker near its window is worth mentioning. |
| `sessions` | Each voice's transcript identity: `{ role, provider, sessionId }`, known sessions only (a role is omitted until its first turn completes). The cheap state-only map; the resolved path and the health verdicts live in `duet doctor`. |
| `pendingSteers` | Staged steers not yet delivered: `{ stagedAt, stagedDuring?, text }`. |
| `snippetProposals` | Queued snippet-library edits awaiting the human's end-of-run review: `{ snippetKey, rationale, at }`. |
| `lastActivity` | The orchestrator's most recent recorded action. |

### `stop`, by `kind`

**`running`** — a phase is live; `duet steer` is the channel.

```json
{ "kind": "running", "pid": 4242, "phase": "impl" }
```

**`gate`** — a decision is waiting. Present `packet.summary` (it is written to be decided from), then act with one of `commands`. When `packet.humanDecisions` is present, scan it first: empty or all-`severity:"low"` is safe to relay an approve; any `"high"` is a genuine product decision — hold and put it to the human. It is **signal-only**; nothing crosses the gate but the human's command.

```json
{
  "kind": "gate",
  "phase": "impl",
  "gate": "shipGate",
  "heading": "SHIP gate — the orchestrator's packet (CEO summary first)",
  "hint": "(verify in your environment before deciding — …)",
  "packet": {
    "summary": "…",
    "artifacts": ["docs/plans/feature.md"],
    "humanDecisions": [{ "title": "Billing-gate the export?", "severity": "high" }]
  },
  "commands": {
    "approve": "duet continue <run-id> --approve",
    "reject": "duet continue <run-id> --reject \"<feedback>\""
  }
}
```

**`flag`** — the orchestrator queued a question and the run is paused on it. Present `question` and `context` whole. `cause` distinguishes a `human` question (a real product/environment call — relay it), an `infra` failure (`cause:"infra"` plus an `errorClass` such as `network` / `auth` / `quota-billing` — report it as broken, not a question; `duet doctor` shows what broke), and a `budget` stop (a cost cap was hit — resumable: raise the budget or resume, not an outage; no `errorClass`). The `crashed` stop below is the separate driver-death signal.

```json
{
  "kind": "flag",
  "question": "Should the export be billing-gated?",
  "context": "The reviewer flagged it as a product call.",
  "cause": "human",
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

**`done`** — the run is complete. Both arcs open a PR, so the `summary` leads with the PR URL.

```json
{ "kind": "done", "summary": "PR: https://github.com/…" }
```

## The framing file (for run starts from dictation)

A markdown file: an optional `---`-fenced frontmatter block holding only fixed machine-parsed values (`workflow`, `gates_at`, `spec`, `retry_infra`, `gateless`, `interactive`, and a `consultant` on/off toggle), then prose that, at the first phase, each worker reads independently as its own briefing. Everything judgment-weighed belongs in the prose, never the frontmatter. Write that prose as the briefing it is: speak to the reader as "you" and pair each action with the knowledge behind it ("read X to understand Y, then build Z; verify with W"), so whoever opens the file reads it as onboarding written for them. Draft from this skeleton, filling what the human's dictation gives you and asking for what it doesn't — a thin framing produces hours of misdirected autonomous work:

```markdown
---
# workflow: full           — full (default) or rir. full: frame → spec → plan →
#                             impl → PR. rir: research → implement → publish
#                             (a PR; no spec/plan), for small work.
# gates_at: overnight       — phases whose gates the human attends; the rest
#                             auto-cross. full's default is overnight. Presets
#                             are workflow-specific: full → skip-plan (walk away
#                             at spec approval, return at the Ship gate) /
#                             overnight (= frame,spec); rir → afk (attend none).
#                             Or a list, e.g. "frame, spec, finish".
# spec: path/to/draft.md    — enter at the spec review loop (skips FRAME). full-only.
# gateless: true            — walk away from the START: pre-authorize every gate;
#                             consultant keeps its framing read + backstop, bet
#                             audits off. Conflicts with gates_at and interactive.
# interactive: true         — orchestrate from the human's session (needs a live
#                             terminal); the --interactive flag by another door.
# consultant: on            — on|off toggle for a config-bound consultant (the
#                             provider/model binding stays a flag, never here).
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
<for reconciling docs after the implementation (full's `finish` phase, rir's
 `publish` phase): a docs-update skill if one exists, else where docs live and
 what a change like this should update>
```
