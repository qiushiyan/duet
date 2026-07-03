import { effectiveBindingFor } from './config.ts';
import { phaseSpec } from './phases.ts';
import type { PhaseName, ReviewPosture } from './phases.ts';
import type { WorkerRole } from './providers/types.ts';
// Type-only on the run-store imports, so no runtime cycle closes: run-store.ts
// value-imports this module (workerRolesFor), and the harness value-imports
// both. The value edges out of here are phases.ts and config.ts, neither of
// which imports this module. The Voice edge is erased at build.
import type { RunState, Voice } from './run-store.ts';

/**
 * Run-state role POLICY — the consultant's three asymmetries expressed once, as
 * data, and read by BOTH send_prompt hosts (the blocking path in
 * harness/tools.ts and the async harness/turn-dispatcher.ts) through the helpers
 * below. This is the canonical "deletion-test" module: the scattered
 * `role === 'reviewer'` checks are ABSORBED here, never paralleled — delete the
 * table and the rule reappears at N call sites.
 *
 * Not a provider contract (providers/types.ts) and not persisted run data
 * (run-store.ts): it is the behavior keyed off a role, so it lives in its own
 * module, importing RunState type-only so no runtime cycle closes.
 */

interface RolePolicy {
  /**
   * persistent — the session is resumed turn after turn (implementer, reviewer).
   * ephemeral — a fresh seeded session per checkpoint (consultant): low-context
   * by construction, so it never decays into a second embedded reviewer.
   */
  session: 'persistent' | 'ephemeral';
  /** Read-only workers may not write or execute (reviewer and consultant). */
  readOnly: boolean;
  /**
   * How a turn orphaned by a session quit is recovered: `takeover` resumes or
   * inspects the durable session (the persistent roles); `discard-and-reseed`
   * drops it and re-sends a fresh body (the consultant — ephemeral + read-only
   * makes the discard safe). Consumed in slice 6; carried as data from here.
   */
  orphan: 'takeover' | 'discard-and-reseed';
}

const POLICY: Record<WorkerRole, RolePolicy> = {
  implementer: { session: 'persistent', readOnly: false, orphan: 'takeover' },
  reviewer: { session: 'persistent', readOnly: true, orphan: 'takeover' },
  consultant: { session: 'ephemeral', readOnly: true, orphan: 'discard-and-reseed' },
};

/**
 * The resume session id for a role's next turn at `phase`, or `undefined` when
 * the next send must mint a fresh session. Two derivations, no events (T1):
 *
 * - An ephemeral role never resumes — the whole of "fresh session per
 *   checkpoint".
 * - A persistent role resumes its record ONLY when the record's provider
 *   matches the phase's effective binding's provider. A mismatch (the
 *   post-handoff `build` override switched the role's provider) derives
 *   `undefined`, so a cross-provider resume is unrepresentable rather than
 *   guarded: no hook, no crash window — the answer re-derives on any host,
 *   even for a run resumed mid-arc by an older flow.
 *
 * The two resume sites (the blocking turn in tools.ts, the dispatcher's
 * background launch) read this instead of `state.workerSessions[role]`
 * directly, so both rules hold on BOTH hosts.
 */
export function sessionIdFor(state: RunState, role: WorkerRole, phase: PhaseName): string | undefined {
  if (POLICY[role].session === 'ephemeral') return undefined;
  const record = state.workerSessions[role];
  if (!record) return undefined;
  const effective = effectiveBindingFor(state.bindings, role, state.workflow ?? 'full', phase);
  return record.provider === effective.provider ? record.id : undefined;
}

/** Whether a role's worker runs read-only — the reviewer and the consultant. */
export function readOnlyFor(role: WorkerRole): boolean {
  return POLICY[role].readOnly;
}

/**
 * How a turn orphaned by a session quit is recovered — `takeover` for the
 * persistent roles, `discard-and-reseed` for the ephemeral consultant. The
 * single discriminator the orphan paths read (send_prompt's orphan branch,
 * check_turns' copy), so the discard-vs-takeover decision stays data — never a
 * re-sprinkled `role === 'consultant'` check.
 */
export function orphanRecoveryFor(role: WorkerRole): 'takeover' | 'discard-and-reseed' {
  return POLICY[role].orphan;
}

/**
 * Whether duet resumes a role's session (`persistent`) or seeds a fresh one each
 * turn (`ephemeral`). The discriminator `duet takeover` reads to decide
 * resume-vs-inspect: the latest ephemeral checkpoint is inspectable but never a
 * resume target, since the next turn starts clean.
 */
export function sessionPolicyFor(role: WorkerRole): 'persistent' | 'ephemeral' {
  return POLICY[role].session;
}

