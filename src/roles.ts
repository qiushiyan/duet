import { dutyBindingFor, sessionCompatible } from './config.ts';
import { continuityEdgeFor, dutiesOf, phaseSpec, stageOf, stageOfDuty, stageOfDutyLane, stagesOf } from './phases.ts';
import type { Duty, PhaseName, ReviewPosture } from './phases.ts';
import type { VoiceAddress } from './providers/types.ts';
// Type-only on the run-store imports, so no runtime cycle closes: the value
// edges out of here are phases.ts and config.ts, neither of which imports
// this module. The RunState/Voice/SessionKey edges are erased at build.
import type { RunState, SessionKey, Voice, WorkerSessionRecord } from './run-store.ts';

/**
 * Voice POLICY — the behavior keyed off an address, expressed once as data and
 * read by BOTH send_prompt hosts (the blocking path in harness/tools.ts and
 * the async harness/turn-dispatcher.ts) through the helpers below. This is
 * the canonical "deletion-test" module: scattered per-address checks are
 * ABSORBED here, never paralleled — delete the table and the rule reappears
 * at N call sites.
 *
 * The policy follows the LANE, not the individual duty: makers (architect,
 * builder) write; checkers (analyst, critic, judge) are read-only; both are
 * persistent sessions recovered by takeover. The consultant is the one
 * non-duty address — ephemeral, read-only, discard-and-reseed.
 */

interface VoicePolicy {
  /**
   * persistent — the session is resumed turn after turn (the duty voices).
   * ephemeral — a fresh seeded session per checkpoint (consultant): low-context
   * by construction, so it never decays into a second embedded checker.
   */
  session: 'persistent' | 'ephemeral';
  /** Read-only voices may not write or execute (the checker lane and the consultant). */
  readOnly: boolean;
  /**
   * How a turn orphaned by a session quit is recovered: `takeover` resumes or
   * inspects the durable session (the duty voices); `discard-and-reseed`
   * drops it and re-sends a fresh body (the consultant — ephemeral + read-only
   * makes the discard safe).
   */
  orphan: 'takeover' | 'discard-and-reseed';
}

function policyFor(address: VoiceAddress): VoicePolicy {
  if (address === 'consultant') return { session: 'ephemeral', readOnly: true, orphan: 'discard-and-reseed' };
  return { session: 'persistent', readOnly: stageOfDutyLane(address) === 'checker', orphan: 'takeover' };
}

/** Whether an address's worker runs read-only — the checker lane and the consultant. */
export function readOnlyFor(address: VoiceAddress): boolean {
  return policyFor(address).readOnly;
}

/**
 * How a turn orphaned by a session quit is recovered — `takeover` for the
 * duty voices, `discard-and-reseed` for the ephemeral consultant. The single
 * discriminator the orphan paths read (send_prompt's orphan branch,
 * check_turns' copy), so the discard-vs-takeover decision stays data.
 */
export function orphanRecoveryFor(address: VoiceAddress): 'takeover' | 'discard-and-reseed' {
  return policyFor(address).orphan;
}

/**
 * Whether duet resumes an address's session (`persistent`) or seeds a fresh
 * one each turn (`ephemeral`). The discriminator `duet takeover` reads to
 * decide resume-vs-inspect: the latest ephemeral checkpoint is inspectable
 * but never a resume target, since the next turn starts clean.
 */
export function sessionPolicyFor(address: VoiceAddress): 'persistent' | 'ephemeral' {
  return policyFor(address).session;
}

/**
 * Whether an ACCEPTED-but-aborted `/compact` turn must RESET the voice's
 * session (drop its slots so the next send mints fresh, `sessionIdFor →
 * undefined`). Keyed off the SAME policy as everything else — only a
 * `persistent` voice carries a resumable session that a failed compact
 * leaves un-compacted and bloated, so resuming it is exactly wrong; the
 * ephemeral consultant already reseeds every turn, so there is nothing to
 * reset. The ONE predicate both the settle (which performs the delete) and
 * the render (which tells the orchestrator the session was reset) read.
 */
export function shouldResetAfterCompactAbort(address: VoiceAddress, isCompactTurn: boolean, aborted: boolean): boolean {
  return aborted && isCompactTurn && sessionPolicyFor(address) === 'persistent';
}

/** A duty's session slot in `RunState.sessions` — the only SessionKey constructor. */
export function sessionKeyFor(duty: Duty): SessionKey {
  return `${stageOfDuty(duty)}.${duty}`;
}

