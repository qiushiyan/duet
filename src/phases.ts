/**
 * The workflow registry — the single source of truth for the run arcs.
 *
 * duet is workflow-aware: `WORKFLOWS` holds one entry per arc, and each
 * workflow owns its complete spec — the ordered phases, the entry route, the
 * handoff gate, the gate presets, and the force-attended gates. A run records
 * which workflow it is on (`RunState.workflow`); everything arc-shaped resolves
 * through it.
 *
 * The flat lookups everything already uses — `PHASE[name]`, the
 * `Record<PhaseName, …>` run-state maps, the entry-prompt dispatch — are
 * DERIVED from the registry and stay flat, made unambiguous by globally-unique
 * phase names. Only genuinely topology/policy-shaped helpers are
 * workflow-scoped (`phasesOf`, `gatePhasesOf`, `phaseOfGateState`, the machine
 * factory, the lifecycle position probe). `validateRegistry` (run once at
 * module load) checks the two invariants the split rests on: phase names are
 * globally unique, and gate-state names are unique within a workflow.
 *
 * Every per-phase fact lives here: the order of phases, each phase's gate (its
 * machine state name and human-facing copy), the review-loop posture, and the
 * runaway rails (round caps, budgets, timeouts). The statechart
 * (src/harness/machine.ts) builds its states from a workflow's phases; the
 * driver, CLI, and prompts look phases up here.
 *
 * The arcs (docs/automation-design.md §"Phases and gates"):
 *
 *   full:  frame → Direction → spec → Commit-spec → plan → Plan-approval
 *          (walk away) → impl (AFK) → Ship → docs → Docs-plan → pr →
 *          Open-PR → open → done
 */

/**
 * The gate a phase exits through (registry input shape). String-typed at input
 * time; the derived `GatePhase` discriminates on `gate` being non-null.
 */
interface GateInput {
  /** Machine state name — a domain name, not derived from the phase. */
  readonly state: string;
  /** Status heading above the gate packet. */
  readonly heading: string;
  /** One-line notification/stop description. */
  readonly ready: string;
  /** Extra guidance printed under the decide-with commands, when the gate warrants it. */
  readonly hint: string | null;
}

/**
 * A phase definition as written in the registry — string-typed so the literal
 * `WORKFLOWS` table can be authored without forward references, then narrowed
 * by `as const`. `PhaseSpec` (below) is the consumer-facing view with
 * `name: PhaseName`.
 */
interface PhaseSpecInput<Name extends string = string> {
  readonly name: Name;
  readonly snippets: readonly string[];
  readonly gate: GateInput | null;
  readonly artifactLabel: string;
  readonly reviewLoop: boolean;
  readonly roundCap: number;
  readonly orchestratorBudgetUsd: number;
  readonly workerBudgetUsd: number;
  readonly workerTurnTimeoutMs: number;
}

/** A workflow definition as written in the registry (string-typed input shape). */
export interface WorkflowSpecInput {
  /** Stable identifier, equal to the registry key. */
  readonly name: string;
  /** Human-facing arc name, shown by the selector and status. */
  readonly displayName: string;
  /** The ordered arc. */
  readonly phases: readonly PhaseSpecInput[];
  /**
   * The entry route: the phase a snapshot-less run starts in (`firstPhase`),
   * and — for arcs that admit a draft-spec entry — the phase a `--spec` run
   * skips to (`specSkipsTo`).
   */
  readonly entry: { readonly firstPhase: string; readonly specSkipsTo?: string };
  /**
   * The walk-away → headless boundary: the gate where an interactive run hands
   * off to the detached driver (always crossed live there, regardless of
   * gates_at).
   */
  readonly handoffGate: string;
  /** Named gates_at presets, workflow-scoped — pure aliases for gate lists. */
  readonly presets: Record<string, readonly string[]>;
  /** Gates that can never be pre-authorized (outward-facing/non-negotiable). */
  readonly forceAttend: readonly string[];
}

