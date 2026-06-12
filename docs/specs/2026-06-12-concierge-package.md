# Concierge package: remote interaction via Claude Code

**Status:** Implemented (plan: `docs/plans/2026-06-12-concierge-package.md`; awaiting its first live remote session). **Date:** 2026-06-12. Product decisions settled by interview — `docs/future-directions.md` §Active carries the verdicts; this spec turned them into the buildable shape.

## Summary

We're adding the ability to supervise and act on a duet run from anywhere — phone included — without building any remote infrastructure of our own. Today the human can act only at quiescent stops, only from the terminal, through shell-flag strings; mid-phase they are a spectator. After this lands: a one-line steering channel into live phases (`duet steer`), machine-readable run state (`duet status --json`), and a packaged Claude Code skill (`skills/duet-concierge/`) that teaches any CC session to drive the duet CLI on the human's behalf — so Claude Code's native remote control, mobile push, and `/loop` supervision become duet's remote layer for free.

The approach is three small pieces riding existing seams: steer reuses the run-dir staging pattern and the tool-result steering surface; JSON status is a second renderer over the existing status model; the skill is packaging plus discipline, zero runtime. No daemon, no server, no harness redesign.

Boundary: **fixed** — mid-phase steering, phone-based gate/flag decisions with packet summaries, run-start from dictation. **Not fixed** — orchestrator-in-CC (separate horizon, `docs/future-directions.md`), multi-run supervision (one run per project dir as today), takeover (stays terminal-only by nature). **Deferred** — `duet skills install` convenience and a `.claude-plugin/plugin.json` (until publishing turns real); `duet runs --json` (single-run supervision needs only `status`).

## Current vs. desired

```
Current:                                Desired:
Human acts on a run                     Human acts on a run
└─ at a quiescent stop                  ├─ at a stop: duet continue (unchanged)
   └─ from the terminal                 ├─ mid-phase: duet steer "…"
      └─ duet continue --…              │    └─ delivered on the next tool result
Mid-phase: spectator or takeover        └─ run start: duet new --framing (unchanged)
Away: macOS ping, then nothing          Concierge CC session (skill + /remote-control + /loop)
                                        ├─ reads: status --json, logs
                                        └─ acts: new / steer / continue — gate verbs behind a
                                           permission ask-rule that prompts on the phone
```

## The steer channel

