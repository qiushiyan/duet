import { describe, expect } from 'vitest';
import {
  framePhaseEntryPrompt,
  implPhaseEntryPrompt,
  implementPhaseEntryPrompt,
  specPhaseEntryPrompt,
} from '../src/harness/orchestrator-prompts.ts';
import { createRun } from '../src/run-store.ts';
import { consultantBindings, test } from './helpers/fixtures.ts';

// A gateless run runs the consultant as a BACKSTOP only: its bet-level
// checkpoints (frame analysis, spec/implement bet audits) drop out of the phase
// briefs, while the correctness backstop (the acceptance-contract verify) is
// untouched. These assert the routing at the rendered-brief surface get_task serves.
describe('gateless routes the consultant to its backstop in the phase briefs', () => {
  test('frame: gateless drops the consultant from both the analysis send and the direction synthesis', ({
    consultantRun,
  }) => {
    const bound = framePhaseEntryPrompt(consultantRun, 2);
    expect.soft(bound).toContain('consultant-frame'); // the bet-level analysis send
    expect.soft(bound).toContain("the consultant's analyses"); // folded into the synthesis
    consultantRun.gateless = true;
    const gateless = framePhaseEntryPrompt(consultantRun, 2);
    expect.soft(gateless).not.toContain('consultant-frame');
    expect.soft(gateless).not.toContain("the consultant's analyses");
    expect.soft(gateless).toContain("reviewer's analysis to the implementer"); // the no-consultant synthesis
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
