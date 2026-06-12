/**
 * The phase table — the single source of truth for the run arc.
 *
 * Every per-phase fact lives here: the order of phases, each phase's gate
 * (its machine state name and human-facing copy), the review-loop posture,
 * and the runaway rails (round caps, budgets, timeouts). The statechart
 * (src/harness/machine.ts) builds its states from this table; the driver,
 * CLI, and prompts look phases up here. Adding or changing a phase is a
 * one-table edit.
 *
 * The arc (docs/automation-design.md §"Phases and gates"):
 *
 *   frame → Direction gate → spec → Commit-spec gate → plan → Plan-approval
 *   gate (walk away) → impl (AFK) → Ship gate → docs → Docs-plan gate → pr →
 *   Open-PR gate → open → done
 */

export type PhaseName = 'frame' | 'spec' | 'plan' | 'impl' | 'docs' | 'pr' | 'open';

/** Phases that end at a human gate (`open` advances straight to done). */
export type GatePhase = Exclude<PhaseName, 'open'>;

export interface PhaseSpec {
  name: PhaseName;
  /**
   * The gate this phase exits through: its machine state name and the
   * human-facing copy `duet status` renders. `null` for `open`, the one
   * phase that runs after the last gate and advances straight to done.
   */
  gate: {
    /** Machine state name — a domain name, not derived from the phase. */
    state: string;
    /** Status heading above the gate packet. */
    heading: string;
    /** One-line notification/stop description. */
    ready: string;
    /** Extra guidance printed under the decide-with commands, when the gate warrants it. */
    hint: string | null;
  } | null;
  /** What the human sends back on reject — names the artifact in feedback prompts. */
  artifactLabel: string;
  /**
   * Whether the phase's substance IS the review loop — advance_phase refuses
   * with zero rounds there. The others (synthesis, docs mechanics, PR
   * mechanics) may legitimately advance without the reviewer.
   */
  reviewLoop: boolean;
  /** Runaway backstop, not an exit mechanism — generous by design (~2× observed rounds). */
  roundCap: number;
  /**
   * Per-invocation rails. The AFK impl phase runs 1–3 hours with many worker
   * turns, so its ceilings are wider; hitting any of them flags the human
   * rather than crashing.
   */
  orchestratorBudgetUsd: number;
  workerBudgetUsd: number;
  workerTurnTimeoutMs: number;
}

export const PHASES: readonly PhaseSpec[] = [
  {
    name: 'frame',
    gate: {
      state: 'directionGate',
      heading: 'DIRECTION gate — the synthesized direction',
      ready: 'Direction gate — synthesized direction ready',
      hint: null,
    },
    artifactLabel: 'direction analysis',
    reviewLoop: false,
    roundCap: 2,
    orchestratorBudgetUsd: 15,
    workerBudgetUsd: 10,
    workerTurnTimeoutMs: 30 * 60_000,
  },
  {
    name: 'spec',
    gate: {
      state: 'commitSpecGate',
      heading: "SPEC gate — the orchestrator's summary",
      ready: 'Commit-spec gate — spec ready for review',
      hint: null,
    },
    artifactLabel: 'spec',
    reviewLoop: true,
    roundCap: 6,
    orchestratorBudgetUsd: 15,
    workerBudgetUsd: 10,
    workerTurnTimeoutMs: 30 * 60_000,
  },
  {
    name: 'plan',
    gate: {
      state: 'planApprovalGate',
      heading: "PLAN gate — the orchestrator's summary",
      ready: 'Plan-approval gate — plan ready for review',
      hint: null,
    },
    artifactLabel: 'plan',
    reviewLoop: true,
    roundCap: 4,
    orchestratorBudgetUsd: 15,
    workerBudgetUsd: 10,
    workerTurnTimeoutMs: 30 * 60_000,
  },
  {
    name: 'impl',
    gate: {
      state: 'shipGate',
      heading: 'SHIP gate — the orchestrator’s packet (CEO summary first)',
      ready: 'Ship gate — implementation packet ready',
      hint: '(verify in your environment before deciding — migrations, smoke tests; approving enters FINAL REVIEW: docs → PR description → Open-PR gate)',
    },
    artifactLabel: 'implementation',
    reviewLoop: true,
    roundCap: 6,
    orchestratorBudgetUsd: 30,
    workerBudgetUsd: 25,
    workerTurnTimeoutMs: 60 * 60_000,
  },
  {
    name: 'docs',
    gate: {
      state: 'docsPlanGate',
      heading: 'DOCS-PLAN gate — the proposal',
      ready: 'Docs-plan gate — proposal ready',
      hint: null,
    },
    artifactLabel: 'docs plan',
    reviewLoop: false,
    roundCap: 2,
    orchestratorBudgetUsd: 10,
    workerBudgetUsd: 10,
    workerTurnTimeoutMs: 30 * 60_000,
  },
  {
    name: 'pr',
    gate: {
      state: 'openPrGate',
      heading: 'OPEN-PR gate — the PR description',
      ready: 'Open-PR gate — PR description ready',
      hint: '(approving opens the PR: the implementer pushes the branch and runs gh pr create)',
    },
    artifactLabel: 'PR description',
    reviewLoop: false,
    roundCap: 2,
    orchestratorBudgetUsd: 10,
    workerBudgetUsd: 10,
    workerTurnTimeoutMs: 30 * 60_000,
  },
  {
    name: 'open',
    gate: null, // runs after the last gate; advances straight to done
    artifactLabel: 'PR opening',
    reviewLoop: false,
    roundCap: 1,
    orchestratorBudgetUsd: 5,
    workerBudgetUsd: 5,
    workerTurnTimeoutMs: 15 * 60_000,
  },
];

/** Per-phase lookup. */
export const PHASE: Record<PhaseName, PhaseSpec> = Object.fromEntries(
  PHASES.map((p) => [p.name, p]),
) as Record<PhaseName, PhaseSpec>;

/** The gate-bearing phase names, in arc order — the `gates_at` vocabulary. */
export const GATE_PHASES: readonly GatePhase[] = PHASES.filter((p) => p.gate !== null).map(
  (p) => p.name as GatePhase,
);

/** Resolve a machine gate-state name (e.g. "shipGate") to its phase, or undefined. */
export function phaseOfGateState(stateName: string): GatePhase | undefined {
  return PHASES.find((p) => p.gate?.state === stateName)?.name as GatePhase | undefined;
}

/** A gate phase's gate spec — non-null by construction (every GatePhase row has one). */
export function gateOf(phase: GatePhase): NonNullable<PhaseSpec['gate']> {
  const gate = PHASE[phase].gate;
  if (!gate) throw new Error(`phase ${phase} has no gate — the phase table and GatePhase type disagree`);
  return gate;
}
