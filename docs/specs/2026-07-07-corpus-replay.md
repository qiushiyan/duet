# Corpus Replay

**Status:** pre-build design. This belongs in `docs/specs/` because it is a forward-looking per-change artifact; when the slice ships, the durable facts move into the corpus runbook and engineering docs.

## Summary

The corpus already preserves a run's protocol record: the orchestrator's phase prompt and terminal calls, every worker prompt body and snippet tag, every worker response, the frozen workflow, and the terminal run state. This slice turns that archive into a deliberate replay probe: re-run one recorded phase's orchestrator as a fresh, real SDK session against workers scripted from that record, then diff the fresh routing against the original.

Replay is a differential probe of orchestrator policy under recorded worker stimuli. It is not a literal reconstruction of "what would have happened," because the current model can be nondeterministic, the snippet library may have changed, and the archived `state.json` is terminal state rather than phase-entry state. The report makes those limits visible. A replay diff is evidence for a human reading the transcript, not a score.

Once this lands, `duet` gains a one-phase replay command that spends real orchestrator tokens only after an explicit cost gate, writes only into a replay-owned output directory, and emits a human-readable report plus a JSON report. It does not judge whether a divergence is better or worse; the human keeps that call.

## Goals

Replay answers one question: faced with the same recorded phase brief and the same recorded worker responses, what routing choices does the current orchestrator make?

The report compares three surfaces:

- **Snippet routing:** each worker turn's duty, snippet tag, fan-out membership, and adapted prompt body. The tag and ordering are structural; wording changes inside an otherwise aligned prompt body are reported separately as adaptation drift.
- **Terminal calls:** whether the phase ended by `advance_phase` or `ask_human`, and the terminal content the orchestrator supplied.
- **Loop shape:** review rounds used, fan-outs, per-duty ordering, extra or missing turns, and the point where a fresh run exhausts the recorded worker script.

The core product rule is honest reconstruction. Replay serves byte-identical recorded inputs wherever the record carries them: the phase brief logged in `orchestrator.log`, worker response bodies logged in each voice log, worker prompt bodies and tags from the original record for comparison, and entry-time human input already folded into the recorded brief. Where replay must synthesize or fall back, the report names it instead of smoothing it over.

## User Behavior

The command surface is explicit because replay spends real orchestrator tokens. A normal run prints the record, phase, output directory, model/budget context, and the fact that the orchestrator will run live; it proceeds only with `--yes`. A dry-run mode performs record loading, parsing, state rewind, and reconstruction checks without invoking the SDK.

Reports separate structural drift from benign nondeterminism:

- **Structural drift** means the policy shape changed: a different snippet tag, a different duty, a changed fan-out, an extra or missing turn, a changed terminal verb, a changed terminal payload at the decision level, or extra review rounds.
- **Adaptation drift** means the fresh orchestrator chose the same structural route but worded the worker prompt differently. The report shows where the body diverged without folding that into the structural verdict.
- **Reconstruction notes** are first-class output. Examples: raw `list_snippets` tool output could not be reconstructed from the record, so replay served the current snippet library; phase-entry state was synthesized from terminal `state.json`; a scripted worker was exhausted after the fresh run sent an extra turn.

The diff has an anchored region and an unanchored tail. The anchored region runs until the first structural divergence or script exhaustion, inclusive. Adaptation diffs are meaningful there. After that point the fresh run may be receiving sentinel or mis-ordinal worker responses, so later prompt-body differences are either suppressed or labeled post-divergence, not comparable.

Records remain read-only instruments. Replay never writes to the corpus record, a live run directory, or provider session stores. Its run state, voice logs, report JSON, and report text live only under the replay output directory. Any git or filesystem side effects caused by harness tools are confined to an isolated replay workspace.

## Non-Goals

This slice does not score divergences. It produces a diff; deciding whether a changed route is better, worse, or acceptable remains a human review task.