**Storage — not `state.json`.** Steers arrive while a driver is live and holds its in-memory `RunState`, saving at every tool call — a CLI write into `state.json` would race those saves and get clobbered (the existing `pendingMessage` handshake never faces this: input stages only while no driver runs). Steers get their own home: `.duet/runs/<id>/steers/`, one file per steer (timestamped name; body = the human's text verbatim plus `staged_at` / `staged_during` metadata). Staging is an atomic file create; consuming is an atomic rename into `steers/delivered/` — append and drain never collide. Known edge, accepted: a crash between delivery and rename can redeliver a steer; a repeated human instruction is benign where a lost one is not (the mirror image of the consume-then-crash trade in the input handshake).

**Delivery — the next tool result.** One phase is typically one long orchestrator turn (`src/harness/driver.ts`), so turn boundaries are too rare to ride; tool results arrive every few minutes all phase long and are already the harness's steering surface. `createPhaseTools` (`src/harness/tools.ts`) wraps every handler: after a handler produces its result — success or refusal — pending steers are drained and appended as a tagged block plus one steering sentence naming what it is and what to do (convention 5, `docs/prompting-and-tool-design.md`):

```
<human_steer staged_at="…">
drop the retry tests
</human_steer>
The human sent this mid-phase guidance just now. It is the editor-in-chief's
voice — fold it into your routing from this point; it outranks reviewer
opinions and does not count toward any cap.
```

**Carry-forward.** A steer that misses its window (phase ended before another tool call completed) is not dropped: `buildPrompt` drains leftover steers into the next phase's entry or resume prompt with `staged_during` provenance, and the orchestrator judges staleness — judgment to the LLM, structure to code.

**CLI gating — live phases only.** `duet steer <text>` is legal iff a phase is live (or died mid-flight). The signal is *not* the machine snapshot: snapshots persist only at quiescent states (`docs/engineering.md` §XState usage), so a phase-tagged snapshot never exists on disk — mid-phase, `machine.json` still shows the previous stop. The CLI decides from the signals that do exist. A live driver pid (the `aliveDriverPid` check `continue` and `takeover` already use) means a phase is running — steer is legal. No driver with the snapshot parked at a quiescent stop means the run is waiting there, and the error names that stop's own channel: at a gate, `continue --approve` / `--reject`; at a flag, `--answer`; on a finished run it says so. A run that crashed mid-phase — no live driver plus run-state evidence the run got past the snapshot's stop (no snapshot at all, or `phaseStarted` ahead of the snapshot's position) — accepts the steer: it rides the recovery entry prompt.

**Orchestrator contract.** A short system-prompt addition (governed by `docs/prompting-and-tool-design.md`): a steer is the human's mid-phase voice — authoritative like gate feedback, processed not answered; relay into worker prompts at the orchestrator's judgment; a steer is never itself a reason to ask_human. Staging and delivery both land in the voice logs and `duet status` shows undelivered steers, so the channel is auditable end to end.

## `duet status --json`

`src/status.ts` splits into a status *model* (one object derived from `RunState` + liveness probe) consumed by two renderers: the existing human text and `JSON.stringify`. The JSON carries what the concierge needs to brief the human and pick the right channel: run id, branch, phase, machine state, a discriminated `stop` (`running` / `gate` — with gate name and packet / `flag` — with the queued question / `done`), the while-you-were-away auto-approval packets, rounds against caps, costs, driver liveness, undelivered steers, snippet-proposal count, last activity. The schema's compatibility promise is additive-only — the skill's reference doc documents the fields, and a field rename is a breaking change to the shipped skill.

No separate `duet packet` command: the packet is a field of the stop, and one surface is one thing to teach.

## The skill: `skills/duet-concierge/`

A new top-level `skills/` directory — the shipped product skills, distinct from the dev-time `.claude/skills/`. Layout per the Agent Skills standard: `SKILL.md` (under ~500 lines) plus `references/cli-reference.md` (the verb and flag table, the `status --json` field meanings). Frontmatter: triggering description with the natural keywords ("duet run", "gate", "approve", "what's the run doing"); `allowed-tools` pre-approving **read verbs only** (`Bash(duet status*)`, `Bash(duet logs*)`, `Bash(duet runs*)`) — never the gate verbs.

The body's pillars, in priority order:

1. **Identity** — a relay, not a fourth engineer. The concierge reports, translates, and executes the human's intent; it never forms opinions about artifacts (the orchestrator's division-of-labor rule, extended one layer out).
2. **Verbatim discipline** — the human's words cross unparaphrased into `--reject`, `--answer`, and `steer`. Summarize *toward* the human freely; never editorialize *from* them.
3. **The channel-translation table** — the skill's core competence: live phase → `duet steer`; gate → `continue --approve` / `--reject "<verbatim>"`; flag → `continue --answer "<verbatim>"`; "start a run" → draft the framing file from dictation, show it, then `duet new --framing <file>`. `status --json`'s `stop.kind` is the discriminator, so the translation is mechanical.
4. **Supervision recipe** — a `/loop`-based watch on `status --json` (or Monitor on `duet logs`); when a stop lands, *end the turn with the report* — the turn-ending report is what fires Claude Code's mobile push reliably.
5. **Setup** — one-time: the permission ask-rule (`"ask": ["Bash(duet continue*)"]`) so gate verbs always prompt, on the phone too; the recommendation to run a dedicated session (`claude --model sonnet`, then `/remote-control`, then the loop). Recommendation in prose — no frontmatter `model:` pin.

A coherence test in the style of `tests/snippets.test.ts` guards the skill: every duet verb and flag the skill or its reference names must exist in the CLI's command table — a renamed flag fails a five-second test, not a phone session.

## Non-goals

- No duet-owned server, daemon, webhook, or notification transport — Claude Code is the remote layer, `notify.ts` stays as-is.
- No worker-facing steer awareness: steers reach the orchestrator only; workers hear about them through orchestrator prompts if at all.
- No change to gate semantics, the statechart, or the event vocabulary — steer is prompt surface, not a machine event.
- No `runs --json`, no installer command, no plugin manifest in this package.

## Testing

Behaviors that matter (cases, fixtures, and mocking boundaries are the plan's job):

- Steer staging and draining across the process boundary: file-per-steer, rename-consume, queue order preserved, redelivery edge documented.
- Delivery lands on the next tool result — any tool, refusal results included — and on no result twice.
- Carry-forward: leftover steers appear in the next entry/resume prompt with provenance, then are consumed.
- CLI gating by machine tag with the right error copy per stop kind.
- `status --json`: shape pinned, `stop` discriminates correctly across running/gate/flag/done fixtures.
- Skill coherence: verbs and flags named in `skills/duet-concierge/` exist in the CLI.

## Build constraint

This package touches `driver.ts`, `tools.ts`, and the run store — the code live drivers re-spawn from — so it is built attended in normal sessions, not as a duet-on-duet run (the self-hosting hazard recorded in `docs/future-directions.md`).

## Open questions

Both resolved at plan time (`docs/plans/2026-06-12-concierge-package.md` §Decisions):

- ~~Should *delivered* steers be folded into the next gate packet's history so the human sees their own steers reflected at the stop?~~ **Yes, by instruction, not mechanism:** the orchestrator's `<human_steers>` system-prompt paragraph tells it to note received guidance in its `advance_phase` packet; the voice logs and `steers/delivered/` are the structural audit trail. Code folding steer text into packets would be the harness editorializing.
- ~~Does the steer block appear in `advance_phase`'s acknowledgement when steers arrived during the final tool call of a phase?~~ **No — steers never deliver into a dying turn.** When a call set an outcome flag (advance requested, question queued) the drain is skipped: guidance appended to a turn the orchestrator has been told to end lands and dies. Held steers ride carry-forward into the next harness prompt, where they can still shape routing. The one `ask_human` path that continues the phase (a staged answer fed back inline) delivers normally.
