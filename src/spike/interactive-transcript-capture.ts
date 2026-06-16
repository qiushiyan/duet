/**
 * Live-auth verification handoff for the interactive Claude worker transport.
 *
 * WRITTEN, NEVER RUN BY THE AFK IMPLEMENTER. Running it needs a real,
 * already-authenticated interactive `claude` login (subscription OAuth) and a
 * tmux server — a login the AFK run cannot perform without blocking or failing.
 * It is the human's to run, by hand, once: it drives one (then a resumed, then a
 * `/compact`) prompt through the REAL TmuxPane + the locator + parseInteractiveTurn
 * and prints each captured turn for eyeballing.
 *
 *   node src/spike/interactive-transcript-capture.ts
 *
 * The five checks this is the evidence for — each a pass/fail the spike cannot
 * claim proven without it:
 *
 *   1. BILLING METER. A real interactive turn draws the FLAT interactive quota,
 *      not the metered Agent-SDK credit pool. (Confirm against your usage after
 *      a turn — this script can't read the meter; that's the manual part.)
 *   2. BYPASS SUPPRESSES PROMPTS (P4). The driven turn edits/commits/runs with
 *      nobody at the keyboard and never blocks waiting for a permission keypress.
 *      Watch the pane (tmux attach) during turn 1 — it must not stall on a prompt.
 *   3. SESSION PIN-OR-CORRELATE IS STABLE. Turn 2 resumes turn 1's session id and
 *      the locator re-correlates to the same transcript across the resumed turn
 *      (printed below — turn 2's sessionId must equal turn 1's).
 *   4. ONE PROMPT → ONE CLEAN ASSISTANT MESSAGE. Each injected prompt yields
 *      exactly one new final assistant message the parser extracts cleanly, with
 *      a detectable turn boundary (turn 1 / turn 2 text below must be the single
 *      final reply, not joined tool narration).
 *   5. COMPACTION OVER INTERACTIVE. Interactive `/compact` writes a recognizable
 *      transcript boundary and preserves the session id, so the impl phase's
 *      first turn (compact-for-impl) captures correctly (turn 3 below must print
 *      the synthetic confirmation and the UNCHANGED session id).
 *
 * GATING ARTIFACT. The transcript the human captures here is not just a check —
 * it is the FIXTURE OF RECORD. If the real event vocabulary differs from the
 * hand-authored fixtures (tests/helpers/interactive-transcript.ts), the
 * correction lands in the isolated predicates of src/providers/interactive-claude.ts
 * (and, if the prompt/nonce or session id live somewhere unexpected, the
 * locator/watch control flow) WITH this captured transcript as the new fixture.
 * The mechanism is "proven" only once parseInteractiveTurn + the locator run
 * green against a real capture. Copy the relevant `~/.claude/projects/<slug>/
 * <session>.jsonl` lines into a fixture and re-run the Slice 1 / Slice 4 tests.
 */

import { InteractiveClaudeWorker } from '../providers/interactive-claude.ts';
import type { WorkerTurn } from '../providers/types.ts';

const MODEL = process.env['DUET_SPIKE_MODEL'] ?? 'claude-opus-4-8';
const TIMEOUT_MS = 10 * 60_000;

function show(label: string, turn: WorkerTurn): void {
  console.log(`\n=== ${label} ===`);
  console.log(`  sessionId: ${turn.sessionId}`);
  console.log(`  tokens:    ${turn.tokens ? `${turn.tokens.input} in / ${turn.tokens.output} out` : '(none reported)'}`);
  console.log(
    `  context:   ${turn.context ? `${turn.context.usedTokens}/${turn.context.windowTokens}` : '(none — window source unconfirmed; check 5/fixture)'}`,
  );
  console.log(`  costUsd:   ${turn.costUsd ?? '(omitted by P5 — expected for interactive)'}`);
  console.log(`  text:\n${turn.text}`);
}

const worker = new InteractiveClaudeWorker({ model: MODEL, timeoutMs: TIMEOUT_MS });
const cwd = process.cwd();

// Turn 1 — a fresh session: one clean assistant message, bypass posture (checks 2 & 4).
const turn1 = await worker.runTurn({
  prompt: 'Reply with exactly the single word ALPHA and nothing else.',
  cwd,
});
show('turn 1 (fresh session)', turn1);

// Turn 2 — resume turn 1's session: the id and the correlation must be stable (check 3).
const turn2 = await worker.runTurn({
  prompt: 'Reply with exactly the single word BETA and nothing else.',
  sessionId: turn1.sessionId,
  cwd,
});
show('turn 2 (resumed session)', turn2);
console.log(`\nsession stable across resume: ${turn1.sessionId === turn2.sessionId ? 'YES' : 'NO — investigate'}`);

// Turn 3 — an interactive /compact: a recognizable boundary, synthetic confirmation, session preserved (check 5).
const turn3 = await worker.runTurn({
  prompt: '/compact keep the gist of this short exchange',
  sessionId: turn2.sessionId,
  cwd,
});
show('turn 3 (/compact)', turn3);
console.log(`\nsession preserved across compact: ${turn3.sessionId === turn2.sessionId ? 'YES' : 'NO — investigate'}`);

console.log(
  '\nNext: copy the captured ~/.claude/projects/<slug>/<session>.jsonl lines into a fixture and re-run the Slice 1 / Slice 4 tests against the real shape — that is the gate.',
);