/**
 * The planning duty whose session `duty` LIVE-continues, or undefined — the
 * registry edge (continuityEdgeFor) filtered by the frozen bindings'
 * session-compatibility. A provider- or transport-crossing edge was degraded
 * at manifest freeze (echoed there); here it simply walks nothing, so the
 * decision has exactly one derivation and no persisted copy.
 */
export function liveContinuityEdgeFor(state: RunState, duty: Duty): Duty | undefined {
  const from = continuityEdgeFor(state.workflow ?? 'full', duty);
  if (!from) return undefined;
  return sessionCompatible(dutyBindingFor(state.bindings, from), dutyBindingFor(state.bindings, duty)) ? from : undefined;
}

/**
 * The session record an address's next turn would continue — a duty's own
 * slot first, else the live continuity edge's planning slot, else none. The
 * consultant answers its one checkpoint-scoped slot (inspection only; resume
 * policy is sessionIdFor's job). The ONE record resolver every session
 * consumer reads (resume, takeover, orphan copy, doctor, stats), so "which
 * session is this voice's" cannot drift per surface. No phase parameter — a
 * duty names its own stage.
 */
export function sessionRecordFor(state: RunState, address: VoiceAddress): WorkerSessionRecord | undefined {
  if (address === 'consultant') return state.sessions['consultant'];
  const own = state.sessions[sessionKeyFor(address)];
  if (own) return own;
  const from = liveContinuityEdgeFor(state, address);
  return from ? state.sessions[sessionKeyFor(from)] : undefined;
}

/**
 * The session SLOTS a reset for `address` must clear — the duty's own slot
 * plus, while the duty still rides its continuity edge, the planning slot
 * that edge walks to. Clearing only the own slot would leave the next send
 * walking the edge straight back into the very session the reset meant to
 * drop (the wedged-past-its-ceiling case).
 */
export function sessionSlotsToReset(state: RunState, address: VoiceAddress): SessionKey[] {
  if (address === 'consultant') return ['consultant'];
  const from = liveContinuityEdgeFor(state, address);
  return from ? [sessionKeyFor(address), sessionKeyFor(from)] : [sessionKeyFor(address)];
}

/**
 * The resume session id for an address's next turn, or `undefined` when the
 * next send must mint a fresh session. Derivations, no events (T1):
 *
 * - The ephemeral consultant never resumes — the whole of "fresh session per
 *   checkpoint".
 * - A duty resumes its own slot, or the planning record its live continuity
 *   edge carries forward (a degraded edge walks nothing — the duty starts
 *   fresh, exactly what the freeze echoed).
 * - The record's provider must match the duty's frozen binding — state.json
 *   is a hint, so a hand-edited record naming the wrong provider derives
 *   fresh rather than resuming across CLIs.
 *
 * The two resume sites (the blocking turn in tools.ts, the dispatcher's
 * background launch) read this instead of `state.sessions` directly, so the
 * rules hold on BOTH hosts.
 */
export function sessionIdFor(state: RunState, address: VoiceAddress): string | undefined {
  if (address === 'consultant') return undefined;
  const record = sessionRecordFor(state, address);
  if (!record) return undefined;
  return record.provider === dutyBindingFor(state.bindings, address).provider ? record.id : undefined;
}

/**
 * The action catalog — the snippet keys whose use ENCODES BEHAVIOR, as
 * explicit metadata (T3). Deliberately a code map keyed by snippet key, never
 * fields in the snippets/ TOML: the override layers replace snippet BODIES
 * per-key, and an override must never be able to change behavior. Scope rule:
 * catalog only the keys that drive code today (round counting, write
 * authority); the full snippet taxonomy waits until something reads it.
 * tests/snippets.test.ts pins the catalog against the library — every catalog
 * key exists, and every review-family key in a phase list is cataloged.
 */
interface ActionBehavior {
  /** Counts against the phase's review-round backstop cap (the checker only). */
  readonly countsReviewRound?: true;
}

export const ACTION_CATALOG: Record<string, ActionBehavior> = {
  'review-spec': { countsReviewRound: true },
  'review-spec-again': { countsReviewRound: true },
  'review-plan': { countsReviewRound: true },
  'review-plan-again': { countsReviewRound: true },
  'review-design': { countsReviewRound: true },
  'review-design-again': { countsReviewRound: true },
  'review-implementation': { countsReviewRound: true },
  'review-implementation-again': { countsReviewRound: true },
  'review-direct': { countsReviewRound: true },
  'review-and-fix': { countsReviewRound: true },
  // Explicitly cataloged as NOT a round: the midpoint checkpoint is one-shot
  // mid-build guidance, not a round of the post-implementation review loop —
  // counting it would burn a third of the implement cap on a pause the cap
  // wasn't budgeting for.
  'review-midpoint': {},
};

