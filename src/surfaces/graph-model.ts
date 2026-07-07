/**
 * The workflow-spine — the one structural projection of a `CompiledWorkflow`
 * that both `duet graph` views and `duet workflows check` lean on, so none of
 * them re-derive the pipeline from the raw resolvers independently (the deletion
 * test: delete `structuralSpine` and blueprint + run + check each re-join
 * phase→gate→stage→cap→edge→checkpoint by hand).
 *
 * It is ONE structural core (`structuralSpine`, pure over a `CompiledWorkflow`)
 * with per-view OVERLAY builders that discriminate on `GraphModel.mode`. The
 * structure is identical for every consumer because every consumer reads a
 * `CompiledWorkflow` — the frozen `workflow.json` for a run, the read-only
 * resolver for a blueprint; only the overlay (config defaults vs frozen bindings,
 * live position) differs. That is why one core serves all without collapsing
 * into a god-model.
 *
 * Import direction (trust gradient): this composes `registry` + `voices`
 * (bindings) resolvers from `surfaces/` — never the reverse — the `doctor.ts`
 * cross-layer precedent.
 */

import {
  consultantCheckpointView,
  continuityEdgeFor,
  defaultPosture,
  defaultPreAuthorizedOf,
  gatePhasesOf,
  phasesOf,
  stageOf,
  stagesOf,
} from '../registry/workflows.ts';
import type {
  CompiledWorkflow,
  ConsultantCheckpoint,
  Duty,
  GatePhase,
  PhaseName,
  PhaseSpec,
  StageName,
} from '../registry/workflows.ts';
import { allBindings, formatBinding } from '../voices/bindings.ts';
import type { BindAddress, DegradedEdge, VoiceBindings } from '../voices/bindings.ts';
import type { WorkflowSource } from '../run/store.ts';

/** One phase, projected structurally — identical for every view (the frozen shape). */
export interface PhaseNode {
  name: PhaseName;
  /** The phase's block identity (the workflow vocabulary), for the block summary. */
  block: PhaseSpec['semantics']['block'];
  stage: StageName;
  gate: {
    /** The compact gate label — the heading's leading "<X>" token. */
    label: string;
    /** The machine gate-state name (the run overlay maps outcomes through it). */
    state: string;
  };
  /** The phase's stage duty pair (maker makes, checker checks). */
  duties: { maker: Duty; checker: Duty };
  /** Whether the phase's substance IS a review loop (doc-loop / build). */
  reviewLoop: boolean;
  /** The runaway round cap — present only for a review-loop phase. */
  roundCap?: number;
  /** The static consultant-checkpoint mode this phase carries, when any (registry data; the blueprint enriches it to a live view). */
  consultantCheckpoint?: ConsultantCheckpoint;
}

/** A stage, projected structurally — its duty pair and its declared continuity edges. */
export interface StageNode {
  name: StageName;
  duties: { maker: Duty; checker: Duty };
  /**
   * The planning duty each of this stage's duties structurally CONTINUES from
   * (delivery only), keyed by the continuing duty — e.g. `{ builder: 'architect',
   * critic: 'analyst' }`. Empty when the stage's duties start fresh (planning, or
   * relay's whole delivery). This is stage-scoped registry data (`StageSpec.edges`);
   * a binding-dependent degrade to fresh is a blueprint-overlay concern, not here.
   */
  continuity: Partial<Record<Duty, Duty>>;
}

/** The shared structural spine — every view's common skeleton. */
export interface WorkflowSpine {
  name: string;
  displayName: string;
  /** Where the compiled workflow was resolved from — attached by an overlay (structuralSpine is source-blind). */
  source?: WorkflowSource;
  phases: PhaseNode[];
  stages: StageNode[];
  /** The default attended-gate set; `undefined` ⇒ attend-all (the pre-feature default). */
  defaultPosture: GatePhase[] | undefined;
}

/** A stage's maker+checker duties, resolved once (the phase and stage nodes share it). */
function dutyPairOf(workflow: CompiledWorkflow, stage: StageName): { maker: Duty; checker: Duty } {
  const spec = stagesOf(workflow).find((s) => s.name === stage)!;
  return { maker: spec.duties.maker, checker: spec.duties.checker };
}

