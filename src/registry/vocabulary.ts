/**
 * Workflow vocabulary and validation — the leaf registry module shared by the
 * SDK compiler and the shipped workflow registry. It imports nothing from higher
 * layers and owns the closed block/duty vocabulary plus load-time validation.
 */

/**
 * A consultant checkpoint mode — the posture the optional consultant takes at a
 * phase, named by lineage, not by phase. The modes:
 *
 * - `frame` — the generative third-analysis mode (framing).
 * - `specGate` — the critical bet-audit mode just before the Commit-spec gate.
 * - `implGate` — the open-ended bet-audit mode at the impl-side gate. short's
 *   `implement` uses it (it has no plan phase, so it authors no contract).
 * - `contract` — the generative-and-writing mode: the consultant AUTHORS the
 *   acceptance contract (full's `plan`; blueprint's and relay's `spec`), blind to the code.
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

/**
 * The doc-loop's artifact — sets the review lens and the snippet family. A
 * workflow's docs are ordered: the FIRST is always the `spec` (half-technical:
 * the product tier plus the module shape, seams, and test standards), and any
 * later doc is a `plan` (the tactics the spec deferred — slices, cases,
 * fixtures, sequencing). A workflow with no plan phase hands the spec straight
 * to the build; that is topology, not a third artifact (the retired `design`
 * kind was a proxy for exactly this).
 */
export type ArtifactKind = 'spec' | 'plan';

/**
 * How the build phase enters: full compacts the planning session down to the
 * committed spec + plan (`compact-for-impl`), a plan-less workflow re-anchors
 * on its one committed spec (`implement-spec`), short builds directly from the
 * research decisions (`implement-direct`), and relay seeds a FRESH builder
 * session from the committed spec (`fresh-seed` — the provider-switched
 * builder never held the planning context, so there is nothing to compact;
 * the document is the whole re-anchor).
 */
export type EntrySeed = 'compact-for-impl' | 'implement-spec' | 'implement-direct' | 'fresh-seed';

/**
 * The build's review posture — the vocabulary's load-bearing axis: `critique`
 * (the critic critiques, the builder fixes — the reflect-then-round-2 loop),
 * `writable` (one round, the builder applies fixes in place), `fixer`
 * (relay: the judge applies fixes directly with write access and owns the
 * finishing tails; substance escalates to the human rather than being
 * patched over).
 */
export type ReviewPosture = 'critique' | 'writable' | 'fixer';

/**
 * The worked-example set a phase's brief appends — per-world data, keyed not
 * inlined. Named after the KNOB VALUES that select them, never after a workflow
 * (`docs/engineering.md`: a behavior conditioned on a workflow name instead of a
 * knob is the drift to refuse). The doc-loop carries no key: each artifact has
 * exactly one example world, so a key there would restate `artifactKind`.
 */
export type ExamplesKey = 'frame' | 'research' | 'impl-from-plan' | 'impl-from-spec' | 'impl-direct' | 'impl-fixer';

/**
 * The model-read brief worlds the prose layer actually ships. The registry
 * declares the closed set without importing the prose maps (trust gradient:
 * registry imports nothing); `validateRegistry` checks every phase against this
 * at load, and `orchestrator/briefs.ts` type-checks its data records against the
 * same declaration. A missing world is therefore a load-time workflow error,
 * not a mid-run render throw.
 *
 * The doc-loop is absent by construction: its prose map (`DOC_BRIEFS`) is keyed
 * by the closed `ArtifactKind` union and proved total by TypeScript, so there is
 * no world a valid artifact could fail to have.
 */
export const BRIEF_WORLDS = {
  frame: ['frame', 'research'],
  build: {
    critique: ['impl-from-plan', 'impl-from-spec'],
    writable: ['impl-direct'],
    fixer: ['impl-fixer'],
  },
} as const satisfies {
  frame: readonly ExamplesKey[];
  build: Record<ReviewPosture, readonly ExamplesKey[]>;
};

export type FrameBriefWorld = (typeof BRIEF_WORLDS.frame)[number];
export type CritiqueBuildBriefWorld = (typeof BRIEF_WORLDS.build.critique)[number];
export type WritableBuildBriefWorld = (typeof BRIEF_WORLDS.build.writable)[number];
export type FixerBuildBriefWorld = (typeof BRIEF_WORLDS.build.fixer)[number];

