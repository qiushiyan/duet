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
import { defaultBindingsFor } from '../src/config.ts';
import { createRun } from '../src/run-store.ts';
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
    shortRun,
    blueprintRun,
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
    expect.soft(writeAuthorityFor(shortRun, 'implement', 'reviewer', 'review-direct')).toBe(false);
    expect.soft(writeAuthorityFor(blueprintRun, 'design', 'reviewer', 'review-design')).toBe(false);
    // The consultant's contract/verify relaxations are PROMPT-scoped — the
    // resolver never widens it, so author-never-commits holds mechanically.
    expect.soft(writeAuthorityFor(consultantRun, 'plan', 'consultant', 'consultant-contract')).toBe(false);
    expect.soft(writeAuthorityFor(consultantRun, 'implement', 'consultant', 'consultant-verify')).toBe(false);
  });

  test('writeAuthorityFor on relay: the fixer writes action-scoped, never phase-blanket', ({ projectDir }) => {
    const relay = createRun({ cwd: projectDir, bindings: defaultBindingsFor('relay'), workflow: 'relay', framing: 'x' });
    // The fixer's grant: review-and-fix, and the reviewer-owned tails.
    expect.soft(writeAuthorityFor(relay, 'implement', 'reviewer', 'review-and-fix')).toBe(true);
    expect.soft(writeAuthorityFor(relay, 'implement', 'reviewer', 'reconcile-docs')).toBe(true); // buildTailOwner
    expect.soft(writeAuthorityFor(relay, 'implement', 'reviewer', 'ceo-summary')).toBe(true); // buildTailOwner
    expect.soft(writeAuthorityFor(relay, 'finish', 'reviewer', 'pr-description')).toBe(true); // finishOwner
    // Action-scoped, never a blanket: mid-build the builder is the sole writer,
    // so a midpoint turn under the fixer posture stays guidance-only — two
    // interleaved writers would wreck the builder's model of its own tree.
    expect.soft(writeAuthorityFor(relay, 'implement', 'reviewer', 'review-midpoint')).toBe(false);
    expect.soft(writeAuthorityFor(relay, 'implement', 'reviewer', 'custom')).toBe(false);
    // And never in the planning arc — the relay reviewer is critique-only pre-handoff.
    expect.soft(writeAuthorityFor(relay, 'design', 'reviewer', 'review-design')).toBe(false);
    expect.soft(writeAuthorityFor(relay, 'frame', 'reviewer', 'think-holistic')).toBe(false);
  });

  test('countsReviewRound: the fixer round counts like any review round', () => {
    expect.soft(countsReviewRound('reviewer', 'review-and-fix')).toBe(true);
    expect.soft(countsReviewRound('implementer', 'review-and-fix')).toBe(false);
  });

  test('sessionIdFor: duty slots resume within their stage; the ephemeral consultant never does', ({ run }) => {
    run.sessions = {
      'planning.architect': { provider: 'claude', id: 'i-1' },
      'planning.analyst': { provider: 'codex', id: 'r-1' },
      consultant: { provider: 'claude', id: 'c-1' },
    };
    expect.soft(sessionIdFor(run, 'implementer', 'spec')).toBe('i-1');
    expect.soft(sessionIdFor(run, 'reviewer', 'plan')).toBe('r-1');
    expect.soft(sessionIdFor(run, 'consultant', 'plan')).toBeUndefined(); // ephemeral, despite a tracked slot
  });

  test('sessionIdFor: a delivery duty with a LIVE continuity edge resumes the planning session (full)', ({ run }) => {
    // Before the builder's first delivery settle, its slot is empty — the
    // builder←architect edge carries the planning session across the boundary
    // (the boundary compact rides that resumed session). Once the builder's
    // own record exists, it wins.
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'planning-era' } };
    expect.soft(sessionIdFor(run, 'implementer', 'implement')).toBe('planning-era'); // edge walk
    expect.soft(sessionIdFor(run, 'reviewer', 'implement')).toBeUndefined(); // analyst never settled — nothing to carry
    run.sessions['delivery.builder'] = { provider: 'claude', id: 'build-era' };
    expect.soft(sessionIdFor(run, 'implementer', 'implement')).toBe('build-era'); // own slot wins
    expect.soft(sessionIdFor(run, 'implementer', 'plan')).toBe('planning-era'); // planning still resumes its own
  });

  test('sessionIdFor: a DEGRADED edge (provider-crossing bindings) walks nothing — the build mints fresh (T1)', ({ run }) => {
    // The maker lane plans on claude (architect) and builds on codex (builder):
    // the edge was degraded at manifest freeze, so the planning-era claude
    // session must never be resumed through the codex CLI. Derived at the
    // read, not evented: no crash window, idempotent on any host.
    run.bindings = {
      ...run.bindings,
      duties: { ...run.bindings.duties, builder: { provider: 'codex' } },
    };
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'planning-era' } };
    expect.soft(sessionIdFor(run, 'implementer', 'plan')).toBe('planning-era'); // planning: own slot, same provider
    expect.soft(sessionIdFor(run, 'implementer', 'implement')).toBeUndefined(); // delivery: degraded edge — mint fresh
    // Once the build's codex session settles under its own slot, it resumes.
    run.sessions['delivery.builder'] = { provider: 'codex', id: 'build-era' };
    expect.soft(sessionIdFor(run, 'implementer', 'implement')).toBe('build-era');
  });

  test('sessionIdFor: relay declares no edges — the whole delivery is born fresh', ({ run }) => {
    run.workflow = 'relay';
    run.bindings = defaultBindingsFor('relay');
    run.sessions = {
      'planning.architect': { provider: 'claude', id: 'arch-1' },
      'planning.analyst': { provider: 'codex', id: 'ana-1' },
    };
    expect.soft(sessionIdFor(run, 'implementer', 'implement')).toBeUndefined(); // builder: fresh by design
    expect.soft(sessionIdFor(run, 'reviewer', 'implement')).toBeUndefined(); // judge: fresh by design
    expect.soft(sessionIdFor(run, 'implementer', 'design')).toBe('arch-1'); // planning untouched
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
