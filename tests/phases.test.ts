import { describe, expect, test } from 'vitest';
import {
  PHASE,
  WORKFLOWS,
  acceptanceContractPathForSpec,
  consultantCheckpointOf,
  consultantSnippetFor,
  contractAuthorPhaseOf,
  defaultPosture,
  gateOf,
  gatePhasesOf,
  handoffWatchLabel,
  phaseOfGateState,
  phasesOf,
  validateRegistry,
} from '../src/phases.ts';
import type { WorkflowSpecInput } from '../src/phases.ts';

/**
 * The workflow registry — the source of truth the flat lookups derive from.
 * These guard the two derivation invariants (`validateRegistry`) and pin Full's
 * arc literally, so a malformed registry can't self-validate against tests that
 * also derive from it.
 */

// A minimal phase in the registry input shape. `gateState` null ⇒ open-ended.
function phase(name: string, gateState: string | null) {
  return {
    name,
    snippets: [] as readonly string[],
    gate: gateState ? { state: gateState, heading: 'h', ready: 'r', hint: null } : null,
    artifactLabel: name,
    reviewLoop: false,
    roundCap: 1,
    orchestratorBudgetUsd: 1,
    workerBudgetUsd: 1,
    workerTurnTimeoutMs: 1,
  };
}

// A minimal valid workflow: a gate phase `a` then an open-ended `b`.
function workflow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'w',
    displayName: 'W',
    phases: [phase('a', 'aGate'), phase('b', null)],
    entry: { firstPhase: 'a' },
    handoffGate: 'a',
    presets: {},
    forceAttend: [] as readonly string[],
    defaultPreAuthorized: [] as readonly string[],
    ...overrides,
  };
}

describe('validateRegistry', () => {
  test.for<{ name: string; registry: Record<string, WorkflowSpecInput>; throws: RegExp | null }>([
    { name: 'a good registry passes', registry: { w: workflow() }, throws: null },
    {
      name: 'a phase name shared across two workflows throws',
      registry: { w1: workflow(), w2: workflow({ name: 'w2' }) },
      throws: /phase name "a" appears in both/,
    },
    {
      name: 'two gates sharing a state within one workflow throws',
      registry: { w: workflow({ phases: [phase('a', 'g'), phase('b', 'g')] }) },
      throws: /two gates with state "g"/,
    },
    {
      name: 'a handoffGate that is not a gate phase throws',
      registry: { w: workflow({ handoffGate: 'b' }) },
      throws: /handoffGate "b" is not a gate phase/,
    },
    {
      name: 'a forceAttend entry that is not a gate phase throws',
      registry: { w: workflow({ forceAttend: ['b'] }) },
      throws: /forceAttend entry "b" is not a gate phase/,
    },
    {
      name: 'a defaultPreAuthorized entry that is not a gate phase throws',
      registry: { w: workflow({ defaultPreAuthorized: ['b'] }) },
      throws: /defaultPreAuthorized entry "b" is not a gate phase/,
    },
    {
      name: 'a gate in both forceAttend and defaultPreAuthorized throws (disjointness)',
      registry: { w: workflow({ forceAttend: ['a'], defaultPreAuthorized: ['a'] }) },
      throws: /gate "a" is in both forceAttend and defaultPreAuthorized/,
    },
    {
      name: 'a preset value that is not a gate phase throws',
      registry: { w: workflow({ presets: { p: ['b'] } }) },
      throws: /preset "p" value "b" is not a gate phase/,
    },
    {
      name: 'an entry.firstPhase not in the workflow throws',
      registry: { w: workflow({ entry: { firstPhase: 'zzz' } }) },
      throws: /entry\.firstPhase "zzz" is not a phase/,
    },
    {
      name: 'an entry.specSkipsTo not in the workflow throws',
      registry: { w: workflow({ entry: { firstPhase: 'a', specSkipsTo: 'zzz' } }) },
      throws: /entry\.specSkipsTo "zzz" is not a phase/,
    },
  ])('$name', ({ registry, throws }) => {
    if (throws) expect(() => validateRegistry(registry)).toThrow(throws);
    else expect(() => validateRegistry(registry)).not.toThrow();
  });
});