/** A phase's block identity + knob values (discriminated on `block`). */
export type PhaseSemantics =
  | { readonly block: 'frame'; readonly examplesKey: 'frame' | 'research' }
  | {
      readonly block: 'doc-loop';
      readonly artifactKind: ArtifactKind;
      /**
       * A committed doc phase precedes this one. DERIVED from the phase list by
       * the compiler, carried here so no renderer re-derives topology: it decides
       * the acceptance contract's seed placement — a doc with an upstream
       * committed document authors EARLY from it (full's plan, blind to the
       * technical approach), one without authors LATE from its own converged
       * draft (blueprint/relay's spec).
       */
      readonly hasUpstreamDoc: boolean;
      /**
       * This is planning's last phase — approving its gate hands the run to the
       * headless driver. DERIVED like the above; the gate hint and the brief's
       * advance clause read it rather than asking which workflow this is.
       */
      readonly isHandoffPhase: boolean;
    }
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
};

/**
 * What each entry seed brings to the build's front: the persistent-session
 * workflows enter through the planning→implementation boundary compaction
 * (compact-for-impl), and a plan-less workflow adds its doc seed on top —
 * implement-spec re-anchors the build on the ONE committed spec, NOT short's
 * implement-direct (that body assumes no document exists). short enters
 * directly from the research decisions, no compaction ceremony.
 */
const ENTRY_SEED_SNIPPETS: Record<EntrySeed, readonly string[]> = {
  'compact-for-impl': ['compact-for-impl'],
  'implement-spec': ['compact-for-impl', 'implement-spec'],
  'implement-direct': ['implement-direct'],
  // The fresh builder seeds from the committed spec alone — implement-spec's
  // body is cold-safe (it anchors on the document and the vendored lessons,
  // never on prior session context), and there is no planning session to compact.
  'fresh-seed': ['implement-spec'],
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
export function snippetsForSemantics(s: PhaseSemantics): readonly string[] {
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
    // The doc order — the topology the artifact kinds ENCODE, checked rather
    // than assumed. A workflow's first document is always the spec (the
    // half-technical one, carrying the whole mental model); every later one is a
    // plan (the tactics the spec deferred). start-plan's body rereads "the
    // settled spec", so a plan with no spec upstream would brief a worker about a
    // document that does not exist; and a second spec has no world to render.
    const docs = wf.phases.filter((p) => p.semantics?.block === 'doc-loop');
    docs.forEach((p, i) => {
      if (p.semantics.block !== 'doc-loop') return;
      const expected: ArtifactKind = i === 0 ? 'spec' : 'plan';
      if (p.semantics.artifactKind !== expected) {
        throw new Error(
          i === 0
            ? `registry: workflow "${wfName}" opens its documents with a "${p.semantics.artifactKind}" doc-loop ("${p.name}") — a workflow's first document is always the spec, and a plan rereads a settled spec that would not exist`
            : `registry: workflow "${wfName}" phase "${p.name}" is a "${p.semantics.artifactKind}" doc-loop following another document — only the first document is a spec; every later one is a plan (the tactics the spec deferred)`,
        );
      }
    });
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
    // The doc-loop's DERIVED facts must agree with the topology they were derived
    // from. The compiler computes them; a frozen or hand-authored spec could
    // carry a lie, and the renderers trust them without re-deriving — so a wrong
    // `isHandoffPhase` would tell a worker the run hands off to AFK when a plan
    // phase still follows.
    const handoffPhase = planning.phases.at(-1);
    for (const p of wf.phases) {
      if (p.semantics?.block !== 'doc-loop') continue;
      const priorDoc = wf.phases.slice(0, arcPhases.indexOf(p.name)).some((q) => q.semantics?.block === 'doc-loop');
      if (p.semantics.hasUpstreamDoc !== priorDoc) {
        throw new Error(
          `registry: workflow "${wfName}" phase "${p.name}" declares hasUpstreamDoc ${p.semantics.hasUpstreamDoc} but ${priorDoc ? 'a document phase precedes it' : 'no document phase precedes it'} — the field is derived from the phase list and decides where the acceptance contract seeds from`,
        );
      }
      const isHandoff = p.name === handoffPhase;
      if (p.semantics.isHandoffPhase !== isHandoff) {
        throw new Error(
          `registry: workflow "${wfName}" phase "${p.name}" declares isHandoffPhase ${p.semantics.isHandoffPhase} but planning's last phase is "${handoffPhase}" — the field is derived from the stage partition and decides the gate's hand-off-to-AFK copy`,
        );
      }
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
