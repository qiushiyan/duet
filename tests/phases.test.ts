import { describe, expect, test } from 'vitest';
import {
  GATELESS_CONSULTANT_SNIPPETS,
  WORKFLOWS,
  acceptanceContractPathForSpec,
  consultantCheckpointLive,
  consultantSnippetFor,
  consultantSnippetsForWorkflow,
  contractAuthorPhaseOf,
  defaultPosture,
  gateOf,
  gatePhasesOf,
  handoffWatchLabel,
  isBackstopCheckpoint,
  isPostHandoffPhase,
  phaseOfGateState,
  phaseSnippetsFor,
  phaseSpec,
  phasesOf,
  validateRegistry,
  workflowHasConsultantBackstop,
} from '../src/phases.ts';
import type { WorkflowSpecInput } from '../src/phases.ts';

/**
 * The workflow registry — the source of truth the flat lookups derive from.
 * These guard the two derivation invariants (`validateRegistry`) and pin Full's
 * arc literally, so a malformed registry can't self-validate against tests that
 * also derive from it.
 */

// A minimal phase in the registry input shape — always gated (every phase gates).
function phase(name: string, gateState: string = `${name}Gate`) {
  return {
    name,
    snippets: [] as readonly string[],
    gate: { state: gateState, heading: 'h', ready: 'r', hint: null },
    artifactLabel: name,
    reviewLoop: false,
    roundCap: 1,
    orchestratorBudgetUsd: 1,
    workerBudgetUsd: 1,
    workerTurnTimeoutMs: 1,
  };
}

// A minimal valid workflow: two gate phases `a` and `b`.
function workflow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'w',
    displayName: 'W',
    phases: [phase('a', 'aGate'), phase('b', 'bGate')],
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
      // Workflow-scoped phase identity: both arcs may name their build phase
      // "implement" and their finish phase "finish", so a name shared ACROSS
      // workflows is legal and intended, not a collision.
      name: 'a phase name shared across two workflows is legal (workflow-scoped identity)',
      registry: { w1: workflow(), w2: workflow({ name: 'w2' }) },
      throws: null,
    },
    {
      name: 'a phase name duplicated WITHIN one workflow throws',
      registry: { w: workflow({ phases: [phase('a', 'aGate'), phase('a', 'a2Gate')] }) },
      throws: /has two phases named "a"/,
    },
    {
      name: 'two gates sharing a state within one workflow throws',
      registry: { w: workflow({ phases: [phase('a', 'g'), phase('b', 'g')] }) },
      throws: /two gates with state "g"/,
    },
    {
      name: 'a handoffGate that is not a gate phase throws',
      registry: { w: workflow({ handoffGate: 'ghost' }) },
      throws: /handoffGate "ghost" is not a gate phase/,
    },
    {
      name: 'a forceAttend entry that is not a gate phase throws',
      registry: { w: workflow({ forceAttend: ['ghost'] }) },
      throws: /forceAttend entry "ghost" is not a gate phase/,
    },
    {
      name: 'a defaultPreAuthorized entry that is not a gate phase throws',
      registry: { w: workflow({ defaultPreAuthorized: ['ghost'] }) },
      throws: /defaultPreAuthorized entry "ghost" is not a gate phase/,
    },
    {
      name: 'a gate in both forceAttend and defaultPreAuthorized throws (disjointness)',
      registry: { w: workflow({ forceAttend: ['a'], defaultPreAuthorized: ['a'] }) },
      throws: /gate "a" is in both forceAttend and defaultPreAuthorized/,
    },
    {
      name: 'a preset value that is not a gate phase throws',
      registry: { w: workflow({ presets: { p: ['ghost'] } }) },
      throws: /preset "p" value "ghost" is not a gate phase/,
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

  test("full's default exclusion ['plan','implement','finish'] resolves to ['frame','spec'] (the overnight posture)", () => {
    expect(defaultPosture(gatePhasesOf('full'), ['plan', 'implement', 'finish'])).toEqual(['frame', 'spec']);
  });

  test('a single-element exclusion drops only that gate, order preserved', () => {
    expect(defaultPosture(gatePhasesOf('full'), ['finish'])).toEqual(['frame', 'spec', 'plan', 'implement']);
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
      'implement',
      'finish',
    ]);
  });

  test('gatePhasesOf("full") is every phase — finish carries the Open-PR gate, none are gate-less', () => {
    expect(gatePhasesOf('full')).toEqual(['frame', 'spec', 'plan', 'implement', 'finish']);
  });

  test('full pre-authorizes plan, impl, and finish by default (the overnight posture) and force-attends nothing', () => {
    expect.soft(WORKFLOWS.full.forceAttend).toEqual([]); // an open PR is reversible (the human owns the merge; a reject amends it)
    expect.soft(WORKFLOWS.full.defaultPreAuthorized).toEqual(['plan', 'implement', 'finish']); // disjoint from forceAttend (validateRegistry guards it)
  });

  test('phaseSpec resolves a phase within its workflow, and throws for a foreign one', () => {
    expect(phaseSpec('full', 'implement').gate?.state).toBe('shipGate');
    expect(phaseSpec('full', 'finish').gate?.state).toBe('openPrGate'); // open-then-review in one phase
    // Workflow-scoped: a lookup naming a phase the arc doesn't own fails loud
    // rather than silently resolving a foreign arc's phase (the old flat PHASE map
    // would have collapsed a shared name to one arbitrary entry).
    expect(() => phaseSpec('rir', 'plan')).toThrow(/not part of the "rir" workflow/);
  });

  test('phaseOfGateState resolves within the workflow, undefined otherwise', () => {
    expect(phaseOfGateState('full', 'shipGate')).toBe('implement');
    expect(phaseOfGateState('full', 'directionGate')).toBe('frame');
    expect(phaseOfGateState('full', 'nopeGate')).toBeUndefined();
  });

  test('gateOf returns the gate spec for a gate phase', () => {
    expect(gateOf('full', 'finish').state).toBe('openPrGate');
  });
});

