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
 *   blueprint: frame → Direction → design → Design (walk away) → implement
 *           (AFK; build → review → reconcile docs) → Ship → finish (open the PR)
 *           → Open-PR → done — one committed design doc replaces spec + plan
 *   short:    research → Direction (walk away) → implement (AFK; build → review →
 *           reconcile docs) → Ship → finish (open the PR) → Open-PR → done
 *
 * The arcs share the `implement` and `finish` phase names — legal because phase
 * identity is workflow-scoped (see below); their specs still differ per arc.
 */

import { basename, dirname, extname } from 'node:path';
import { build, compileWorkflow, defineWorkflow, doc, finish, frame, installWorkflowCompilerRegistry } from './define.ts';

/**
 * A consultant checkpoint mode — the posture the optional consultant takes at a
 * phase, named by lineage, not by phase. The modes:
 *
 * - `frame` — the generative third-analysis mode (framing).
 * - `specGate` — the critical bet-audit mode just before the Commit-spec gate.
 * - `implGate` — the open-ended bet-audit mode at the impl-side gate. short's
 *   `implement` uses it (it has no plan phase, so it authors no contract).
 * - `contract` — the generative-and-writing mode: the consultant AUTHORS the
 *   acceptance contract (full's `plan`; blueprint's and relay's `design`), blind to the plan and code.
 * - `verify` — the evidence-grounded verification mode: a fresh session VERIFIES
 *   the frozen acceptance contract (the verify-carrying `implement` phases), supplanting the open-ended
 *   `implGate` audit there.
 *
 * Each workflow maps the modes onto its own phases (full: frame/specGate/contract/
 * verify; short: frame/implGate — no spec or plan phase, so no contract loop). The
 * `contract`/`verify` pair is the acceptance-contract feature; `implGate` is
 * NOT globally re-pointed (short still audits the bet with no contract to verify).
 * Registry data, so "where the consultant fires" stays in the single source.
 */
export type ConsultantCheckpoint = 'frame' | 'specGate' | 'implGate' | 'contract' | 'verify';

/**
 * The workflow vocabulary (docs/specs/2026-07-03-workflow-vocabulary.md): each
 * phase row names WHICH BLOCK it is and the knob values that configure it, as
 * one grouped sub-object — never scattered booleans. The vocabulary is CLOSED:
 * a knob value exists only when duet ships hand-written prompt support for it
 * and a shipped arc exercises it, so these unions grow only with a shipping
 * arc (relay adds `fixer`/`fresh-seed` with its own commit). The grouping is
 * the clean compile target for a deferred external-arc compiler; values below
 * are set to reproduce the current arcs exactly.
 *
 * What deliberately does NOT live here: the verify checkpoint and the
 * contract-author placement (both already registry data via
 * `consultantCheckpoint` — a second copy could disagree), and the round cap
 * (a plain row field).
 */

/** The lane that owns a finishing tail (the build tail or the PR phase). */
export type TailOwner = 'maker' | 'checker';

/** The doc-loop's artifact — sets the review lens and the snippet family. */
export type ArtifactKind = 'spec' | 'plan' | 'design';

/**
 * How the build phase enters: full compacts the planning session down to the
 * committed spec + plan (`compact-for-impl`), the blueprint arc re-anchors on its
 * one committed doc (`implement-design`), short builds directly from the
 * research decisions (`implement-direct`), and relay seeds a FRESH builder
 * session from the committed design doc (`fresh-seed` — the provider-switched
 * builder never held the planning context, so there is nothing to compact;
 * the doc is the whole re-anchor).
 */
export type EntrySeed = 'compact-for-impl' | 'implement-design' | 'implement-direct' | 'fresh-seed';

/**
 * The build's review posture — the vocabulary's load-bearing axis: `critique`
 * (the critic critiques, the builder fixes — the reflect-then-round-2 loop),
 * `writable` (one round, the builder applies fixes in place), `fixer`
 * (relay: the judge applies fixes directly with write access and owns the
 * finishing tails; substance escalates to the human rather than being
 * patched over).
 */
export type ReviewPosture = 'critique' | 'writable' | 'fixer';

