# Implementation plan: concierge package

**Spec:** `docs/specs/2026-06-12-concierge-package.md` (as amended — the steer CLI gating derives from driver liveness + run-state evidence, not from a phase-tagged snapshot, which never exists on disk). **Date:** 2026-06-12.

Four vertical slices, one commit each, in dependency order: the steer store and CLI command land first (a human-usable primitive), then delivery into the live orchestrator, then the status model with `--json`, then the skill that consumes both. Build constraint from the spec: this touches `driver.ts`, `tools.ts`, and the run store — built attended, never as a duet-on-duet run.

## Decisions resolved at plan time

The spec deferred two open questions to this plan, and implementation research settled two more:

1. **Steers never deliver into a dying turn** (spec open question 2). The wrapper skips draining when this call set an outcome flag (`outcome.advanceRequested || outcome.questionQueued`): a steer appended to `advance_phase`'s or a queued `ask_human`'s acknowledgement reaches an orchestrator that has been told to end its turn — the guidance lands and dies. Held steers ride carry-forward into the next prompt (phase entry, answer/feedback resume, or recovery nudge), where they can actually shape routing. The one `ask_human` path that *continues* the phase — a staged answer fed back inline — delivers normally. One rule, no per-tool special cases: *steers deliver on results that continue the phase.*

2. **Delivered steers reach the gate packet by instruction, not mechanism** (spec open question 1). The orchestrator's steer paragraph (slice 2) instructs it to reflect mid-phase guidance in its `advance_phase` summary. Structure already gives the human the audit trail — staging and delivery both land in the voice logs, and consumed steer files persist in `steers/delivered/`. Folding steer text into packets in code would be the harness editorializing; judgment to the LLM, structure to code.

3. **The `stop` model carries a fifth kind, `crashed`** (small additive spec delta). The spec names running/gate/flag/done, but a concierge that can't distinguish "phase running" from "phase died mid-flight" tells the human "all good" forever. The same signals that gate `duet steer` (live pid, snapshot position, `phaseStarted`/`pendingQuestion` evidence) discriminate it for free. Known detection limit, accepted: a driver that crashes *after* a gate rejection looks like "still at the gate" (`phaseStarted` was set long before; nothing distinguishes the re-entry). The consequence is benign — the human re-rejects or re-approves and the run recovers — and `state.json` is a hint, not forensics.

4. **`cli.ts` becomes importable via `import.meta.main`**. The skill coherence test must enumerate the real command table, but `cli.ts` ends with a top-level `parseAsync` (cli.ts:353) — importing it runs the CLI. Fix: wrap command registration in an exported `buildProgram(): Command` and guard the parse with `if (import.meta.main)` (Node 24 supports it; the `_drive` respawn uses `process.argv[1]` and is unaffected). Fallback if the global-symlink smoke test misbehaves: split a `cli-program.ts` builder module and keep `src/cli.ts` as the parsing bin — bin paths and `publishConfig` untouched either way.

Two ordering choices inside the steer mechanics, both mirroring documented house trades:

- **Tool-result delivery: peek → append → mark delivered.** A crash before the rename redelivers (benign); marking first would make the edge a *lost* steer. This is the spec's chosen trade, implemented in that order.
- **Carry-forward: drain at prompt-build time**, mirroring `consumeHumanInput`'s consume-then-crash trade (run-store.ts:203-214) — the same accepted edge, same rationale, documented at the drain site.

Concurrency note for the wrapper: the orchestrator may issue parallel tool calls (the stale-capture comment at tools.ts:154-156 exists for this). Two drains racing is tolerable — `markSteersDelivered` swallows `ENOENT` (the other drain won), and a rare double-append is a repeated human instruction, benign by the spec's own argument. The whole steer path in the wrapper is fail-soft: a steer-layer error logs and returns the handler's result unmodified, never corrupting a tool result.

---

## Slice 1 — The steer store, the position probe, and `duet steer`

The human-usable primitive: stage a note from any terminal; duet stores it durably, gates it to live (or crashed) phases, and tells you how it will arrive. No delivery yet — that's slice 2 — but nothing here is a trap: staged steers are visible on disk and in the voice log, and the confirmation says when delivery happens.

### `src/run-store.ts` — the steer store