/**
 * Whether a turn counts as a review round against the phase's backstop cap:
 * the CHECKER duty on a cataloged review action, and only the checker. A
 * consultant turn NEVER counts — it is additive, never substitutive, so
 * advance_phase's "needs a review round" rule keeps requiring an embedded
 * checker round. Catalog-driven, not `tag.startsWith('review')`: the metadata
 * is explicit per key, so an uncataloged or custom tag never counts and the
 * midpoint exemption is data rather than a carve-out.
 */
export function countsReviewRound(address: VoiceAddress, tag: string): boolean {
  if (address === 'consultant') return false;
  return stageOfDutyLane(address) === 'checker' && (ACTION_CATALOG[tag]?.countsReviewRound ?? false);
}

/**
 * The build tail's actions — reconcile-docs + ceo-summary, inside implement,
 * strictly before verify. Named once: writeAuthorityFor grants them to a
 * checker-owned tail, and the relay brief routes them by the same set.
 */
const BUILD_TAIL_ACTIONS: ReadonlySet<string> = new Set(['reconcile-docs', 'ceo-summary']);

/**
 * The checker's write grants per review posture, ACTION-scoped — never a
 * phase blanket. `critique` and `writable` grant nothing: under both, the
 * MAKER applies fixes (apply-review is a builder action). `fixer` grants
 * exactly review-and-fix — and only that: a review-midpoint turn under the
 * fixer stays guidance-only, because mid-build the builder is the sole writer
 * and two interleaved writers would wreck its mental model of its own tree.
 * (The judge's tail writes — reconcile-docs, ceo-summary — ride the
 * buildTailOwner grant below, not the posture.)
 */
const CHECKER_WRITE_GRANTS: Partial<Record<ReviewPosture, ReadonlySet<string>>> = {
  fixer: new Set(['review-and-fix']),
};

/**
 * Whether an address's worker turn runs WITH write authority — the one
 * resolver every harness path that mutates correctness state reads (T2). The
 * lane policy is the default beneath it: makers always write, and a read-only
 * voice widens only where the phase's semantics grant it — a posture grant
 * (action-scoped), a checker-owned build tail, or a checker-owned finish (the
 * PR mechanics are the owner's whole phase). The consultant's contract/verify
 * relaxations stay PROMPT-scoped — they never flip this flag, so
 * author-never-commits holds mechanically.
 */
export function writeAuthorityFor(state: RunState, phase: PhaseName, address: VoiceAddress, action: string): boolean {
  if (!policyFor(address).readOnly) return true;
  if (address === 'consultant') return false;
  const semantics = phaseSpec(state.workflow ?? 'full', phase).semantics;
  switch (semantics.block) {
    case 'build':
      return (
        (CHECKER_WRITE_GRANTS[semantics.reviewPosture]?.has(action) ?? false) ||
        (semantics.buildTailOwner === 'checker' && BUILD_TAIL_ACTIONS.has(action))
      );
    case 'finish':
      return semantics.finishOwner === 'checker';
    default:
      return false;
  }
}

/**
 * The protocol addresses live at `phase` — the stage's two duty voices plus
 * the consultant when bound. The send_prompt enum, the check_turns iteration,
 * and the phase-exit gate all enumerate this, so a surface can neither prompt
 * a foreign stage's duty nor drop the bound consultant.
 */
export function phaseAddressesFor(state: RunState, phase: PhaseName): VoiceAddress[] {
  const workflow = state.workflow ?? 'full';
  const [maker, checker] = dutiesOf(workflow, stageOf(workflow, phase));
  return state.bindings.consultant ? [maker, checker, 'consultant'] : [maker, checker];
}

/**
 * The run's bound VOICES — the orchestrator, every stage's duty voices in run
 * order, and the consultant when bound. The enumeration for the surfaces that
 * show every voice (doctor's rows, status's context, the tmux panes, the
 * per-voice logs), which must keep the orchestrator — a protocol-address
 * surface routed through phaseAddressesFor would silently drop it.
 */
export function voicesFor(state: RunState): Voice[] {
  const workflow = state.workflow ?? 'full';
  const duties = stagesOf(workflow).flatMap((stage) => dutiesOf(workflow, stage.name));
  return state.bindings.consultant ? ['orchestrator', ...duties, 'consultant'] : ['orchestrator', ...duties];
}
