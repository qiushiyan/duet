/**
 * The workflow registry — the single source of truth for the run arcs.
 *
 * duet is workflow-aware: `WORKFLOWS` holds one entry per arc, and each
 * workflow owns its complete spec — the ordered phases, the stages that
 * partition them (with each stage's duty voices and continuity edges), the
 * entry route, the gate presets, and the force-attended gates. A run records
 * which workflow it is on (`RunState.workflow`); everything arc-shaped resolves
 * through it.
 *
 * Phase identity is WORKFLOW-SCOPED: a phase is identified by (workflow, name),
 * so both arcs can name their build phase "implement" and their finish phase
 * "finish" without collision. `phaseSpec(workflow, phase)` is the one per-phase
 * lookup — there is no global `PHASE[name]` map, because a shared name across
 * arcs would collapse it. The run-state maps stay `Record<PhaseName, …>`: a run
 * lives on exactly one arc and only ever keys its own arc's phase names, so the
 * shared-name union is unambiguous per run. `validateRegistry` (run once at
 * module load) checks two invariants: phase names are unique WITHIN a workflow,
 * and gate-state names are unique within a workflow.
 *
 * Every per-phase fact lives here: the order of phases, each phase's gate (its
 * machine state name and human-facing copy), the review-loop posture, and the
 * runaway rails (round caps, budgets, timeouts). The statechart
 * (src/run/machine.ts) builds its states from a workflow's phases; the
 * driver, CLI, and prompts look phases up here.
 *
 * The arcs (docs/automation-design.md §"Phases and gates"):
 *
 *   full:   frame → Direction → spec → Commit-spec → plan → Plan-approval
 *           (walk away) → implement (AFK; build → review → reconcile docs) → Ship
 *           → finish (open the PR) → Open-PR → done
 *   blueprint: frame → Direction → spec → Commit-spec (walk away) → implement
 *           (AFK; build → review → reconcile docs) → Ship → finish (open the PR)
 *           → Open-PR → done — full minus the plan phase; the spec is the design
 *   relay:  blueprint's shape with a fresh, criss-crossed delivery: the judge
 *           fixes findings in place and owns the docs + PR tails
 *   short:    research → Direction (walk away) → implement (AFK; build → review →
 *           reconcile docs) → Ship → finish (open the PR) → Open-PR → done
 *
 * The arcs share the `implement` and `finish` phase names — legal because phase
 * identity is workflow-scoped (see below); their specs still differ per arc.
 */

import { basename, dirname, extname } from 'node:path';
import { build, compileWorkflow, defineWorkflow, doc, finish, frame } from './define.ts';
import { snippetsForSemantics, validateRegistry } from './vocabulary.ts';
import type {
  ConsultantCheckpoint,
  Duty,
  GatePhase,
  PhaseName,
  PhaseSpec,
  StageName,
  WorkflowRef,
  WorkflowSpecInput,
} from './vocabulary.ts';

export {
  BRIEF_WORLDS,
  DUTIES,
  stageOfDuty,
  stageOfDutyLane,
  validateRegistry,
  validatedWorkflowSpec,
} from './vocabulary.ts';
export type {
  ArtifactKind,
  CompiledWorkflow,
  ConsultantCheckpoint,
  CritiqueBuildBriefWorld,
  Duty,
  EntrySeed,
  ExamplesKey,
  FixerBuildBriefWorld,
  FrameBriefWorld,
  GatePhase,
  PhaseName,
  PhaseSpec,
  PhaseSemantics,
  ReviewPosture,
  StageName,
  StageSpecInput,
  TailOwner,
  WorkflowName,
  WorkflowRef,
  WorkflowSpec,
  WorkflowSpecInput,
  WritableBuildBriefWorld,
} from './vocabulary.ts';

