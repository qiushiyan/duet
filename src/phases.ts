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
 *          (walk away) → impl (AFK) → Ship → finish (reconcile docs → PR
 *          → Open-PR) → done
 *   rir:   research → Direction (walk away) → implement (AFK) → Ship
 *          → publish (reconcile docs → PR → Open-PR) → done
 */

import { basename, dirname, extname } from 'node:path';

/**
 * A consultant checkpoint mode — the posture the optional consultant takes at a
 * phase, named by lineage, not by phase. The modes:
 *
 * - `frame` — the generative third-analysis mode (framing).
 * - `specGate` — the critical bet-audit mode just before the Commit-spec gate.
 * - `implGate` — the open-ended bet-audit mode at the impl-side gate. RIR's
 *   `implement` uses it (it has no plan phase, so it authors no contract).
 * - `contract` — the generative-and-writing mode: the consultant AUTHORS the
 *   acceptance contract (Full's `plan`), blind to the plan and code.
 * - `verify` — the evidence-grounded verification mode: a fresh session VERIFIES
 *   the frozen acceptance contract (Full's `impl`), supplanting the open-ended
 *   `implGate` audit there.
 *
 * Each arc maps the modes onto its own phases (Full: frame/specGate/contract/
 * verify; RIR: frame/implGate — no spec or plan phase, so no contract loop). The
 * `contract`/`verify` pair is the acceptance-contract feature; `implGate` is
 * NOT globally re-pointed (RIR still audits the bet with no contract to verify).
 * Registry data, so "where the consultant fires" stays in the single source.
 */
export type ConsultantCheckpoint = 'frame' | 'specGate' | 'implGate' | 'contract' | 'verify';

/**
 * The gate a phase exits through (registry input shape). String-typed at input
 * time, then narrowed by `as const`. Every phase gates, so this is non-optional.
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
  readonly gate: GateInput;
  readonly artifactLabel: string;
  readonly reviewLoop: boolean;
  readonly roundCap: number;
  readonly orchestratorBudgetUsd: number;
  readonly workerBudgetUsd: number;
  readonly workerTurnTimeoutMs: number;
  /**
   * The consultant checkpoint this phase carries (absent ⇒ none). Drives the
   * orchestrator-brief injection that only fires when a consultant is bound; the
   * unbound run never reads it.
   */
  readonly consultantCheckpoint?: ConsultantCheckpoint;
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
  /**
   * Gates pre-authorized by default — the inverse of `forceAttend`. Materialized
   * out of a new run's posture at `createRun` (the run persists `gatesAt = gate
   * phases − defaultPreAuthorized`), so a default run auto-crosses these while a
   * legacy run (absent `gatesAt`) keeps attend-all unchanged. Disjoint from
   * `forceAttend` (validateRegistry enforces it). Empty ⇒ no default pre-auth
   * (the materialization leaves `gatesAt` absent — pure pre-feature behavior).
   */
  readonly defaultPreAuthorized: readonly string[];
}