This slice does not batch across many records, replay workers with live providers, add a UI, or version-pin the historical snippet library. It also does not try to reconstruct a whole run from gate to gate. Slice 1 targets planning/doc-loop phases, not delivery phases; delivery replay brings continuity edges, write-authority differences, and verify-checkpoint rewind rules that deserve their own state classification before they are trusted. One planning phase is enough to prove the replay kernel and make the first diff useful.

Two ratification choices stay with the human:

- **Worked example phase.** Recommendation: use `20260707-0647-0dbb` `design`, because it probes the live calibration question around review-loop convergence, compaction before re-review, optional polish routing, and low-severity `human_decisions`. Use `20260707-0545-d43b` `design` instead if the priority is consultant or contract behavior.
- **Same-version repeatability.** Recommendation: keep it out of the required first slice, but shape the JSON so repeated runs can be compared later. Making repeatability mandatory now doubles or triples token spend before the first useful harness exists. It is the natural next slice once one replay report is actionable.

## Module Shape

Replay belongs in `src/` because it composes runtime seams: the phase runner, the orchestrator SDK tool host, and `WorkerProvider`. The script layer remains thin because corpus scripts should select records, parse flags, print preambles, and write outputs, not own protocol semantics.

Planned shape:

```
src/
  run/
    voice-log.ts       shared stamped-block parser and marker vocabulary
  replay/
    record.ts          parse a corpus record into a typed replay trace
    phase-state.ts     synthesize isolated phase-entry state
    scripted-worker.ts serve recorded worker responses at the provider seam
    host.ts            PhaseHost adapter and in-process tool capture
    diff.ts            align original and fresh traces
    report.ts          render text and JSON
scripts/
  corpus/
    replay-phase.ts    CLI wrapper and cost gate
```

`src/run/voice-log.ts` owns the voice-log format shared by readers: the stamped-header splitter, the marker anchors that already power `src/surfaces/stats.ts`, and the rule that a body extends until the next stamped header. `src/surfaces/stats.ts` imports that shared vocabulary for timing, and `src/replay/record.ts` imports it for protocol reconstruction. `record.ts` legitimately adds replay-only event extraction on top: `ask_human queued`, `advance_phase` summary bodies, worker prompt bodies, and worker response bodies. The scripts must not grow their own log regexes.

`src/replay/scripted-worker.ts` implements `WorkerProvider`. It keys the script by duty ordinal: the Nth fresh send to a duty receives the Nth recorded response for that duty. It records the expected original tag and prompt body beside the fresh tag and prompt body for the diff, but it never selects a response by prompt-body equality. If the fresh run sends a turn beyond the recorded script, the provider returns a sentinel response and the report marks script exhaustion as structural drift.

`src/replay/host.ts` is a third `PhaseHost` adapter. It reuses `runHostedPhase` so entry-marker replay, nudge-once, terminal-marker handling, and crash-to-flag rails stay shared. The adapter differs only where replay is legitimately different: it serves the recorded phase brief, uses scripted providers, wraps the tools it builds to capture calls in-process, and is not retryable.

The public kernel entry point should be a small, behavioral interface: given a corpus record directory, a phase, an output directory, and a run-turn implementation, it produces report artifacts and reconstruction notes. The default run-turn spends tokens; tests inject a fake turn at the `RunOrchestratorTurn` boundary.

The deletion test is the design guardrail. If `src/run/voice-log.ts` disappears, record parsing and stats drift apart. If `src/replay/record.ts` disappears, protocol reconstruction leaks into the CLI, the diff, and tests. If `src/replay/host.ts` disappears, replay-specific conditions and tool instrumentation leak into the production in-process host. If the scripted worker adapter disappears, recorded response policy leaks into tool handlers. Each module hides a real decision behind a small interface.

## Foundation Decision

The existing structure mostly absorbs replay. `src/orchestrator/hosts/host-runner.ts` already names `PhaseHost` as the host-variation seam. `src/voices/providers/types.ts` already names `WorkerProvider` as the worker implementation seam. Replay should extend those concepts rather than add replay conditionals to the production driver.

Do not thread a `createWorkers` factory through `makeInProcessHost`. That would touch the production hot path to serve an offline instrument. Instead, `makeReplayHost` builds its own providers and calls the same `createPhaseTools` surface the production host uses.