describe('defaultPosture — the materialized default gate posture', () => {
  test('empty defaultPreAuthorized → undefined (legacy attend-all preserved)', () => {
    expect(defaultPosture(gatePhasesOf('full'), [])).toBeUndefined();
  });

  test("full's default exclusion ['plan','impl','finish'] resolves to ['frame','spec'] (the overnight posture)", () => {
    expect(defaultPosture(gatePhasesOf('full'), ['plan', 'impl', 'finish'])).toEqual(['frame', 'spec']);
  });

  test('a single-element exclusion drops only that gate, order preserved', () => {
    expect(defaultPosture(gatePhasesOf('full'), ['finish'])).toEqual(['frame', 'spec', 'plan', 'impl']);
  });
});

describe("the Full workflow derives today's arc", () => {
  // A literal pin (not self-derived): a malformed registry can't pass a test
  // that also derives its expectation from the registry.
  test('phasesOf("full") is the five-phase arc in order (the finishing tail collapsed to finish)', () => {
    expect(phasesOf('full').map((p) => p.name)).toEqual([
      'frame',
      'spec',
      'plan',
      'impl',
      'finish',
    ]);
  });

  test('gatePhasesOf("full") is every phase — finish carries the Open-PR gate, none are gate-less', () => {
    expect(gatePhasesOf('full')).toEqual(['frame', 'spec', 'plan', 'impl', 'finish']);
  });

  test('full pre-authorizes plan, impl, and finish by default (the overnight posture) and force-attends nothing', () => {
    expect.soft(WORKFLOWS.full.forceAttend).toEqual([]); // a draft PR open is reversible
    expect.soft(WORKFLOWS.full.defaultPreAuthorized).toEqual(['plan', 'impl', 'finish']); // disjoint from forceAttend (validateRegistry guards it)
  });

  test('PHASE indexes every phase across all workflows, flat', () => {
    expect(Object.keys(PHASE).sort()).toEqual(
      ['frame', 'impl', 'implement', 'finish', 'plan', 'publish', 'research', 'spec'].sort(),
    );
    expect(PHASE['impl'].gate?.state).toBe('shipGate');
    expect(PHASE['finish'].gate?.state).toBe('openPrGate'); // open-then-review in one phase
  });

  test('phaseOfGateState resolves within the workflow, undefined otherwise', () => {
    expect(phaseOfGateState('full', 'shipGate')).toBe('impl');
    expect(phaseOfGateState('full', 'directionGate')).toBe('frame');
    expect(phaseOfGateState('full', 'nopeGate')).toBeUndefined();
  });

  test('gateOf returns the gate spec for a gate phase', () => {
    expect(gateOf('finish').state).toBe('openPrGate');
  });
});

describe('the RIR workflow', () => {
  test('phasesOf("rir") is research → implement → publish', () => {
    expect(phasesOf('rir').map((p) => p.name)).toEqual(['research', 'implement', 'publish']);
  });

  test('all three RIR phases are gates; reused gate-state names resolve within the workflow', () => {
    expect(gatePhasesOf('rir')).toEqual(['research', 'implement', 'publish']);
    expect(phaseOfGateState('rir', 'directionGate')).toBe('research');
    expect(phaseOfGateState('rir', 'shipGate')).toBe('implement');
    // openPrGate is reused from Full (resolution is workflow-scoped) — in RIR it
    // maps to the publish phase, the finishing tail that opens the PR.
    expect(phaseOfGateState('rir', 'openPrGate')).toBe('publish');
    // A Full-only gate state still does not resolve inside RIR.
    expect(phaseOfGateState('rir', 'commitSpecGate')).toBeUndefined();
  });

  test('implement is the writable single review round (roundCap 1)', () => {
    const implement = phasesOf('rir').find((p) => p.name === 'implement')!;
    expect.soft(implement.reviewLoop).toBe(true);
    expect.soft(implement.roundCap).toBe(1);
  });

  test('publish opens a REAL (non-draft) PR — the finishing tail, mechanics not a review loop', () => {
    const publish = phasesOf('rir').find((p) => p.name === 'publish')!;
    expect.soft(publish.gate?.state).toBe('openPrGate');
    expect.soft(publish.reviewLoop).toBe(false);
    // draftPr distinguishes RIR's real PR from Full's draft — the single fact the
    // shared reject-amend clause reads.
    expect.soft(publish.draftPr).toBe(false);
    expect.soft(PHASE['finish'].draftPr).toBe(true);
  });

  test('the rir snippet assignments encode the build spine and the docs→publish move', () => {
    const snippetsOf = (name: string) => phasesOf('rir').find((p) => p.name === name)!.snippets;
    // research synthesizes the direction (this arc drafts no spec).
    expect.soft(snippetsOf('research')).toEqual(['think-holistic', 'compare-notes']);
    // the build spine, in order — handoff orients the reviewer before the review
    // round; reconcile-docs is absent here, having moved to publish.
    expect.soft(snippetsOf('implement')).toEqual(['implement-direct', 'handoff-direct', 'review-direct', 'apply-review']);
    // publish reconciles docs (they ride the PR now) and writes the description.
    expect.soft(snippetsOf('publish')).toEqual(['reconcile-docs', 'pr-description', 'compact-for-cleanup']);
  });
});

