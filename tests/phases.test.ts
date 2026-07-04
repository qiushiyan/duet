import { describe, expect, test } from 'vitest';
import {
  GATELESS_CONSULTANT_SNIPPETS,
  WORKFLOWS,
  acceptanceContractPathForSpec,
  consultantCheckpointLive,
  consultantSnippetFor,
  checkerDutyOf,
  consultantSnippetsForWorkflow,
  continuityEdgeFor,
  contractAuthorPhaseOf,
  defaultPosture,
  dutiesOf,
  fixerDutyFor,
  gateOf,
  gatePhasesOf,
  handoffGateOf,
  handoffWatchLabel,
  isBackstopCheckpoint,
  isPostHandoffPhase,
  makerDutyOf,
  phaseOfGateState,
  stageOf,
  stageOfDuty,
  stagesOf,
  phaseSnippetsFor,
  phaseSpec,
  phasesOf,
  validateRegistry,
  workflowHasConsultantBackstop,
} from '../src/phases.ts';
import type { PhaseSemantics, StageSpecInput, WorkflowSpecInput } from '../src/phases.ts';

/**
 * The workflow registry — the source of truth the flat lookups derive from.
 * These guard the two derivation invariants (`validateRegistry`) and pin Full's
 * arc literally, so a malformed registry can't self-validate against tests that
 * also derive from it.
 */

// A minimal phase in the registry input shape — always gated (every phase gates).
function phase(name: string, gateState: string = `${name}Gate`, overrides: Record<string, unknown> = {}) {
  return {
    name,
    semantics: { block: 'frame', examplesKey: 'frame' } as PhaseSemantics,
    gate: { state: gateState, heading: 'h', ready: 'r', hint: null },
    artifactLabel: name,
    reviewLoop: false,
    roundCap: 1,
    orchestratorBudgetUsd: 1,
    workerBudgetUsd: 1,
    workerTurnTimeoutMs: 1,
    ...overrides,
  };
}

// A minimal valid stage pair partitioning phases `a` (planning) and `b` (delivery).
// Cast at the edge: the overrides deliberately build INVALID shapes (foreign
// duties, reversed partitions) for the validation cases to reject.
function stages(overrides: { planning?: Record<string, unknown>; delivery?: Record<string, unknown> } = {}): StageSpecInput[] {
  return [
    { name: 'planning', phases: ['a'], duties: { maker: 'architect', checker: 'analyst' }, ...overrides.planning },
    { name: 'delivery', phases: ['b'], duties: { maker: 'builder', checker: 'critic' }, ...overrides.delivery },
  ] as unknown as StageSpecInput[];
}