/**
 * Whether an ACCEPTED-but-aborted `/compact` turn must RESET the role's worker
 * session (drop it so the next send mints fresh, `sessionIdFor → undefined`).
 * Keyed off the SAME role policy as everything else — only a `persistent` role
 * (implementer, reviewer) carries a resumable session that a failed compact
 * leaves un-compacted and bloated, so resuming it is exactly wrong; an
 * `ephemeral` role (the consultant) already reseeds every turn, so there is
 * nothing to reset. The ONE predicate both the settle (which performs the
 * delete) and the render (which tells the orchestrator the role was reset) read,
 * so the two sites cannot drift onto a hard-coded `role === 'implementer'` that
 * silently bypasses this table.
 */
export function shouldResetAfterCompactAbort(role: WorkerRole, isCompactTurn: boolean, aborted: boolean): boolean {
  return aborted && isCompactTurn && sessionPolicyFor(role) === 'persistent';
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
  /** Counts against the phase's review-round backstop cap (reviewer only). */
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
 * Whether a turn counts as a review round against the phase's backstop cap: the
 * reviewer on a cataloged review action, and only the reviewer. A consultant
 * turn NEVER counts — it is additive, never substitutive, so advance_phase's
 * "needs a review round" rule keeps requiring an embedded reviewer round.
 * Catalog-driven, not `tag.startsWith('review')`: the metadata is explicit
 * per key, so an uncataloged or custom tag never counts and the midpoint
 * exemption is data rather than a carve-out.
 */
export function countsReviewRound(role: WorkerRole, tag: string): boolean {
  return role === 'reviewer' && (ACTION_CATALOG[tag]?.countsReviewRound ?? false);
}

/**
 * The build tail's actions — reconcile-docs + ceo-summary, inside implement,
 * strictly before verify. Named once: writeAuthorityFor grants them to a
 * reviewer-owned tail, and the relay brief routes them by the same set.
 */
const BUILD_TAIL_ACTIONS: ReadonlySet<string> = new Set(['reconcile-docs', 'ceo-summary']);

/**
 * The reviewer's write grants per review posture, ACTION-scoped — never a
 * phase blanket. `critique` and `writable` grant nothing: under both, the
 * IMPLEMENTER applies fixes (apply-review is an implementer action). `fixer`
 * grants exactly review-and-fix — and only that: a review-midpoint turn under
 * the fixer stays guidance-only, because mid-build the builder is the sole
 * writer and two interleaved writers would wreck its mental model of its own
 * tree. (The fixer's tail writes — reconcile-docs, ceo-summary — ride the
 * buildTailOwner grant below, not the posture.)
 */
const REVIEWER_WRITE_GRANTS: Partial<Record<ReviewPosture, ReadonlySet<string>>> = {
  fixer: new Set(['review-and-fix']),
};

/**
 * Whether a role's worker turn runs WITH write authority — the one resolver
 * every harness path that mutates correctness state reads (T2). The static
 * POLICY table is the default beneath it: the implementer always writes, and
 * a read-only role widens only where the phase's semantics grant it — a
 * posture grant (action-scoped), a reviewer-owned build tail, or a
 * reviewer-owned finish (the PR mechanics are the owner's whole phase). The
 * consultant's contract/verify relaxations stay PROMPT-scoped as today — they
 * never flip this flag, so author-never-commits holds mechanically.
 */
export function writeAuthorityFor(state: RunState, phase: PhaseName, role: WorkerRole, action: string): boolean {
  if (!POLICY[role].readOnly) return true;
  if (role !== 'reviewer') return false;
  const semantics = phaseSpec(state.workflow ?? 'full', phase).semantics;
  switch (semantics.block) {
    case 'build':
      return (
        (REVIEWER_WRITE_GRANTS[semantics.reviewPosture]?.has(action) ?? false) ||
        (semantics.buildTailOwner === 'reviewer' && BUILD_TAIL_ACTIONS.has(action))
      );
    case 'finish':
      return semantics.finishOwner === 'reviewer';
    default:
      return false;
  }
}

/**
 * The run's BOUND worker roles, in arc order — the always-present base pair plus
 * the consultant only when bound. The both-hosts enablement: every static
 * implementer/reviewer enumeration routes through this (slice 3), so the
 * consultant is visible on every surface when bound and the surface is
 * byte-for-byte today's when absent.
 */
export function workerRolesFor(state: RunState): WorkerRole[] {
  return state.bindings.consultant
    ? ['implementer', 'reviewer', 'consultant']
    : ['implementer', 'reviewer'];
}

/**
 * The run's bound VOICES — the orchestrator plus its worker roles. The companion
 * of workerRolesFor for the surfaces that enumerate every voice (doctor's role
 * rows, status' context, the tmux panes), not just the workers: routing those
 * through workerRolesFor would silently drop the orchestrator.
 */
export function voicesFor(state: RunState): Voice[] {
  return ['orchestrator', ...workerRolesFor(state)];
}