/** The worked-example set a phase's brief appends — per-workflow data, keyed not inlined. */
export type ExamplesKey = 'frame' | 'research' | 'spec' | 'plan' | 'design' | 'impl' | 'blueprint-impl' | 'short-impl' | 'relay-impl';

/**
 * The model-read brief worlds the prose layer actually ships. The registry
 * declares the closed set without importing the prose maps (trust gradient:
 * registry imports nothing); `validateRegistry` checks every phase against this
 * at load, and `orchestrator/briefs.ts` type-checks its data records against the
 * same declaration. A missing world is therefore a load-time workflow error,
 * not a mid-run render throw.
 */
export const BRIEF_WORLDS = {
  frame: ['frame', 'research'],
  docLoop: {
    spec: ['spec'],
    plan: ['plan'],
    design: ['design'],
  },
  build: {
    critique: ['impl', 'blueprint-impl'],
    writable: ['short-impl'],
    fixer: ['relay-impl'],
  },
} as const satisfies {
  frame: readonly ExamplesKey[];
  docLoop: Record<ArtifactKind, readonly ExamplesKey[]>;
  build: Record<ReviewPosture, readonly ExamplesKey[]>;
};

export type FrameBriefWorld = (typeof BRIEF_WORLDS.frame)[number];
export type DocLoopBriefArtifact = keyof typeof BRIEF_WORLDS.docLoop;
export type CritiqueBuildBriefWorld = (typeof BRIEF_WORLDS.build.critique)[number];
export type WritableBuildBriefWorld = (typeof BRIEF_WORLDS.build.writable)[number];
export type FixerBuildBriefWorld = (typeof BRIEF_WORLDS.build.fixer)[number];

/** A phase's block identity + knob values (discriminated on `block`). */
export type PhaseSemantics =
  | { readonly block: 'frame'; readonly examplesKey: 'frame' | 'research' }
  | { readonly block: 'doc-loop'; readonly artifactKind: ArtifactKind; readonly examplesKey: ExamplesKey }
  | {
      readonly block: 'build';
      readonly entrySeed: EntrySeed;
      readonly reviewPosture: ReviewPosture;
      readonly midpoint: 'judgment' | 'none';
      /**
       * Whether the Ship packet leads with the CEO summary (`ceo-summary`) or
       * stays lean (short's deliberate choice — the human reads what shipped, the
       * docs, and the review outcome). The knob T7 predicted: the snippet
       * derivation forces the full/blueprint-vs-short difference to be explicit.
       */
      readonly shipPacket: 'ceo-summary' | 'lean';
      /** Who runs the build tail (reconcile-docs + ceo-summary — inside implement, strictly before verify). */
      readonly buildTailOwner: TailOwner;
      readonly examplesKey: ExamplesKey;
    }
  | { readonly block: 'finish'; readonly finishOwner: TailOwner };

/**
 * The block ↔ snippet attachment maps (T7: blocks own their snippets). Each
 * semantic element carries its snippet family as EXPLICIT DATA — never parsed
 * from a naming convention, because the library predates the convention
 * (plan's draft snippet is `start-plan`, not `write-plan`). A phase's base
 * snippet list is the union of what its semantics contribute
 * (`snippetsForSemantics`), in canonical order; the per-row hand lists are
 * gone, and the parity pins prove the derived lists byte-identical to them.
 *
 * These maps are also what CLOSES the vocabulary structurally: the knob types
 * are checked against them at load (validateRegistry), so "a knob value ships
 * its prompt support" is a load failure, not prose. A new knob value lands as
 * one entry here plus its snippets in the owning snippets/ file.
 */
const FRAME_SNIPPETS: readonly string[] = ['think-holistic', 'compare-notes'];

/** Each doc-loop artifact's draft / review / update (-again) family. */
const ARTIFACT_SNIPPETS: Record<ArtifactKind, readonly string[]> = {
  spec: ['write-spec', 'review-spec', 'update-spec', 'review-spec-again', 'update-spec-again'],
  plan: ['start-plan', 'review-plan', 'update-plan', 'review-plan-again', 'update-plan-again'],
  design: ['write-design', 'review-design', 'update-design', 'review-design-again', 'update-design-again'],
};