export const WORKFLOWS = {
  full: {
    name: 'full',
    displayName: 'Full (spec → plan → implement → ship → PR)',
    phases: [
      {
        name: 'frame',
        // Base snippets are the run's ALWAYS-ON templates. The consultant
        // checkpoint snippet is NOT listed here — it is registry data
        // (consultantCheckpoint, below) folded in per-run by phaseSnippetsFor
        // only when a consultant is bound, so list_snippets never exposes it on
        // an unbound run (the default-off byte-for-byte invariant).
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
        consultantCheckpoint: 'frame',
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
        roundCap: 3,
        orchestratorBudgetUsd: 15,
        workerBudgetUsd: 10,
        workerTurnTimeoutMs: 30 * 60_000,
        consultantCheckpoint: 'specGate',
      },
      {
        name: 'plan',
        snippets: ['start-plan', 'review-plan', 'update-plan', 'review-plan-again', 'update-plan-again'],
        gate: {
          state: 'planApprovalGate',
          heading: "PLAN gate — the orchestrator's summary",
          ready: 'Plan-approval gate — plan ready for review',
          hint: null,
        },
        artifactLabel: 'plan',
        reviewLoop: true,
        roundCap: 3,
        orchestratorBudgetUsd: 15,
        workerBudgetUsd: 10,
        workerTurnTimeoutMs: 30 * 60_000,
        // The acceptance-contract AUTHOR checkpoint: the consultant authors the
        // contract here, blind to the plan loop running alongside it, and the
        // human ratifies it when approving this gate (it is the freeze gate).
        consultantCheckpoint: 'contract',
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
          hint: '(verify in your environment before deciding — migrations, smoke tests; approving enters FINISH: reconcile docs → PR → Open-PR gate)',
        },
        artifactLabel: 'implementation',
        reviewLoop: true,
        roundCap: 3,
        orchestratorBudgetUsd: 30,
        workerBudgetUsd: 25,
        workerTurnTimeoutMs: 60 * 60_000,
        // The acceptance-contract VERIFY checkpoint: a fresh session verifies the
        // frozen contract by running the built system, supplanting the
        // open-ended implGate bet-audit (RIR keeps implGate — it has no contract).
        consultantCheckpoint: 'verify',
      },
      {
        // The finishing tail, collapsed to one phase (2026-06-26; was docs → pr
        // → open, three orchestrator sessions for one logical step). Open-then-
        // review in one continuous session: reconcile docs + commit → write the
        // PR description → open the PR — and only THEN does the gate interpose.
        // Pre-authorized (the default), the PR opens and the gate auto-crosses to
        // done with the URL leading the packet; attended (`finish` in gates_at),
        // the run stops at the opened PR — approve marks it done, reject re-enters
        // this loop to AMEND the open PR (gh pr edit / more commits), never to
        // re-open. Reject-as-amend is sound because amending an open PR is itself
        // reversible. The open is idempotent by a worker-side gh-pr-view check, not
        // run-state. The PR is mergeable on open (the bug-review bots fire on it),
        // so the env-verification reminder rides the body as a "Verification
        // (pending)" checklist rather than a draft state. No consultant checkpoint
        // (the verify checkpoint already ran at impl); compact-for-cleanup stays
        // reachable for the rare bloated-context case. (Q2 retired the Docs-plan
        // gate for the identical reasons; this finishes that line.) Mirror of rir's
        // `publish` — same shape, same entry brief (openPrPhaseEntryPrompt).
        name: 'finish',
        snippets: ['reconcile-docs', 'pr-description', 'compact-for-cleanup'],
        gate: {
          state: 'openPrGate',
          heading: 'OPEN-PR gate — docs reconciled, PR open',
          ready: 'Open-PR gate — PR open, ready for your review',
          hint: '(the PR is already open and auto-crosses to done by default; list `finish` in gates_at for a post-open review stop — approve marks it done, reject amends the open PR. The merge is always yours.)',
        },
        artifactLabel: 'PR',
        reviewLoop: false,
        roundCap: 2,
        orchestratorBudgetUsd: 15,
        workerBudgetUsd: 15,
        workerTurnTimeoutMs: 30 * 60_000,
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
      'skip-plan': ['frame', 'spec', 'impl'],
    },
    // The full sleep posture is the default (2026-06-26, Q20 resolved to it):
    // plan, impl (Ship), and finish (Open-PR) are all pre-authorized, so a new
    // run materializes gatesAt = ['frame','spec'] — the `overnight` preset. The
    // Ship auto-cross shifts environment verification (migrations, smoke tests)
    // from before-the-PR to PR-review time; the opened PR carries a Verification
    // (pending) checklist as the standing reminder. forceAttend stays empty:
    // opening a PR is non-destructive (the human still owns the merge) and a
    // gate-reject amends it in place, so the Open-PR gate is never force-attended,
    // only attended when `finish` is listed in gates_at. forceAttend and
    // defaultPreAuthorized must stay disjoint (validateRegistry guards it at load).
    forceAttend: [],
    defaultPreAuthorized: ['plan', 'impl', 'finish'],
  },
  rir: {
    name: 'rir',
    displayName: 'Research → Implement → Review',
    phases: [
      {
        name: 'research',
        // Shared with Full's frame. Library-choice guidance lives in implement-direct
        // (rir's plan-discipline home), not here — research is the direction phase.
        snippets: ['think-holistic', 'compare-notes'],
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
        consultantCheckpoint: 'frame',
      },
      {
        name: 'implement',
        // The spine order: build, orient the reviewer, one writable review round.
        // Docs no longer fold in here — they moved to the `publish` phase, where
        // they ride the PR (the arc now opens one). So the Ship gate reviews the
        // code + review outcome, like full's impl Ship gate.
        snippets: ['implement-direct', 'handoff-direct', 'review-direct', 'apply-review'],
        gate: {
          state: 'shipGate',
          heading: 'SHIP gate — the implementation packet',
          ready: 'Ship gate — implementation packet ready',
          hint: '(verify in your environment before deciding — migrations, smoke tests; approving enters PUBLISH: reconcile docs → open the real PR)',
        },
        artifactLabel: 'implementation',
        reviewLoop: true,
        // One writable review round — the runaway backstop, not an exit gate.
        roundCap: 1,
        orchestratorBudgetUsd: 30,
        workerBudgetUsd: 25,
        workerTurnTimeoutMs: 60 * 60_000,
        consultantCheckpoint: 'implGate',
      },
      {
        // The finishing tail for rir — the mirror of full's `finish`: same shape,
        // same entry brief (openPrPhaseEntryPrompt). Reconcile docs (they ride the
        // PR now that the arc has one) → write the PR description → gh pr create.
        // Pre-authorized (the `afk` posture), the PR opens and the Open-PR gate
        // auto-crosses to done; attended (`publish` in gates_at), the run stops at
        // the opened PR — approve marks it done, reject re-enters to AMEND it (gh pr
        // edit / more commits), never to re-open. No consultant checkpoint (the
        // implGate bet-audit already ran at implement).
        name: 'publish',
        snippets: ['reconcile-docs', 'pr-description', 'compact-for-cleanup'],
        gate: {
          // Gate-state name reused from Full — legal because resolution is
          // workflow-scoped (phaseOfGateState(workflow, …)); reusing it lights up
          // status's opensPr and the shared reject-amend clause for rir too.
          state: 'openPrGate',
          heading: 'OPEN-PR gate — docs reconciled, PR open',
          ready: 'Open-PR gate — PR open, ready for your review',
          hint: '(the PR is already open and auto-crosses to done by default; list `publish` in gates_at for a post-open review stop — approve marks it done, reject amends the open PR. The merge is always yours.)',
        },
        artifactLabel: 'PR',
        reviewLoop: false,
        roundCap: 2,
        orchestratorBudgetUsd: 15,
        workerBudgetUsd: 15,
        workerTurnTimeoutMs: 30 * 60_000,
      },
    ],
    entry: { firstPhase: 'research' },
    handoffGate: 'research',
    // afk attends no gates — a headless RIR run auto-crosses Direction, Ship, and
    // the new Open-PR gate straight to done (the user's walk-away-after-research
    // flow). forceAttend pins nothing for RIR; defaultPreAuthorized stays empty,
    // so a bare run attends all three gates (legacy attend-all default).
    presets: { afk: [] },
    forceAttend: [],
    defaultPreAuthorized: [],
  },
} as const satisfies Record<string, WorkflowSpecInput>;

