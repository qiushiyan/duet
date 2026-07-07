import { describe, expect } from 'vitest';
import { buildPhaseBrief } from '../../src/orchestrator/briefs.ts';
import type { PhaseName } from '../../src/registry/workflows.ts';
import { test } from '../helpers/fixtures.ts';
import { parityRun } from './matrix.ts';
import type { ParityRunOpts } from './matrix.ts';

/**
 * The phase-brief parity pins — every (workflow, phase) entry brief across the
 * run-state matrix, pinned byte-identical at the one public seam both hosts
 * cross (`buildPhaseBrief`). The rule (one-PR plan step 2): every conditional
 * branch in orchestrator-prompts.ts has at least one pinned fixture BEFORE the
 * renderer refactor; wording improvements discovered mid-refactor are deferred,
 * never folded in. A red pin during steps 3–7 means behavior changed — the
 * refactor is wrong, not the pin.
 *
 * Case naming: `<workflow>-<phase>.<variant>`; the variant names the branch the
 * case exists to hold (default = the workflow's materialized posture, fresh run).
 */

const CASES: Array<{ name: string; phase: PhaseName; opts: ParityRunOpts }> = [
  // ---- full: frame (attended by default; branch policy; consultant fan-out) ----
  { name: 'full-frame.default', phase: 'frame', opts: {} },
  { name: 'full-frame.consultant', phase: 'frame', opts: { consultant: true } },
  { name: 'full-frame.no-branch', phase: 'frame', opts: { branch: null } },
  { name: 'full-frame.preauthorized', phase: 'frame', opts: { gatesAt: [] } },

  // ---- full: spec (draft vs --spec review; audit checkpoint; gateless drop) ----
  { name: 'full-spec.draft', phase: 'spec', opts: { warmSessions: true } },
  {
    name: 'full-spec.draft-autocrossed',
    phase: 'spec',
    opts: { warmSessions: true, gatesAt: [], autoApprovals: ['directionGate'] },
  },
  { name: 'full-spec.review', phase: 'spec', opts: { spec: true } },
  { name: 'full-spec.review-consultant', phase: 'spec', opts: { spec: true, consultant: true } },
  {
    name: 'full-spec.review-consultant-gateless',
    phase: 'spec',
    opts: { spec: true, consultant: true, gateless: true, gatesAt: [] },
  },

  // ---- full: plan (contract author placement; spec-path vs convention prose) ----
  { name: 'full-plan.default', phase: 'plan', opts: { spec: true, warmSessions: true } },
  { name: 'full-plan.consultant', phase: 'plan', opts: { spec: true, warmSessions: true, consultant: true } },
  { name: 'full-plan.consultant-no-spec', phase: 'plan', opts: { warmSessions: true, consultant: true } },
  {
    name: 'full-plan.autocrossed',
    phase: 'plan',
    opts: { spec: true, warmSessions: true, gatesAt: [], autoApprovals: ['directionGate', 'commitSpecGate'] },
  },

  // ---- full: implement (approval narration; posture; compaction prose; verify) ----
  { name: 'full-implement.default', phase: 'implement', opts: { spec: true, warmSessions: true } },
  {
    name: 'full-implement.autocrossed',
    phase: 'implement',
    opts: { spec: true, warmSessions: true, autoApprovals: ['planApprovalGate'] },
  },
  {
    name: 'full-implement.attended',
    phase: 'implement',
    opts: { spec: true, warmSessions: true, gatesAt: ['frame', 'spec', 'plan', 'implement', 'finish'] },
  },
  { name: 'full-implement.codex', phase: 'implement', opts: { spec: true, warmSessions: true, codexImplementer: true } },
  {
    name: 'full-implement.consultant-no-contract',
    phase: 'implement',
    opts: { spec: true, warmSessions: true, consultant: true },
  },
  {
    name: 'full-implement.consultant-draft',
    phase: 'implement',
    opts: { spec: true, warmSessions: true, consultant: true, contract: 'draft' },
  },
  {
    name: 'full-implement.consultant-frozen',
    phase: 'implement',
    opts: { spec: true, warmSessions: true, consultant: true, contract: 'frozen' },
  },
  {
    name: 'full-implement.consultant-verified',
    phase: 'implement',
    opts: { spec: true, warmSessions: true, consultant: true, contract: 'verified' },
  },
  {
    name: 'full-implement.consultant-frozen-gateless',
    phase: 'implement',
    opts: { spec: true, warmSessions: true, consultant: true, contract: 'frozen', gateless: true, gatesAt: [] },
  },

  // ---- full: finish (Open-PR posture both ways; Ship-gate narration) ----
  { name: 'full-finish.default', phase: 'finish', opts: { spec: true, warmSessions: true } },
  {
    name: 'full-finish.autocrossed',
    phase: 'finish',
    opts: { spec: true, warmSessions: true, autoApprovals: ['planApprovalGate', 'shipGate'] },
  },
  {
    name: 'full-finish.attended',
    phase: 'finish',
    opts: { spec: true, warmSessions: true, gatesAt: ['frame', 'spec', 'plan', 'implement', 'finish'] },
  },

  // ---- blueprint: the one-doc workflow (frame pre-authorized by default) ----
  { name: 'blueprint-frame.default', phase: 'frame', opts: { workflow: 'blueprint' } },
  { name: 'blueprint-design.draft', phase: 'design', opts: { workflow: 'blueprint', warmSessions: true } },
  {
    name: 'blueprint-design.draft-autocrossed',
    phase: 'design',
    opts: { workflow: 'blueprint', warmSessions: true, autoApprovals: ['directionGate'] },
  },
  { name: 'blueprint-design.review', phase: 'design', opts: { workflow: 'blueprint', spec: true } },
  {
    name: 'blueprint-design.review-consultant',
    phase: 'design',
    opts: { workflow: 'blueprint', spec: true, consultant: true },
  },
  {
    name: 'blueprint-design.draft-consultant',
    phase: 'design',
    opts: { workflow: 'blueprint', warmSessions: true, consultant: true },
  },
  { name: 'blueprint-implement.default', phase: 'implement', opts: { workflow: 'blueprint', spec: true, warmSessions: true } },
  {
    name: 'blueprint-implement.codex',
    phase: 'implement',
    opts: { workflow: 'blueprint', spec: true, warmSessions: true, codexImplementer: true },
  },
  {
    name: 'blueprint-implement.consultant-frozen',
    phase: 'implement',
    opts: { workflow: 'blueprint', spec: true, warmSessions: true, consultant: true, contract: 'frozen' },
  },
  {
    // The no-contract verify skip on a DESIGN-gate workflow — pins the derived
    // gate name ("authored at the design phase", not full's plan) in the one
    // brief text shared across the verify-carrying builds.
    name: 'blueprint-implement.consultant-no-contract',
    phase: 'implement',
    opts: { workflow: 'blueprint', spec: true, warmSessions: true, consultant: true },
  },
  { name: 'blueprint-finish.default', phase: 'finish', opts: { workflow: 'blueprint', spec: true, warmSessions: true } },

  // ---- relay: the fixer workflow (blueprint's shape; the writing judge owns the tails) ----
  { name: 'relay-frame.default', phase: 'frame', opts: { workflow: 'relay' } },
  { name: 'relay-design.review', phase: 'design', opts: { workflow: 'relay', spec: true } },
  {
    name: 'relay-design.review-consultant',
    phase: 'design',
    opts: { workflow: 'relay', spec: true, consultant: true },
  },
  { name: 'relay-implement.default', phase: 'implement', opts: { workflow: 'relay', spec: true, warmSessions: true } },
  {
    name: 'relay-implement.autocrossed',
    phase: 'implement',
    opts: { workflow: 'relay', spec: true, warmSessions: true, autoApprovals: ['designGate'] },
  },
  {
    name: 'relay-implement.consultant-frozen',
    phase: 'implement',
    opts: { workflow: 'relay', spec: true, warmSessions: true, consultant: true, contract: 'frozen' },
  },
  { name: 'relay-finish.default', phase: 'finish', opts: { workflow: 'relay', spec: true, warmSessions: true } },

  // ---- short: the lighter workflow (attend-all by default; one writable round) ----
  { name: 'short-research.default', phase: 'research', opts: { workflow: 'short' } },
  { name: 'short-research.consultant', phase: 'research', opts: { workflow: 'short', consultant: true } },
  { name: 'short-implement.default', phase: 'implement', opts: { workflow: 'short', warmSessions: true } },
  { name: 'short-implement.consultant', phase: 'implement', opts: { workflow: 'short', warmSessions: true, consultant: true } },
  {
    name: 'short-implement.consultant-gateless',
    phase: 'implement',
    opts: { workflow: 'short', warmSessions: true, consultant: true, gateless: true, gatesAt: [] },
  },
  {
    name: 'short-implement.autocrossed',
    phase: 'implement',
    opts: { workflow: 'short', warmSessions: true, gatesAt: [], autoApprovals: ['directionGate'] },
  },
  { name: 'short-finish.default', phase: 'finish', opts: { workflow: 'short', warmSessions: true } },
  {
    name: 'short-finish.preauthorized',
    phase: 'finish',
    opts: { workflow: 'short', warmSessions: true, gatesAt: [], autoApprovals: ['directionGate', 'shipGate'] },
  },
];

describe('phase-brief parity pins', () => {
  for (const c of CASES) {
    test(c.name, async ({ projectDir }) => {
      const state = parityRun(projectDir, c.opts);
      await expect(buildPhaseBrief(state, c.phase)).toMatchFileSnapshot(`./pins/briefs/${c.name}.txt`);
    });
  }
});
