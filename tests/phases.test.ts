import { describe, expect, test } from 'vitest';
import {
  BRIEF_WORLDS,
  GATELESS_CONSULTANT_SNIPPETS,
  WORKFLOWS,
  acceptanceContractPathForSpec,
  consultantCheckpointLive,
  consultantCheckpointView,
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
} from '../src/registry/workflows.ts';
import type { PhaseSemantics, StageSpecInput, WorkflowSpecInput } from '../src/registry/workflows.ts';

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

describe('the blueprint workflow (the middle arc — full minus the plan phase)', () => {
  // A literal pin (not self-derived), like full's: frame → spec → implement → finish.
  test('phasesOf("blueprint") is the four-phase arc in order', () => {
    expect(phasesOf('blueprint').map((p) => p.name)).toEqual(['frame', 'spec', 'implement', 'finish']);
  });

  test('all four phases are gates; shared gate-state names resolve within the workflow', () => {
    expect.soft(gatePhasesOf('blueprint')).toEqual(['frame', 'spec', 'implement', 'finish']);
    expect.soft(phaseOfGateState('blueprint', 'directionGate')).toBe('frame');
    expect.soft(phaseOfGateState('blueprint', 'commitSpecGate')).toBe('spec');
    expect.soft(phaseOfGateState('blueprint', 'shipGate')).toBe('implement');
    expect.soft(phaseOfGateState('blueprint', 'openPrGate')).toBe('finish');
    // The plan gate is full-only — blueprint's spec IS its last planning phase.
    expect.soft(phaseOfGateState('blueprint', 'planApprovalGate')).toBeUndefined();
  });

  test('the spec phase is ONE review loop at cap 2 — the arc premises fast convergence', () => {
    const spec = phaseSpec('blueprint', 'spec');
    expect.soft(spec.reviewLoop).toBe(true);
    expect.soft(spec.roundCap).toBe(2); // an explicit `rounds: 2`, not full's default 3
    expect.soft(spec.artifactLabel).toBe('spec');
    // The SAME doc-loop family full's spec runs — one artifact, one snippet set.
    expect.soft(spec.snippets).toEqual(phaseSpec('full', 'spec').snippets);
  });

  // The two facts the compiler derives from the phase list and the renderers then
  // trust: this spec is the whole design (nothing follows it in planning), and it
  // has no upstream document, so its contract authors from its own converged draft.
  test('the spec carries the derived topology: terminal in planning, no upstream doc', () => {
    const semantics = phaseSpec('blueprint', 'spec').semantics;
    expect(semantics.block).toBe('doc-loop');
    if (semantics.block !== 'doc-loop') return;
    expect.soft(semantics.isHandoffPhase).toBe(true);
    expect.soft(semantics.hasUpstreamDoc).toBe(false);
    // full's spec is the mirror: a plan follows, so it is neither.
    const fullSpec = phaseSpec('full', 'spec').semantics;
    if (fullSpec.block !== 'doc-loop') return;
    expect.soft(fullSpec.isHandoffPhase).toBe(false);
    expect.soft(fullSpec.hasUpstreamDoc).toBe(false);
    const fullPlan = phaseSpec('full', 'plan').semantics;
    if (fullPlan.block !== 'doc-loop') return;
    expect.soft(fullPlan.isHandoffPhase).toBe(true);
    expect.soft(fullPlan.hasUpstreamDoc).toBe(true);
  });

  // The hand-off-to-AFK clause is one derivation (isHandoffPhase), rendered by
  // whichever planning phase ends the stage. Assert the token and the absence
  // flip, not the sentence: the tails legitimately differ per block.
  test("planning's last gate says it hands off to AFK; a gate with a plan after it does not", () => {
    const clause = 'approving hands off to AFK implementation';
    expect.soft(gateOf('blueprint', 'spec').hint).toContain(clause);
    expect.soft(gateOf('relay', 'spec').hint).toContain(clause);
    expect.soft(gateOf('short', 'research').hint).toContain(clause);
    // full's spec is a waypoint — the plan is obviously still coming.
    expect.soft(gateOf('full', 'spec').hint).toBeNull();
    expect.soft(gateOf('full', 'frame').hint).toBeNull();
    // …and full's plan gate ends planning but IS the plan, so it says nothing.
    expect.soft(gateOf('full', 'plan').hint).toBeNull();
  });

  test('implement reuses full’s spec with implement-spec as the build seed (not short’s implement-direct)', () => {
    const implement = phaseSpec('blueprint', 'implement');
    const full = phaseSpec('full', 'implement');
    // The one substitution: implement-spec seeds the build (the committed spec is
    // the authority); everything else — midpoint, compactions, the review loop,
    // docs-reconcile-last, ceo-summary — is full's implement.
    expect.soft(implement.snippets).toEqual(['compact-for-impl', 'implement-spec', ...full.snippets.slice(1)]);
    expect.soft(implement.snippets).not.toContain('implement-direct'); // that body assumes no document exists
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

  test('entry: --spec skips to the spec loop (the first doc phase, whatever it is named)', () => {
    expect(WORKFLOWS.blueprint.entry).toEqual({ firstPhase: 'frame', specSkipsTo: 'spec' });
  });

  test('the spec gate is the interactive→headless handoff (derived: planning ends at spec)', () => {
    expect.soft(handoffGateOf('blueprint')).toBe('spec');
    expect.soft(handoffWatchLabel('blueprint')).toBe('spec approved — AFK implement');
  });

  test('the stage partition splits at the spec gate — delivery begins at the AFK build', () => {
    expect.soft(stageOf('blueprint', 'frame')).toBe('planning');
    expect.soft(stageOf('blueprint', 'spec')).toBe('planning'); // the handoff gate itself is planning's last phase
    expect.soft(stageOf('blueprint', 'implement')).toBe('delivery');
    expect.soft(stageOf('blueprint', 'finish')).toBe('delivery');
  });

  test('the one-interruption posture: a new run materializes gatesAt = ["spec"]', () => {
    expect.soft(WORKFLOWS.blueprint.defaultPreAuthorized).toEqual(['frame', 'implement', 'finish']);
    expect.soft(WORKFLOWS.blueprint.forceAttend).toEqual([]);
    expect.soft(WORKFLOWS.blueprint.presets.afk).toEqual([]);
    // The materialized default: attend the spec gate only — read one document,
    // tap once, walk away. (The severity hold still converts a `high` at the
    // auto-crossed Direction gate into an attended stop — pinned in lifecycle tests.)
    expect.soft(defaultPosture(gatePhasesOf('blueprint'), WORKFLOWS.blueprint.defaultPreAuthorized)).toEqual(['spec']);
  });

  test('consultant checkpoints: frame → contract → verify — no challenge anywhere (a stance, not an accident)', () => {
    expect.soft(phaseSpec('blueprint', 'frame').consultantCheckpoint).toBe('frame');
    expect.soft(phaseSpec('blueprint', 'spec').consultantCheckpoint).toBe('contract'); // LATE-authored: after the loop converges
    expect.soft(phaseSpec('blueprint', 'implement').consultantCheckpoint).toBe('verify');
    expect.soft(phaseSpec('blueprint', 'finish').consultantCheckpoint).toBeUndefined();
    // The arc exists for work where the owner trusts the direction after framing:
    // no holding bet-audit at any phase, so a gateless blueprint run drops nothing extra.
    const modes = phasesOf('blueprint').map((p) => p.consultantCheckpoint);
    expect.soft(modes).not.toContain('specGate');
    expect.soft(modes).not.toContain('implGate');
  });

  test('contractAuthorPhaseOf("blueprint") is its spec phase — that gate is the freeze gate', () => {
    expect.soft(contractAuthorPhaseOf('blueprint')).toBe('spec');
    expect.soft(consultantSnippetFor('blueprint', 'spec')).toBe('consultant-contract');
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

  test('consultantCheckpointView folds mode + render-facing kind + liveness, hiding the internal `challenge` name', () => {
    // A checkpoint phase, consultant bound: mode is the registry mode, kind is
    // render-facing (specGate's internal `challenge` shown as `bet-audit`), live true.
    expect.soft(consultantCheckpointView('full', 'spec', { consultant: true })).toEqual({
      mode: 'specGate',
      kind: 'bet-audit',
      live: true,
    });
    // The generative frame and the backstops render their kinds verbatim.
    expect.soft(consultantCheckpointView('full', 'frame', { consultant: true })).toEqual({ mode: 'frame', kind: 'generative', live: true });
    expect.soft(consultantCheckpointView('full', 'plan', { consultant: true })).toEqual({ mode: 'contract', kind: 'backstop', live: true });
    expect.soft(consultantCheckpointView('full', 'implement', { consultant: true })).toEqual({ mode: 'verify', kind: 'backstop', live: true });
    // The internal taxonomy never leaks: no view ever reports kind `challenge`.
    for (const phase of phasesOf('full')) {
      const view = consultantCheckpointView('full', phase.name, { consultant: true });
      expect.soft(view?.kind).not.toBe('challenge');
    }
    // A phase without a checkpoint yields undefined (not a zero-value object).
    expect.soft(consultantCheckpointView('full', 'finish', { consultant: true })).toBeUndefined();
    // Liveness threads consultantCheckpointLive: unbound ⇒ live false but the
    // static mode/kind still resolve; gateless drops the bet-audit's liveness,
    // keeps the generative frame and backstop live.
    expect.soft(consultantCheckpointView('full', 'spec', { consultant: false })).toEqual({ mode: 'specGate', kind: 'bet-audit', live: false });
    expect.soft(consultantCheckpointView('full', 'spec', { consultant: true, gateless: true })?.live).toBe(false);
    expect.soft(consultantCheckpointView('full', 'frame', { consultant: true, gateless: true })?.live).toBe(true);
    expect.soft(consultantCheckpointView('full', 'implement', { consultant: true, gateless: true })?.live).toBe(true);
    // The RIR implGate is also a bet-audit by render kind (internal `challenge`).
    expect.soft(consultantCheckpointView('short', 'implement', { consultant: true })).toEqual({ mode: 'implGate', kind: 'bet-audit', live: true });
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
      ['blueprint', 'frame'], ['blueprint', 'spec'], ['blueprint', 'finish'],
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

describe('stageOf — the stage partition at the handoff boundary', () => {
  // full's handoff gate is `plan`; short's is `research`. The phases up to and
  // INCLUDING the handoff gate are planning; the build + finishing tail are
  // delivery — the boundary every duty-keyed lookup (bindings, sessions) rides.
  test('full: the phases through the plan handoff gate are planning', () => {
    expect.soft(stageOf('full', 'frame')).toBe('planning');
    expect.soft(stageOf('full', 'spec')).toBe('planning');
    expect.soft(stageOf('full', 'plan')).toBe('planning'); // the handoff gate is planning's last phase
  });

  test('full: the build and finishing tail are delivery', () => {
    expect.soft(stageOf('full', 'implement')).toBe('delivery');
    expect.soft(stageOf('full', 'finish')).toBe('delivery');
  });

  test('short: research (the handoff gate) is planning; implement and finish are delivery', () => {
    expect.soft(stageOf('short', 'research')).toBe('planning');
    expect.soft(stageOf('short', 'implement')).toBe('delivery');
    expect.soft(stageOf('short', 'finish')).toBe('delivery');
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
      { name: 'planning', phases: ['frame', 'spec'] },
      { name: 'delivery', phases: ['implement', 'finish'] },
    ]);
    expect.soft(stagesOf('relay').map((s) => ({ name: s.name, phases: s.phases }))).toEqual([
      { name: 'planning', phases: ['frame', 'spec'] },
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
    expect.soft(handoffGateOf('blueprint')).toBe('spec');
    expect.soft(handoffGateOf('relay')).toBe('spec');
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
        buildTailOwner: 'checker',
        examplesKey: 'impl-fixer',
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
      phases: [phase('a', 'aGate'), buildPhase({ reviewPosture: 'writable', examplesKey: 'impl-direct' })],
      stages: stages({ delivery: { edges: { builder: { from: 'architect' } } } }),
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /has no planning session to continue/,
    );
  });

  test('a session-carrying entrySeed without a maker edge throws (the edge and the seed are one fact)', () => {
    const w = workflow({
      phases: [phase('a', 'aGate'), buildPhase({ reviewPosture: 'writable', examplesKey: 'impl-direct', entrySeed: 'compact-for-impl' })],
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /declare the edge or seed fresh/,
    );
  });
});

describe('validateRegistry — brief worlds are load-time vocabulary', () => {
  test('a frame phase with an undeclared prose world throws before brief render', () => {
    const w = workflow({
      phases: [
        phase('a', 'aGate', { semantics: { block: 'frame', examplesKey: 'impl' } as unknown as PhaseSemantics }),
        phase('b', 'bGate'),
      ],
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /no frame brief world is declared.*valid frame worlds: frame, research/,
    );
  });

  test("a workflow's first document must be the spec — a plan would reread a spec that never existed", () => {
    const w = workflow({
      phases: [
        phase('a', 'aGate', {
          reviewLoop: true,
          semantics: { block: 'doc-loop', artifactKind: 'plan', hasUpstreamDoc: false, isHandoffPhase: true } as PhaseSemantics,
        }),
        phase('b', 'bGate'),
      ],
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /opens its documents with a "plan" doc-loop/,
    );
  });

  test('a second spec is rejected — only the first document is a spec, every later one a plan', () => {
    const w = workflow({
      phases: [
        phase('a', 'aGate', {
          reviewLoop: true,
          semantics: { block: 'doc-loop', artifactKind: 'spec', hasUpstreamDoc: false, isHandoffPhase: false } as PhaseSemantics,
        }),
        phase('a2', 'a2Gate', {
          reviewLoop: true,
          semantics: { block: 'doc-loop', artifactKind: 'spec', hasUpstreamDoc: true, isHandoffPhase: true } as PhaseSemantics,
        }),
        phase('b', 'bGate'),
      ],
      stages: stages({ planning: { phases: ['a', 'a2'] } }),
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /phase "a2" is a "spec" doc-loop following another document/,
    );
  });

  // The doc-loop's derived facts are trusted by the renderers without re-derivation
  // (the gate hint, the contract's seed placement), so a frozen or hand-authored
  // spec must not be able to lie about them.
  test('a lying hasUpstreamDoc throws — it decides where the acceptance contract seeds from', () => {
    const w = workflow({
      phases: [
        phase('a', 'aGate', {
          reviewLoop: true,
          semantics: { block: 'doc-loop', artifactKind: 'spec', hasUpstreamDoc: true, isHandoffPhase: true } as PhaseSemantics,
        }),
        phase('b', 'bGate'),
      ],
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /phase "a" declares hasUpstreamDoc true but no document phase precedes it/,
    );
  });

  test("a lying isHandoffPhase throws — it decides the gate's hand-off-to-AFK copy", () => {
    const w = workflow({
      phases: [
        phase('a', 'aGate', {
          reviewLoop: true,
          semantics: { block: 'doc-loop', artifactKind: 'spec', hasUpstreamDoc: false, isHandoffPhase: false } as PhaseSemantics,
        }),
        phase('b', 'bGate'),
      ],
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /phase "a" declares isHandoffPhase false but planning's last phase is "a"/,
    );
  });

  test('a fixer build from a plan prose world is rejected with the missing-world fix', () => {
    const w = workflow({
      phases: [
        phase('a', 'aGate'),
        phase('b', 'bGate', {
          reviewLoop: true,
          semantics: {
            block: 'build',
            entrySeed: 'fresh-seed',
            reviewPosture: 'fixer',
            midpoint: 'judgment',
            shipPacket: 'ceo-summary',
            buildTailOwner: 'checker',
            examplesKey: 'impl-from-plan',
          } as PhaseSemantics,
        }),
      ],
      stages: stages({ delivery: { duties: { maker: 'builder', checker: 'judge' } } }),
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /no fixer build brief world is declared.*valid fixer build worlds: impl-fixer/,
    );
  });

  test('the registry declaration names the shipped build prose worlds', () => {
    expect(BRIEF_WORLDS.build).toEqual({
      critique: ['impl-from-plan', 'impl-from-spec'],
      writable: ['impl-direct'],
      fixer: ['impl-fixer'],
    });
  });
});

describe('validateRegistry — the acceptance contract is one chain (author ⇔ verify)', () => {
  // A coherent delivery build that can carry a verify checkpoint: fresh-seed +
  // writable keeps the default critic checker and needs no continuity edge.
  const buildPhase = (overrides: Record<string, unknown> = {}) =>
    phase('b', 'bGate', {
      reviewLoop: true,
      semantics: {
        block: 'build',
        entrySeed: 'fresh-seed',
        reviewPosture: 'writable',
        midpoint: 'none',
        shipPacket: 'lean',
        buildTailOwner: 'maker',
        examplesKey: 'impl-direct',
      } as PhaseSemantics,
      ...overrides,
    });
  // A coherent planning doc-loop that can carry the contract-author checkpoint.
  const docPhase = (overrides: Record<string, unknown> = {}) =>
    phase('a', 'aGate', {
      reviewLoop: true,
      semantics: { block: 'doc-loop', artifactKind: 'spec', hasUpstreamDoc: false, isHandoffPhase: true } as PhaseSemantics,
      ...overrides,
    });

  test('a verify checkpoint without a contract author throws — nothing would ever be frozen to check', () => {
    const w = workflow({ phases: [docPhase(), buildPhase({ consultantCheckpoint: 'verify' })] });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /"verify" consultant checkpoint without its "contract" counterpart/,
    );
  });

  test('a contract author without a verify throws — a frozen target nothing ever checks', () => {
    const w = workflow({ phases: [docPhase({ consultantCheckpoint: 'contract' }), buildPhase()] });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).toThrow(
      /"contract" consultant checkpoint without its "verify" counterpart/,
    );
  });

  test('both ends together pass (the shipped full/blueprint/relay shape)', () => {
    const w = workflow({
      phases: [docPhase({ consultantCheckpoint: 'contract' }), buildPhase({ consultantCheckpoint: 'verify' })],
    });
    expect(() => validateRegistry({ w } as unknown as Record<string, WorkflowSpecInput>)).not.toThrow();
  });
});