export const WORKFLOWS = {
  full: {
    name: 'full',
    displayName: 'Full (spec → plan → implement → ship → docs → PR)',
    phases: [
      {
        name: 'frame',
        snippets: ['think-holistic', 'compare-notes'],
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
        snippets: ['write-spec', 'review-spec', 'update-spec', 'review-spec-again', 'update-spec-again'],
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
        snippets: ['tdd-plan', 'review-plan', 'update-plan', 'review-plan-again', 'update-plan-again'],
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
        snippets: [
          'compact-for-impl',
          'midpoint-status',
          'review-midpoint',
          'respond-midpoint',
          'compact-for-review',
          'implementation-handoff',
          'review-implementation',
          'respond-review',
          'review-implementation-again',
          'respond-review-again',
          'ceo-summary',
        ],
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
        snippets: ['compact-for-cleanup'],
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
        snippets: ['pr-description'],
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
        snippets: [], // push + gh pr create — mechanics, no library template
        gate: null, // runs after the last gate; advances straight to done
        artifactLabel: 'PR opening',
        reviewLoop: false,
        roundCap: 1,
        orchestratorBudgetUsd: 5,
        workerBudgetUsd: 5,
        workerTurnTimeoutMs: 15 * 60_000,
      },
    ],
    entry: { firstPhase: 'frame', specSkipsTo: 'spec' },
    handoffGate: 'plan',
    presets: {
      /** Attend nothing after the spec — the full sleep posture. */
      overnight: ['frame', 'spec'],
      /**
       * Walk away at spec approval, return at the Ship gate — the plan loop runs
       * unattended. Born from run evidence (the human reports rubber-stamping
       * plan gates); whether this earns default status is Q20's evidence stream.
       */
      'skip-plan': ['frame', 'spec', 'impl', 'docs'],
    },
    forceAttend: ['pr'],
  },
  rir: {
    name: 'rir',
    displayName: 'Research → Implement → Review',
    phases: [
      {
        name: 'research',
        // Shared with Full's frame; use-latest-docs is RIR-only this run.
        snippets: ['think-holistic', 'compare-notes', 'use-latest-docs'],
        gate: {
          // Gate-state name reused from Full — legal because resolution is
          // workflow-scoped (phaseOfGateState(workflow, …)).
          state: 'directionGate',
          heading: 'DIRECTION gate — the synthesized direction',
          ready: 'Direction gate — synthesized direction ready',
          hint: '(approving hands off to AFK implementation — these decisions are the spec; there is no separate spec or plan)',
        },
        artifactLabel: 'direction analysis',
        reviewLoop: false,
        roundCap: 2,
        orchestratorBudgetUsd: 15,
        workerBudgetUsd: 10,
        workerTurnTimeoutMs: 30 * 60_000,
      },
      {
        name: 'implement',
        // The spine order: build, orient the reviewer, one writable review round.
        snippets: ['implement-direct', 'handoff-direct', 'review-direct', 'apply-review'],
        gate: {
          state: 'shipGate',
          heading: 'SHIP gate — the implementation packet',
          ready: 'Ship gate — implementation packet ready',
          hint: '(verify in your environment before deciding — migrations, smoke tests; approving completes the run)',
        },
        artifactLabel: 'implementation',
        reviewLoop: true,
        // One writable review round — the runaway backstop, not an exit gate.
        roundCap: 1,
        orchestratorBudgetUsd: 30,
        workerBudgetUsd: 25,
        workerTurnTimeoutMs: 60 * 60_000,
      },
    ],
    entry: { firstPhase: 'research' },
    handoffGate: 'research',
    // afk attends no gates — a headless RIR run auto-crosses Direction and Ship
    // straight to done. A matched preset may resolve to an empty list (Slice 6);
    // forceAttend pins nothing for RIR (no outward-facing action).
    presets: { afk: [] },
    forceAttend: [],
  },
} as const satisfies Record<string, WorkflowSpecInput>;

/** The workflows duet can run. */
export type WorkflowName = keyof typeof WORKFLOWS;

/** The union of every phase across all workflows (globally unique names). */
type AnyPhase = (typeof WORKFLOWS)[WorkflowName]['phases'][number];

/** Every phase name, derived from the registry. */
export type PhaseName = AnyPhase['name'];

/**
 * Phases that end at a human gate, derived from the registry — a phase whose
 * `gate` is a (non-null) object. The lone open-ended phase (`gate: null`,
 * Full's `open`) is excluded; it runs after the last gate and advances straight
 * to done.
 */
export type GatePhase = Extract<AnyPhase, { gate: object }>['name'];

