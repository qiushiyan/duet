import type { WorkerRole } from './providers/types.ts';
// Type-only on BOTH imports, so this module compiles to a runtime leaf (it
// value-imports nothing) — which is why run-store.ts and the harness can
// value-import it without closing a cycle. The Voice edge is erased at build.
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

/**
 * The run's bound VOICES — the orchestrator plus its worker roles. The companion
 * of workerRolesFor for the surfaces that enumerate every voice (doctor's role
 * rows, status' context, the tmux panes), not just the workers: routing those
 * through workerRolesFor would silently drop the orchestrator.
 */
export function voicesFor(state: RunState): Voice[] {
  return ['orchestrator', ...workerRolesFor(state)];
}