describe('the RIR workflow', () => {
  test('phasesOf("rir") is research → implement → finish', () => {
    expect(phasesOf('rir').map((p) => p.name)).toEqual(['research', 'implement', 'finish']);
  });

  test('all three RIR phases are gates; reused gate-state names resolve within the workflow', () => {
    expect(gatePhasesOf('rir')).toEqual(['research', 'implement', 'finish']);
    expect(phaseOfGateState('rir', 'directionGate')).toBe('research');
    expect(phaseOfGateState('rir', 'shipGate')).toBe('implement');
    // openPrGate is reused from Full (resolution is workflow-scoped) — in RIR it
    // maps to the finish phase, the finishing tail that opens the PR.
    expect(phaseOfGateState('rir', 'openPrGate')).toBe('finish');
    // A Full-only gate state still does not resolve inside RIR.
    expect(phaseOfGateState('rir', 'commitSpecGate')).toBeUndefined();
  });

  test('implement is the writable single review round (roundCap 1)', () => {
    const implement = phasesOf('rir').find((p) => p.name === 'implement')!;
    expect.soft(implement.reviewLoop).toBe(true);
    expect.soft(implement.roundCap).toBe(1);
  });

  test('publish and full’s finish are the same finishing-tail shape — both open the PR via the shared brief', () => {
    // The full→real-PR change converged the two: same gate, same no-review-loop
    // discipline, same caps, same snippet set. They differ only by name (their gate
    // tokens) and the prior gate that approves into them; openPrPhaseEntryPrompt is
    // shared. No draft/real PR-mode flag remains — deleting it from PhaseSpec makes
    // any `.draftPr` read a compile error, so the type system is the regression
    // guard. We assert the shape, not the entry prose.
    for (const p of [phaseSpec('full', 'finish'), phaseSpec('rir', 'finish')]) {
      expect.soft(p.gate?.state).toBe('openPrGate');
      expect.soft(p.reviewLoop).toBe(false);
      expect.soft(p.roundCap).toBe(2);
      expect.soft(p.artifactLabel).toBe('PR');
      expect.soft(p.snippets).toEqual(['reconcile-docs', 'pr-description', 'compact-for-cleanup']);
    }
  });

  test('the rir snippet assignments encode the build spine and the docs move to the finishing phase', () => {
    const snippetsOf = (name: string) => phasesOf('rir').find((p) => p.name === name)!.snippets;
    // research synthesizes the direction (this arc drafts no spec).
    expect.soft(snippetsOf('research')).toEqual(['think-holistic', 'compare-notes']);
    // the build spine, in order — handoff orients the reviewer before the review
    // round; reconcile-docs is absent here, having moved to publish.
    expect.soft(snippetsOf('implement')).toEqual(['implement-direct', 'handoff-direct', 'review-direct', 'apply-review']);
    // publish reconciles docs (they ride the PR now) and writes the description.
    expect.soft(snippetsOf('finish')).toEqual(['reconcile-docs', 'pr-description', 'compact-for-cleanup']);
  });
});