Do not change production brief rendering. `buildPhaseBrief` reads the live spec file and current registry, which is right for live runs and wrong for replay entry. The replay host serves the recorded `harness prompt` body as the phase prompt. It also wraps `get_task` so a fresh orchestrator that re-anchors through the tool receives the recorded brief rather than a live re-render.

Do not export the private production `sdkTurn` just to make replay work. Replay can own a small SDK turn wrapper that uses the exported `toSdkTools` adapter, while tests pass a fake `RunOrchestratorTurn`. If implementation shows the wrapper is exact duplication worth sharing, factor a narrow shared helper without changing production behavior.

The one fallback the first slice accepts is `list_snippets`. Historical records log the adapted prompt bodies sent to workers, not the raw `list_snippets` tool result that the original orchestrator saw. Replay lets the real tool serve the current library and emits a reconstruction note whenever that happens. Version-pinning the snippet library is a later fidelity slice, not an implicit approximation here.

## Architecture Sketch

Replay starts by loading a corpus record through `scripts/corpus/lib.ts`, including `state.json`, `workflow.json`, and the voice logs. The record parser builds an original trace: phase prompt, worker prompt events with tags and bodies, worker response events, terminal events, timestamps, delivered steers, and parse degradation notes.

The state builder then creates an isolated replay workspace under the requested output directory. It copies or writes only the minimum run files needed for `loadRunState`, `saveRunState`, `workflowFor`, and the phase tools to operate against that workspace. It starts from the archived terminal state, but rewind is not a flat clear/preserve list. Its contract is a per-workflow, per-phase classification:

- **Inherited state** is what the phase legitimately had at entry and must be preserved. For a planning design replay, that includes the frozen workflow, bindings, framing, gate posture, branch-fixed evidence from earlier worker sessions, prior phase summaries, and any upstream artifact path that existed before this phase began.
- **Phase-produced state** is what the selected phase created and must be cleared so the fresh orchestrator can earn it again. For a blueprint or relay `design` replay, this includes `phaseStarted.design`, `rounds.design`, `sentSnippets.design`, `phaseSummaries.design`, `terminalMarker`, pending terminal/question state, the design-phase `specPath` when the phase authored the design document, and contract-authorship outputs from that phase: `acceptanceContractDraft` and any later `acceptanceContract` derived from it.
- **Replay identity state** is never inherited, even if it existed at original phase entry, because it points to provider/session reality outside the replay workspace. This includes `orchestratorSessionId`, active-turn hints, pending-turn records, and worker `contextUsage`. Preserving them would resume a ghost orchestrator session or trigger context-pressure rails against scripted workers with no real window.

Worker `sessions` are not blanket-cleared. They are classified by phase and stage: sessions that prove earlier workers were already prompted remain when the fresh phase should see the branch as fixed; sessions produced by the replayed phase are cleared. Sessions produced by a later phase than the one replayed are downstream-produced state: clear them when that can be proven, otherwise keep them inert and emit a reconstruction note. Any classification the builder cannot prove from the workflow and trace becomes a reconstruction note.

The replay host opens a session for `runHostedPhase`. It builds phase tools with the scripted worker providers and wraps the tool handlers before passing them to the orchestrator turn. The wrapper captures fresh `send_prompt`, `advance_phase`, and `ask_human` calls at the tool-handler boundary. This is the honest fresh capture: the replay process already has typed arguments and tool results in hand, so it should not write logs and then re-parse its own output to discover what happened.

When the fresh orchestrator calls `send_prompt`, the real tool rails still run: duplicate-template warnings, review-round counting, fan-out handling, terminal guards, and state writes behave as the harness defines them. The scripted provider returns recorded worker text by duty ordinal. The capture layer records the fresh duty list, tag, body, fan-out shape, and any exhaustion sentinel.

When the fresh orchestrator calls `advance_phase` or `ask_human`, the real terminal rails persist the replay state and the capture layer records the terminal verb and content. `runHostedPhase` then resolves the phase outcome through the same terminal-marker mechanism as production.