/** The workflows duet can run. */
export type WorkflowName = keyof typeof WORKFLOWS;

/** The union of every phase across all workflows (globally unique names). */
type AnyPhase = (typeof WORKFLOWS)[WorkflowName]['phases'][number];

/** Every phase name, derived from the registry. */
export type PhaseName = AnyPhase['name'];

/**
 * Phases that end at a human gate. Every phase in every arc gates (the registry
 * makes `gate` non-nullable), so this is exactly `PhaseName` — kept as a named
 * alias because it reads as intent at the call sites (`gatesAt: GatePhase[]`).
 */
export type GatePhase = PhaseName;

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
   * human-facing copy `duet status` renders. Non-null — every phase in both
   * arcs gates.
   */
  gate: {
    state: string;
    heading: string;
    ready: string;
    hint: string | null;
  };
  /** What the human sends back on reject — names the artifact in feedback prompts. */
  artifactLabel: string;
  /**
   * Whether the phase's substance IS the review loop — advance_phase refuses
   * with zero rounds there. The others (synthesis, docs mechanics, PR
   * mechanics) may legitimately advance without the reviewer.
   */
  reviewLoop: boolean;
  /** Runaway backstop, not an exit mechanism — kept tight by design (a couple rounds, not many). */
  roundCap: number;
  /**
   * Per-invocation rails. The AFK impl phase runs 1–3 hours with many worker
   * turns, so its ceilings are wider; hitting any of them flags the human
   * rather than crashing.
   */
  orchestratorBudgetUsd: number;
  workerBudgetUsd: number;
  workerTurnTimeoutMs: number;
  /** The consultant checkpoint this phase carries, when any (registry data). */
  consultantCheckpoint?: ConsultantCheckpoint;
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
      if (gateStates.has(p.gate.state)) {
        throw new Error(
          `registry: workflow "${wfName}" has two gates with state "${p.gate.state}" — gate-state names must be unique within a workflow so phaseOfGateState is total`,
        );
      }
      gateStates.add(p.gate.state);
    }
    const gatePhases = new Set(wf.phases.map((p) => p.name));
    const requireGatePhase = (value: string, what: string): void => {
      if (!gatePhases.has(value)) {
        throw new Error(
          `registry: workflow "${wfName}" ${what} "${value}" is not a gate phase of this workflow (gate phases: ${[...gatePhases].join(', ') || 'none'})`,
        );
      }
    };
    requireGatePhase(wf.handoffGate, 'handoffGate');
    for (const g of wf.forceAttend) requireGatePhase(g, 'forceAttend entry');
    for (const g of wf.defaultPreAuthorized) requireGatePhase(g, 'defaultPreAuthorized entry');
    // Disjointness: a gate cannot be both force-attended and default-pre-authorized.
    // Materialization omits a defaultPreAuthorized gate from gatesAt, but gateAttended
    // still force-attends a forceAttend gate — so an overlap would render the gate as
    // pre-authorized in the posture text while it actually stops. Catch it at load.
    const forceAttendSet = new Set(wf.forceAttend);
    for (const g of wf.defaultPreAuthorized) {
      if (forceAttendSet.has(g)) {
        throw new Error(
          `registry: workflow "${wfName}" gate "${g}" is in both forceAttend and defaultPreAuthorized — a gate cannot be force-attended and default-pre-authorized at once`,
        );
      }
    }
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

