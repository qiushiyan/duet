import { describe, expect } from 'vitest';
import {
  countsReviewRound,
  orphanRecoveryFor,
  phaseAddressesFor,
  readOnlyFor,
  sessionIdFor,
  sessionKeyFor,
  sessionPolicyFor,
  sessionSlotsToReset,
  shouldResetAfterCompactAbort,
  voicesFor,
  writeAuthorityFor,
} from '../src/voices/policy.ts';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import { createRun } from '../src/run/store.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The voice-policy module — lane-based policy plus the consultant's
 * asymmetries. These guard the enumeration contract every swept surface leans
 * on: addresses are duties, the enumerations are registry-derived (stage
 * order), and the voice surfaces never drop the orchestrator.
 */
describe('voice policy helpers', () => {
  test('phaseAddressesFor: the phase\'s stage duties in maker-first order; consultant appended when bound', ({
    run,
    consultantRun,
  }) => {
    expect.soft(phaseAddressesFor(run, 'spec')).toEqual(['architect', 'analyst']);
    expect.soft(phaseAddressesFor(run, 'implement')).toEqual(['builder', 'critic']);
    expect.soft(phaseAddressesFor(consultantRun, 'spec')).toEqual(['architect', 'analyst', 'consultant']);
    expect.soft(phaseAddressesFor(consultantRun, 'implement')).toEqual(['builder', 'critic', 'consultant']);
  });

  test('phaseAddressesFor on relay: delivery pairs the builder with the judge', ({ projectDir }) => {
    const relay = createRun({ cwd: projectDir, bindings: defaultBindingsFor('relay'), workflow: 'relay', framing: 'x' });
    expect.soft(phaseAddressesFor(relay, 'design')).toEqual(['architect', 'analyst']);
    expect.soft(phaseAddressesFor(relay, 'implement')).toEqual(['builder', 'judge']);
  });

  test('voicesFor: the orchestrator leads, every stage\'s duties follow in run order, never dropped by the consultant', ({
    run,
    consultantRun,
  }) => {
    expect.soft(voicesFor(run)).toEqual(['orchestrator', 'architect', 'analyst', 'builder', 'critic']);
    expect.soft(voicesFor(consultantRun)).toEqual(['orchestrator', 'architect', 'analyst', 'builder', 'critic', 'consultant']);
  });

  test('readOnlyFor follows the lane: makers write, checkers and the consultant are read-only', () => {
    expect.soft(readOnlyFor('architect')).toBe(false);
    expect.soft(readOnlyFor('builder')).toBe(false);
    expect.soft(readOnlyFor('analyst')).toBe(true);
    expect.soft(readOnlyFor('critic')).toBe(true);
    expect.soft(readOnlyFor('judge')).toBe(true);
    expect.soft(readOnlyFor('consultant')).toBe(true);
  });

  test('countsReviewRound: only a checker duty on a CATALOGED review action; the midpoint checkpoint is exempt', () => {
    expect.soft(countsReviewRound('analyst', 'review-spec')).toBe(true);
    expect.soft(countsReviewRound('analyst', 'custom')).toBe(false);
    expect.soft(countsReviewRound('consultant', 'review-spec')).toBe(false); // additive, never substitutive
    expect.soft(countsReviewRound('architect', 'review-spec')).toBe(false);
    // One-shot mid-build guidance, not a loop round — it must not burn the cap
    // the post-implementation review loop budgets on.
    expect.soft(countsReviewRound('critic', 'review-midpoint')).toBe(false);
    expect.soft(countsReviewRound('critic', 'review-implementation')).toBe(true);
    // Catalog-driven, not prefix-matched (T3): a review-prefixed tag the
    // library doesn't ship never counts — behavior lives in the code map,
    // where a snippet-body override can't reach it.
    expect.soft(countsReviewRound('critic', 'review-something-invented')).toBe(false);
  });

  test('countsReviewRound: the fixer round counts like any review round', () => {
    expect.soft(countsReviewRound('judge', 'review-and-fix')).toBe(true);
    expect.soft(countsReviewRound('builder', 'review-and-fix')).toBe(false);
  });

  test('writeAuthorityFor: makers write everywhere; checkers gain nothing on the critique/writable workflows', ({
    run,
    shortRun,
    blueprintRun,
    consultantRun,
  }) => {
    // The maker lane's authority is the static policy — any phase, any action.
    expect.soft(writeAuthorityFor(run, 'implement', 'builder', 'respond-review')).toBe(true);
    expect.soft(writeAuthorityFor(run, 'spec', 'architect', 'update-spec')).toBe(true);
    // The checkers stay read-only on every critique/writable phase/action — the
    // resolver widens only on semantics those workflows never set (a fixer
    // grant, a checker-owned tail).
    expect.soft(writeAuthorityFor(run, 'implement', 'critic', 'review-implementation')).toBe(false);
    expect.soft(writeAuthorityFor(run, 'implement', 'critic', 'reconcile-docs')).toBe(false);
    expect.soft(writeAuthorityFor(run, 'finish', 'critic', 'pr-description')).toBe(false);
    expect.soft(writeAuthorityFor(shortRun, 'implement', 'critic', 'review-direct')).toBe(false);
    expect.soft(writeAuthorityFor(blueprintRun, 'design', 'analyst', 'review-design')).toBe(false);
    // The consultant's contract/verify relaxations are PROMPT-scoped — the
    // resolver never widens it, so author-never-commits holds mechanically.
    expect.soft(writeAuthorityFor(consultantRun, 'plan', 'consultant', 'consultant-contract')).toBe(false);
    expect.soft(writeAuthorityFor(consultantRun, 'implement', 'consultant', 'consultant-verify')).toBe(false);
  });

  test('writeAuthorityFor on relay: the judge writes action-scoped, never phase-blanket', ({ projectDir }) => {
    const relay = createRun({ cwd: projectDir, bindings: defaultBindingsFor('relay'), workflow: 'relay', framing: 'x' });
    // The judge's grant: review-and-fix, and the checker-owned tails.
    expect.soft(writeAuthorityFor(relay, 'implement', 'judge', 'review-and-fix')).toBe(true);
    expect.soft(writeAuthorityFor(relay, 'implement', 'judge', 'reconcile-docs')).toBe(true); // buildTailOwner
    expect.soft(writeAuthorityFor(relay, 'implement', 'judge', 'ceo-summary')).toBe(true); // buildTailOwner
    expect.soft(writeAuthorityFor(relay, 'finish', 'judge', 'pr-description')).toBe(true); // finishOwner
    // Action-scoped, never a blanket: mid-build the builder is the sole writer,
    // so a midpoint turn under the fixer posture stays guidance-only — two
    // interleaved writers would wreck the builder's model of its own tree.
    expect.soft(writeAuthorityFor(relay, 'implement', 'judge', 'review-midpoint')).toBe(false);
    expect.soft(writeAuthorityFor(relay, 'implement', 'judge', 'custom')).toBe(false);
    // And never in the planning stage — relay's analyst is critique-only pre-handoff.
    expect.soft(writeAuthorityFor(relay, 'design', 'analyst', 'review-design')).toBe(false);
    expect.soft(writeAuthorityFor(relay, 'frame', 'analyst', 'think-holistic')).toBe(false);
  });

  test('sessionKeyFor: a duty names its own stage, so the slot key needs no phase', () => {
    expect.soft(sessionKeyFor('architect')).toBe('planning.architect');
    expect.soft(sessionKeyFor('analyst')).toBe('planning.analyst');
    expect.soft(sessionKeyFor('builder')).toBe('delivery.builder');
    expect.soft(sessionKeyFor('judge')).toBe('delivery.judge');
  });

  test('sessionIdFor: duty slots resume within their stage; the ephemeral consultant never does', ({ run }) => {
    run.sessions = {
      'planning.architect': { provider: 'claude', id: 'i-1' },
      'planning.analyst': { provider: 'codex', id: 'r-1' },
      consultant: { provider: 'claude', id: 'c-1' },
    };
    expect.soft(sessionIdFor(run, 'architect')).toBe('i-1');
    expect.soft(sessionIdFor(run, 'analyst')).toBe('r-1');
    expect.soft(sessionIdFor(run, 'consultant')).toBeUndefined(); // ephemeral, despite a tracked slot
  });

  test('sessionIdFor: a delivery duty with a LIVE continuity edge resumes the planning session (full)', ({ run }) => {
    // Before the builder's first delivery settle, its slot is empty — the
    // builder←architect edge carries the planning session across the boundary
    // (the boundary compact rides that resumed session). Once the builder's
    // own record exists, it wins.
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'planning-era' } };
    expect.soft(sessionIdFor(run, 'builder')).toBe('planning-era'); // edge walk
    expect.soft(sessionIdFor(run, 'critic')).toBeUndefined(); // analyst never settled — nothing to carry
    run.sessions['delivery.builder'] = { provider: 'claude', id: 'build-era' };
    expect.soft(sessionIdFor(run, 'builder')).toBe('build-era'); // own slot wins
    expect.soft(sessionIdFor(run, 'architect')).toBe('planning-era'); // planning still resumes its own
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
    expect.soft(sessionIdFor(run, 'architect')).toBe('planning-era'); // planning: own slot, same provider
    expect.soft(sessionIdFor(run, 'builder')).toBeUndefined(); // delivery: degraded edge — mint fresh
    // Once the build's codex session settles under its own slot, it resumes.
    run.sessions['delivery.builder'] = { provider: 'codex', id: 'build-era' };
    expect.soft(sessionIdFor(run, 'builder')).toBe('build-era');
  });

  test('sessionIdFor: relay declares no edges — the whole delivery is born fresh', ({ projectDir }) => {
    const relay = createRun({ cwd: projectDir, workflow: 'relay', bindings: defaultBindingsFor('relay'), framing: 'x' });
    relay.sessions = {
      'planning.architect': { provider: 'claude', id: 'arch-1' },
      'planning.analyst': { provider: 'codex', id: 'ana-1' },
    };
    expect.soft(sessionIdFor(relay, 'builder')).toBeUndefined(); // fresh by design
    expect.soft(sessionIdFor(relay, 'judge')).toBeUndefined(); // fresh by design
    expect.soft(sessionIdFor(relay, 'architect')).toBe('arch-1'); // planning untouched
  });

  test('sessionSlotsToReset: a duty riding a live edge clears the planning slot too, or the walk resurrects the session', ({ run }) => {
    // full's builder before its own slot exists: resetting only delivery.builder
    // would leave sessionIdFor walking the edge straight back into the wedged
    // planning session the reset meant to drop.
    expect.soft(sessionSlotsToReset(run, 'builder')).toEqual(['delivery.builder', 'planning.architect']);
    expect.soft(sessionSlotsToReset(run, 'architect')).toEqual(['planning.architect']);
    expect.soft(sessionSlotsToReset(run, 'consultant')).toEqual(['consultant']);
    // A degraded edge walks nothing, so there is nothing extra to clear.
    run.bindings = { ...run.bindings, duties: { ...run.bindings.duties, builder: { provider: 'codex' } } };
    expect.soft(sessionSlotsToReset(run, 'builder')).toEqual(['delivery.builder']);
  });

  test('orphanRecoveryFor: takeover for the persistent duties, discard-and-reseed for the consultant', () => {
    expect.soft(orphanRecoveryFor('builder')).toBe('takeover');
    expect.soft(orphanRecoveryFor('analyst')).toBe('takeover');
    expect.soft(orphanRecoveryFor('consultant')).toBe('discard-and-reseed');
  });

  test('sessionPolicyFor: persistent for every duty, ephemeral for the consultant', () => {
    expect.soft(sessionPolicyFor('architect')).toBe('persistent');
    expect.soft(sessionPolicyFor('critic')).toBe('persistent');
    expect.soft(sessionPolicyFor('consultant')).toBe('ephemeral');
  });

  test('shouldResetAfterCompactAbort: only a PERSISTENT voice on an aborted /compact resets', () => {
    // The one predicate settleTurn (delete) and renderTurnResult (copy) both read,
    // keyed off sessionPolicyFor — so neither site can drift onto a hard-coded
    // duty check. A persistent voice carries a resumable session a failed
    // compact bloats; the ephemeral consultant reseeds anyway.
    expect.soft(shouldResetAfterCompactAbort('builder', true, true)).toBe(true);
    expect.soft(shouldResetAfterCompactAbort('critic', true, true)).toBe(true); // a compacting checker resets too
    expect.soft(shouldResetAfterCompactAbort('consultant', true, true)).toBe(false); // ephemeral — nothing to reset
    // Both turn facts are load-bearing: a non-/compact abort, or a /compact that settled, never resets.
    expect.soft(shouldResetAfterCompactAbort('builder', false, true)).toBe(false); // not a /compact body
    expect.soft(shouldResetAfterCompactAbort('builder', true, false)).toBe(false); // settled, not aborted
  });
});