/** The compact gate label — the heading's leading "<LABEL>" token (headings are "<LABEL> — <desc>"). */
function gateLabelOf(phase: PhaseSpec): string {
  return phase.gate.heading.split(' — ')[0]!;
}

/**
 * The pure structural core — reads only registry resolvers, so it is testable
 * without fs and is `source`-blind (an overlay attaches `source`). Its only input
 * is a `CompiledWorkflow`, the shape both a frozen run and a read-only blueprint
 * feed, which is why the one core serves every view.
 */
export function structuralSpine(workflow: CompiledWorkflow): WorkflowSpine {
  const phases: PhaseNode[] = phasesOf(workflow).map((p) => {
    const stage = stageOf(workflow, p.name);
    return {
      name: p.name,
      block: p.semantics.block,
      stage,
      gate: { label: gateLabelOf(p), state: p.gate.state },
      duties: dutyPairOf(workflow, stage),
      reviewLoop: p.reviewLoop,
      ...(p.reviewLoop ? { roundCap: p.roundCap } : {}),
      ...(p.consultantCheckpoint ? { consultantCheckpoint: p.consultantCheckpoint } : {}),
    };
  });

  const stages: StageNode[] = stagesOf(workflow).map((s) => {
    const continuity: Partial<Record<Duty, Duty>> = {};
    for (const duty of [s.duties.maker, s.duties.checker]) {
      const from = continuityEdgeFor(workflow, duty);
      if (from) continuity[duty] = from;
    }
    return { name: s.name, duties: { maker: s.duties.maker, checker: s.duties.checker }, continuity };
  });

  return {
    name: workflow.name,
    displayName: workflow.displayName,
    phases,
    stages,
    defaultPosture: defaultPosture(gatePhasesOf(workflow), defaultPreAuthorizedOf(workflow)),
  };
}

/** A resolved default binding row — the address and its human-facing form (`provider:model@effort`). */
export interface BindingRow {
  address: BindAddress;
  label: string;
}

/** A phase's consultant checkpoint projected for the blueprint (its mode, render-facing kind, and liveness). */
export interface PhaseCheckpoint {
  phase: PhaseName;
  mode: ConsultantCheckpoint;
  kind: 'generative' | 'bet-audit' | 'backstop';
  live: boolean;
}

/**
 * The render-ready graph model — one discriminated shape per view. The blueprint
 * overlay adds config-resolved default bindings, the degraded edges those bindings
 * imply, and the live consultant checkpoints; the run overlay (added with the run
 * view) adds live position over the frozen workflow.
 */
export type GraphModel = {
  mode: 'blueprint';
  spine: WorkflowSpine;
  /** Config-resolved DEFAULT bindings — what would run here, labeled as defaults by the renderer. */
  bindings: BindingRow[];
  degradedEdges: DegradedEdge[];
  /** Per-phase consultant checkpoints (only phases that carry one). */
  checkpoints: PhaseCheckpoint[];
};

/**
 * The blueprint overlay: the structural spine plus the config-resolved default
 * bindings, their degraded continuity edges, and the live per-phase consultant
 * checkpoints. `resolved` comes from `resolveRunConfig({ workflow })` with no
 * flags/framing — the defaults a run WOULD freeze on this machine (the renderer
 * labels them as defaults, keeping the honesty that a real run freezes per-run).
 * A blueprint has no run, so checkpoint liveness reads the non-gateless default.
 */
export function blueprintModel(
  workflow: CompiledWorkflow,
  source: WorkflowSource | undefined,
  resolved: { bindings: VoiceBindings; degradedEdges: DegradedEdge[] },
): GraphModel {
  const spine = structuralSpine(workflow);
  const consultant = Boolean(resolved.bindings.consultant);
  const checkpoints: PhaseCheckpoint[] = spine.phases.flatMap((node) => {
    const view = consultantCheckpointView(workflow, node.name, { consultant });
    return view ? [{ phase: node.name, ...view }] : [];
  });
  return {
    mode: 'blueprint',
    spine: { ...spine, ...(source ? { source } : {}) },
    bindings: allBindings(resolved.bindings).map(({ address, binding }) => ({ address, label: formatBinding(binding) })),
    degradedEdges: resolved.degradedEdges,
    checkpoints,
  };
}