const SHIPPED_WORKFLOW_DEFINITIONS = {
  full: defineWorkflow({
    name: 'full',
    title: 'Full (spec → plan → implement → ship → PR)',
    attend: ['frame', 'spec'],
    presets: { overnight: ['frame', 'spec'], 'skip-plan': ['frame', 'spec', 'implement'], afk: [] },
    phases: [
      frame(),
      doc('spec', { audit: true }),
      doc('plan', { contract: true }),
      build({ review: 'critique' }),
      finish(),
    ],
  }),
  // blueprint is full minus the plan phase: one committed spec carries the whole
  // design, and its `rounds: 2` cap is the fast-convergence premise made a rail.
  blueprint: defineWorkflow({
    name: 'blueprint',
    title: 'Blueprint (frame → spec → implement → ship → PR)',
    attend: ['spec'],
    presets: { afk: [] },
    phases: [frame(), doc('spec', { rounds: 2, contract: true }), build({ review: 'critique' }), finish()],
  }),
  relay: defineWorkflow({
    name: 'relay',
    title: 'Relay (frame → spec → fresh build → judge review-and-fix → PR)',
    attend: ['spec'],
    presets: { afk: [] },
    phases: [frame(), doc('spec', { rounds: 2, contract: true }), build({ review: 'fixer' }), finish()],
  }),
  short: defineWorkflow({
    name: 'short',
    title: 'Short (research → implement → ship → PR)',
    presets: { afk: [] },
    phases: [frame({ name: 'research' }), build({ review: 'writable', audit: true }), finish()],
  }),
} as const;

export const WORKFLOWS = {
  full: compileWorkflow(SHIPPED_WORKFLOW_DEFINITIONS.full),
  blueprint: compileWorkflow(SHIPPED_WORKFLOW_DEFINITIONS.blueprint),
  relay: compileWorkflow(SHIPPED_WORKFLOW_DEFINITIONS.relay),
  short: compileWorkflow(SHIPPED_WORKFLOW_DEFINITIONS.short),
} as const satisfies Record<string, WorkflowSpecInput>;

/** The shipped workflow names — useful for tests/help copy that intentionally enumerate the standard library. */
export type ShippedWorkflowName = keyof typeof WORKFLOWS;

validateRegistry(WORKFLOWS);

export function isShippedWorkflowName(name: string): name is ShippedWorkflowName {
  return Object.hasOwn(WORKFLOWS, name);
}

function workflowNameOf(workflow: WorkflowRef): string {
  return typeof workflow === 'string' ? workflow : workflow.name;
}

export function workflowDefinition(workflow: WorkflowRef): WorkflowSpecInput {
  if (typeof workflow !== 'string') return workflow;
  if (isShippedWorkflowName(workflow)) return WORKFLOWS[workflow];
  throw new Error(
    `workflow "${workflow}" is not in the shipped registry (${Object.keys(WORKFLOWS).join(' · ')}) and no frozen workflow spec was supplied`,
  );
}

/**
 * The served registry view: the input rows with each phase's snippet list
 * derived from its semantics (T7). Built once at load, after validation, so
 * every consumer sees one parsed shape — the input's authoring shape (no hand
 * lists) never leaks past this boundary.
 */
function servePhases(workflow: ShippedWorkflowName): readonly PhaseSpec[] {
  return WORKFLOWS[workflow].phases.map((p): PhaseSpec => ({ ...p, snippets: snippetsForSemantics(p.semantics) }));
}

// An explicit literal (not a fromEntries loop) so the Record type proves
// completeness: a new workflow in WORKFLOWS fails to compile until it is
// served here too.
const SERVED_PHASES: Record<ShippedWorkflowName, readonly PhaseSpec[]> = {
  full: servePhases('full'),
  blueprint: servePhases('blueprint'),
  relay: servePhases('relay'),
  short: servePhases('short'),
};

/** A workflow's ordered phases. */
export function phasesOf(workflow: WorkflowRef): readonly PhaseSpec[] {
  if (typeof workflow === 'string' && isShippedWorkflowName(workflow)) return SERVED_PHASES[workflow];
  return workflowDefinition(workflow).phases.map((p): PhaseSpec => ({ ...p, snippets: snippetsForSemantics(p.semantics) }));
}

/** The consumer-facing stage view — the registry input narrowed to `PhaseName`. */
export interface StageSpec {
  name: StageName;
  phases: readonly PhaseName[];
  duties: { maker: Duty; checker: Duty };
  edges?: Partial<Record<Duty, { from: Duty }>>;
}

/** A workflow's two stages, planning then delivery (the validated partition). */
export function stagesOf(workflow: WorkflowRef): readonly StageSpec[] {
  return workflowDefinition(workflow).stages as readonly StageSpec[];
}

/**
 * The stage a phase belongs to — the one resolver for "which side of the
 * boundary is this turn on", replacing every handoff-index comparison. Throws
 * on a phase the workflow doesn't own (a caller bug, same contract as
 * phaseSpec).
 */
