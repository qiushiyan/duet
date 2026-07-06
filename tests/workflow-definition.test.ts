import { describe, expect, test } from 'vitest';
import { build, compileWorkflow, defineWorkflow, doc, finish, frame } from '../src/workflows.ts';
import { WORKFLOWS } from '../src/registry/workflows.ts';

const bootstrapWorkflows = {
  full: defineWorkflow({
    name: 'full',
    title: 'Full (spec → plan → implement → ship → PR)',
    attend: ['frame', 'spec'],
    presets: { overnight: ['frame', 'spec'], 'skip-plan': ['frame', 'spec', 'implement'], afk: [] },
    phases: [
      frame(),
      doc('spec', { audit: true }),
      doc('plan', { contract: true }),
      build({ review: 'critique' }),
      finish(),
    ],
  }),
  blueprint: defineWorkflow({
    name: 'blueprint',
    title: 'Blueprint (frame → design doc → implement → ship → PR)',
    attend: ['design'],
    presets: { afk: [] },
    phases: [frame(), doc('design', { contract: true }), build({ review: 'critique' }), finish()],
  }),
  relay: defineWorkflow({
    name: 'relay',
    title: 'Relay (frame → design doc → fresh build → judge review-and-fix → PR)',
    attend: ['design'],
    presets: { afk: [] },
    phases: [frame(), doc('design', { contract: true }), build({ review: 'fixer' }), finish()],
  }),
  short: defineWorkflow({
    name: 'short',
    title: 'Short (research → implement → ship → PR)',
    presets: { afk: [] },
    phases: [frame({ name: 'research' }), build({ review: 'writable', audit: true }), finish()],
  }),
};

function registryJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe('workflow SDK bootstrap equivalence pins', () => {
  for (const name of Object.keys(bootstrapWorkflows) as Array<keyof typeof bootstrapWorkflows>) {
    test(`${name} compiles byte-identical to the shipped registry row`, () => {
      expect(registryJson(compileWorkflow(bootstrapWorkflows[name]))).toBe(registryJson(WORKFLOWS[name]));
    });
  }
});

describe('compileWorkflow rejects undeclared prose worlds', () => {
  test('a fresh fixer build from a plan fails at load with the missing-world fix', () => {
    expect(() =>
      compileWorkflow(
        defineWorkflow({
          name: 'plan-fixer',
          title: 'Plan fixer',
          phases: [frame(), doc('spec'), doc('plan'), build({ review: 'fixer' }), finish()],
        }),
      ),
    ).toThrow(/plan \+ fresh delivery|no prose world exists/);
  });
});