/**
 * The watch-hint printed when an interactive run hands off to the headless
 * driver at its handoff gate: "<handoff gate> approved — AFK <next phase>".
 * Derived from the registry so each arc reads correctly — Full: "plan approved
 * — AFK impl"; RIR: "research approved — AFK implement" — rather than the old
 * hardcoded "plan approved" that mislabeled a RIR handoff (Q: no plan exists).
 */
export function handoffWatchLabel(workflow: WorkflowName): string {
  const phases = phasesOf(workflow);
  const handoff = WORKFLOWS[workflow].handoffGate;
  const i = phases.findIndex((p) => p.name === handoff);
  const next = phases[i + 1]?.name ?? 'the next phase';
  return `${handoff} approved — AFK ${next}`;
}

/**
 * The workflow a phase belongs to — unambiguous because phase names are
 * globally unique (validateRegistry enforces it). Lets a phase-scoped surface
 * resolve its arc without being handed the workflow explicitly.
 */
export function workflowOfPhase(phase: PhaseName): WorkflowName {
  const owner = (Object.keys(WORKFLOWS) as WorkflowName[]).find((w) =>
    WORKFLOWS[w].phases.some((p) => p.name === phase),
  );
  if (!owner) throw new Error(`no workflow owns phase "${phase}" — the registry and PhaseName disagree`);
  return owner;
}

/**
 * The phase immediately before `phase` in its own arc — the predecessor whose
 * gate approval enters `phase`. Registry-derived so a renamed or reordered arc
 * stays correct (Full: finish ← impl; RIR: publish ← implement). Throws if
 * `phase` is the first in its arc (it has no predecessor) — a caller bug.
 */
export function priorPhaseOf(phase: PhaseName): PhaseName {
  const phases = phasesOf(workflowOfPhase(phase));
  const prior = phases[phases.findIndex((p) => p.name === phase) - 1];
  if (!prior) throw new Error(`phase "${phase}" is first in its arc — it has no predecessor`);
  return prior.name;
}

/** Every phase across all workflows, widened to the consumer-facing view. */
const ALL_PHASES: readonly PhaseSpec[] = Object.values(WORKFLOWS).flatMap(
  (w): readonly PhaseSpec[] => w.phases,
);

/** Per-phase lookup, flat across all workflows (phase names are globally unique). */
export const PHASE: Record<PhaseName, PhaseSpec> = Object.fromEntries(
  ALL_PHASES.map((p) => [p.name, p]),
) as Record<PhaseName, PhaseSpec>;

/** A workflow's gate-bearing phase names, in arc order — its `gates_at` vocabulary. */
export function gatePhasesOf(workflow: WorkflowName): readonly GatePhase[] {
  return WORKFLOWS[workflow].phases.map((p) => p.name);
}

/** A workflow's default-pre-authorized gates (the inverse of `forceAttend`). */
export function defaultPreAuthorizedOf(workflow: WorkflowName): readonly GatePhase[] {
  return WORKFLOWS[workflow].defaultPreAuthorized as readonly GatePhase[];
}