export function stageOf(workflow: WorkflowRef, phase: PhaseName): StageName {
  const stage = stagesOf(workflow).find((s) => s.phases.includes(phase));
  if (!stage) {
    throw new Error(
      `phase "${phase}" is not part of the "${workflowNameOf(workflow)}" workflow (phases: ${phasesOf(workflow).map((p) => p.name).join(', ')})`,
    );
  }
  return stage.name;
}

/** A workflow's stage spec by name — total (validateRegistry pins both stages). */
function stageSpecOf(workflow: WorkflowRef, stage: StageName): StageSpec {
  return stagesOf(workflow).find((s) => s.name === stage)!;
}

/** A stage's two duty voices, maker first — the per-stage worker enumeration. */
export function dutiesOf(workflow: WorkflowRef, stage: StageName): readonly [Duty, Duty] {
  const { maker, checker } = stageSpecOf(workflow, stage).duties;
  return [maker, checker];
}

/** The duty that MAKES in a stage (planning: architect; delivery: builder). */
export function makerDutyOf(workflow: WorkflowRef, stage: StageName): Duty {
  return stageSpecOf(workflow, stage).duties.maker;
}

/** The duty that CHECKS in a stage (planning: analyst; delivery: critic or judge, per the review posture). */
export function checkerDutyOf(workflow: WorkflowRef, stage: StageName): Duty {
  return stageSpecOf(workflow, stage).duties.checker;
}

/**
 * The duty that owns FIXING the build — where the verify self-heal routes a
 * failed assertion, and the addressee of any "send the fix to…" routing. The
 * checker under the fixer posture (relay's judge already fixes with write
 * access; a verify fix is a review finding by another name), the maker
 * everywhere else. A resolver, never prose: briefs, rails, and tool copy all
 * read this, so the routing cannot drift per surface.
 */
export function fixerDutyFor(workflow: WorkflowRef): Duty {
  const build = phasesOf(workflow).find((p) => p.semantics.block === 'build');
  const fixerPosture = build?.semantics.block === 'build' && build.semantics.reviewPosture === 'fixer';
  return fixerPosture ? checkerDutyOf(workflow, 'delivery') : makerDutyOf(workflow, 'delivery');
}

/**
 * The interactive→headless handoff gate — planning's last phase, DERIVED (the
 * old `handoffGate` registry field is deleted; the stage partition is the one
 * source). Approving this gate crosses the stage boundary: continuity edges
 * apply, and an interactively-orchestrated run hands its session to the
 * headless driver.
 */
export function handoffGateOf(workflow: WorkflowRef): GatePhase {
  const planningPhases = stageSpecOf(workflow, 'planning').phases;
  return planningPhases[planningPhases.length - 1]!;
}

/**
 * Approving this phase's gate hands the run to the headless driver — so its gate
 * hint says so, and its brief's advance clause tells the human what they are
 * signing off. The same fact `handoffGateOf` names, asked of one phase.
 */
export function isHandoffPhase(workflow: WorkflowRef, phase: PhaseName): boolean {
  return handoffGateOf(workflow) === phase;
}

/**
 * A committed document precedes this phase. Decides where the acceptance contract
 * seeds from: a doc-loop with an upstream document authors EARLY from it (full's
 * plan, blind to the plan's own tactics); one whose artifact is the only document
 * authors LATE, from its own converged draft (blueprint's and relay's spec).
 */
export function hasUpstreamDoc(workflow: WorkflowRef, phase: PhaseName): boolean {
  const phases = phasesOf(workflow);
  const index = phases.findIndex((p) => p.name === phase);
  return phases.slice(0, index).some((p) => p.semantics?.block === 'doc-loop');
}

/**
 * The planning duty a delivery duty CONTINUES across the stage boundary, or
 * undefined when the duty starts fresh (no edge — relay's whole delivery).
 * The registry half of the session-derivation walk; the binding-dependent
 * degrade (a provider-crossing edge falls back to fresh) happens at manifest
 * freeze, not here.
 */
export function continuityEdgeFor(workflow: WorkflowRef, duty: Duty): Duty | undefined {
  for (const stage of stagesOf(workflow)) {
    const edge = stage.edges?.[duty];
    if (edge) return edge.from;
  }
  return undefined;
}

/** A workflow's entry route, normalized to the optional-specSkipsTo shape. */
export function entryOf(workflow: WorkflowRef): { firstPhase: PhaseName; specSkipsTo?: PhaseName } {
  return workflowDefinition(workflow).entry;
}

