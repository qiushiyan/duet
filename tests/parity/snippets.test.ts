import { describe, expect, test } from 'vitest';
import {
  ANYTIME_SNIPPETS,
  UNLISTED_SNIPPETS,
  consultantSnippetsForWorkflow,
  phaseSnippetsFor,
  phasesOf,
} from '../../src/phases.ts';
import type { PhaseName, WorkflowName } from '../../src/phases.ts';
import { renderSnippetLibrary } from '../../src/snippets.ts';

/**
 * The snippet-surface parity pins, at the two seams the refactor commits must
 * hold byte-identical:
 *
 * - `phaseSnippetsFor` — the effective per-phase lists. The T7 derivation
 *   (blocks own their snippets) replaces the hand-written per-row arrays and
 *   must reproduce these lists exactly; a mismatch there is a missing knob
 *   surfacing, handled in that commit rather than papered over.
 * - `renderSnippetLibrary` — the library actually served to the orchestrator.
 *   The snippets/ directory split must keep the served output byte-identical
 *   (bodies pinned once via the flat renders; per-variant membership pinned as
 *   key lists, since variants differ only by which blocks they include).
 */

const WORKFLOWS: readonly WorkflowName[] = ['full', 'blueprint', 'relay', 'short'];

const keysOf = (rendered: string): string[] =>
  [...rendered.matchAll(/<snippet key="([^"]+)"/g)].map((m) => m[1] as string);

describe('effective snippet-list pins', () => {
  test('per-phase lists across consultant/gateless, plus the fixed sets', async () => {
    const lists: Record<string, unknown> = {};
    for (const workflow of WORKFLOWS) {
      for (const phase of phasesOf(workflow)) {
        lists[`${workflow}.${phase.name}`] = {
          base: phaseSnippetsFor(workflow, phase.name, { consultant: false }),
          consultant: phaseSnippetsFor(workflow, phase.name, { consultant: true }),
          consultantGateless: phaseSnippetsFor(workflow, phase.name, { consultant: true, gateless: true }),
        };
      }
    }
    lists['anytime'] = ANYTIME_SNIPPETS;
    lists['unlisted'] = UNLISTED_SNIPPETS;
    for (const workflow of WORKFLOWS) {
      lists[`consultant-reach.${workflow}`] = [...consultantSnippetsForWorkflow(workflow)];
      lists[`consultant-reach.${workflow}.gateless`] = [...consultantSnippetsForWorkflow(workflow, { gateless: true })];
    }
    await expect(JSON.stringify(lists, null, 2)).toMatchFileSnapshot('./pins/snippets/lists.json');
  });
});

describe('served library pins — flat', () => {
  test('unbound flat render: the shipped library minus every consultant snippet', async () => {
    await expect(renderSnippetLibrary({ all: true })).toMatchFileSnapshot('./pins/snippets/flat-unbound.txt');
  });

  test('bound no-workflow flat render: every consultant snippet body (the full shipped library)', async () => {
    await expect(renderSnippetLibrary({ all: true, consultantBound: true })).toMatchFileSnapshot(
      './pins/snippets/flat-bound.txt',
    );
  });

  test('flat membership across the consultant/workflow/gateless variants', async () => {
    const membership: Record<string, string[]> = {
      unbound: keysOf(renderSnippetLibrary({ all: true })),
      'bound.no-workflow': keysOf(renderSnippetLibrary({ all: true, consultantBound: true })),
      'bound.no-workflow.gateless': keysOf(renderSnippetLibrary({ all: true, consultantBound: true, gateless: true })),
    };
    for (const workflow of WORKFLOWS) {
      membership[`bound.${workflow}`] = keysOf(renderSnippetLibrary({ all: true, consultantBound: true, workflow }));
      membership[`bound.${workflow}.gateless`] = keysOf(
        renderSnippetLibrary({ all: true, consultantBound: true, workflow, gateless: true }),
      );
    }
    await expect(JSON.stringify(membership, null, 2)).toMatchFileSnapshot('./pins/snippets/flat-membership.json');
  });
});

// The phase-scoped view is what list_snippets actually serves mid-run: current
// phase's templates + anytime helpers in full, other phases indexed in arc
// order. One pin per structurally distinct case.
describe('served library pins — phase-scoped', () => {
  const CASES: Array<{ name: string; phase: PhaseName; workflow: WorkflowName; consultant?: boolean; gateless?: boolean }> = [
    { name: 'full-spec.unbound', phase: 'spec', workflow: 'full' },
    { name: 'full-plan.bound', phase: 'plan', workflow: 'full', consultant: true },
    { name: 'full-implement.bound', phase: 'implement', workflow: 'full', consultant: true },
    { name: 'blueprint-design.bound', phase: 'design', workflow: 'blueprint', consultant: true },
    { name: 'relay-implement.bound', phase: 'implement', workflow: 'relay', consultant: true },
    { name: 'short-implement.bound', phase: 'implement', workflow: 'short', consultant: true },
    { name: 'short-implement.bound-gateless', phase: 'implement', workflow: 'short', consultant: true, gateless: true },
  ];

  for (const c of CASES) {
    test(c.name, async () => {
      await expect(
        renderSnippetLibrary({
          phase: c.phase,
          workflow: c.workflow,
          consultantBound: c.consultant ?? false,
          gateless: c.gateless ?? false,
        }),
      ).toMatchFileSnapshot(`./pins/snippets/phase-${c.name}.txt`);
    });
  }

  test('full-frame with sent-to annotations', async () => {
    await expect(
      renderSnippetLibrary({
        phase: 'frame',
        workflow: 'full',
        sentTo: { 'think-holistic': ['implementer', 'reviewer'], 'compare-notes': ['implementer'] },
      }),
    ).toMatchFileSnapshot('./pins/snippets/phase-full-frame.sent-to.txt');
  });
});