/**
 * The default gate posture a new run materializes from its workflow: the gate
 * phases minus the default-pre-authorized ones. Returns `undefined` when nothing
 * is pre-authorized by default (≡ absent `gatesAt` ≡ attend-all/legacy), so a
 * pre-feature run is written byte-for-byte as before. Pure (registry passed in)
 * so it is branch-testable without mutating the live registry.
 */
export function defaultPosture(
  gatePhases: readonly GatePhase[],
  defaultPreAuthorized: readonly string[],
): GatePhase[] | undefined {
  if (defaultPreAuthorized.length === 0) return undefined;
  return gatePhases.filter((g) => !defaultPreAuthorized.includes(g));
}

/**
 * Resolve a machine gate-state name (e.g. "shipGate") to its phase within the
 * run's workflow, or undefined. Scoped, not flat: mapping a state value back to
 * a phase is arc topology, and scoping it lets two workflows reuse a gate-state
 * name without the resolver becoming ambiguous.
 */
export function phaseOfGateState(workflow: WorkflowName, stateName: string): GatePhase | undefined {
  return WORKFLOWS[workflow].phases.find((p) => p.gate.state === stateName)?.name as GatePhase | undefined;
}

/** A gate phase's gate spec — non-null by construction (every phase gates). */
export function gateOf(phase: GatePhase): PhaseSpec['gate'] {
  return PHASE[phase].gate;
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

/** The snippet each consultant checkpoint mode is run with. */
const CONSULTANT_CHECKPOINT_SNIPPET: Record<ConsultantCheckpoint, string> = {
  frame: 'consultant-frame',
  specGate: 'consultant-spec',
  implGate: 'consultant-impl',
  contract: 'consultant-contract',
  verify: 'consultant-verify',
};

/**
 * The consultant checkpoint snippets, as a set — every snippet that is enabled
 * ONLY when a consultant is bound. The render layer (snippets.ts) filters the
 * flat `all=true` library against this so an unbound run's library never exposes
 * one; the classification test reads it as the consultant bucket rather than
 * forcing these into the phases' always-on lists (which is what leaked them).
 */
export const CONSULTANT_SNIPPETS: ReadonlySet<string> = new Set(Object.values(CONSULTANT_CHECKPOINT_SNIPPET));

/**
 * The consultant checkpoint modes that survive a GATELESS run — the correctness
 * BACKSTOP (the contract author + the verify), as opposed to the bet-level
 * CHALLENGE (frame / specGate / implGate). A gateless owner walks away having
 * pre-decided the bet, so the consultant runs only its backstop, never its
 * challenge. The single source for "which checkpoints a gateless run still
 * fires", read by both the snippet surface and the phase briefs.
 */
const BACKSTOP_CHECKPOINTS: ReadonlySet<ConsultantCheckpoint> = new Set(['contract', 'verify']);

/** Whether a phase's consultant checkpoint is a backstop one (survives gateless). */
export function isBackstopCheckpoint(phase: PhaseName): boolean {
  const mode = PHASE[phase].consultantCheckpoint;
  return mode !== undefined && BACKSTOP_CHECKPOINTS.has(mode);
}

/**
 * The consultant snippet keys for the BACKSTOP checkpoints only — the gateless
 * narrowing of CONSULTANT_SNIPPETS for the one render path that has no arc to map
 * phases through (the defensive no-workflow flat render). Derived from the same
 * BACKSTOP_CHECKPOINTS data, so it tracks the registry automatically.
 */
export const BACKSTOP_CONSULTANT_SNIPPETS: ReadonlySet<string> = new Set(
  [...BACKSTOP_CHECKPOINTS].map((m) => CONSULTANT_CHECKPOINT_SNIPPET[m]),
);

/**
 * Whether phase P's consultant checkpoint is LIVE for a run with these knobs — the
 * single bet-vs-backstop gate BOTH the snippet surface (phaseSnippetsFor,
 * consultantSnippetsForWorkflow) and the orchestrator phase briefs derive from, so
 * the two can never disagree about which checkpoints a run fires. Live when a
 * consultant is bound, the phase carries a checkpoint, and EITHER the run is not
 * gateless OR the checkpoint is a backstop one. The asymmetry falls out of
 * isBackstopCheckpoint — a bet-level phase yields `bound && !gateless`, a backstop
 * phase yields `bound` — so no caller re-implements the split (the divergence the
 * scattered `bindings.consultant && !gateless` checks risked). Default-off
 * preserved: no consultant ⇒ false.
 */
export function consultantCheckpointLive(phase: PhaseName, opts: { consultant: boolean; gateless?: boolean }): boolean {
  if (!opts.consultant) return false;
  if (consultantSnippetFor(phase) === undefined) return false;
  return !opts.gateless || isBackstopCheckpoint(phase);
}

/** Whether a workflow has any backstop checkpoint — full does (contract+verify), rir does not. */
export function workflowHasConsultantBackstop(workflow: WorkflowName): boolean {
  return phasesOf(workflow).some((p) => isBackstopCheckpoint(p.name));
}

/**
 * The consultant snippets a WORKFLOW's checkpoints actually reach — full's
 * {frame, spec, contract, verify} snippets; rir's {frame, impl}. The flat
 * `all=true` renderer filters the consultant bucket against this so a bound run's
 * library exposes only the snippets ITS arc can use: a bound rir run never sees
 * `consultant-contract`/`consultant-verify` (nor the Full-only `consultant-spec`)
 * — the contract feature does not leak into the arc that deferred it, and the
 * surface stays per-arc honest, not merely "any consultant snippet". A GATELESS
 * run narrows it further to the backstop, so its bet-level snippets never show —
 * derived, like the briefs, through consultantCheckpointLive.
 */
export function consultantSnippetsForWorkflow(workflow: WorkflowName, opts: { gateless?: boolean } = {}): ReadonlySet<string> {
  return new Set(
    phasesOf(workflow)
      .filter((p) => consultantCheckpointLive(p.name, { consultant: true, gateless: opts.gateless }))
      .map((p) => consultantSnippetFor(p.name)!),
  );
}

/**
 * A phase's snippets ENABLED for this run — the always-on base list, plus the
 * phase's consultant checkpoint snippet appended (last, preserving today's bound
 * order) only when its checkpoint is live for this run. The single source
 * list_snippets reads, so "what the orchestrator may reach for" is base ∪
 * (checkpoint iff live) on every render path: an unbound run sees byte-for-byte
 * the base list, a bound run sees the checkpoint snippet in its owning phase, and
 * a gateless run sees only its backstop checkpoints (consultantCheckpointLive).
 */
export function phaseSnippetsFor(phase: PhaseName, opts: { consultant: boolean; gateless?: boolean }): readonly string[] {
  const checkpoint = consultantSnippetFor(phase);
  return consultantCheckpointLive(phase, opts) && checkpoint
    ? [...PHASE[phase].snippets, checkpoint]
    : PHASE[phase].snippets;
}

/**
 * The consultant snippet a phase's checkpoint runs with, or undefined when the
 * phase carries no checkpoint — the single source the orchestrator-brief
 * injection reads, so the phase→snippet mapping is never duplicated in prompts.
 */
export function consultantSnippetFor(phase: PhaseName): string | undefined {
  const mode = PHASE[phase].consultantCheckpoint;
  return mode ? CONSULTANT_CHECKPOINT_SNIPPET[mode] : undefined;
}

/**
 * The phase in a workflow whose consultant checkpoint AUTHORS the acceptance
 * contract (`contract` mode) — Full's `plan`; `undefined` for an arc with no
 * contract loop (RIR). The freeze step reads this to recognize "this gate is the
 * contract's freeze gate", so the gate→freeze coupling stays registry-derived
 * (never a hardcoded `=== 'plan'`), and an arc that authors no contract freezes
 * none. Derived, since exactly one phase carries the mode (or none).
 */
export function contractAuthorPhaseOf(workflow: WorkflowName): PhaseName | undefined {
  return phasesOf(workflow).find((p) => p.consultantCheckpoint === 'contract')?.name;
}

/**
 * The committed location of a run's acceptance contract, derived from the spec
 * path: the spec's sibling with an `.acceptance.md` suffix (e.g.
 * `docs/specs/2026-06-24-foo.md` → `docs/specs/2026-06-24-foo.acceptance.md`).
 * A convention, not a stored field — both the author step (where to write) and
 * the freeze/verify steps (where to read) derive it from `state.specPath`, so the
 * path is deterministic without new run state. Repo-relative, matching specPath.
 */
export function acceptanceContractPathForSpec(specPath: string): string {
  const dir = dirname(specPath);
  const stem = basename(specPath, extname(specPath));
  const file = `${stem}.acceptance.md`;
  return dir === '.' ? file : `${dir}/${file}`;
}
