import { describe, expect } from 'vitest';
import {
  countsReviewRound,
  orphanRecoveryFor,
  readOnlyFor,
  sessionIdFor,
  sessionPolicyFor,
  shouldResetAfterCompactAbort,
  voicesFor,
  workerRolesFor,
  writeAuthorityFor,
} from '../src/roles.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The role-policy module — the single home for the consultant's asymmetries.
 * These guard the enumeration contract every swept surface leans on: the
 * unbound order is byte-for-byte, and the voice surfaces never drop the
 * orchestrator.
 */
describe('role policy helpers', () => {
  test('workerRolesFor: exactly [implementer, reviewer] unbound (arc order); consultant appended when bound', ({
    run,
    consultantRun,
  }) => {
    expect.soft(workerRolesFor(run)).toEqual(['implementer', 'reviewer']);
    expect.soft(workerRolesFor(consultantRun)).toEqual(['implementer', 'reviewer', 'consultant']);
  });

  test('voicesFor: the orchestrator leads and is never dropped by the consultant', ({ run, consultantRun }) => {
    expect.soft(voicesFor(run)).toEqual(['orchestrator', 'implementer', 'reviewer']);
    expect.soft(voicesFor(consultantRun)).toEqual(['orchestrator', 'implementer', 'reviewer', 'consultant']);
  });

  test('readOnlyFor: reviewer and consultant are read-only; the implementer writes', () => {
    expect.soft(readOnlyFor('implementer')).toBe(false);
    expect.soft(readOnlyFor('reviewer')).toBe(true);
    expect.soft(readOnlyFor('consultant')).toBe(true);
  });

  test('countsReviewRound: only the reviewer on a CATALOGED review action; the midpoint checkpoint is exempt', () => {
    expect.soft(countsReviewRound('reviewer', 'review-spec')).toBe(true);
    expect.soft(countsReviewRound('reviewer', 'custom')).toBe(false);
    expect.soft(countsReviewRound('consultant', 'review-spec')).toBe(false); // additive, never substitutive
    expect.soft(countsReviewRound('implementer', 'review-spec')).toBe(false);
    // One-shot mid-build guidance, not a loop round — it must not burn the cap
    // the post-implementation review loop budgets on.
    expect.soft(countsReviewRound('reviewer', 'review-midpoint')).toBe(false);
    expect.soft(countsReviewRound('reviewer', 'review-implementation')).toBe(true);
    // Catalog-driven, not prefix-matched (T3): a review-prefixed tag the
    // library doesn't ship never counts — behavior lives in the code map,
    // where a snippet-body override can't reach it.
    expect.soft(countsReviewRound('reviewer', 'review-something-invented')).toBe(false);
  });

  test('writeAuthorityFor: the implementer writes everywhere; read-only roles gain nothing on the current arcs', ({
    run,
    rirRun,
    designRun,
    consultantRun,
  }) => {
    // The implementer's authority is the static policy — any phase, any action.
    expect.soft(writeAuthorityFor(run, 'implement', 'implementer', 'respond-review')).toBe(true);
    expect.soft(writeAuthorityFor(run, 'spec', 'implementer', 'update-spec')).toBe(true);
    // The reviewer stays read-only on every current arc/phase/action — the
    // resolver widens only on semantics no shipped arc sets yet (a fixer
    // grant, a reviewer-owned tail).
    expect.soft(writeAuthorityFor(run, 'implement', 'reviewer', 'review-implementation')).toBe(false);
    expect.soft(writeAuthorityFor(run, 'implement', 'reviewer', 'reconcile-docs')).toBe(false);
    expect.soft(writeAuthorityFor(run, 'finish', 'reviewer', 'pr-description')).toBe(false);
    expect.soft(writeAuthorityFor(rirRun, 'implement', 'reviewer', 'review-direct')).toBe(false);
    expect.soft(writeAuthorityFor(designRun, 'design', 'reviewer', 'review-design')).toBe(false);
    // The consultant's contract/verify relaxations are PROMPT-scoped — the
    // resolver never widens it, so author-never-commits holds mechanically.
    expect.soft(writeAuthorityFor(consultantRun, 'plan', 'consultant', 'consultant-contract')).toBe(false);
    expect.soft(writeAuthorityFor(consultantRun, 'implement', 'consultant', 'consultant-verify')).toBe(false);
  });

  test('sessionIdFor: persistent roles resume; the ephemeral consultant never does', ({ run }) => {
    run.workerSessions = { implementer: { provider: 'claude', id: 'i-1' }, reviewer: { provider: 'codex', id: 'r-1' }, consultant: { provider: 'claude', id: 'c-1' } };
    expect.soft(sessionIdFor(run, 'implementer', 'implement')).toBe('i-1');
    expect.soft(sessionIdFor(run, 'reviewer', 'implement')).toBe('r-1');
    expect.soft(sessionIdFor(run, 'consultant', 'implement')).toBeUndefined(); // ephemeral, despite a tracked id
  });

  test('sessionIdFor: a provider mismatch against the phase-effective binding derives a FRESH session (T1)', ({
    run,
  }) => {
    // The implementer plans on claude and builds on codex — its planning-era
    // claude session must never be resumed through the codex CLI. The reset is
    // DERIVED at the read, not evented: no crash window, idempotent on any host.
    run.bindings = {
      ...run.bindings,
      implementer: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless', build: { provider: 'codex' } },
    };
    run.workerSessions = { implementer: { provider: 'claude', id: 'planning-era' } };
    expect.soft(sessionIdFor(run, 'implementer', 'plan')).toBe('planning-era'); // pre-handoff: same provider, resume
    expect.soft(sessionIdFor(run, 'implementer', 'implement')).toBeUndefined(); // post-handoff: codex now — mint fresh
    // Once the build's codex session settles, it resumes normally post-handoff.
    run.workerSessions = { implementer: { provider: 'codex', id: 'build-era' } };
    expect.soft(sessionIdFor(run, 'implementer', 'implement')).toBe('build-era');
    expect.soft(sessionIdFor(run, 'implementer', 'plan')).toBeUndefined(); // and never leaks back into a claude phase
  });

  test('orphanRecoveryFor: takeover for the persistent roles, discard-and-reseed for the consultant', () => {
    expect.soft(orphanRecoveryFor('implementer')).toBe('takeover');
    expect.soft(orphanRecoveryFor('reviewer')).toBe('takeover');
    expect.soft(orphanRecoveryFor('consultant')).toBe('discard-and-reseed');
  });

  test('sessionPolicyFor: persistent for implementer/reviewer, ephemeral for the consultant', () => {
    expect.soft(sessionPolicyFor('implementer')).toBe('persistent');
    expect.soft(sessionPolicyFor('reviewer')).toBe('persistent');
    expect.soft(sessionPolicyFor('consultant')).toBe('ephemeral');
  });

  test('shouldResetAfterCompactAbort: only a PERSISTENT role on an aborted /compact resets', () => {
    // The one predicate settleTurn (delete) and renderTurnResult (copy) both read,
    // keyed off sessionPolicyFor — so neither site can drift onto a hard-coded
    // `role === 'implementer'`. A persistent role carries a resumable session a
    // failed compact bloats; the ephemeral consultant reseeds anyway.
    expect.soft(shouldResetAfterCompactAbort('implementer', true, true)).toBe(true);
    expect.soft(shouldResetAfterCompactAbort('reviewer', true, true)).toBe(true); // a compacting reviewer resets too
    expect.soft(shouldResetAfterCompactAbort('consultant', true, true)).toBe(false); // ephemeral — nothing to reset
    // Both turn facts are load-bearing: a non-/compact abort, or a /compact that settled, never resets.
    expect.soft(shouldResetAfterCompactAbort('implementer', false, true)).toBe(false); // not a /compact body
    expect.soft(shouldResetAfterCompactAbort('implementer', true, false)).toBe(false); // settled, not aborted
  });
});