/** The consumer-facing phase view — the registry input narrowed to `PhaseName`. */
export interface PhaseSpec {
  name: PhaseName;
  /**
   * The snippet keys this phase's work draws on, in the order the orchestrator
   * typically reaches for them. The phase-aware `list_snippets` shows these in
   * full while indexing other phases by key — cross-cutting helpers live in
   * `ANYTIME_SNIPPETS`, deliberately-archived snippets in `UNLISTED_SNIPPETS`,
   * and the completeness test (`tests/snippets.test.ts`) asserts every library
   * snippet is classified, so none goes silently invisible in the default view.
   */
  snippets: readonly string[];
  /**
   * The gate this phase exits through: its machine state name and the
   * human-facing copy `duet status` renders. `null` for an open-ended phase
   * (Full's `open`) that runs after the last gate and advances straight to done.
   */
  gate: {
    state: string;
    heading: string;
    ready: string;
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

/**
 * Registry integrity, validated at module load (not assumed): the two
 * invariants the flat/scoped derivation rests on, plus the topology references
 * each workflow makes to its own gate/phase names. Throws naming the violation.
 */
export function validateRegistry(workflows: Record<string, WorkflowSpecInput>): void {
  const phaseOwner = new Map<string, string>(); // phase name → owning workflow
  for (const [wfName, wf] of Object.entries(workflows)) {
    const phaseNames = new Set<string>();
    const gateStates = new Set<string>();
    for (const p of wf.phases) {
      const prior = phaseOwner.get(p.name);
      if (prior !== undefined) {
        throw new Error(
          `registry: phase name "${p.name}" appears in both "${prior}" and "${wfName}" — phase names must be globally unique so the derived PHASE/PhaseName are unambiguous`,
        );
      }
      phaseOwner.set(p.name, wfName);
      phaseNames.add(p.name);
      if (p.gate) {
        if (gateStates.has(p.gate.state)) {
          throw new Error(
            `registry: workflow "${wfName}" has two gates with state "${p.gate.state}" — gate-state names must be unique within a workflow so phaseOfGateState is total`,
          );
        }
        gateStates.add(p.gate.state);
      }
    }
    const gatePhases = new Set(wf.phases.filter((p) => p.gate !== null).map((p) => p.name));
    const requireGatePhase = (value: string, what: string): void => {
      if (!gatePhases.has(value)) {
        throw new Error(
          `registry: workflow "${wfName}" ${what} "${value}" is not a gate phase of this workflow (gate phases: ${[...gatePhases].join(', ') || 'none'})`,
        );
      }
    };
    requireGatePhase(wf.handoffGate, 'handoffGate');
    for (const g of wf.forceAttend) requireGatePhase(g, 'forceAttend entry');
    for (const [presetName, gates] of Object.entries(wf.presets)) {
      for (const g of gates) requireGatePhase(g, `preset "${presetName}" value`);
    }
    if (!phaseNames.has(wf.entry.firstPhase)) {
      throw new Error(
        `registry: workflow "${wfName}" entry.firstPhase "${wf.entry.firstPhase}" is not a phase of this workflow`,
      );
    }
    if (wf.entry.specSkipsTo !== undefined && !phaseNames.has(wf.entry.specSkipsTo)) {
      throw new Error(
        `registry: workflow "${wfName}" entry.specSkipsTo "${wf.entry.specSkipsTo}" is not a phase of this workflow`,
      );
    }
  }
}

validateRegistry(WORKFLOWS);

/** A workflow's ordered phases. */
export function phasesOf(workflow: WorkflowName): readonly PhaseSpec[] {
  return WORKFLOWS[workflow].phases;
}

/** A workflow's entry route, normalized to the optional-specSkipsTo shape. */
export function entryOf(workflow: WorkflowName): { firstPhase: PhaseName; specSkipsTo?: PhaseName } {
  return WORKFLOWS[workflow].entry;
}

/** Every phase across all workflows, widened to the consumer-facing view. */
const ALL_PHASES: readonly PhaseSpec[] = Object.values(WORKFLOWS).flatMap(
  (w): readonly PhaseSpec[] => w.phases,
);

/** Per-phase lookup, flat across all workflows (phase names are globally unique). */
export const PHASE: Record<PhaseName, PhaseSpec> = Object.fromEntries(
  ALL_PHASES.map((p) => [p.name, p]),
) as Record<PhaseName, PhaseSpec>;

/**
 * Transitional alias = Full's phases, kept so consumers not yet migrated to
 * `phasesOf(workflow)` still compile. Removed in Slice 5 once the last consumer
 * is workflow-scoped.
 */
export const PHASES: readonly PhaseSpec[] = WORKFLOWS.full.phases;

/** A workflow's gate-bearing phase names, in arc order — its `gates_at` vocabulary. */
export function gatePhasesOf(workflow: WorkflowName): readonly GatePhase[] {
  return WORKFLOWS[workflow].phases.filter((p) => p.gate !== null).map((p) => p.name as GatePhase);
}

/**
 * Resolve a machine gate-state name (e.g. "shipGate") to its phase within the
 * run's workflow, or undefined. Scoped, not flat: mapping a state value back to
 * a phase is arc topology, and scoping it lets two workflows reuse a gate-state
 * name without the resolver becoming ambiguous.
 */
export function phaseOfGateState(workflow: WorkflowName, stateName: string): GatePhase | undefined {
  return WORKFLOWS[workflow].phases.find((p) => p.gate?.state === stateName)?.name as GatePhase | undefined;
}

/** A gate phase's gate spec — non-null by construction (every GatePhase row has one). */
export function gateOf(phase: GatePhase): NonNullable<PhaseSpec['gate']> {
  const gate = PHASE[phase].gate;
  if (!gate) throw new Error(`phase ${phase} has no gate — the phase table and GatePhase type disagree`);
  return gate;
}

/**
 * Snippets usable in any phase — cross-cutting helpers the phase-aware
 * `list_snippets` always shows in full alongside the current phase's
 * templates, so the genuinely reusable tools are never behind `all=true`.
 */
export const ANYTIME_SNIPPETS: readonly string[] = [
  'reread-context',
  'commits-summary',
  'find-similar-bugs',
  'list-assumptions',
  'trace-execution',
  'smart-adapt-skills',
  'technical-difficulty',
];

/**
 * Snippets kept in the library but deliberately not surfaced by default —
 * reachable only via `list_snippets({all:true})`. `compact-for-plan` is the
 * manual after-spec compaction duet replaced with the after-plan
 * `compact-for-impl` (docs/automation-design.md §"Worker compaction"); it
 * stays available for a judgment-timed early cut when a long spec phase bloats
 * context, but is not a default template (surfacing it in the plan phase would
 * invite the very pre-plan compaction the design moved away from).
 */
export const UNLISTED_SNIPPETS: readonly string[] = ['compact-for-plan'];