/**
 * The watch-hint printed when an interactive run hands off to the headless
 * driver at its handoff gate: "<handoff gate> approved — AFK <next phase>".
 * Derived from the registry so each workflow reads correctly — full: "plan approved
 * — AFK impl"; short: "research approved — AFK implement" — rather than the old
 * hardcoded "plan approved" that mislabeled a short-workflow handoff (Q: no plan exists).
 */
export function handoffWatchLabel(workflow: WorkflowRef): string {
  const phases = phasesOf(workflow);
  const handoff = handoffGateOf(workflow);
  const i = phases.findIndex((p) => p.name === handoff);
  const next = phases[i + 1]?.name ?? 'the next phase';
  return `${handoff} approved — AFK ${next}`;
}

/**
 * The phase immediately before `phase` in its own arc — the predecessor whose
 * gate approval enters `phase`. Registry-derived so a renamed or reordered arc
 * stays correct (full: finish ← implement; short: finish ← implement). Throws if
 * `phase` is the first in its arc (it has no predecessor) — a caller bug.
 */
export function priorPhaseOf(workflow: WorkflowRef, phase: PhaseName): PhaseName {
  const phases = phasesOf(workflow);
  const prior = phases[phases.findIndex((p) => p.name === phase) - 1];
  if (!prior) throw new Error(`phase "${phase}" is first in the "${workflowNameOf(workflow)}" workflow — it has no predecessor`);
  return prior.name;
}

/**
 * A phase's spec within its workflow — the one per-phase lookup, replacing the
 * old global `PHASE[name]` map (which a phase name shared across arcs would have
 * collapsed to a single, arc-arbitrary entry). Throws on an unknown (workflow,
 * phase): a lookup that names a phase the arc doesn't own is a caller bug, and
 * failing loud beats silently resolving a foreign arc's phase.
 */
export function phaseSpec(workflow: WorkflowRef, phase: PhaseName): PhaseSpec {
  const spec = phasesOf(workflow).find((p) => p.name === phase);
  if (!spec) {
    throw new Error(`phase "${phase}" is not part of the "${workflowNameOf(workflow)}" workflow (phases: ${phasesOf(workflow).map((p) => p.name).join(', ')})`);
  }
  return spec;
}

/** A workflow's gate-bearing phase names, in arc order — its `gates_at` vocabulary. */
export function gatePhasesOf(workflow: WorkflowRef): readonly GatePhase[] {
  return workflowDefinition(workflow).phases.map((p) => p.name);
}