describe('consultant checkpoints (registry data per arc)', () => {
  test('Full maps frame/specGate onto frame/spec, and the acceptance-contract pair onto plan/impl', () => {
    expect.soft(phaseSpec('full', 'frame').consultantCheckpoint).toBe('frame');
    expect.soft(phaseSpec('full', 'spec').consultantCheckpoint).toBe('specGate');
    // The acceptance contract: plan AUTHORS it, impl VERIFIES it (the latter
    // supplants the open-ended implGate audit Full's impl used to carry).
    expect.soft(phaseSpec('full', 'plan').consultantCheckpoint).toBe('contract');
    expect.soft(phaseSpec('full', 'implement').consultantCheckpoint).toBe('verify');
    // Phases without a checkpoint carry none.
    expect.soft(phaseSpec('full', 'finish').consultantCheckpoint).toBeUndefined();
  });

  test('RIR consultant modes: frame@research, implGate@implement, publish carries none; NO contract/verify/specGate', () => {
    expect.soft(phaseSpec('rir', 'research').consultantCheckpoint).toBe('frame');
    expect.soft(phaseSpec('rir', 'implement').consultantCheckpoint).toBe('implGate');
    expect.soft(phaseSpec('rir', 'finish').consultantCheckpoint).toBeUndefined();
    const rirModes = phasesOf('rir').map((p) => p.consultantCheckpoint);
    // RIR authors no contract (no plan phase), so it never verifies one — implGate
    // stays the open-ended bet audit; it is not globally re-pointed to verify.
    expect.soft(rirModes).not.toContain('specGate');
    expect.soft(rirModes).not.toContain('contract');
    expect.soft(rirModes).not.toContain('verify');
  });

  test('each checkpoint resolves to its (non-review-prefixed) snippet', () => {
    expect.soft(consultantSnippetFor('full', 'frame')).toBe('consultant-frame');
    expect.soft(consultantSnippetFor('full', 'spec')).toBe('consultant-spec');
    expect.soft(consultantSnippetFor('full', 'plan')).toBe('consultant-contract');
    expect.soft(consultantSnippetFor('full', 'implement')).toBe('consultant-verify');
    expect.soft(consultantSnippetFor('rir', 'research')).toBe('consultant-frame');
    expect.soft(consultantSnippetFor('rir', 'implement')).toBe('consultant-impl');
    expect.soft(consultantSnippetFor('full', 'finish')).toBeUndefined(); // a non-checkpoint phase
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

describe('the AFK build caps (S3 — wall-clock-bounded per-turn timeouts)', () => {
  test('both arcs’ build phases carry the 90-min wall-clock cap', () => {
    // 90 min = 3× the longest healthy build turn (29.5 min) measured across the
    // corpus — the high end of the 2–3× band; a hit is a resumable checkpoint.
    expect.soft(phaseSpec('full', 'implement').workerTurnTimeoutMs).toBe(90 * 60_000);
    expect.soft(phaseSpec('rir', 'implement').workerTurnTimeoutMs).toBe(90 * 60_000);
  });

  test('the planning and finishing phases keep the 30-min cap (their longest healthy turns ≈17 min)', () => {
    for (const [workflow, phase] of [
      ['full', 'frame'], ['full', 'spec'], ['full', 'plan'], ['full', 'finish'],
      ['rir', 'research'], ['rir', 'finish'],
    ] as const) {
      expect.soft(phaseSpec(workflow, phase).workerTurnTimeoutMs).toBe(30 * 60_000);
    }
  });
});

describe('gateless drops the consultant bet-audit, keeping the generative frame + backstop (registry helpers)', () => {
  test('isBackstopCheckpoint: only the contract author and the verify are correctness backstops', () => {
    // The backstop (correctness) checkpoints.
    expect.soft(isBackstopCheckpoint('full', 'plan')).toBe(true); // contract author
    expect.soft(isBackstopCheckpoint('full', 'implement')).toBe(true); // verify
    // Not backstops: the generative frame and the bet-audit challenges. (frame still
    // survives gateless as a generative checkpoint — see consultantCheckpointLive.)
    expect.soft(isBackstopCheckpoint('full', 'frame')).toBe(false); // generative frame analysis
    expect.soft(isBackstopCheckpoint('full', 'spec')).toBe(false); // specGate bet audit
    expect.soft(isBackstopCheckpoint('rir', 'implement')).toBe(false); // rir implGate bet audit
    expect.soft(isBackstopCheckpoint('full', 'finish')).toBe(false); // no checkpoint at all
  });

  test('phaseSnippetsFor: gateless drops the bet-audit snippet but keeps the generative frame and the backstop', () => {
    // spec carries the specGate bet audit — gateless omits it; the base list stays.
    expect.soft(phaseSnippetsFor('full', 'spec', { consultant: true })).toContain('consultant-spec');
    expect.soft(phaseSnippetsFor('full', 'spec', { consultant: true, gateless: true })).not.toContain('consultant-spec');
    // frame carries the generative third-opinion — gateless keeps it (non-holding).
    expect.soft(phaseSnippetsFor('full', 'frame', { consultant: true, gateless: true })).toContain('consultant-frame');
    // impl carries the verify backstop — gateless keeps it.
    expect.soft(phaseSnippetsFor('full', 'implement', { consultant: true, gateless: true })).toContain('consultant-verify');
    // Unbound is unchanged either way (default-off).
    expect.soft(phaseSnippetsFor('full', 'frame', { consultant: false, gateless: true })).not.toContain('consultant-frame');
  });

  test('consultantSnippetsForWorkflow: gateless exposes the generative frame + the backstop per arc', () => {
    // Full bound: all four checkpoint snippets; gateless → the frame + backstop trio (specGate dropped).
    expect.soft([...consultantSnippetsForWorkflow('full')].sort()).toEqual(
      ['consultant-contract', 'consultant-frame', 'consultant-spec', 'consultant-verify'].sort(),
    );
    expect.soft([...consultantSnippetsForWorkflow('full', { gateless: true })].sort()).toEqual(
      ['consultant-contract', 'consultant-frame', 'consultant-verify'].sort(),
    );
    // RIR has no backstop, so a gateless RIR run exposes just the generative frame (its implGate audit drops).
    expect.soft([...consultantSnippetsForWorkflow('rir', { gateless: true })]).toEqual(['consultant-frame']);
  });

  test('consultantCheckpointLive: the single gateless predicate both surfaces derive from', () => {
    // Unbound is always false — the default-off floor.
    expect.soft(consultantCheckpointLive('full', 'spec', { consultant: false })).toBe(false);
    expect.soft(consultantCheckpointLive('full', 'implement', { consultant: false, gateless: true })).toBe(false);
    // A bet-audit challenge: bound and not gateless; gateless drops it.
    expect.soft(consultantCheckpointLive('full', 'spec', { consultant: true })).toBe(true);
    expect.soft(consultantCheckpointLive('full', 'spec', { consultant: true, gateless: true })).toBe(false);
    expect.soft(consultantCheckpointLive('rir', 'implement', { consultant: true, gateless: true })).toBe(false); // rir implGate
    // The generative frame: bound, gateless-independent (non-holding, so it survives).
    expect.soft(consultantCheckpointLive('full', 'frame', { consultant: true, gateless: true })).toBe(true); // full framing
    expect.soft(consultantCheckpointLive('rir', 'research', { consultant: true, gateless: true })).toBe(true); // rir framing
    // A backstop checkpoint: bound, gateless-independent.
    expect.soft(consultantCheckpointLive('full', 'plan', { consultant: true, gateless: true })).toBe(true); // contract
    expect.soft(consultantCheckpointLive('full', 'implement', { consultant: true, gateless: true })).toBe(true); // verify
    // A phase with no checkpoint is never live.
    expect.soft(consultantCheckpointLive('full', 'finish', { consultant: true })).toBe(false);
  });

  test('workflowHasConsultantBackstop: full has the contract+verify backstop, rir has none', () => {
    expect.soft(workflowHasConsultantBackstop('full')).toBe(true);
    expect.soft(workflowHasConsultantBackstop('rir')).toBe(false);
  });

  test('S8: the full-arc afk preset is attend-none registry data, keeping every consultant net (gateless OFF)', () => {
    // Registry data only — afk mirrors rir's, no statechart change.
    expect.soft(WORKFLOWS.full.presets.afk).toEqual([]);
    expect.soft(WORKFLOWS.rir.presets.afk).toEqual([]); // rir unchanged

    // The defining difference from --gateless: afk runs with gateless OFF, so BOTH
    // the holding bet-audit challenge AND the correctness backstop stay live.
    expect.soft(consultantCheckpointLive('full', 'spec', { consultant: true, gateless: false })).toBe(true); // challenge kept
    expect.soft(consultantCheckpointLive('full', 'plan', { consultant: true, gateless: false })).toBe(true); // contract backstop
    expect.soft(consultantCheckpointLive('full', 'implement', { consultant: true, gateless: false })).toBe(true); // verify backstop
    // (Whereas gateless drops only the holding challenge — pinned in the gateless test above.)
  });

  test('GATELESS_CONSULTANT_SNIPPETS: the generative frame plus the contract + verify backstop keys', () => {
    expect([...GATELESS_CONSULTANT_SNIPPETS].sort()).toEqual(
      ['consultant-contract', 'consultant-frame', 'consultant-verify'].sort(),
    );
  });
});

describe('handoffWatchLabel — the interactive→headless handoff hint, per arc', () => {
  // The label is derived from the registry (handoff gate + next phase), not
  // hardcoded — so a RIR handoff reads "research approved", never "plan approved".
  test('full hands off at the plan gate into implement', () => {
    expect(handoffWatchLabel('full')).toBe('plan approved — AFK implement');
  });

  test('rir hands off at the Direction (research) gate into implement', () => {
    expect(handoffWatchLabel('rir')).toBe('research approved — AFK implement');
  });
});

describe('isPostHandoffPhase — the "doing" set strictly after the handoff gate', () => {
  // full's handoffGate is `plan`; rir's is `research`. The planning phases up to
  // and INCLUDING the handoff gate are pre-handoff; the build + finishing tail are
  // post-handoff — this is the boundary the per-phase implementer-model swap keys on.
  test('full: planning phases (through the plan handoff gate) are pre-handoff', () => {
    expect.soft(isPostHandoffPhase('full', 'frame')).toBe(false);
    expect.soft(isPostHandoffPhase('full', 'spec')).toBe(false);
    expect.soft(isPostHandoffPhase('full', 'plan')).toBe(false); // the handoff gate itself is NOT after itself
  });

  test('full: the build and finishing tail are post-handoff', () => {
    expect.soft(isPostHandoffPhase('full', 'implement')).toBe(true);
    expect.soft(isPostHandoffPhase('full', 'finish')).toBe(true);
  });

  test('rir: research (the handoff gate) is pre-handoff; implement and publish are post', () => {
    expect.soft(isPostHandoffPhase('rir', 'research')).toBe(false);
    expect.soft(isPostHandoffPhase('rir', 'implement')).toBe(true);
    expect.soft(isPostHandoffPhase('rir', 'finish')).toBe(true);
  });
});