/**
 * What each entry seed brings to the build's front: the persistent-session
 * arcs enter through the design→implementation boundary compaction
 * (compact-for-impl), and the blueprint arc adds its doc seed on top —
 * implement-design re-anchors the build on the ONE committed doc, NOT short's
 * implement-direct (that body assumes no design artifact exists). short enters
 * directly from the research decisions, no compaction ceremony.
 */
const ENTRY_SEED_SNIPPETS: Record<EntrySeed, readonly string[]> = {
  'compact-for-impl': ['compact-for-impl'],
  'implement-design': ['compact-for-impl', 'implement-design'],
  'implement-direct': ['implement-direct'],
  // The fresh builder seeds from the committed doc alone — implement-design's
  // body is cold-safe (it anchors on the doc and the vendored lessons, never
  // on prior session context), and there is no planning session to compact.
  'fresh-seed': ['implement-design'],
};

const MIDPOINT_SNIPPETS: readonly string[] = ['midpoint-status', 'review-midpoint', 'respond-midpoint'];

/**
 * Each review posture's loop family. The critique loop opens with the
 * build→review boundary compaction (compact-for-review) — the multi-round
 * reflect-then-round-2 discipline reviews a long persistent build, and the
 * boundary compaction is its entry ritual; the writable one-round arc
 * deliberately drops that ceremony along with the -again rounds.
 */
const REVIEW_POSTURE_SNIPPETS: Record<ReviewPosture, readonly string[]> = {
  critique: [
    'compact-for-review',
    'implementation-handoff',
    'review-implementation',
    'respond-review',
    'review-implementation-again',
    'respond-review-again',
  ],
  writable: ['handoff-direct', 'review-direct', 'apply-review'],
  // The handoff stays with the BUILDER — whoever wrote the code authors the
  // map — and review-and-fix is the fixer's one writable round. No boundary
  // compaction: the fixer's session is born fresh at the handoff.
  fixer: ['implementation-handoff', 'review-and-fix'],
};

const FINISH_SNIPPETS: readonly string[] = ['pr-description', 'compact-for-cleanup'];

/**
 * A phase's base snippet list, derived from its semantics — the union of what
 * each semantic element contributes, in canonical order (build: entry seed →
 * midpoint → review posture → tail). These are the run's ALWAYS-ON templates;
 * the consultant checkpoint snippet is deliberately NOT part of the
 * derivation — it is separate registry data (consultantCheckpoint) folded in
 * per-run by phaseSnippetsFor only when a consultant is bound, so
 * list_snippets never exposes it on an unbound run (the default-off
 * byte-for-byte invariant).
 *
 * In the build tail, reconcile-docs is universal — docs reconcile as the LAST
 * build step (before the consultant verify, which stays last) so the Ship
 * gate reviews code + docs together and `finish` stays a mechanical PR open —
 * and ceo-summary rides only a `ceo-summary` ship packet.
 */
function snippetsForSemantics(s: PhaseSemantics): readonly string[] {
  switch (s.block) {
    case 'frame':
      return FRAME_SNIPPETS;
    case 'doc-loop':
      return ARTIFACT_SNIPPETS[s.artifactKind];
    case 'build':
      return [
        ...ENTRY_SEED_SNIPPETS[s.entrySeed],
        ...(s.midpoint === 'judgment' ? MIDPOINT_SNIPPETS : []),
        ...REVIEW_POSTURE_SNIPPETS[s.reviewPosture],
        'reconcile-docs',
        ...(s.shipPacket === 'ceo-summary' ? ['ceo-summary'] : []),
      ];
    case 'finish':
      return FINISH_SNIPPETS;
  }
}

/**
 * The stage vocabulary (CONTEXT.md: Workflow structure). A workflow's phases
 * PARTITION into exactly two stages — `planning` (the attended thinking
 * stretch: the entry phase through the last phase before the build) and
 * `delivery` (the AFK stretch: implement + finish). A stage is one holistic
 * thinking flow: one primary model carries it end to end, and duty bindings
 * are scoped to it. The interactive→headless handoff and the approval-boundary
 * semantics live at the stage edge (`handoffGateOf` derives as planning's last
 * phase — the old `handoffGate` field is deleted; one source).
 */