// A minimal valid workflow: two gate phases `a` and `b`, one per stage.
function workflow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'w',
    displayName: 'W',
    phases: [phase('a', 'aGate'), phase('b', 'bGate')],
    stages: stages(),
    entry: { firstPhase: 'a' },
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
    // ---- the stage topology (the duty-keyed runtime's invariants) ----
    {
      name: 'a workflow without the planning/delivery stage pair throws',
      registry: { w: workflow({ stages: [stages()[0]] }) },
      throws: /exactly the two stages "planning" then "delivery"/,
    },
    {
      name: 'stages out of order throw',
      registry: { w: workflow({ stages: [...stages()].reverse() }) },
      throws: /exactly the two stages "planning" then "delivery"/,
    },
    {
      name: 'an empty stage throws',
      registry: { w: workflow({ stages: stages({ planning: { phases: [] }, delivery: { phases: ['a', 'b'] } }) }) },
      throws: /stage "planning" has no phases/,
    },
    {
      name: 'stages that do not partition the phase list in order throw',
      registry: { w: workflow({ stages: stages({ planning: { phases: ['b'] }, delivery: { phases: ['a'] } }) }) },
      throws: /do not partition its phases/,
    },
    {
      name: 'a stage phase missing from the partition throws',
      registry: { w: workflow({ stages: stages({ delivery: { phases: [] } }) }) },
      throws: /stage "delivery" has no phases/,
    },
    {
      name: 'a duty outside the closed vocabulary throws',
      registry: { w: workflow({ stages: stages({ planning: { duties: { maker: 'author', checker: 'analyst' } } }) }) },
      throws: /maker duty "author" is not in the duty vocabulary/,
    },
    {
      name: "a duty in a foreign stage throws (duties are globally stage-unique — a duty alone names its stage)",
      registry: { w: workflow({ stages: stages({ planning: { duties: { maker: 'builder', checker: 'analyst' } } }) }) },
      throws: /"builder" is a delivery duty/,
    },
    {
      name: 'a checker duty in the maker slot throws',
      registry: { w: workflow({ stages: stages({ delivery: { duties: { maker: 'judge', checker: 'critic' } } }) }) },
      throws: /"judge" is a delivery duty|puts "judge" in the maker slot/,
    },
    {
      name: 'a continuity edge on the planning stage throws (edges run planning→delivery only)',
      registry: {
        w: workflow({ stages: stages({ planning: { edges: { architect: { from: 'builder' } } } }) }),
      },
      throws: /edges on its planning stage/,
    },
    {
      name: 'a continuity edge into a duty the delivery stage lacks throws',
      registry: {
        w: workflow({ stages: stages({ delivery: { edges: { judge: { from: 'analyst' } } } }) }),
      },
      throws: /edge into "judge", which is not a delivery duty/,
    },
    {
      name: 'a continuity edge from a non-planning duty throws',
      registry: {
        w: workflow({ stages: stages({ delivery: { edges: { builder: { from: 'judge' } } } }) }),
      },
      throws: /"judge" is not a planning duty/,
    },
    {
      name: 'a lane-crossing continuity edge throws (maker continues maker, checker continues checker)',
      registry: {
        w: workflow({ stages: stages({ delivery: { edges: { builder: { from: 'analyst' } } } }) }),
      },
      throws: /crosses lanes/,
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
    {
      // Vocabulary coherence: reviewLoop must agree with the block — doc-loop
      // and build phases ARE review loops; frame and finish phases are not.
      name: 'a frame block claiming reviewLoop throws (semantics ↔ flag coherence)',
      registry: { w: workflow({ phases: [phase('a', 'aGate', { reviewLoop: true }), phase('b', 'bGate')] }) },
      throws: /reviewLoop true but block "frame"/,
    },
    {
      name: 'a doc-loop block without reviewLoop throws',
      registry: {
        w: workflow({
          phases: [
            phase('a', 'aGate', { semantics: { block: 'doc-loop', artifactKind: 'spec', examplesKey: 'spec' } }),
            phase('b', 'bGate'),
          ],
        }),
      },
      throws: /reviewLoop false but block "doc-loop"/,
    },
    {
      // A checkpoint fires from the block that hosts its work: a contract
      // author on a frame block would brief the consultant about a document
      // the phase never produces.
      name: 'a consultant checkpoint on a foreign block throws',
      registry: {
        w: workflow({ phases: [phase('a', 'aGate', { consultantCheckpoint: 'contract' }), phase('b', 'bGate')] }),
      },
      throws: /checkpoint "contract" but is a "frame" block/,
    },
    {
      // The closed vocabulary, structurally: a knob value with no shipped
      // snippet family fails at load — "a knob value ships its prompt support"
      // is enforced, not prose. (TypeScript already forbids this for the
      // literal registry; this is the same rule for a registry that arrives as
      // data, e.g. a future external arc file.)
      name: 'a knob value without a shipped snippet family throws (closed vocabulary)',
      registry: {
        w: workflow({
          phases: [
            phase('a', 'aGate', {
              reviewLoop: true,
              semantics: { block: 'doc-loop', artifactKind: 'memo', examplesKey: 'spec' } as unknown as PhaseSemantics,
            }),
            phase('b', 'bGate'),
          ],
        }),
      },
      throws: /artifactKind "memo", which ships no snippet family/,
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
    expect(() => phaseSpec('short', 'plan')).toThrow(/not part of the "short" workflow/);
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
  test('phasesOf("short") is research → implement → finish', () => {
    expect(phasesOf('short').map((p) => p.name)).toEqual(['research', 'implement', 'finish']);
  });

  test('all three RIR phases are gates; reused gate-state names resolve within the workflow', () => {
    expect(gatePhasesOf('short')).toEqual(['research', 'implement', 'finish']);
    expect(phaseOfGateState('short', 'directionGate')).toBe('research');
    expect(phaseOfGateState('short', 'shipGate')).toBe('implement');
    // openPrGate is reused from Full (resolution is workflow-scoped) — in RIR it
    // maps to the finish phase, the finishing tail that opens the PR.
    expect(phaseOfGateState('short', 'openPrGate')).toBe('finish');
    // A Full-only gate state still does not resolve inside RIR.
    expect(phaseOfGateState('short', 'commitSpecGate')).toBeUndefined();
  });

  test('implement is the writable single review round (roundCap 1)', () => {
    const implement = phasesOf('short').find((p) => p.name === 'implement')!;
    expect.soft(implement.reviewLoop).toBe(true);
    expect.soft(implement.roundCap).toBe(1);
  });

  test('every arc’s finish is the same PR-only finishing-tail shape — docs already reconciled at Ship', () => {
    // The arcs' finish converged: same gate, same no-review-loop discipline, same
    // caps, same snippet set. Docs moved OUT of finish into the implement tail, so
    // finish is now PR-only (pr-description → open PR), with compact-for-cleanup
    // reachable for the rare bloated case. They differ only by the prior gate that
    // approves into them; openPrPhaseEntryPrompt is shared.
    for (const p of [phaseSpec('full', 'finish'), phaseSpec('blueprint', 'finish'), phaseSpec('short', 'finish')]) {
      expect.soft(p.gate?.state).toBe('openPrGate');
      expect.soft(p.reviewLoop).toBe(false);
      expect.soft(p.roundCap).toBe(2);
      expect.soft(p.artifactLabel).toBe('PR');
      expect.soft(p.snippets).toEqual(['pr-description', 'compact-for-cleanup']);
      expect.soft(p.snippets).not.toContain('reconcile-docs'); // docs reconcile at implement now
    }
  });

  test('full implement reconciles docs as the last build step, before the ship packet (Ship reviews code + docs)', () => {
    const implement = phaseSpec('full', 'implement').snippets;
    // reconcile-docs sits after the review loop and immediately before ceo-summary,
    // so the Ship packet covers docs and finish is left the mechanical PR open. It
    // also precedes the consultant verify (which runs last), keeping the
    // verification of the exact shipped state.
    expect.soft(implement).toContain('reconcile-docs');
    expect.soft(implement.indexOf('reconcile-docs')).toBeLessThan(implement.indexOf('ceo-summary'));
    expect.soft(implement.indexOf('reconcile-docs')).toBeGreaterThan(implement.indexOf('respond-review-again'));
  });

  test('the rir snippet assignments encode the build spine with docs at the implement tail', () => {
    const snippetsOf = (name: string) => phasesOf('short').find((p) => p.name === name)!.snippets;
    // research synthesizes the direction (this arc drafts no spec).
    expect.soft(snippetsOf('research')).toEqual(['think-holistic', 'compare-notes']);
    // the build spine, in order — handoff orients the reviewer before the review
    // round, then reconcile-docs is the last build step (docs reviewed at Ship).
    expect.soft(snippetsOf('implement')).toEqual(['implement-direct', 'handoff-direct', 'review-direct', 'apply-review', 'reconcile-docs']);
    // finish is PR-only now (docs already on the branch from implement).
    expect.soft(snippetsOf('finish')).toEqual(['pr-description', 'compact-for-cleanup']);
  });
});

