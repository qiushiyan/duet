import { describe, expect } from 'vitest';
import { continuePlanner } from '../src/continue-planner.ts';
import type { ContinueFacts, RestoredFacts } from '../src/continue-planner.ts';
import type { RunPosition } from '../src/harness/lifecycle.ts';
import { test } from './helpers/fixtures.ts';

/**
 * continuePlanner is the pure decision behind `duet continue` — one case per
 * ContinueAction, built from RunPosition literals and restored-machine fact
 * objects directly, with no `_drive`, editor, or git. The existing end-to-end
 * continue/afk paths (tests/cli.test.ts, continue-input.test.ts, lifecycle.test.ts)
 * remain the integration oracle for the thin executor; these pin the decision.
 */

/** A restored-machine fact bundle with overridable fields (defaults: a non-gate active loop). */
const facts = (over: Partial<RestoredFacts> = {}): RestoredFacts => ({
  value: 'implementLoop',
  status: 'active',
  hasGateTag: false,
  canApprove: false,
  canReject: false,
  canAnswer: false,
  ...over,
});

/** Compose the planner's facts argument; `restored` defaults to null (interactive / no snapshot). */
const at = (over: Partial<ContinueFacts> & { position: RunPosition }): ContinueFacts => ({
  eventType: undefined,
  headless: false,
  restored: null,
  ...over,
});

describe('continuePlanner — the interactive host', () => {
  test('approve at the handoff gate (plan) crosses to handoff and freezes the contract', ({ interactiveRun }) => {
    const action = continuePlanner(interactiveRun, at({ position: { kind: 'gate', phase: 'plan' }, eventType: 'approve' }));
    expect(action).toEqual({
      kind: 'interactive-cross',
      event: { type: 'human.approve' },
      after: 'handoff',
      freezeContractPhase: 'plan',
    });
  });

  test('approve at an earlier attended gate (spec) crosses inline with no contract freeze', ({ interactiveRun }) => {
    const action = continuePlanner(interactiveRun, at({ position: { kind: 'gate', phase: 'spec' }, eventType: 'approve' }));
    expect(action).toEqual({ kind: 'interactive-cross', event: { type: 'human.approve' }, after: 'inline' });
  });

  test('reject at a gate crosses inline (a reject never hands off)', ({ interactiveRun }) => {
    const action = continuePlanner(interactiveRun, at({ position: { kind: 'gate', phase: 'spec' }, eventType: 'reject' }));
    expect(action).toEqual({ kind: 'interactive-cross', event: { type: 'human.reject' }, after: 'inline' });
  });

  test('answer at a flag crosses inline', ({ interactiveRun }) => {
    const action = continuePlanner(interactiveRun, at({ position: { kind: 'flag', phase: 'spec' }, eventType: 'answer' }));
    expect(action).toEqual({ kind: 'interactive-cross', event: { type: 'human.answer' }, after: 'inline' });
  });

  test('bare --headless mid-phase drops to the headless driver', ({ interactiveRun }) => {
    const action = continuePlanner(interactiveRun, at({ position: { kind: 'interactive', phase: 'spec' }, headless: true }));
    expect(action).toEqual({ kind: 'interactive-drop-headless' });
  });

  test('--headless at a gate fails — the human owes a decision first', ({ interactiveRun }) => {
    const action = continuePlanner(interactiveRun, at({ position: { kind: 'gate', phase: 'spec' }, headless: true }));
    expect(action.kind).toBe('fail');
    expect((action as { message: string }).message).toContain('parked at its gate');
  });

  test('bare continue shows status', ({ interactiveRun }) => {
    const action = continuePlanner(interactiveRun, at({ position: { kind: 'gate', phase: 'spec' } }));
    expect(action).toEqual({ kind: 'interactive-show-status' });
  });

  test('an invalid crossing (approve at a flag) fails with the crossing message', ({ interactiveRun }) => {
    const action = continuePlanner(interactiveRun, at({ position: { kind: 'flag', phase: 'spec' }, eventType: 'approve' }));
    expect(action.kind).toBe('fail');
    expect((action as { message: string }).message).toContain('queued question');
  });
});

describe('continuePlanner — the headless host', () => {
  test('a crashed run with no decision re-enters from the transcripts, carrying the resume event', ({ run }) => {
    const action = continuePlanner(run, at({ position: { kind: 'crashed', phase: 'implement', resumeEvent: 'approve' } }));
    expect(action).toEqual({ kind: 'crash-recover', resumeEvent: 'approve' });
  });

  test('a crashed run with no resume event re-enters with no event', ({ run }) => {
    const action = continuePlanner(run, at({ position: { kind: 'crashed', phase: 'implement' } }));
    expect(action).toEqual({ kind: 'crash-recover' });
  });

  test('a decision with no restored snapshot fails — nothing to act on', ({ run }) => {
    const action = continuePlanner(run, at({ position: { kind: 'gate', phase: 'spec' }, eventType: 'approve', restored: null }));
    expect(action.kind).toBe('fail');
    expect((action as { message: string }).message).toContain('no gate to act on');
  });

  test('a snapshot parked at a pre-authorized gate re-enters (it auto-crosses)', ({ run }) => {
    run.gatesAt = ['frame', 'spec']; // plan is pre-authorized (not attended)
    const action = continuePlanner(
      run,
      at({ position: { kind: 'gate', phase: 'plan' }, restored: facts({ value: 'planApprovalGate', hasGateTag: true }) }),
    );
    expect(action).toEqual({ kind: 'preauth-recover' });
  });

  test('no decision at a non-gate restored state shows status', ({ run }) => {
    const action = continuePlanner(run, at({ position: { kind: 'gate', phase: 'spec' }, restored: facts({ value: 'implementLoop' }) }));
    expect(action).toEqual({ kind: 'show-status' });
  });

  test('a decision on a completed run fails', ({ run }) => {
    const action = continuePlanner(
      run,
      at({ position: { kind: 'done' }, eventType: 'approve', restored: facts({ status: 'done', value: 'done' }) }),
    );
    expect(action.kind).toBe('fail');
    expect((action as { message: string }).message).toContain('is complete');
  });

  test('an event invalid at the restored state fails with the gate-vs-flag message', ({ run }) => {
    const action = continuePlanner(
      run,
      at({ position: { kind: 'gate', phase: 'spec' }, eventType: 'answer', restored: facts({ value: 'commitSpecGate', hasGateTag: true }) }),
    );
    expect(action.kind).toBe('fail');
    expect((action as { message: string }).message).toContain('this is a gate');
  });

  test('a valid gate event becomes a gate-decision', ({ run }) => {
    const action = continuePlanner(
      run,
      at({ position: { kind: 'gate', phase: 'spec' }, eventType: 'approve', restored: facts({ value: 'commitSpecGate', hasGateTag: true, canApprove: true }) }),
    );
    expect(action).toEqual({ kind: 'gate-decision', eventType: 'approve' });
  });

  test('no decision and a valid restored gate that is attended shows status', ({ run }) => {
    // spec is attended in the overnight posture, so it is not a pre-auth re-enter.
    run.gatesAt = ['frame', 'spec'];
    const action = continuePlanner(
      run,
      at({ position: { kind: 'gate', phase: 'spec' }, restored: facts({ value: 'commitSpecGate', hasGateTag: true }) }),
    );
    expect(action).toEqual({ kind: 'show-status' });
  });
});
