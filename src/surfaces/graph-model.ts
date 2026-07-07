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
  ANYTIME_SNIPPETS,
  consultantCheckpointView,
  continuityEdgeFor,
  defaultPosture,
  defaultPreAuthorizedOf,
  gatePhasesOf,
  phaseOfGateState,
  phaseSnippetsFor,
  phasesOf,
  stageOf,
  stagesOf,
} from '../registry/workflows.ts';
import type {
  ArtifactKind,
  CompiledWorkflow,
  ConsultantCheckpoint,
  Duty,
  GatePhase,
  PhaseName,
  PhaseSpec,
  ReviewPosture,
  StageName,
} from '../registry/workflows.ts';
import { allBindings, degradedEdgesFor, formatBinding } from '../voices/bindings.ts';
import type { BindAddress, DegradedEdge, VoiceBindings } from '../voices/bindings.ts';
import type { ContextEvent, RunState, WorkflowSource } from '../run/store.ts';
import type { RunPosition } from '../run/position.ts';
import type { VoiceAddress } from '../voices/providers/types.ts';
import type { ErrorClass } from '../voices/health.ts';
import type { StatusModel, StopModel } from './status.ts';

/** One phase, projected structurally — identical for every view (the frozen shape). */
export interface PhaseNode {
  name: PhaseName;
  /** The phase's block identity (the workflow vocabulary), for the block summary. */
  block: PhaseSpec['semantics']['block'];
  /** The doc-loop's artifact (`doc-loop` blocks only) — the block summary's distinguishing knob. */
  artifactKind?: ArtifactKind;
  /** The build's review posture (`build` blocks only) — the block summary's distinguishing knob. */
  reviewPosture?: ReviewPosture;
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

/** The human-facing block summary for a phase node — `doc-loop (spec)` / `build (critique)` / `frame` / `finish`. The one place both the graph and `workflows check` derive it, from the model. */
export function blockSummary(node: PhaseNode): string {
  switch (node.block) {
    case 'frame':
      return 'frame';
    case 'doc-loop':
      return `doc-loop (${node.artifactKind})`;
    case 'build':
      return `build (${node.reviewPosture})`;
    case 'finish':
      return 'finish';
  }
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
      ...(p.semantics.block === 'doc-loop' ? { artifactKind: p.semantics.artifactKind } : {}),
      ...(p.semantics.block === 'build' ? { reviewPosture: p.semantics.reviewPosture } : {}),
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

/** The blueprint view: the structural spine + config-resolved default bindings, their degraded edges, and the live consultant checkpoints. */
export interface BlueprintGraphModel {
  mode: 'blueprint';
  spine: WorkflowSpine;
  /** Config-resolved DEFAULT bindings — what would run here, labeled as defaults by the renderer. */
  bindings: BindingRow[];
  degradedEdges: DegradedEdge[];
  /** Per-phase consultant checkpoints (only phases that carry one). */
  checkpoints: PhaseCheckpoint[];
}

/** A phase's live overlay state — its position in the arc, gate outcome, rounds, and any state-derived drift. */
export interface RunNodeState {
  phase: PhaseName;
  status: 'done' | 'current' | 'future';
  /** Every phase gates; posture is known always, outcome only once the gate is behind the cursor. */
  gate: {
    posture: 'attended' | 'pre-authorized';
    /** How a PASSED gate was crossed — `auto-crossed` when ledgered in autoApprovals, else `crossed`. Never "attended" (state does not attest an explicit human approval). */
    outcome?: 'auto-crossed' | 'crossed';
    /** A `high` human decision that holds/held this (possibly pre-authorized) gate. */
    heldHigh?: true;
  };
  /** used/cap for a review-loop phase. */
  rounds?: { used: number; cap: number };
  /** State-derived divergence from the expected shape — all phase-attributed (no log read). */
  drift: DriftFlag[];
}

/** A phase-attributed drift signal — the run view's state-derived divergence flags (distinct from the trace's log-timeline drift; deliberately not a shared engine). */
export type DriftFlag =
  | { kind: 'unexpected-tag'; tag: string; voice: VoiceAddress }
  | { kind: 'rounds-past-cap'; used: number; cap: number }
  | { kind: 'auto-retry'; errorClass: ErrorClass; attempt: number }
  | { kind: 'steer-staged'; stagedAt: string };

/** The run view: the frozen workflow's structural spine with live position, gate outcomes, rounds, drift, and the run-level intervention summary overlaid. */
export interface RunGraphModel {
  mode: 'run';
  runId: string;
  spine: WorkflowSpine;
  nodes: RunNodeState[];
  stop: StopModel;
  /** The degraded continuity edges the run's FROZEN bindings imply — so the arc never implies an edge the manifest made fresh. */
  degradedEdges: DegradedEdge[];
  /** Context interventions (compaction / cutoff / salvage / reset) — run/voice-level: a ContextEvent carries no phase, so it is never a per-phase flag. */
  interventions: ContextEvent[];
  /** The while-away ledgers, for the footer summary (auto-approvals also drive gate outcomes; retries also drive per-phase drift). */
  ledgers: { autoApprovals: StatusModel['autoApprovals']; awayRetries: StatusModel['awayRetries'] };
}

/**
 * The render-ready graph model — one discriminated shape per view. The blueprint
 * overlay adds config-resolved default bindings, degraded edges, and live
 * checkpoints; the run overlay adds live position over the frozen workflow.
 */
export type GraphModel = BlueprintGraphModel | RunGraphModel;

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
): BlueprintGraphModel {
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

/** The phase a live run is currently at, or undefined when the position carries none (done / abandoned) — the cursor for done/current/future. */
function cursorPhaseOf(position: RunPosition): PhaseName | undefined {
  switch (position.kind) {
    case 'running':
    case 'interactive':
    case 'gate':
    case 'flag':
    case 'crashed':
      return position.phase;
    case 'done':
    case 'abandoned':
      return undefined;
  }
}

/**
 * The phase-attributed drift for one phase — all state-derived, no log read: a
 * snippet tag the phase's arc doesn't own (`sentSnippets` vs `phaseSnippetsFor`,
 * plus the always-legal anytime helpers), rounds past cap, an auto-retry in the
 * phase, and a steer currently staged during it. The trace's ordering drift is a
 * separate computation over the log timeline — deliberately not shared.
 */
function driftForPhase(
  workflow: CompiledWorkflow,
  phase: PhaseName,
  state: RunState,
  status: StatusModel,
  opts: { consultant: boolean; gateless?: boolean },
): DriftFlag[] {
  const flags: DriftFlag[] = [];
  const allowed = new Set<string>([...phaseSnippetsFor(workflow, phase, opts), ...ANYTIME_SNIPPETS]);
  const sent = state.sentSnippets?.[phase];
  if (sent) {
    for (const [voice, tags] of Object.entries(sent) as Array<[VoiceAddress, string[] | undefined]>) {
      for (const tag of tags ?? []) if (!allowed.has(tag)) flags.push({ kind: 'unexpected-tag', tag, voice });
    }
  }
  const round = status.rounds.find((r) => r.phase === phase);
  if (round && round.used > round.cap) flags.push({ kind: 'rounds-past-cap', used: round.used, cap: round.cap });
  for (const r of state.autoRetries ?? []) if (r.phase === phase) flags.push({ kind: 'auto-retry', errorClass: r.errorClass, attempt: r.attempt });
  // Pending-only, by design: a steer CURRENTLY staged during this phase (delivered
  // steers are consumed and belong to the trace's both-directory history, not here).
  for (const s of status.pendingSteers) if (s.stagedDuring === phase) flags.push({ kind: 'steer-staged', stagedAt: s.stagedAt });
  return flags;
}

/**
 * The run overlay: the frozen workflow's structural spine with live position and
 * outcomes overlaid. It renders OVER the pinned `StatusModel` (the concierge
 * contract) plus the raw `state`/`position` for the signals StatusModel doesn't
 * carry (snippet drift, high decisions, frozen-binding degradation) — it never
 * forks a second run-state model. `status` must be built with the run's pending
 * steers so the steer-drift signal is populated.
 */
export function runGraphModel(
  workflow: CompiledWorkflow,
  status: StatusModel,
  state: RunState,
  position: RunPosition,
): RunGraphModel {
  const spine = structuralSpine(workflow);
  const phaseNames = spine.phases.map((p) => p.name);
  const cursor = cursorPhaseOf(position);
  const cursorIdx = cursor ? phaseNames.indexOf(cursor) : -1;
  const roundsByPhase = new Map(status.rounds.map((r) => [r.phase, r]));
  const autoApprovedPhases = new Set(
    (state.autoApprovals ?? [])
      .map((a) => phaseOfGateState(workflow, a.gate))
      .filter((p): p is PhaseName => p !== undefined),
  );
  const opts = { consultant: Boolean(state.bindings.consultant), gateless: state.gateless === true };

  const nodes: RunNodeState[] = spine.phases.map((node, idx) => {
    const nodeStatus: RunNodeState['status'] =
      position.kind === 'done'
        ? 'done'
        : cursorIdx === -1
          ? state.phaseStarted[node.name]
            ? 'done' // abandoned: no cursor — a started phase was at least reached
            : 'future'
          : idx < cursorIdx
            ? 'done'
            : idx === cursorIdx
              ? 'current'
              : 'future';
    const attended = state.gatesAt === undefined || state.gatesAt.includes(node.name);
    const heldHigh = (state.phaseSummaries[node.name]?.humanDecisions ?? []).some((d) => d.severity === 'high');
    const round = roundsByPhase.get(node.name);
    return {
      phase: node.name,
      status: nodeStatus,
      gate: {
        posture: attended ? 'attended' : 'pre-authorized',
        ...(nodeStatus === 'done' ? { outcome: autoApprovedPhases.has(node.name) ? 'auto-crossed' : 'crossed' } : {}),
        ...(heldHigh ? { heldHigh: true as const } : {}),
      },
      ...(round ? { rounds: { used: round.used, cap: round.cap } } : {}),
      drift: driftForPhase(workflow, node.name, state, status, opts),
    };
  });

  return {
    mode: 'run',
    runId: state.runId,
    spine,
    nodes,
    stop: status.stop,
    degradedEdges: degradedEdgesFor(state.bindings, workflow),
    interventions: status.contextEvents,
    ledgers: { autoApprovals: status.autoApprovals, awayRetries: status.awayRetries },
  };
}