export type StageName = 'planning' | 'delivery';

/**
 * The duty vocabulary — a worker's identity within a stage, CLOSED and
 * globally stage-unique (a duty alone names its stage, the invariant the bare
 * `--bind <duty>=…` grammar rests on; enforced by validateRegistry, never
 * assumed). Planning has `architect` (makes) and `analyst` (checks); delivery
 * has `builder` (makes) and `critic` or `judge` (checks — which one is the
 * workflow's review-posture knob: a fixer-posture build is judged, the others
 * critiqued). The vocabulary grows only with a shipping workflow.
 */
export type Duty = 'architect' | 'analyst' | 'builder' | 'critic' | 'judge';

/**
 * Each duty's fixed place in the vocabulary — the stage it names and the lane
 * it fills. The single source for stage-uniqueness (validateRegistry checks
 * every authored stage against it) and for `stageOfDuty`, the resolver the
 * bare-duty CLI grammar reads.
 */
const DUTY_INFO: Record<Duty, { stage: StageName; lane: 'maker' | 'checker' }> = {
  architect: { stage: 'planning', lane: 'maker' },
  analyst: { stage: 'planning', lane: 'checker' },
  builder: { stage: 'delivery', lane: 'maker' },
  critic: { stage: 'delivery', lane: 'checker' },
  judge: { stage: 'delivery', lane: 'checker' },
};

/** The closed duty vocabulary, in table order — for surfaces that enumerate it without a run in hand. */
export const DUTIES = Object.keys(DUTY_INFO) as readonly Duty[];

/** The stage a duty names — total, from the closed vocabulary's own table. */
export function stageOfDuty(duty: Duty): StageName {
  return DUTY_INFO[duty].stage;
}

/** The lane a duty fills — makers (architect, builder) make; checkers (analyst, critic, judge) check. */
export function stageOfDutyLane(duty: Duty): 'maker' | 'checker' {
  return DUTY_INFO[duty].lane;
}

/**
 * A stage as written in the registry: its ordered phase slice, its two duty
 * voices (exactly two per stage — the old two-worker legibility, restated per
 * stage), and its continuity edges.
 *
 * `edges` (delivery-side only) declare that a delivery duty CONTINUES a
 * planning duty's session across the stage boundary — `builder: { from:
 * 'architect' }` means the builder's first delivery turn resumes the
 * architect's session. No edge ⇒ the duty starts fresh (relay's whole
 * delivery — the criss-cross's point). The seed RITUAL an edge carries is not
 * duplicated here: the maker lane's ritual is the build phase's `entrySeed`
 * knob (one source — validateRegistry holds the two coherent), and the
 * checker lane continues directly. An edge whose two duties' FROZEN bindings
 * cross providers degrades to fresh at manifest freeze — a binding concern,
 * checked there, never here (the registry cannot see bindings).
 */