New section after the input-staging handshake (~line 215). One steer = one JSON file under `.duet/runs/<id>/steers/`; consumed = renamed into `steers/delivered/`. File name `<ISO-stamp with ms>-<2 random bytes hex>.json` — lexicographic order is staging order, the suffix kills same-millisecond collisions (same recipe as `runId`, run-store.ts:151-152).

```ts
export interface Steer {
  file: string;            // filename — the rename handle
  text: string;            // the human's words, verbatim
  stagedAt: string;        // ISO timestamp
  stagedDuring?: PhaseName; // best-effort provenance from the position probe
}

export function stageSteer(state, text, stagedDuring?): Steer
export function listPendingSteers(state): Steer[]
export function markSteersDelivered(state, steers): void
```

- `stageSteer` mkdirs `steers/`, writes with flag `'wx'` (atomic create, never clobbers), and appends the staging event to the orchestrator voice log (`appendVoiceLog` — the spec's "staging lands in the voice logs"; two-process `O_APPEND` of small blocks is safe).
- `listPendingSteers` reads `steers/` (files only — `delivered/` is a subdir), parses, sorts by filename. Unparseable files: skip, like `listRuns` skips corrupt run dirs (run-store.ts:257-259).
- `markSteersDelivered` mkdirs `delivered/`, renames each, swallows `ENOENT`.

### `src/harness/lifecycle.ts` — the position probe

The shared derivation the spec amendment names, placed next to `aliveDriverPid` (lifecycle.ts:47-58), used by steer gating now and the status model in slice 3:

```ts
export type RunPosition =
  | { kind: 'running'; pid: number; phase: PhaseName }
  | { kind: 'gate'; phase: GatePhase }            // waiting at phase's exit gate
  | { kind: 'flag'; phase: PhaseName }            // waiting on a queued question
  | { kind: 'crashed'; phase: PhaseName }         // mid-phase, no live driver
  | { kind: 'done' };

export function probeRunPosition(state: RunState): RunPosition
```

Derivation, in order:

1. `aliveDriverPid` (excluding `process.pid` — `_drive` prints status at its own exit, cli.ts:43 already guards this) → `running`; the phase comes from the snapshot-position table below.
2. No snapshot on disk → `crashed` in the run's first phase (`specPath ? 'spec' : 'frame'`) — the driver died before the first quiescent stop.
3. Restore the snapshot through a probe actor (the `createActor` + `getSnapshot` idiom from cli.ts:180-184). `status === 'done'` → `done`.
4. Snapshot at `<P>FlagWait`: `pendingQuestion` present → `flag(P)`; absent (the answer was consumed, then the driver died) → `crashed(P)`.
5. Snapshot at phase P's gate: `phaseStarted[next(P)]` set (the entry prompt was built, then the driver died) → `crashed(next(P))`; unset → `gate(P)`. Next-phase lookup walks `PHASES` order (`phases.ts:60`).

The same table supplies `running`'s current phase (best-effort, for `stagedDuring`): no snapshot → first phase; flag-wait → P; gate → `phaseStarted[next(P)] ? next(P) : P` (a reject re-entry is mid-P). `continue`'s inline probe (cli.ts:163-197) stays as-is — it needs the raw snapshot for `.can()` validation and has its own pre-auth branch; don't force a unification.

### `src/status.ts` — the refusal copy

Pure copy function (this module owns human-facing strings): `steerRefusal(position: RunPosition, runId: string): string | undefined`. `running`/`crashed` → `undefined` (steer proceeds). Per the spec: at a gate the error names `duet continue <id> --approve` / `--reject "<feedback>"` as the steering channel there; at a flag it names `--answer "<text>"`; `done` says the run is complete. Error copy follows the house style — name the state, prescribe the channel (`parseGatesAt`'s errors at framing.ts:144-152 are the register).

### `src/cli.ts` — the command

```
duet steer <text> [runId]
```

Load the run (latest default, like every other command), `probeRunPosition`, `steerRefusal` → `fail(copy)` or `stageSteer(state, text, position.phase)`. Confirmation states the delivery contract: running → "staged — delivered on the orchestrator's next tool result (usually within minutes)"; crashed → "staged — the phase is down; it rides the recovery prompt when the run re-enters (resume with `duet continue <id>`)".

### Tests

`tests/run-store.test.ts`, new describe "the steer store":

- staging creates one file per steer under `steers/`; `listPendingSteers` returns them in staging order with verbatim text and metadata
- a second process copy (`loadRunState`) staging concurrently appends without clobbering — file-per-steer is the point
- `markSteersDelivered` removes them from the pending list; the files persist under `delivered/` (the audit trail)
- marking an already-delivered steer is a no-op (`ENOENT` swallowed — the parallel-drain race)
- staging appends to the orchestrator voice log

`tests/lifecycle.test.ts`, new describe "probeRunPosition". Snapshot fixtures come from driving `driveToQuiescence` with `scriptedMachine` outcomes (`tests/helpers/scripted-machine.ts`) — it persists `machine.json` + state at the stop, exactly as production does; "live driver" = write `process.pid`… is excluded, so use a real spawned `sleep` child or write a known-alive foreign pid — simplest is spawning a short-lived `node -e setTimeout` child and using its pid, killed in cleanup:

- live driver pid → `running`
- no snapshot, no driver → `crashed` in `frame` (framing-only run) and in `spec` (spec-entry run)
- snapshot at `directionGate`, `phaseStarted.spec` unset → `gate('frame')`; with `phaseStarted.spec` set → `crashed('spec')`
- snapshot at a flag-wait with `pendingQuestion` → `flag`; same snapshot, question consumed → `crashed` in that phase
- done snapshot → `done`

`tests/status.test.ts`, new describe "steerRefusal": `test.for` across the five kinds — gate copy names `--approve`/`--reject`, flag copy names `--answer`, done says complete, running/crashed return `undefined`.

---

## Slice 2 — Delivery: the tool-result wrapper, carry-forward, and the orchestrator contract

The steer becomes real: staged text reaches the live orchestrator on its next tool result, leftovers ride the next prompt, and the system prompt tells the orchestrator what a steer *is*.

### `src/harness/orchestrator-prompts.ts` — the steer prompt surface

One module owns all steer copy (it's prompt surface, governed by `docs/prompting-and-tool-design.md`):

- `renderSteerBlock(steers: Steer[], mode: 'live' | 'carried'): string` — the `<human_steer staged_at="…">` blocks (carried mode adds `staged_during`) plus the one steering sentence. Live mode is the spec's wording: the human's mid-phase voice, fold it into your routing from this point, it outranks reviewer opinions, it does not count toward any cap. Carried mode replaces "just now" with provenance and hands staleness to judgment: fold in what still applies; drop what a later gate decision superseded.
- A `<human_steers>` paragraph appended to `ORCHESTRATOR_SYSTEM_PROMPT` (lines 15-38), framework-with-why per convention 2: a steer is the human steering the run mid-phase — authoritative like gate feedback; process it into your routing, never answer it back (there is no reply channel mid-phase); relay it into worker prompts at your judgment; a steer is never by itself a reason to ask_human; and your `advance_phase` packet should note mid-phase guidance you received and how it shaped the routing (decision 2 above).

### `src/harness/tools.ts` — the wrapper

In `createPhaseTools`, wrap the built array before returning (tools.ts:361-363): `tools: tools.map(withSteerDelivery)`. The wrapper, per decision 1 and the ordering trade:

1. `result = await handler(args, extra)`
2. if `outcome.advanceRequested || outcome.questionQueued` → return result untouched (steers wait for carry-forward)
3. `listPendingSteers(state)` — none → return result
4. append `{ type: 'text', text: renderSteerBlock(steers, 'live') }` to `result.content` (refusal results included — `isError` results are still prompt surface)
5. `markSteersDelivered`, voice-log the delivery, narrate one `log()` line
6. steps 3–5 sit in a try/catch: on error, log and return the unmodified result — a steer bug must never corrupt a tool result

### `src/harness/driver.ts` — carry-forward

`buildPrompt` (driver.ts:206-237): compute the base prompt exactly as today, then drain — `listPendingSteers` + `markSteersDelivered` (the consume-then-crash trade, documented at the site), and return `base + '\n\n' + renderSteerBlock(steers, 'carried')` when any exist. This covers all four prompt shapes with one seam: phase entry, answer resume, feedback resume, and the crash-recovery nudge.

### Spec bookkeeping

Record decisions 1 and 2 in the spec's "Open questions" section (verdict + one line of why, strike-through style per repo convention) — the spec leads; it shouldn't still ask what the code now answers.

### Tests

`tests/tools.test.ts`, new describe "steer delivery" (the harness at tools.test.ts:20-40 already exercises wrapped handlers via `tool.handler(args, {})` — no new seam):

- a staged steer arrives appended to the next tool result (`write_note` is the cheapest carrier): `<human_steer>` block, verbatim text, `staged_at`; the steer moves to `delivered/`
- …and on no result twice: a second call carries nothing
- delivery rides refusal results: stage, then trigger the duplicate-template warning (tools.test.ts:121-134 pattern) — the `isError` result carries the block
- multiple steers staged → delivered together, in staging order
- `advance_phase`'s acknowledgement never carries steers; they stay pending (use `frame`, which advances without a review round)
- a queued `ask_human`'s acknowledgement never carries steers; they stay pending
- `ask_human` answered from a staged answer (the phase-continuing path) does deliver
- a steer staged *while* a worker turn is in flight lands on that turn's own result — the spec's minutes-cadence promise (the resolvable-promise FakeWorker pattern, tools.test.ts:100-117: start the call, stage, resolve, assert)

`tests/driver.test.ts`, new describe "steer carry-forward" (scripted sessions, driver.test.ts:22-43):

- a steer staged after `frame` advances appears in the `spec` entry prompt with `staged_during` provenance — and is consumed
- a steer staged while a question is queued rides the answer-resume prompt alongside the answer
- gate-feedback resume carries pending steers the same way
- crash-recovery re-entry (nothing staged, phase already started) carries them on the nudge prompt

---

## Slice 3 — The status model and `duet status --json`

`status.ts` splits into one derivation and two renderers; the JSON surface is the model, verbatim.

### `src/status.ts` — model + renderers

```ts
export interface StatusModel {
  runId: string; createdAt: string;
  branch?: string; specPath?: string; machineState?: string;
  stop:
    | { kind: 'running'; pid: number; phase: PhaseName }
    | { kind: 'gate'; phase: GatePhase; gate: string; heading: string; hint?: string;
        packet?: { summary: string; artifacts: string[] };
        commands: { approve: string; reject: string } }
    | { kind: 'flag'; question: string; context?: string; command: string }
    | { kind: 'crashed'; phase: PhaseName; command: string }
    | { kind: 'done'; summary?: string };
  gatesAt?: GatePhase[];
  autoApprovals: Array<{ gate: string; at: string; headline: string }>;
  rounds: Array<{ phase: PhaseName; used: number; cap: number }>;
  costs: RunState['costs'];
  pendingSteers: Array<{ stagedAt: string; stagedDuring?: PhaseName; text: string }>;
  snippetProposals: Array<{ snippetKey: string; rationale: string; at: string }>; // bodies stay in state.json
  lastActivity?: string;
}

export function buildStatusModel(state: RunState, position: RunPosition,
  pendingSteers: Steer[]): StatusModel
```

- The `stop` discrimination is `RunPosition` (slice 1) joined with the phase table: gate stops pull `heading`/`hint` from `gateOf`, the packet from `phaseSummaries`, and render the decide-with commands as full strings — the concierge's channel translation becomes string lookup. The auto-approval headline extraction (status.ts:62-66) moves into the model.
- `renderStatus(model)` keeps today's copy, ported to read the model; two additions: a `pendingSteers` section ("staged steers awaiting delivery", with text and age) and the `crashed` stop ("the <phase> phase stopped mid-flight — resume with `duet continue <id>`").
- `describeStop` stays as-is — the notification body has its own callers (lifecycle.ts:118) and needs no model.
- Purity holds: `status.ts` still touches no fs/process/xstate — the CLI gathers `position` and `pendingSteers` and passes them in.

### `src/cli.ts`

`status` gains `--json` (cli.ts:327-336); `showStatus` (cli.ts:38-46) becomes: probe → `buildStatusModel(state, position, listPendingSteers(state))` → human render or `JSON.stringify(model, null, 2)`. The `_drive` exit-status path (cli.ts:245) flows through the same probe (its own-pid exclusion is in the probe, decision in slice 1).

### Tests

`tests/status.test.ts`:

- existing `renderStatus` copy tests re-point mechanically: `renderStatus(buildStatusModel(run, position, []))` with hand-built positions — the pinned copy stays pinned
- stop discrimination: `test.for` across fixtures of all five kinds — `stop.kind` and payload (gate carries heading + packet + both command strings; flag carries the question verbatim; crashed carries the resume command)
- the schema-promise guard: `Object.keys(model).sort()` pinned exactly — removing or renaming a field fails a test, which is the additive-only promise made enforceable (the skill's reference doc documents these fields)
- the steers section renders text + provenance; the crashed stop copy renders
- gate `commands` strings round-trip into the documented `duet continue <id> --approve` / `--reject "<feedback>"` forms

---

## Slice 4 — The skill and its coherence test

Packaging plus discipline, zero runtime — and a test that makes a renamed flag fail in five seconds instead of in a phone session.

### `src/cli.ts` — importable program

Wrap registration in `export function buildProgram(): Command` (the existing `program` construction, cli.ts:56-351, moves inside); tail becomes `if (import.meta.main) await buildProgram().parseAsync(process.argv)`. Smoke-check the global symlink (`duet status` via the `pnpm add -g .` link) and `pnpm build` before committing; fall back to the `cli-program.ts` split (decision 4) if either misbehaves.

### `skills/duet-concierge/SKILL.md` (new top-level `skills/` dir)

Frontmatter: `name: duet-concierge`; a triggering `description` carrying the natural vocabulary ("duet run", "gate", "approve", "reject", "steer", "what's the run doing"); `allowed-tools` pre-approving read verbs only — `Bash(duet status*)`, `Bash(duet logs*)`, `Bash(duet runs*)`. Body, in the spec's priority order, well under the ~500-line ceiling:

1. **Identity** — a relay, not a fourth engineer: report, translate, execute the human's intent; never an opinion on an artifact (the orchestrator's division-of-labor rule, one layer out).
2. **Verbatim discipline** — the human's words cross unparaphrased into `--reject` / `--answer` / `steer` (quoting guidance included); summarize *toward* the human freely, never editorialize *from* them.
3. **The channel-translation table**, keyed on `status --json`'s `stop.kind`: `running` → `duet steer "<verbatim>"`; `gate` → `duet continue --approve` or `--reject "<verbatim>"`; `flag` → `duet continue --answer "<verbatim>"`; `crashed` → tell the human, then `duet continue` to resume on their go-ahead; `done` → report; "start a run" → draft the framing from dictation, show it verbatim, then `duet new --framing <file>`.
4. **Supervision recipe** — a `/loop` watch on `duet status --json` (or Monitor on `duet logs`); when a stop lands, *end the turn with the report* — the turn-ending report is what fires the mobile push.
5. **Setup** — the permission ask-rule (`"ask": ["Bash(duet continue*)"]`) so gate verbs always prompt, on the phone too; the dedicated-session recommendation (`claude --model sonnet`, `/remote-control`, then the loop) in prose — no frontmatter `model:` pin.

### `skills/duet-concierge/references/cli-reference.md`

The verb and flag table (every public command; `_drive`/`_colorize` excluded), the `status --json` field meanings (the slice-3 schema, field by field — this document is the compatibility promise's other half), and one worked example per stop kind.

### `tests/skill.test.ts`

- both skill files parse; SKILL.md frontmatter has `name`, `description`, `allowed-tools`
- the read-only guard: every `allowed-tools` entry matches `status`/`logs`/`runs` only — a `continue`, `new`, or `steer` pre-approval is a test failure (the rogue-concierge property, enforced)
- every `duet <verb>` token in either file names a command on `buildProgram()` (and no hidden command is referenced)
- every `--flag` appearing in a `duet <cmd> …` span exists among that command's options (`cmd.options` long names; spans = inline code + fenced blocks)
- importing `buildProgram` runs nothing (the test's own existence proves the `import.meta.main` guard)

---

## After the slices (not in this plan)

Doc updates ride a follow-up pass per the workflow: README status line, `automation-design.md` CLI table + a concierge section, `engineering.md` module map (steer store, position probe, status model), `future-directions.md` Active entry marked shipped. The skill's first live session (phone + `/remote-control` + a real run) is the verification the docs pass will cite.
