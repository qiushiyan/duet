import { describe, expect } from 'vitest';
import {
  ORCHESTRATOR_SYSTEM_PROMPT,
  answerResumePrompt,
  approvalRiderBlock,
  feedbackResumePrompt,
  nudgeContinuePrompt,
  orchestratorSystemPrompt,
  renderSteerBlock,
} from '../../src/orchestrator/briefs.ts';
import type { PhaseName, WorkflowName } from '../../src/registry/workflows.ts';
import type { Steer } from '../../src/run/steers.ts';
import { test } from '../helpers/fixtures.ts';
import { parityRun } from './matrix.ts';

/**
 * Parity pins for the prompt surfaces OUTSIDE the phase briefs: the
 * orchestrator's system prompt (and its consultant/contract variants), the
 * resume prompts (gate feedback, answer, nudge), the steer block, and the
 * approval rider. Together with briefs.test.ts this pins every export of
 * orchestrator-prompts.ts that reaches a model.
 */

describe('orchestrator system prompt pins', () => {
  test('unbound: the base prompt verbatim, consultant-free on every workflow', async ({ projectDir }) => {
    const state = parityRun(projectDir);
    // Default-off byte-for-byte: no consultant ⇒ the constant itself, and the
    // workflow cannot leak in (short renders identically).
    expect.soft(orchestratorSystemPrompt(state)).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
    expect.soft(orchestratorSystemPrompt(parityRun(projectDir, { workflow: 'short' }))).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
    await expect(orchestratorSystemPrompt(state)).toMatchFileSnapshot('./pins/system-prompt/base.txt');
  });

  test('consultant-bound: contract-authoring workflows carry the contract addendum', async ({ projectDir }) => {
    await expect(
      orchestratorSystemPrompt(parityRun(projectDir, { consultant: true })),
    ).toMatchFileSnapshot('./pins/system-prompt/consultant-full.txt');
    await expect(
      orchestratorSystemPrompt(parityRun(projectDir, { workflow: 'blueprint', consultant: true })),
    ).toMatchFileSnapshot('./pins/system-prompt/consultant-blueprint.txt');
  });

  test('consultant-bound short: the base clause only — the contract feature never leaks into the workflow that deferred it', async ({
    projectDir,
  }) => {
    await expect(
      orchestratorSystemPrompt(parityRun(projectDir, { workflow: 'short', consultant: true })),
    ).toMatchFileSnapshot('./pins/system-prompt/consultant-short.txt');
  });

  test('a fixer workflow appends the writing-judge clause; other workflows stay byte-identical', async ({ projectDir }) => {
    const relay = orchestratorSystemPrompt(parityRun(projectDir, { workflow: 'relay' }));
    expect.soft(relay.startsWith(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(true); // append-only, never a rewrite
    await expect(relay).toMatchFileSnapshot('./pins/system-prompt/relay.txt');
    await expect(
      orchestratorSystemPrompt(parityRun(projectDir, { workflow: 'relay', consultant: true })),
    ).toMatchFileSnapshot('./pins/system-prompt/relay-consultant.txt');
  });
});

// Gate-feedback re-entry covers both branch pairs: re-runs-review-loop
// (reviewLoop && cap > 1) vs direct-revision, and the opens-PR amend clause.
const FEEDBACK_CASES: Array<[WorkflowName, PhaseName]> = [
  ['full', 'frame'],
  ['full', 'spec'],
  ['full', 'plan'],
  ['full', 'implement'],
  ['full', 'finish'],
  ['blueprint', 'design'],
  ['blueprint', 'implement'],
  ['relay', 'design'],
  ['relay', 'implement'],
  ['relay', 'finish'],
  ['short', 'research'],
  ['short', 'implement'],
  ['short', 'finish'],
];

describe('resume prompt pins', () => {
  test('gate feedback re-entry, per (workflow, phase)', async () => {
    const rendered = FEEDBACK_CASES.map(
      ([workflow, phase]) =>
        `=== ${workflow}/${phase} ===\n${feedbackResumePrompt(workflow, phase, 'Parity feedback: tighten the error copy.')}`,
    ).join('\n\n');
    await expect(rendered).toMatchFileSnapshot('./pins/resume/feedback.txt');
  });

  test('answer, nudge, and approval rider', async () => {
    const rendered = [
      `=== answer ===\n${answerResumePrompt('Parity answer: yes, gate it to the paid plan.')}`,
      `=== nudge ===\n${nudgeContinuePrompt()}`,
      `=== approval rider ===\n${approvalRiderBlock('Parity rider: proceed, but keep the flag name stable.')}`,
    ].join('\n\n');
    await expect(rendered).toMatchFileSnapshot('./pins/resume/other.txt');
  });

  test('steer block, live and carried', async () => {
    const steers: Steer[] = [
      { file: '001.md', text: 'Parity steer: prefer the smaller diff.', stagedAt: '2026-07-03T00:00:00.000Z', stagedDuring: 'implement' },
      { file: '002.md', text: 'Parity steer: skip the rename.', stagedAt: '2026-07-03T00:01:00.000Z' },
    ];
    const rendered = [
      `=== live ===\n${renderSteerBlock(steers, 'live')}`,
      `=== carried ===\n${renderSteerBlock(steers, 'carried')}`,
    ].join('\n\n');
    await expect(rendered).toMatchFileSnapshot('./pins/resume/steers.txt');
  });
});
