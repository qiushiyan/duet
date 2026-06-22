import type { WorkerRole } from './providers/types.ts';
// Type-only: importing RunState as a value would close a runtime cycle
// (run-store.ts value-imports the harness, which reads this module). The
// RunState edge is erased at build, so no cycle exists.
import type { RunState } from './run-store.ts';

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
 * The resume session id for a role's next turn, or `undefined` for an ephemeral
 * role — the whole of "fresh session per checkpoint". The two resume sites (the
 * blocking turn in tools.ts, the dispatcher's background launch) read this
 * instead of `state.workerSessions[role]` directly, so ephemerality holds on
 * BOTH hosts.
 */
export function sessionIdFor(state: RunState, role: WorkerRole): string | undefined {
  return POLICY[role].session === 'ephemeral' ? undefined : state.workerSessions[role];
}

/** Whether a role's worker runs read-only — the reviewer and the consultant. */
export function readOnlyFor(role: WorkerRole): boolean {
  return POLICY[role].readOnly;
}

/**
 * Whether a turn counts as a review round against the phase's backstop cap: the
 * reviewer on a `review*`-tagged prompt, and only the reviewer. A consultant
 * turn NEVER counts — it is additive, never substitutive, so advance_phase's
 * "needs a review round" rule keeps requiring an embedded reviewer round.
 */
export function countsReviewRound(role: WorkerRole, tag: string): boolean {
  return role === 'reviewer' && tag.startsWith('review');
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
