import { describe, expect, test } from 'vitest';
import {
  PHASE,
  gateOf,
  gatePhasesOf,
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

describe("the Full workflow derives today's arc", () => {
  // A literal pin (not self-derived): a malformed registry can't pass a test
  // that also derives its expectation from the registry.
  test('phasesOf("full") is the seven-phase arc in order', () => {
    expect(phasesOf('full').map((p) => p.name)).toEqual([
      'frame',
      'spec',
      'plan',
      'impl',
      'docs',
      'pr',
      'open',
    ]);
  });

  test('gatePhasesOf("full") is every phase but the open-ended one', () => {
    expect(gatePhasesOf('full')).toEqual(['frame', 'spec', 'plan', 'impl', 'docs', 'pr']);
  });

  test('PHASE indexes every phase across all workflows, flat', () => {
    expect(Object.keys(PHASE).sort()).toEqual(
      ['docs', 'frame', 'impl', 'implement', 'open', 'pr', 'plan', 'research', 'spec'].sort(),
    );
    expect(PHASE['impl'].gate?.state).toBe('shipGate');
    expect(PHASE['open'].gate).toBeNull();
  });

  test('phaseOfGateState resolves within the workflow, undefined otherwise', () => {
    expect(phaseOfGateState('full', 'shipGate')).toBe('impl');
    expect(phaseOfGateState('full', 'directionGate')).toBe('frame');
    expect(phaseOfGateState('full', 'nopeGate')).toBeUndefined();
  });

  test('gateOf returns the gate spec for a gate phase', () => {
    expect(gateOf('pr').state).toBe('openPrGate');
  });
});

describe('the RIR workflow', () => {
  test('phasesOf("rir") is research → implement', () => {
    expect(phasesOf('rir').map((p) => p.name)).toEqual(['research', 'implement']);
  });

  test('both RIR phases are gates; reused gate-state names resolve within the workflow', () => {
    expect(gatePhasesOf('rir')).toEqual(['research', 'implement']);
    expect(phaseOfGateState('rir', 'directionGate')).toBe('research');
    expect(phaseOfGateState('rir', 'shipGate')).toBe('implement');
    // The Full-only gate states do not resolve inside RIR.
    expect(phaseOfGateState('rir', 'commitSpecGate')).toBeUndefined();
    expect(phaseOfGateState('rir', 'openPrGate')).toBeUndefined();
  });

  test('implement is the writable single review round (roundCap 1)', () => {
    const implement = phasesOf('rir').find((p) => p.name === 'implement')!;
    expect.soft(implement.reviewLoop).toBe(true);
    expect.soft(implement.roundCap).toBe(1);
  });
});