export interface StageSpecInput {
  readonly name: StageName;
  /** The stage's ordered phase slice; the stages together partition the workflow's phases. */
  readonly phases: readonly string[];
  readonly duties: { readonly maker: Duty; readonly checker: Duty };
  readonly edges?: Partial<Record<Duty, { readonly from: Duty }>>;
}

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
  /**
   * The phase's block identity + knob values (the workflow vocabulary). The
   * phase's snippet list is DERIVED from this (snippetsForSemantics) — rows
   * carry no hand list.
   */
  readonly semantics: PhaseSemantics;
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
   * The workflow's stages — planning then delivery, partitioning `phases` in
   * order (validateRegistry enforces the partition). Duties, continuity edges,
   * and the derived handoff gate (`handoffGateOf` = planning's last phase) all
   * live here.
   */
  readonly stages: readonly StageSpecInput[];
  /**
   * The entry route: the phase a snapshot-less run starts in (`firstPhase`),
   * and — for arcs that admit a draft-spec entry — the phase a `--spec` run
   * skips to (`specSkipsTo`).
   */
  readonly entry: { readonly firstPhase: string; readonly specSkipsTo?: string };
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

installWorkflowCompilerRegistry({ briefWorlds: BRIEF_WORLDS, validateWorkflowSpec: validatedWorkflowSpec });

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
  blueprint: defineWorkflow({
    name: 'blueprint',
    title: 'Blueprint (frame → design doc → implement → ship → PR)',
    attend: ['design'],
    presets: { afk: [] },
    phases: [frame(), doc('design', { contract: true }), build({ review: 'critique' }), finish()],
  }),
  relay: defineWorkflow({
    name: 'relay',
    title: 'Relay (frame → design doc → fresh build → judge review-and-fix → PR)',
    attend: ['design'],
    presets: { afk: [] },
    phases: [frame(), doc('design', { contract: true }), build({ review: 'fixer' }), finish()],
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

/** A workflow's identity is boundary-validated, not a closed vocabulary. */
export type WorkflowName = string;

/** A phase name is workflow-scoped and boundary-validated against the run's workflow. */
export type PhaseName = string;

/**
 * Phases that end at a human gate. Every phase in every arc gates (the registry
 * makes `gate` non-nullable), so this is exactly `PhaseName` — kept as a named
 * alias because it reads as intent at the call sites (`gatesAt: GatePhase[]`).
 */
export type GatePhase = PhaseName;

declare const compiledWorkflowBrand: unique symbol;

export type CompiledWorkflow = WorkflowSpecInput & {
  readonly [compiledWorkflowBrand]: true;
};

export type WorkflowSpec = CompiledWorkflow;
export type WorkflowRef = WorkflowName | WorkflowSpec;

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

export function validatedWorkflowSpec(workflow: WorkflowSpecInput): CompiledWorkflow {
  validateRegistry({ [workflow.name]: workflow });
  return workflow as CompiledWorkflow;
}

/** The consumer-facing phase view — the registry input narrowed to `PhaseName`. */
export interface PhaseSpec {
  name: PhaseName;
  /** The phase's block identity + knob values (the workflow vocabulary). */
  semantics: PhaseSemantics;
  /**
   * The snippet keys this phase's work draws on, in the order the orchestrator
   * typically reaches for them — DERIVED from the semantics at load
   * (snippetsForSemantics), never hand-listed per row. The phase-aware
   * `list_snippets` shows these in full while indexing other phases by key —
   * cross-cutting helpers live in `ANYTIME_SNIPPETS`, deliberately-archived
   * snippets in `UNLISTED_SNIPPETS`, and the completeness test
   * (`tests/snippets.test.ts`) asserts every library snippet is classified, so
   * none goes silently invisible in the default view.
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
   * mechanics) may legitimately advance without a review round.
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
  for (const [wfName, wf] of Object.entries(workflows)) {
    const phaseNames = new Set<string>();
    const gateStates = new Set<string>();
    for (const p of wf.phases) {
      if (phaseNames.has(p.name)) {
        throw new Error(
          `registry: workflow "${wfName}" has two phases named "${p.name}" — phase names must be unique WITHIN a workflow so phaseSpec(workflow, …) is total. (Across workflows a shared name is legal and intended: both arcs name their build phase "implement" and their finish phase "finish".)`,
        );
      }
      phaseNames.add(p.name);
      if (gateStates.has(p.gate.state)) {
        throw new Error(
          `registry: workflow "${wfName}" has two gates with state "${p.gate.state}" — gate-state names must be unique within a workflow so phaseOfGateState is total`,
        );
      }
      gateStates.add(p.gate.state);
      // Vocabulary coherence — the semantics grouping must agree with the row
      // facts it sits beside, or a composition could describe one world and run
      // another. Two structural rules:
      //
      // 1. reviewLoop ⇔ the block HAS a review loop (doc-loop and build do;
      //    frame and finish don't) — the advance rail reads reviewLoop, the
      //    briefs read the block, and they must never disagree.
      if (p.semantics === undefined) {
        throw new Error(
          `registry: workflow "${wfName}" phase "${p.name}" has no semantics — every phase names its block and knob values (the workflow vocabulary)`,
        );
      }
      const loopBlock = p.semantics.block === 'doc-loop' || p.semantics.block === 'build';
      if (loopBlock !== p.reviewLoop) {
        throw new Error(
          `registry: workflow "${wfName}" phase "${p.name}" has reviewLoop ${p.reviewLoop} but block "${p.semantics.block}" — doc-loop and build phases are review loops, frame and finish phases are not`,
        );
      }
      // 2. A consultant checkpoint fires from the block that hosts it: the
      //    generative frame read at a frame block, the spec bet-audit and the
      //    contract author at a doc-loop, the impl bet-audit and the contract
      //    verify at a build. A checkpoint on a foreign block would brief a
      //    consultant about work the phase doesn't do.
      if (p.consultantCheckpoint !== undefined) {
        const hostBlocks: Record<ConsultantCheckpoint, PhaseSemantics['block']> = {
          frame: 'frame',
          specGate: 'doc-loop',
          contract: 'doc-loop',
          implGate: 'build',
          verify: 'build',
        };
        const host = hostBlocks[p.consultantCheckpoint];
        if (p.semantics.block !== host) {
          throw new Error(
            `registry: workflow "${wfName}" phase "${p.name}" carries consultant checkpoint "${p.consultantCheckpoint}" but is a "${p.semantics.block}" block — that checkpoint fires from a "${host}" block`,
          );
        }
      }
      // 3. The closed vocabulary, structurally: every knob value a row uses
      //    must have its snippet family in the attachment maps — "a knob value
      //    ships its prompt support" as a load failure, not prose. (TypeScript
      //    enforces this for the literal registry; this is the same rule for
      //    any registry that arrives as data.)
      if (p.semantics.block === 'doc-loop' && ARTIFACT_SNIPPETS[p.semantics.artifactKind] === undefined) {
        throw new Error(
          `registry: workflow "${wfName}" phase "${p.name}" uses artifactKind "${p.semantics.artifactKind}", which ships no snippet family — a knob value exists only with its prompt support (ARTIFACT_SNIPPETS)`,
        );
      }
      if (p.semantics.block === 'build') {
        if (ENTRY_SEED_SNIPPETS[p.semantics.entrySeed] === undefined) {
          throw new Error(
            `registry: workflow "${wfName}" phase "${p.name}" uses entrySeed "${p.semantics.entrySeed}", which ships no snippet family — a knob value exists only with its prompt support (ENTRY_SEED_SNIPPETS)`,
          );
        }
        if (REVIEW_POSTURE_SNIPPETS[p.semantics.reviewPosture] === undefined) {
          throw new Error(
            `registry: workflow "${wfName}" phase "${p.name}" uses reviewPosture "${p.semantics.reviewPosture}", which ships no snippet family — a knob value exists only with its prompt support (REVIEW_POSTURE_SNIPPETS)`,
          );
        }
      }
      // 4. The prose world must exist for the block/posture shape. The snippet
      //    maps prove executable templates exist; BRIEF_WORLDS proves the
      //    model-read phase brief can render one dedicated world for the same
      //    composition. This closes the old render-time gap in buildPhaseBrief.
      if (p.semantics.block === 'frame') {
        if (!(BRIEF_WORLDS.frame as readonly string[]).includes(p.semantics.examplesKey)) {
          throw new Error(
            `registry: workflow "${wfName}" phase "${p.name}" selects frame examplesKey "${p.semantics.examplesKey}", but no frame brief world is declared for it — valid frame worlds: ${BRIEF_WORLDS.frame.join(', ')}. Add the prose world to BRIEF_WORLDS and src/orchestrator/briefs.ts, or choose one of the valid worlds.`,
          );
        }
      }
      if (p.semantics.block === 'doc-loop') {
        const worlds = (BRIEF_WORLDS.docLoop as Record<string, readonly string[]>)[p.semantics.artifactKind];
        if (!worlds?.includes(p.semantics.examplesKey)) {
          throw new Error(
            `registry: workflow "${wfName}" phase "${p.name}" is a "${p.semantics.artifactKind}" doc-loop with examplesKey "${p.semantics.examplesKey}", but no doc-loop brief world is declared for that pair — valid ${p.semantics.artifactKind} worlds: ${worlds?.join(', ') ?? 'none'}. Add the prose world to BRIEF_WORLDS and src/orchestrator/briefs.ts, or choose a declared artifact/world pair.`,
          );
        }
      }
      if (p.semantics.block === 'build') {
        const worlds = (BRIEF_WORLDS.build as Record<string, readonly string[]>)[p.semantics.reviewPosture];
        if (!worlds?.includes(p.semantics.examplesKey)) {
          throw new Error(
            `registry: workflow "${wfName}" phase "${p.name}" is a "${p.semantics.reviewPosture}" build with examplesKey "${p.semantics.examplesKey}", but no ${p.semantics.reviewPosture} build brief world is declared for it — valid ${p.semantics.reviewPosture} build worlds: ${worlds?.join(', ') ?? 'none'}. Add the prose world to BRIEF_WORLDS and src/orchestrator/briefs.ts, or choose a declared build world.`,
          );
        }
      }
    }
    // The acceptance contract is one chain — author → freeze → verify — so a
    // workflow declares BOTH ends or NEITHER: a verify with no author has
    // nothing to check (its brief would render a skip forever), an author with
    // no verify freezes a target nothing ever checks. The verify brief's
    // gate-name derivation (contractAuthorPhaseOf) leans on this pairing.
    const checkpointModes = new Set(wf.phases.map((p) => p.consultantCheckpoint).filter((m) => m !== undefined));
    if (checkpointModes.has('verify') !== checkpointModes.has('contract')) {
      throw new Error(
        `registry: workflow "${wfName}" declares a "${checkpointModes.has('verify') ? 'verify' : 'contract'}" consultant checkpoint without its "${checkpointModes.has('verify') ? 'contract' : 'verify'}" counterpart — the acceptance contract is author → freeze → verify as one chain; a workflow carries both or neither`,
      );
    }
    // The stage topology — the invariants the duty-keyed runtime rests on,
    // checked as TOPOLOGY ONLY (the registry cannot see bindings; the
    // binding-dependent check — the provider-crossing edge degrade — runs at
    // manifest freeze, the one place all binding sources are resolved).
    if (wf.stages.length !== 2 || wf.stages[0]?.name !== 'planning' || wf.stages[1]?.name !== 'delivery') {
      throw new Error(
        `registry: workflow "${wfName}" must have exactly the two stages "planning" then "delivery" (got: ${wf.stages.map((s) => s.name).join(', ') || 'none'}) — every workflow splits into the attended thinking stretch and the AFK delivery`,
      );
    }
    const [planning, delivery] = [wf.stages[0], wf.stages[1]];
    for (const stage of wf.stages) {
      if (stage.phases.length === 0) {
        throw new Error(
          `registry: workflow "${wfName}" stage "${stage.name}" has no phases — each stage carries at least one (a workflow with no document still has a planning stage: its research/frame phase alone)`,
        );
      }
    }
    const stagePhases = wf.stages.flatMap((s) => s.phases);
    const arcPhases = wf.phases.map((p) => p.name);
    if (stagePhases.length !== arcPhases.length || stagePhases.some((p, i) => p !== arcPhases[i])) {
      throw new Error(
        `registry: workflow "${wfName}" stages [${stagePhases.join(', ')}] do not partition its phases [${arcPhases.join(', ')}] in order — every phase belongs to exactly one stage, planning first`,
      );
    }
    // Duties: in the vocabulary, in their own stage, in their own lane —
    // global stage-uniqueness is what the bare `--bind <duty>=…` grammar
    // rests on, so it is enforced here, never assumed.
    for (const stage of wf.stages) {
      for (const lane of ['maker', 'checker'] as const) {
        const duty = stage.duties[lane];
        const info = DUTY_INFO[duty] as (typeof DUTY_INFO)[Duty] | undefined;
        if (!info) {
          throw new Error(
            `registry: workflow "${wfName}" stage "${stage.name}" ${lane} duty "${duty}" is not in the duty vocabulary (${Object.keys(DUTY_INFO).join(', ')}) — the vocabulary is closed and grows only with a shipping workflow`,
          );
        }
        if (info.stage !== stage.name) {
          throw new Error(
            `registry: workflow "${wfName}" stage "${stage.name}" names "${duty}" as its ${lane} — "${duty}" is a ${info.stage} duty, and duties are globally stage-unique so a duty alone names its stage`,
          );
        }
        if (info.lane !== lane) {
          throw new Error(
            `registry: workflow "${wfName}" stage "${stage.name}" puts "${duty}" in the ${lane} slot — "${duty}" is a ${info.lane} duty`,
          );
        }
      }
    }
    // The delivery checker is named by the build's review posture: a fixer
    // build is JUDGED (the checker fixes and owns tails), the others are
    // CRITIQUED. Authored explicitly for registry legibility, held coherent
    // here so the address and the posture can never describe different worlds.
    const buildPhase = wf.phases.find((p) => p.semantics?.block === 'build');
    if (buildPhase && buildPhase.semantics.block === 'build' && delivery.phases.includes(buildPhase.name)) {
      const expectedChecker = buildPhase.semantics.reviewPosture === 'fixer' ? 'judge' : 'critic';
      if (delivery.duties.checker !== expectedChecker) {
        throw new Error(
          `registry: workflow "${wfName}" delivery checker is "${delivery.duties.checker}" but the build's review posture "${buildPhase.semantics.reviewPosture}" names the checker "${expectedChecker}" — the checker duty and the posture are one fact`,
        );
      }
      // Maker-edge ⇔ entry-seed coherence: fresh-seed means the maker is born
      // fresh at the boundary (no session to continue); every other seed
      // carries the planning session forward, so the edge must say so too.
      const hasMakerEdge = delivery.edges?.[delivery.duties.maker] !== undefined;
      if (buildPhase.semantics.entrySeed === 'fresh-seed' && hasMakerEdge) {
        throw new Error(
          `registry: workflow "${wfName}" declares a continuity edge into its delivery maker "${delivery.duties.maker}" but the build's entrySeed is "fresh-seed" — a fresh-seeded maker has no planning session to continue; drop the edge or change the seed`,
        );
      }
      if (buildPhase.semantics.entrySeed !== 'fresh-seed' && !hasMakerEdge) {
        throw new Error(
          `registry: workflow "${wfName}" build entrySeed "${buildPhase.semantics.entrySeed}" carries the planning session across the boundary but no continuity edge into "${delivery.duties.maker}" is declared — declare the edge or seed fresh`,
        );
      }
    }
    // Edges run planning → delivery only, lane to lane.
    if (planning.edges && Object.keys(planning.edges).length > 0) {
      throw new Error(
        `registry: workflow "${wfName}" declares continuity edges on its planning stage — edges run planning→delivery only (a delivery duty continues a planning session, never the reverse)`,
      );
    }
    for (const [into, edge] of Object.entries(delivery.edges ?? {})) {
      if (edge === undefined) continue;
      if (into !== delivery.duties.maker && into !== delivery.duties.checker) {
        throw new Error(
          `registry: workflow "${wfName}" declares a continuity edge into "${into}", which is not a delivery duty of this workflow (${delivery.duties.maker}, ${delivery.duties.checker})`,
        );
      }
      if (edge.from !== planning.duties.maker && edge.from !== planning.duties.checker) {
        throw new Error(
          `registry: workflow "${wfName}" continuity edge ${into} ← ${edge.from}: "${edge.from}" is not a planning duty of this workflow (${planning.duties.maker}, ${planning.duties.checker})`,
        );
      }
      if (DUTY_INFO[into as Duty].lane !== DUTY_INFO[edge.from].lane) {
        throw new Error(
          `registry: workflow "${wfName}" continuity edge ${into} ← ${edge.from} crosses lanes — a maker continues a maker's session, a checker a checker's`,
        );
      }
    }
    const gatePhases = new Set(wf.phases.map((p) => p.name));
    const requireGatePhase = (value: string, what: string): void => {
      if (!gatePhases.has(value)) {
        throw new Error(
          `registry: workflow "${wfName}" ${what} "${value}" is not a gate phase of this workflow (gate phases: ${[...gatePhases].join(', ') || 'none'})`,
        );
      }
    };
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
 * contract (`contract` mode) — Full's `plan`; `undefined` for an arc with no
 * contract loop (short). The freeze step reads this to recognize "this gate is the
 * contract's freeze gate", so the gate→freeze coupling stays registry-derived
 * (never a hardcoded `=== 'plan'`), and an arc that authors no contract freezes
 * none. Derived, since exactly one phase carries the mode (or none).
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
