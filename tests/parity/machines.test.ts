import { describe, expect, test } from 'vitest';
import { interactiveMachineFor, machineFor } from '../../src/run/machine.ts';
import { WORKFLOWS } from '../../src/registry/workflows.ts';
import type { WorkflowName } from '../../src/registry/workflows.ts';

/**
 * The machine-shape parity pins: each workflow's statechart serialized to its
 * structural facts — state names, tags, event→target transitions, the entry
 * route, the invoke wiring. JSON.stringify drops the function-valued fields
 * (the invoke input mapper, the context factory), leaving exactly the shape
 * the vocabulary refactor must preserve: same states, same gates, same
 * human.*-only crossings. The relay commit ADDS a machine (a new pin), it
 * never changes these three.
 */

// Derived from the registry, never a hand list — a new workflow's machine
// shape is pinned the same commit it ships.
const WORKFLOW_NAMES = Object.keys(WORKFLOWS) as readonly WorkflowName[];

const shapeOf = (workflow: WorkflowName): string => {
  const { config } = machineFor(workflow);
  return JSON.stringify({ id: config.id, initial: config.initial, states: config.states }, null, 2);
};

describe('machine-shape parity pins', () => {
  for (const workflow of WORKFLOW_NAMES) {
    test(workflow, async () => {
      await expect(shapeOf(workflow)).toMatchFileSnapshot(`./pins/machines/${workflow}.json`);
    });
  }

  test('the interactive machine shares each workflow’s shape (only the phase actor differs)', () => {
    for (const workflow of WORKFLOW_NAMES) {
      const { config } = interactiveMachineFor(workflow);
      expect
        .soft(JSON.stringify({ id: config.id, initial: config.initial, states: config.states }, null, 2))
        .toBe(shapeOf(workflow));
    }
  });
});