/** A workflow's default-pre-authorized gates (the inverse of `forceAttend`). */
export function defaultPreAuthorizedOf(workflow: WorkflowRef): readonly GatePhase[] {
  return workflowDefinition(workflow).defaultPreAuthorized as readonly GatePhase[];
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
export function phaseOfGateState(workflow: WorkflowRef, stateName: string): GatePhase | undefined {
  return workflowDefinition(workflow).phases.find((p) => p.gate.state === stateName)?.name as GatePhase | undefined;
}

/** A gate phase's gate spec — non-null by construction (every phase gates). */
export function gateOf(workflow: WorkflowRef, phase: GatePhase): PhaseSpec['gate'] {
  return phaseSpec(workflow, phase).gate;
}

/**
 * Snippets usable in any phase — cross-cutting helpers the phase-aware
 * `list_snippets` always shows in full alongside the current phase's
 * templates, so the genuinely reusable tools are never behind `all=true`.
 */
export const ANYTIME_SNIPPETS: readonly string[] = [
  'reread-context',
  'recover-context',
  'compact-inflight',
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
 * The walk-away compatibility of a consultant checkpoint — its KIND, the single
 * classification every gateless-narrowing helper derives from. Three kinds:
 *
 * - `generative` — additive and NON-HOLDING (frame): a third analysis folded into
 *   the direction. It can never hold a crossing, so a gateless owner keeps it — a
 *   free upfront perspective at the moment before any code, with no walk-away cost.
 * - `challenge` — a HOLDING bet-audit (specGate / implGate): open-ended judgment
 *   whose `high` can hold a pre-authorized crossing. This is the friction a
 *   walk-away opts out of, so gateless DROPS it.
 * - `backstop` — the HOLDING correctness floor (contract / verify): automated AFK
 *   protection against shipping past a broken target. A gateless owner keeps it.
 *
 * gateless's rule falls out as `kind !== 'challenge'`: gateless drops only the
 * holding bet-audit, keeping the non-holding generative frame and the correctness
 * backstop. This one record is the single source — both `isBackstopCheckpoint`
 * (which `workflowHasConsultantBackstop` reads to tell full from short) and
 * `survivesGateless` (the gateless predicate) derive from it, never from a
 * parallel set.
 */
type CheckpointKind = 'generative' | 'challenge' | 'backstop';
const CHECKPOINT_KIND: Record<ConsultantCheckpoint, CheckpointKind> = {
  frame: 'generative',
  specGate: 'challenge',
  implGate: 'challenge',
  contract: 'backstop',
  verify: 'backstop',
};

/**
 * The RENDER-facing checkpoint kind — the internal `challenge` name (a holding
 * bet-audit) shown to a human as `bet-audit`, the two others verbatim. The one
 * place the internal→display rename lives, so a surface that renders checkpoints
 * (`consultantCheckpointView`) stays taxonomy-free: it never sees `challenge`.
 */
export type CheckpointRenderKind = 'generative' | 'bet-audit' | 'backstop';
const CHECKPOINT_RENDER_KIND: Record<CheckpointKind, CheckpointRenderKind> = {
  generative: 'generative',
  challenge: 'bet-audit',
  backstop: 'backstop',
};

/** A phase's consultant checkpoint projected for display: its mode, its render-facing kind, and whether it's live for this run's knobs. */
export interface ConsultantCheckpointView {
  /** The static checkpoint mode (registry data — never the internal `challenge` alias, which is a kind, not a mode). */
  mode: ConsultantCheckpoint;
  kind: CheckpointRenderKind;
  live: boolean;
}

/** Whether a phase's consultant checkpoint is a correctness backstop (contract / verify). */
export function isBackstopCheckpoint(workflow: WorkflowRef, phase: PhaseName): boolean {
  const mode = phaseSpec(workflow, phase).consultantCheckpoint;
  return mode !== undefined && CHECKPOINT_KIND[mode] === 'backstop';
}

/**
 * Whether a phase's consultant checkpoint SURVIVES a gateless run — everything but
 * the holding bet-audit `challenge`. The generative framing read survives (it is
 * non-holding — pure enrichment of the direction), as does the correctness
 * backstop; only the `challenge` the owner has pre-decided away is dropped. The
 * single gateless gate `consultantCheckpointLive` reads.
 */
function survivesGateless(workflow: WorkflowRef, phase: PhaseName): boolean {
  const mode = phaseSpec(workflow, phase).consultantCheckpoint;
  return mode !== undefined && CHECKPOINT_KIND[mode] !== 'challenge';
}

/**
 * The consultant snippet keys that SURVIVE a gateless run — the gateless narrowing
 * of CONSULTANT_SNIPPETS for the one render path that has no arc to map phases
 * through (the defensive no-workflow flat render). Generative + backstop snippets
 * (everything but the bet-audit `challenge`), derived from CHECKPOINT_KIND so it
 * tracks the registry automatically.
 */
export const GATELESS_CONSULTANT_SNIPPETS: ReadonlySet<string> = new Set(
  (Object.keys(CHECKPOINT_KIND) as ConsultantCheckpoint[])
    .filter((mode) => CHECKPOINT_KIND[mode] !== 'challenge')
    .map((mode) => CONSULTANT_CHECKPOINT_SNIPPET[mode]),
);

/**
 * Whether phase P's consultant checkpoint is LIVE for a run with these knobs — the
 * single gateless gate BOTH the snippet surface (phaseSnippetsFor,
 * consultantSnippetsForWorkflow) and the orchestrator phase briefs derive from, so
 * the two can never disagree about which checkpoints a run fires. Live when a
 * consultant is bound, the phase carries a checkpoint, and EITHER the run is not
 * gateless OR the checkpoint survives gateless (generative or backstop — only the
 * holding `challenge` bet-audit drops). The asymmetry falls out of survivesGateless
 * — a `challenge` phase yields `bound && !gateless`, a generative/backstop phase
 * yields `bound` — so no caller re-implements the split (the divergence the
 * scattered `bindings.consultant && !gateless` checks risked). Default-off
 * preserved: no consultant ⇒ false.
 */
export function consultantCheckpointLive(workflow: WorkflowRef, phase: PhaseName, opts: { consultant: boolean; gateless?: boolean }): boolean {
  if (!opts.consultant) return false;
  if (consultantSnippetFor(workflow, phase) === undefined) return false;
  return !opts.gateless || survivesGateless(workflow, phase);
}

/**
 * A phase's consultant checkpoint projected for a render surface — the single
 * additive reader that folds the module-private `CHECKPOINT_KIND` map (renamed
 * to its render-facing form) and `consultantCheckpointLive` into one call, so a
 * surface never re-encodes the checkpoint taxonomy. Returns `undefined` when the
 * phase carries no checkpoint (the common case); otherwise `{ mode, kind, live }`
 * where `kind` is render-facing (`challenge` → `bet-audit`, mapped here) and
 * `live` is this run's gateless-aware liveness (default-off preserved: no
 * consultant ⇒ live false).
 */
export function consultantCheckpointView(
  workflow: WorkflowRef,
  phase: PhaseName,
  opts: { consultant: boolean; gateless?: boolean },
): ConsultantCheckpointView | undefined {
  const mode = phaseSpec(workflow, phase).consultantCheckpoint;
  if (mode === undefined) return undefined;
  return {
    mode,
    kind: CHECKPOINT_RENDER_KIND[CHECKPOINT_KIND[mode]],
    live: consultantCheckpointLive(workflow, phase, opts),
  };
}

/** Whether a workflow has any backstop checkpoint — full does (contract+verify), short does not. */
export function workflowHasConsultantBackstop(workflow: WorkflowRef): boolean {
  return phasesOf(workflow).some((p) => isBackstopCheckpoint(workflow, p.name));
}

/**
 * The consultant snippets a WORKFLOW's checkpoints actually reach — full's
 * {frame, spec, contract, verify} snippets; short's {frame, impl}. The flat
 * `all=true` renderer filters the consultant bucket against this so a bound run's
 * library exposes only the snippets ITS arc can use: a bound short run never sees
 * `consultant-contract`/`consultant-verify` (nor the Full-only `consultant-spec`)
 * — the contract feature does not leak into the arc that deferred it, and the
 * surface stays per-arc honest, not merely "any consultant snippet". A GATELESS
 * run narrows it further to the backstop, so its bet-level snippets never show —
 * derived, like the briefs, through consultantCheckpointLive.
 */
export function consultantSnippetsForWorkflow(workflow: WorkflowRef, opts: { gateless?: boolean } = {}): ReadonlySet<string> {
  return new Set(
    phasesOf(workflow)
      .filter((p) => consultantCheckpointLive(workflow, p.name, { consultant: true, gateless: opts.gateless }))
      .map((p) => consultantSnippetFor(workflow, p.name)!),
  );
}

/**
 * A phase's snippets ENABLED for this run — the always-on base list, plus the
 * phase's consultant checkpoint snippet appended (last, preserving today's bound
 * order) only when its checkpoint is live for this run. The single source
 * list_snippets reads, so "what the orchestrator may reach for" is base ∪
 * (checkpoint iff live) on every render path: an unbound run sees byte-for-byte
 * the base list, a bound run sees the checkpoint snippet in its owning phase, and
 * a gateless run sees only its gateless-surviving checkpoints — the generative
 * frame and the correctness backstop, never the bet-audit (consultantCheckpointLive).
 */
export function phaseSnippetsFor(workflow: WorkflowRef, phase: PhaseName, opts: { consultant: boolean; gateless?: boolean }): readonly string[] {
  const spec = phaseSpec(workflow, phase);
  const checkpoint = consultantSnippetFor(workflow, phase);
  return consultantCheckpointLive(workflow, phase, opts) && checkpoint
    ? [...spec.snippets, checkpoint]
    : spec.snippets;
}

/**
 * The consultant snippet a phase's checkpoint runs with, or undefined when the
 * phase carries no checkpoint — the single source the orchestrator-brief
 * injection reads, so the phase→snippet mapping is never duplicated in prompts.
 */
export function consultantSnippetFor(workflow: WorkflowRef, phase: PhaseName): string | undefined {
  const mode = phaseSpec(workflow, phase).consultantCheckpoint;
  return mode ? CONSULTANT_CHECKPOINT_SNIPPET[mode] : undefined;
}

/**
 * The phase in a workflow whose consultant checkpoint AUTHORS the acceptance
 * contract (`contract` mode) — full's `plan`, blueprint's and relay's `spec`;
 * `undefined` for a workflow with no contract loop (short). The freeze step reads
 * this to recognize "this gate is the contract's freeze gate", so the gate→freeze
 * coupling stays registry-derived (never a hardcoded `=== 'plan'`), and a workflow
 * that authors no contract freezes none. Derived, since exactly one phase carries
 * the mode (or none).
 */
export function contractAuthorPhaseOf(workflow: WorkflowRef): PhaseName | undefined {
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