describe('the design workflow (the middle arc — one design doc between framing and the build)', () => {
  // A literal pin (not self-derived), like full's: frame → design → implement → finish.
  test('phasesOf("design") is the four-phase arc in order', () => {
    expect(phasesOf('blueprint').map((p) => p.name)).toEqual(['frame', 'design', 'implement', 'finish']);
  });

  test('all four phases are gates; shared gate-state names resolve within the workflow', () => {
    expect.soft(gatePhasesOf('blueprint')).toEqual(['frame', 'design', 'implement', 'finish']);
    expect.soft(phaseOfGateState('blueprint', 'directionGate')).toBe('frame');
    expect.soft(phaseOfGateState('blueprint', 'designGate')).toBe('design');
    expect.soft(phaseOfGateState('blueprint', 'shipGate')).toBe('implement');
    expect.soft(phaseOfGateState('blueprint', 'openPrGate')).toBe('finish');
    // Full-only gate states do not resolve inside the design arc.
    expect.soft(phaseOfGateState('blueprint', 'commitSpecGate')).toBeUndefined();
    expect.soft(phaseOfGateState('blueprint', 'planApprovalGate')).toBeUndefined();
  });

  test('the design phase is ONE review loop at cap 2 — the arc premises fast convergence', () => {
    const design = phaseSpec('blueprint', 'design');
    expect.soft(design.reviewLoop).toBe(true);
    expect.soft(design.roundCap).toBe(2); // not full's 3: the observed spec/plan loops never used 3
    expect.soft(design.artifactLabel).toBe('design doc');
    expect.soft(design.snippets).toEqual([
      'write-design',
      'review-design',
      'update-design',
      'review-design-again',
      'update-design-again',
    ]);
  });

  test('implement reuses full’s spec with implement-design as the build seed (not rir’s implement-direct)', () => {
    const implement = phaseSpec('blueprint', 'implement');
    const full = phaseSpec('full', 'implement');
    // The one substitution: implement-design seeds the build (the committed design
    // doc is the authority); everything else — midpoint, compactions, the review
    // loop, docs-reconcile-last, ceo-summary — is full's implement.
    expect.soft(implement.snippets).toEqual(['compact-for-impl', 'implement-design', ...full.snippets.slice(1)]);
    expect.soft(implement.snippets).not.toContain('implement-direct'); // that body assumes no design artifact exists
    expect.soft(implement.roundCap).toBe(full.roundCap);
    expect.soft(implement.gate.state).toBe('shipGate');
    expect.soft(implement.workerTurnTimeoutMs).toBe(90 * 60_000);
    // reconcile-docs still runs after the review loop, before the ship packet.
    expect.soft(implement.snippets.indexOf('reconcile-docs')).toBeGreaterThan(implement.snippets.indexOf('respond-review-again'));
    expect.soft(implement.snippets.indexOf('reconcile-docs')).toBeLessThan(implement.snippets.indexOf('ceo-summary'));
  });

  test('finish is byte-for-byte full’s finish (the shared PR-only finishing tail)', () => {
    expect(phaseSpec('blueprint', 'finish')).toEqual(phaseSpec('full', 'finish'));
  });

  test('entry: --spec skips to the design loop (the flag generalizes to "a draft of the primary artifact")', () => {
    expect(WORKFLOWS.blueprint.entry).toEqual({ firstPhase: 'frame', specSkipsTo: 'design' });
  });

  test('the design gate is the interactive→headless handoff (derived: planning ends at design)', () => {
    expect.soft(handoffGateOf('blueprint')).toBe('design');
    expect.soft(handoffWatchLabel('blueprint')).toBe('design approved — AFK implement');
  });

  test('isPostHandoffPhase splits at the design gate — the impl-model swap kicks in at the AFK build', () => {
    expect.soft(isPostHandoffPhase('blueprint', 'frame')).toBe(false);
    expect.soft(isPostHandoffPhase('blueprint', 'design')).toBe(false); // the handoff gate itself is NOT after itself
    expect.soft(isPostHandoffPhase('blueprint', 'implement')).toBe(true);
    expect.soft(isPostHandoffPhase('blueprint', 'finish')).toBe(true);
  });

  test('the one-interruption posture: a new run materializes gatesAt = ["design"]', () => {
    expect.soft(WORKFLOWS.blueprint.defaultPreAuthorized).toEqual(['frame', 'implement', 'finish']);
    expect.soft(WORKFLOWS.blueprint.forceAttend).toEqual([]);
    expect.soft(WORKFLOWS.blueprint.presets.afk).toEqual([]);
    // The materialized default: attend the design gate only — read one document,
    // tap once, walk away. (The severity hold still converts a `high` at the
    // auto-crossed Direction gate into an attended stop — pinned in lifecycle tests.)
    expect.soft(defaultPosture(gatePhasesOf('blueprint'), WORKFLOWS.blueprint.defaultPreAuthorized)).toEqual(['design']);
  });

  test('consultant checkpoints: frame → contract → verify — no challenge anywhere (a stance, not an accident)', () => {
    expect.soft(phaseSpec('blueprint', 'frame').consultantCheckpoint).toBe('frame');
    expect.soft(phaseSpec('blueprint', 'design').consultantCheckpoint).toBe('contract'); // LATE-authored: after the loop converges
    expect.soft(phaseSpec('blueprint', 'implement').consultantCheckpoint).toBe('verify');
    expect.soft(phaseSpec('blueprint', 'finish').consultantCheckpoint).toBeUndefined();
    // The arc exists for work where the owner trusts the direction after framing:
    // no holding bet-audit at any phase, so a gateless design run drops nothing extra.
    const modes = phasesOf('blueprint').map((p) => p.consultantCheckpoint);
    expect.soft(modes).not.toContain('specGate');
    expect.soft(modes).not.toContain('implGate');
  });

  test('contractAuthorPhaseOf("design") is the design phase — the design gate is the freeze gate', () => {
    expect.soft(contractAuthorPhaseOf('blueprint')).toBe('design');
    expect.soft(consultantSnippetFor('blueprint', 'design')).toBe('consultant-contract');
    expect.soft(consultantSnippetFor('blueprint', 'implement')).toBe('consultant-verify');
    expect.soft(workflowHasConsultantBackstop('blueprint')).toBe(true);
  });

  test('gateless narrows nothing on this arc (no challenge to drop): frame + contract + verify survive', () => {
    expect.soft([...consultantSnippetsForWorkflow('blueprint')].sort()).toEqual(
      ['consultant-contract', 'consultant-frame', 'consultant-verify'].sort(),
    );
    expect.soft([...consultantSnippetsForWorkflow('blueprint', { gateless: true })].sort()).toEqual(
      ['consultant-contract', 'consultant-frame', 'consultant-verify'].sort(),
    );
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
    expect.soft(phaseSpec('short', 'research').consultantCheckpoint).toBe('frame');
    expect.soft(phaseSpec('short', 'implement').consultantCheckpoint).toBe('implGate');
    expect.soft(phaseSpec('short', 'finish').consultantCheckpoint).toBeUndefined();
    const rirModes = phasesOf('short').map((p) => p.consultantCheckpoint);
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
    expect.soft(consultantSnippetFor('short', 'research')).toBe('consultant-frame');
    expect.soft(consultantSnippetFor('short', 'implement')).toBe('consultant-impl');
    expect.soft(consultantSnippetFor('full', 'finish')).toBeUndefined(); // a non-checkpoint phase
    // The consultant snippets are phase-bound to their checkpoint phases and
    // never carry the review- prefix (which countsReviewRound keys on).
    for (const snippet of ['consultant-frame', 'consultant-spec', 'consultant-impl', 'consultant-contract', 'consultant-verify']) {
      expect.soft(snippet.startsWith('review')).toBe(false);
    }
  });

  test('contractAuthorPhaseOf names the contract freeze gate per arc (Full: plan; RIR: none)', () => {
    expect.soft(contractAuthorPhaseOf('full')).toBe('plan');
    expect.soft(contractAuthorPhaseOf('short')).toBeUndefined();
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
  test('every arc’s build phase carries the 90-min wall-clock cap', () => {
    // 90 min = 3× the longest healthy build turn (29.5 min) measured across the
    // corpus — the high end of the 2–3× band; a hit is a resumable checkpoint.
    expect.soft(phaseSpec('full', 'implement').workerTurnTimeoutMs).toBe(90 * 60_000);
    expect.soft(phaseSpec('blueprint', 'implement').workerTurnTimeoutMs).toBe(90 * 60_000);
    expect.soft(phaseSpec('short', 'implement').workerTurnTimeoutMs).toBe(90 * 60_000);
  });

  test('the planning and finishing phases keep the 30-min cap (their longest healthy turns ≈17 min)', () => {
    for (const [workflow, phase] of [
      ['full', 'frame'], ['full', 'spec'], ['full', 'plan'], ['full', 'finish'],
      ['blueprint', 'frame'], ['blueprint', 'design'], ['blueprint', 'finish'],
      ['short', 'research'], ['short', 'finish'],
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
    expect.soft(isBackstopCheckpoint('short', 'implement')).toBe(false); // rir implGate bet audit
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
    expect.soft([...consultantSnippetsForWorkflow('short', { gateless: true })]).toEqual(['consultant-frame']);
  });

  test('consultantCheckpointLive: the single gateless predicate both surfaces derive from', () => {
    // Unbound is always false — the default-off floor.
    expect.soft(consultantCheckpointLive('full', 'spec', { consultant: false })).toBe(false);
    expect.soft(consultantCheckpointLive('full', 'implement', { consultant: false, gateless: true })).toBe(false);
    // A bet-audit challenge: bound and not gateless; gateless drops it.
    expect.soft(consultantCheckpointLive('full', 'spec', { consultant: true })).toBe(true);
    expect.soft(consultantCheckpointLive('full', 'spec', { consultant: true, gateless: true })).toBe(false);
    expect.soft(consultantCheckpointLive('short', 'implement', { consultant: true, gateless: true })).toBe(false); // rir implGate
    // The generative frame: bound, gateless-independent (non-holding, so it survives).
    expect.soft(consultantCheckpointLive('full', 'frame', { consultant: true, gateless: true })).toBe(true); // full framing
    expect.soft(consultantCheckpointLive('short', 'research', { consultant: true, gateless: true })).toBe(true); // rir framing
    // A backstop checkpoint: bound, gateless-independent.
    expect.soft(consultantCheckpointLive('full', 'plan', { consultant: true, gateless: true })).toBe(true); // contract
    expect.soft(consultantCheckpointLive('full', 'implement', { consultant: true, gateless: true })).toBe(true); // verify
    // A phase with no checkpoint is never live.
    expect.soft(consultantCheckpointLive('full', 'finish', { consultant: true })).toBe(false);
  });

  test('workflowHasConsultantBackstop: full has the contract+verify backstop, rir has none', () => {
    expect.soft(workflowHasConsultantBackstop('full')).toBe(true);
    expect.soft(workflowHasConsultantBackstop('short')).toBe(false);
  });

  test('S8: the full-arc afk preset is attend-none registry data, keeping every consultant net (gateless OFF)', () => {
    // Registry data only — afk mirrors rir's, no statechart change.
    expect.soft(WORKFLOWS.full.presets.afk).toEqual([]);
    expect.soft(WORKFLOWS.short.presets.afk).toEqual([]); // rir unchanged

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
    expect(handoffWatchLabel('short')).toBe('research approved — AFK implement');
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
    expect.soft(isPostHandoffPhase('short', 'research')).toBe(false);
    expect.soft(isPostHandoffPhase('short', 'implement')).toBe(true);
    expect.soft(isPostHandoffPhase('short', 'finish')).toBe(true);
  });
});

describe('the stage partition — stages, duties, and continuity edges (registry data)', () => {
  test('every shipped workflow partitions into planning then delivery, pinned literally', () => {
    // Pinned (not derived) so a malformed registry can't self-validate.
    expect.soft(stagesOf('full').map((s) => ({ name: s.name, phases: s.phases }))).toEqual([
      { name: 'planning', phases: ['frame', 'spec', 'plan'] },
      { name: 'delivery', phases: ['implement', 'finish'] },
    ]);
    expect.soft(stagesOf('blueprint').map((s) => ({ name: s.name, phases: s.phases }))).toEqual([
      { name: 'planning', phases: ['frame', 'design'] },
      { name: 'delivery', phases: ['implement', 'finish'] },
    ]);
    expect.soft(stagesOf('relay').map((s) => ({ name: s.name, phases: s.phases }))).toEqual([
      { name: 'planning', phases: ['frame', 'design'] },
      { name: 'delivery', phases: ['implement', 'finish'] },
    ]);
    // A workflow with no document still has a planning stage: research alone.
    expect.soft(stagesOf('short').map((s) => ({ name: s.name, phases: s.phases }))).toEqual([
      { name: 'planning', phases: ['research'] },
      { name: 'delivery', phases: ['implement', 'finish'] },
    ]);
  });

  test('stageOf resolves each phase to its stage; a foreign phase throws', () => {
    expect.soft(stageOf('full', 'plan')).toBe('planning');
    expect.soft(stageOf('full', 'implement')).toBe('delivery');
    expect.soft(stageOf('short', 'research')).toBe('planning');
    expect.soft(() => stageOf('short', 'plan')).toThrow(/not part of the "short" workflow/);
  });

  test('handoffGateOf derives as planning last phase — the deleted handoffGate field, one source', () => {
    expect.soft(handoffGateOf('full')).toBe('plan');
    expect.soft(handoffGateOf('blueprint')).toBe('design');
    expect.soft(handoffGateOf('relay')).toBe('design');
    expect.soft(handoffGateOf('short')).toBe('research');
  });

  test('duty resolvers: planning is architect/analyst everywhere; delivery checker follows the review posture', () => {
    expect.soft(dutiesOf('full', 'planning')).toEqual(['architect', 'analyst']);
    expect.soft(dutiesOf('full', 'delivery')).toEqual(['builder', 'critic']);
    expect.soft(makerDutyOf('relay', 'delivery')).toBe('builder');
    // relay's fixer posture names its delivery checker the JUDGE; the critique
    // and writable postures keep the critic.
    expect.soft(checkerDutyOf('relay', 'delivery')).toBe('judge');
    expect.soft(checkerDutyOf('full', 'delivery')).toBe('critic');
    expect.soft(checkerDutyOf('short', 'delivery')).toBe('critic');
  });

  test('stageOfDuty names each duty stage from the closed vocabulary', () => {
    expect.soft(stageOfDuty('architect')).toBe('planning');
    expect.soft(stageOfDuty('analyst')).toBe('planning');
    expect.soft(stageOfDuty('builder')).toBe('delivery');
    expect.soft(stageOfDuty('critic')).toBe('delivery');
    expect.soft(stageOfDuty('judge')).toBe('delivery');
  });

  test('fixerDutyFor routes a fix to the judge under the fixer posture, the builder everywhere else', () => {
    expect.soft(fixerDutyFor('relay')).toBe('judge');
    expect.soft(fixerDutyFor('full')).toBe('builder');
    expect.soft(fixerDutyFor('blueprint')).toBe('builder');
    expect.soft(fixerDutyFor('short')).toBe('builder');
  });

  test('continuity edges: full/blueprint/short carry both lanes; relay delivery is born fresh', () => {
    for (const wf of ['full', 'blueprint', 'short'] as const) {
      expect.soft(continuityEdgeFor(wf, 'builder')).toBe('architect');
      expect.soft(continuityEdgeFor(wf, 'critic')).toBe('analyst');
    }
    expect.soft(continuityEdgeFor('relay', 'builder')).toBeUndefined();
    expect.soft(continuityEdgeFor('relay', 'judge')).toBeUndefined();
    // Planning duties never have inbound edges.
    expect.soft(continuityEdgeFor('full', 'architect')).toBeUndefined();
  });
});

describe('validateRegistry — posture/seed coherence on a delivery build phase', () => {
  const buildPhase = (semantics: Record<string, unknown>) =>
    phase('b', 'bGate', {
      reviewLoop: true,
      semantics: {
        block: 'build',
        entrySeed: 'fresh-seed',
        reviewPosture: 'fixer',
        midpoint: 'none',
        shipPacket: 'lean',
        buildTailOwner: 'reviewer',
        examplesKey: 'relay-impl',
        ...semantics,
      } as PhaseSemantics,
    });

  test('a fixer build with a critic checker throws (the checker duty and the posture are one fact)', () => {
    const w = workflow({ phases: [phase('a', 'aGate'), buildPhase({})] });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /checker is "critic" but the build's review posture "fixer" names the checker "judge"/,
    );
  });

  test('a fresh-seed build with a maker continuity edge throws', () => {
    const w = workflow({
      phases: [phase('a', 'aGate'), buildPhase({ reviewPosture: 'writable' })],
      stages: stages({ delivery: { edges: { builder: { from: 'architect' } } } }),
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /has no planning session to continue/,
    );
  });

  test('a session-carrying entrySeed without a maker edge throws (the edge and the seed are one fact)', () => {
    const w = workflow({
      phases: [phase('a', 'aGate'), buildPhase({ reviewPosture: 'writable', entrySeed: 'compact-for-impl' })],
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /declare the edge or seed fresh/,
    );
  });
});