Finally, the diff aligns the original trace with the fresh trace. It reports the first structural divergence, adaptation diffs only in the anchored region, terminal differences, loop-shape differences, the unanchored tail when present, and reconstruction notes. Text is optimized for a human reading one phase. JSON mirrors the same structure for later tooling.

## Test Standards

Tests should exercise behavior through replay's public kernel and through the two real seams: `WorkerProvider` and `RunOrchestratorTurn`. They should not call the live SDK, and they should not mock internal helpers just to make assertions convenient.

Voice-log tests pin the shared stamped-header parser and marker vocabulary before replay parses anything. Record parsing tests then use small voice-log fixtures with real `appendVoiceLog` header shape. They prove the parser preserves bodies byte-for-byte, attributes tags and terminals correctly, and reports malformed or missing sections as degradation notes rather than silently dropping them.

Scripted-worker tests drive the provider directly and through `createPhaseTools`. They prove per-duty ordinal selection, expected-vs-fresh prompt capture, fan-out ordering, and exhaustion sentinel behavior. Prompt-body mismatch is an observation, never a lookup key.

Phase-state tests use temporary directories and real `loadRunState` / `saveRunState` boundaries. They prove the replay state is isolated from the corpus record, can be loaded as a normal run state, applies the per-workflow phase classification, clears phase-produced and replay-identity state, and preserves inherited state such as branch-fixed session evidence.

Replay-host tests inject a fake `RunOrchestratorTurn` that calls the provided tools. That fake is the orchestrator boundary; inside it, the real tool handlers should run. These tests prove the host serves the recorded brief, wraps `get_task`, captures tool calls in-process, drives through `runHostedPhase`, and leaves production `makeInProcessHost` untouched.

The host and phase-state coverage should include a consultant-bound contract phase where a fresh replay that skips the scripted consultant is refused at `advance_phase`, proving contract-checkpoint observability rather than only field clearing.

Diff and report tests compare typed traces, not raw logs. They should cover aligned adaptation drift, changed tag or duty, changed terminal verb/content, extra/missing turns, fan-out changes, round-count drift, anchored-region cutoff, unanchored-tail labeling, reconstruction notes, and script exhaustion. JSON and text can be checked at different altitudes: JSON for exact structure, text for the load-bearing lines a human needs.

Isolation tests are not optional. They should snapshot or hash the corpus record before and after a dry run and a fake-turn replay, assert that provider session stores were not touched, and assert that every new artifact lands under the replay output directory.

## Rabbit Holes Settled

`get_task` is a replay input surface, not a live helper during replay. If the fresh orchestrator calls it, replay returns the recorded phase brief so the orchestrator does not accidentally see a changed spec file or current registry text.

`list_snippets` remains current-library-backed in this slice. The record does not contain the raw historical tool result, and reconstructing it from adapted worker prompts would be dishonest. The report names the fallback.

Mid-phase steers are recorded, but slice 1 does not re-inject them at their original tool-result boundary. Entry-time riders, answers, and carried steers that are already folded into the recorded phase brief are reproduced by serving that brief. A recorded live steer delivered during a tool result becomes a reconstruction note unless this slice's worked example proves it needs the full reinjection machinery.

The replay workspace must be realistic enough for harness rails. It is isolated from the project and corpus, but it still needs a normal `.duet/runs/<runId>` shape, the frozen `workflow.json`, and enough git/worktree shape that a surprising `create_branch` call fails only for policy-relevant reasons. Any project file that cannot be reconstructed is a note, not a silent live read.

Capture at the tool-handler boundary sees the structural events replay needs: `send_prompt` arguments before the worker response, terminal tool arguments, and handler results. The original record still needs log parsing because historical runs only exist as logs.

Ordinal scripting intentionally cascades after early structural drift. If the fresh orchestrator sends a different first prompt to a duty, it still receives that duty's first recorded response, and the report marks the prompt mismatch. Similarity matching would hide the divergence inside the replay mechanism.

Nondeterminism is accepted, not solved. A single replay diff can show that behavior changed; it cannot prove why. Repeatability belongs in a later calibration slice unless the human ratifies it into this one.