describe('consultant checkpoints (registry data per arc)', () => {
  test('Full maps frame/specGate onto frame/spec, and the acceptance-contract pair onto plan/impl', () => {
    expect.soft(consultantCheckpointOf('frame')).toBe('frame');
    expect.soft(consultantCheckpointOf('spec')).toBe('specGate');
    // The acceptance contract: plan AUTHORS it, impl VERIFIES it (the latter
    // supplants the open-ended implGate audit Full's impl used to carry).
    expect.soft(consultantCheckpointOf('plan')).toBe('contract');
    expect.soft(consultantCheckpointOf('impl')).toBe('verify');
    // Phases without a checkpoint carry none.
    expect.soft(consultantCheckpointOf('finish')).toBeUndefined();
  });

  test('RIR consultant modes: frame@research, implGate@implement, publish carries none; NO contract/verify/specGate', () => {
    expect.soft(consultantCheckpointOf('research')).toBe('frame');
    expect.soft(consultantCheckpointOf('implement')).toBe('implGate');
    expect.soft(consultantCheckpointOf('publish')).toBeUndefined();
    const rirModes = phasesOf('rir').map((p) => p.consultantCheckpoint);
    // RIR authors no contract (no plan phase), so it never verifies one — implGate
    // stays the open-ended bet audit; it is not globally re-pointed to verify.
    expect.soft(rirModes).not.toContain('specGate');
    expect.soft(rirModes).not.toContain('contract');
    expect.soft(rirModes).not.toContain('verify');
  });

  test('each checkpoint resolves to its (non-review-prefixed) snippet', () => {
    expect.soft(consultantSnippetFor('frame')).toBe('consultant-frame');
    expect.soft(consultantSnippetFor('spec')).toBe('consultant-spec');
    expect.soft(consultantSnippetFor('plan')).toBe('consultant-contract');
    expect.soft(consultantSnippetFor('impl')).toBe('consultant-verify');
    expect.soft(consultantSnippetFor('research')).toBe('consultant-frame');
    expect.soft(consultantSnippetFor('implement')).toBe('consultant-impl');
    expect.soft(consultantSnippetFor('finish')).toBeUndefined(); // a non-checkpoint phase
    // The consultant snippets are phase-bound to their checkpoint phases and
    // never carry the review- prefix (which countsReviewRound keys on).
    for (const snippet of ['consultant-frame', 'consultant-spec', 'consultant-impl', 'consultant-contract', 'consultant-verify']) {
      expect.soft(snippet.startsWith('review')).toBe(false);
    }
  });

  test('contractAuthorPhaseOf names the contract freeze gate per arc (Full: plan; RIR: none)', () => {
    expect.soft(contractAuthorPhaseOf('full')).toBe('plan');
    expect.soft(contractAuthorPhaseOf('rir')).toBeUndefined();
  });

  test('acceptanceContractPathForSpec derives the spec sibling with an .acceptance.md suffix', () => {
    expect.soft(acceptanceContractPathForSpec('docs/specs/2026-06-24-foo.md')).toBe(
      'docs/specs/2026-06-24-foo.acceptance.md',
    );
    expect.soft(acceptanceContractPathForSpec('SPEC.md')).toBe('SPEC.acceptance.md');
    expect.soft(acceptanceContractPathForSpec('a/b/c/plan.spec.md')).toBe('a/b/c/plan.spec.acceptance.md');
  });
});

describe('handoffWatchLabel — the interactive→headless handoff hint, per arc', () => {
  // The label is derived from the registry (handoff gate + next phase), not
  // hardcoded — so a RIR handoff reads "research approved", never "plan approved".
  test('full hands off at the plan gate into impl', () => {
    expect(handoffWatchLabel('full')).toBe('plan approved — AFK impl');
  });

  test('rir hands off at the Direction (research) gate into implement', () => {
    expect(handoffWatchLabel('rir')).toBe('research approved — AFK implement');
  });
});
