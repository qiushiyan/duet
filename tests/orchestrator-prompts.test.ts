import { describe, expect } from 'vitest';
import {
  framePhaseEntryPrompt,
  implPhaseEntryPrompt,
  implementPhaseEntryPrompt,
  specPhaseEntryPrompt,
} from '../src/harness/orchestrator-prompts.ts';
import { DEFAULT_BINDINGS } from '../src/config.ts';
import { createRun } from '../src/run-store.ts';
import { consultantBindings, test } from './helpers/fixtures.ts';

// A gateless run drops only the consultant's HOLDING bet audit (spec/implement)
// from the phase briefs; its non-holding generative framing read and the
// correctness backstop (the acceptance-contract verify) are untouched. These
// assert the routing at the rendered-brief surface get_task serves.
describe('gateless drops the consultant bet-audit in the phase briefs, keeping frame + backstop', () => {
  test('frame: the generative third-opinion is byte-identical gateless or not — gateless keeps it (non-holding)', ({
    consultantRun,
  }) => {
    const attended = framePhaseEntryPrompt(consultantRun, 2);
    expect.soft(attended).toContain('consultant-frame'); // the generative analysis send
    expect.soft(attended).toContain("the consultant's analyses"); // folded into the synthesis
    consultantRun.gateless = true;
    const gateless = framePhaseEntryPrompt(consultantRun, 2);
    expect.soft(gateless).toBe(attended); // generative frame survives gateless untouched
  });

  test('spec: gateless omits the pre-gate bet audit', ({ consultantRun }) => {
    expect.soft(specPhaseEntryPrompt(consultantRun, 3)).toContain('bet audit');
    consultantRun.gateless = true;
    expect.soft(specPhaseEntryPrompt(consultantRun, 3)).not.toContain('bet audit');
  });

  test('impl: the verify backstop is byte-identical gateless or not — gateless never touches it', ({
    consultantRun,
  }) => {
    const attended = implPhaseEntryPrompt(consultantRun, 3);
    consultantRun.gateless = true;
    const gateless = implPhaseEntryPrompt(consultantRun, 3);
    expect.soft(gateless).toBe(attended); // the correctness backstop is unaffected by gateless
    expect.soft(gateless).toContain('acceptance contract'); // and it still runs
  });

  test('rir implement: gateless drops the open-ended bet audit', ({ projectDir }) => {
    const rir = createRun({ cwd: projectDir, bindings: consultantBindings, workflow: 'rir', framing: 'x' });
    expect.soft(implementPhaseEntryPrompt(rir, 1)).toContain('bet audit');
    rir.gateless = true;
    expect.soft(implementPhaseEntryPrompt(rir, 1)).not.toContain('bet audit');
  });
});

// The impl/implement briefs put a worker's scratch in the run-scoped dir and
// forbid deleting under .duet/ — the regression guard for an implementer that
// ran `rm -rf .duet` cleaning its scratch and deleted the live run mid-build.
// The old top-level `.duet/scratch/` and its "delete before handoff" step (the
// trigger) are gone; scratch now rides the run's own lifecycle.
describe('the scratch guardrail keeps a worker out of the live run state', () => {
  test('full impl: per-run scratch path, no cleanup step, deleting under .duet/ forbidden', ({ projectDir }) => {
    const run = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, framing: 'x' });
    const brief = implPhaseEntryPrompt(run, 3);
    expect.soft(brief).toContain(`.duet/runs/${run.runId}/scratch/`); // inside the run dir, not a shared parent
    expect.soft(brief).toContain('never delete .duet/'); // the hard guardrail, with its reason in the brief
    expect.soft(brief).not.toContain('.duet/scratch/'); // the old top-level location is gone
    expect.soft(brief).not.toContain('delete them before handoff'); // and the cleanup step that triggered the rm
  });

  test('rir implement: same guardrail and per-run scratch path', ({ projectDir }) => {
    const rir = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, workflow: 'rir', framing: 'x' });
    const brief = implementPhaseEntryPrompt(rir, 1);
    expect.soft(brief).toContain(`.duet/runs/${rir.runId}/scratch/`);
    expect.soft(brief).toContain('never delete .duet/');
    expect.soft(brief).not.toContain('delete them before handoff');
  });
});

// Universal (attended + gateless): a verify failure routes to the implementer for
// a bounded fix → re-verify loop, holding the gate only for an assertion that
// stays broken — the conscious softening of "a failed assertion always holds".
describe('verify self-heal (universal, when a contract is frozen)', () => {
  test('a frozen contract drives the implementer-first self-heal loop, holding only a stuck assertion', ({
    consultantRun,
  }) => {
    consultantRun.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'abc' };
    const brief = implPhaseEntryPrompt(consultantRun, 3);
    expect.soft(brief).toContain('self-heal'); // the universal loop
    expect.soft(brief).toContain('implementer first'); // route failures to the implementer, not the human
    expect.soft(brief).toContain('re-verify'); // a fresh, independent re-check
    expect.soft(brief).toContain('still fails after'); // only a stuck assertion holds the gate
  });

  test('the self-heal loop is identical gateless or not (the backstop is universal)', ({ consultantRun }) => {
    consultantRun.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'abc' };
    const attended = implPhaseEntryPrompt(consultantRun, 3);
    consultantRun.gateless = true;
    expect.soft(implPhaseEntryPrompt(consultantRun, 3)).toBe(attended);
  });
});
