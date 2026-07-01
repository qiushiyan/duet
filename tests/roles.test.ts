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

  test('countsReviewRound: only the reviewer on a review* tag', () => {
    expect.soft(countsReviewRound('reviewer', 'review-spec')).toBe(true);
    expect.soft(countsReviewRound('reviewer', 'custom')).toBe(false);
    expect.soft(countsReviewRound('consultant', 'review-spec')).toBe(false); // additive, never substitutive
    expect.soft(countsReviewRound('implementer', 'review-spec')).toBe(false);
  });

  test('sessionIdFor: persistent roles resume; the ephemeral consultant never does', ({ run }) => {
    run.workerSessions = { implementer: 'i-1', reviewer: 'r-1', consultant: 'c-1' };
    expect.soft(sessionIdFor(run, 'implementer')).toBe('i-1');
    expect.soft(sessionIdFor(run, 'reviewer')).toBe('r-1');
    expect.soft(sessionIdFor(run, 'consultant')).toBeUndefined(); // ephemeral, despite a tracked id
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
