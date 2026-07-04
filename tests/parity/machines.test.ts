import { describe, expect, test } from 'vitest';
import { interactiveMachineFor, machineFor } from '../../src/harness/machine.ts';
import type { WorkflowName } from '../../src/phases.ts';

/**
 * The machine-shape parity pins: each arc's statechart serialized to its
 * structural facts — state names, tags, event→target transitions, the entry
 * route, the invoke wiring. JSON.stringify drops the function-valued fields
 * (the invoke input mapper, the context factory), leaving exactly the shape
 * the vocabulary refactor must preserve: same states, same gates, same
 * human.*-only crossings. The relay commit ADDS a machine (a new pin), it
 * never changes these three.
 */

const WORKFLOWS: readonly WorkflowName[] = ['full', 'blueprint', 'relay', 'short'];

const shapeOf = (workflow: WorkflowName): string => {
  const { config } = machineFor(workflow);
  return JSON.stringify({ id: config.id, initial: config.initial, states: config.states }, null, 2);
};

describe('machine-shape parity pins', () => {
  for (const workflow of WORKFLOWS) {
    test(workflow, async () => {
      await expect(shapeOf(workflow)).toMatchFileSnapshot(`./pins/machines/${workflow}.json`);
    });
  }

  test('the interactive machine shares each arc’s shape (only the phase actor differs)', () => {
    for (const workflow of WORKFLOWS) {
      const { config } = interactiveMachineFor(workflow);
      expect
        .soft(JSON.stringify({ id: config.id, initial: config.initial, states: config.states }, null, 2))
        .toBe(shapeOf(workflow));
    }
  });
});
