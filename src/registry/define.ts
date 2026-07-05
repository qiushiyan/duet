import type {
  ArtifactKind,
  CompiledWorkflow,
  ConsultantCheckpoint,
  EntrySeed,
  GatePhase,
  PhaseSemantics,
  ReviewPosture,
  TailOwner,
  WorkflowSpecInput,
} from './workflows.ts';

type CompilerRegistry = {
  briefWorlds: typeof import('./workflows.ts').BRIEF_WORLDS;
  validateWorkflowSpec: (workflow: WorkflowSpecInput) => CompiledWorkflow;
};

let compilerRegistry: CompilerRegistry | undefined;

export function installWorkflowCompilerRegistry(registry: CompilerRegistry): void {
  compilerRegistry = registry;
}

function registryForCompile(): CompilerRegistry {
  if (!compilerRegistry) {
    throw new Error('workflow compiler registry is not initialized — import from "duet/workflows", not from the internal registry module directly');
  }
  return compilerRegistry;
}

declare const phaseExprBrand: unique symbol;
declare const workflowDefinitionBrand: unique symbol;

export type GateName = string;

type PhaseExprBase = {
  readonly name?: string;
  readonly [phaseExprBrand]: true;
};

type FrameExpr = PhaseExprBase & {
  readonly block: 'frame';
};

type DocExpr = PhaseExprBase & {
  readonly block: 'doc';
  readonly artifact: ArtifactKind;
  readonly rounds?: number;
  readonly contract?: boolean;
  readonly audit?: boolean;
};

type BuildExpr = PhaseExprBase & {
  readonly block: 'build';
  readonly review: ReviewPosture;
  readonly audit?: boolean;
};

type FinishExpr = PhaseExprBase & {
  readonly block: 'finish';
};

export type PhaseExpr = FrameExpr | DocExpr | BuildExpr | FinishExpr;

export interface WorkflowDefinitionInput {
  readonly name: string;
  readonly title: string;
  readonly phases: readonly PhaseExpr[];
  readonly attend?: readonly GateName[];
  readonly presets?: Record<string, readonly GateName[]>;
}

export type WorkflowDefinition = WorkflowDefinitionInput & {
  readonly [workflowDefinitionBrand]: true;
};

export type { CompiledWorkflow } from './workflows.ts';

type FrameOptions = {
  readonly name?: string;
};

type DocOptions = {
  readonly rounds?: number;
  readonly contract?: boolean;
  readonly audit?: boolean;
  readonly name?: string;
};

type BuildOptions = {
  readonly review: ReviewPosture;
  readonly audit?: boolean;
  readonly name?: string;
};

type FinishOptions = {
  readonly name?: string;
};

type NormalizedPhase = {
  readonly expr: PhaseExpr;
  readonly name: string;
  readonly index: number;
};

export function frame(options: FrameOptions = {}): PhaseExpr {
  assertKnownKeys(options, ['name'], 'frame');
  return { block: 'frame', ...presentName(options.name) } as FrameExpr;
}

export function doc(artifact: ArtifactKind, options: DocOptions = {}): PhaseExpr {
  const artifacts = workflowArtifacts();
  if (!(artifacts as readonly string[]).includes(artifact)) {
    throw new Error(`doc() artifact "${artifact}" is not in the workflow SDK vocabulary — valid artifacts: ${artifacts.join(', ')}`);
  }
  assertKnownKeys(options, ['rounds', 'contract', 'audit', 'name'], `doc("${artifact}")`);
  if (options.rounds !== undefined) assertPositiveInteger(options.rounds, `doc("${artifact}").rounds`);
  if (options.contract && options.audit) {
    throw new Error(`doc("${artifact}") cannot set both contract and audit — a phase carries one consultant checkpoint`);
  }
  if (options.audit && artifact !== 'spec') {
    throw new Error(`doc("${artifact}", { audit: true }) has no shipped consultant audit prose — audit is only declared for the spec doc-loop`);
  }
  if (options.contract && artifact === 'spec') {
    throw new Error(`doc("spec", { contract: true }) has no shipped contract-author prose — contract is only declared for plan or design doc-loops`);
  }
  return {
    block: 'doc',
    artifact,
    ...presentNumber('rounds', options.rounds),
    ...presentBoolean('contract', options.contract),
    ...presentBoolean('audit', options.audit),
    ...presentName(options.name),
  } as DocExpr;
}

export function build(options: BuildOptions): PhaseExpr {
  assertKnownKeys(options, ['review', 'audit', 'name'], 'build');
  const reviews = workflowReviews();
  if (!(reviews as readonly string[]).includes(options.review)) {
    throw new Error(`build() review "${options.review}" is not in the workflow SDK vocabulary — valid reviews: ${reviews.join(', ')}`);
  }
  return {
    block: 'build',
    review: options.review,
    ...presentBoolean('audit', options.audit),
    ...presentName(options.name),
  } as BuildExpr;
}

export function finish(options: FinishOptions = {}): PhaseExpr {
  assertKnownKeys(options, ['name'], 'finish');
  return { block: 'finish', ...presentName(options.name) } as FinishExpr;
}

export function defineWorkflow(input: WorkflowDefinitionInput): WorkflowDefinition {
  assertKnownKeys(input, ['name', 'title', 'phases', 'attend', 'presets'], 'defineWorkflow');
  if (!input.name.trim()) throw new Error('defineWorkflow() requires a non-empty name');
  if (!input.title.trim()) throw new Error(`workflow "${input.name}" requires a non-empty title`);
  if (input.phases.length === 0) throw new Error(`workflow "${input.name}" must declare at least one phase`);
  return input as WorkflowDefinition;
}

export function compileWorkflow(definition: WorkflowDefinition): CompiledWorkflow {
  const phases = normalizePhases(definition);
  const buildPhase = onlyPhase(phases, 'build', definition.name);
  const finishPhase = onlyPhase(phases, 'finish', definition.name);
  if (finishPhase.index < buildPhase.index) {
    throw new Error(`workflow "${definition.name}" puts finish before build — delivery must build before it opens the PR`);
  }
  if (finishPhase.index !== phases.length - 1) {
    throw new Error(`workflow "${definition.name}" has phases after finish — finish must be the final phase`);
  }
  for (const phase of phases.slice(buildPhase.index + 1)) {
    if (phase.expr.block === 'frame' || phase.expr.block === 'doc') {
      throw new Error(`workflow "${definition.name}" phase "${phase.name}" is a planning block after build — frame/doc-loop phases must precede delivery`);
    }
  }

  const contractPhases = phases.filter((p) => p.expr.block === 'doc' && p.expr.contract);
  if (contractPhases.length > 1) {
    throw new Error(
      `workflow "${definition.name}" declares multiple contract-author phases (${contractPhases.map((p) => p.name).join(', ')}) — the acceptance contract has one author checkpoint`,
    );
  }
  const contractPhase = contractPhases[0];
  const upstreamArtifact = upstreamArtifactFor(phases, buildPhase.index);
  const deliveryFresh = buildPhase.expr.block === 'build' && buildPhase.expr.review === 'fixer';
  const buildSemantics = buildSemanticsFor(definition.name, buildPhase, upstreamArtifact, deliveryFresh);
  const finishOwner = finishOwnerFor(buildSemantics.reviewPosture);

  if (buildPhase.expr.block === 'build' && buildPhase.expr.audit && contractPhase) {
    throw new Error(
      `workflow "${definition.name}" build "${buildPhase.name}" asks for an impl audit, but "${contractPhase.name}" already authors an acceptance contract — contract workflows derive a verify checkpoint instead of an implGate audit`,
    );
  }
  if (buildPhase.expr.block === 'build' && buildPhase.expr.audit && upstreamArtifact !== undefined) {
    throw new Error(
      `workflow "${definition.name}" build "${buildPhase.name}" asks for an impl audit after a ${upstreamArtifact} doc, but no shipped prose world exists for that combination — impl audit is only declared for the docless short build`,
    );
  }

  const compiled: WorkflowSpecInput = {
    name: definition.name,
    displayName: definition.title,
    phases: phases.map((phase) =>
      compilePhase(definition.name, phase, {
        buildPhase,
        buildSemantics,
        contractPhase,
        finishOwner,
        hasDocLoopAfter: hasDocLoopAfter(phases, phase.index, buildPhase.index),
        isFirstPlanningFrame: isFirstPlanningFrame(phases, phase.index, buildPhase.index),
      }),
    ),
    stages: stagesFor(phases, buildPhase.index, buildSemantics.reviewPosture),
    entry: entryFor(phases),
    presets: presetsFor(definition),
    forceAttend: [],
    defaultPreAuthorized: defaultPreAuthorizedFor(definition, phases),
  };

  return registryForCompile().validateWorkflowSpec(compiled);
}

function compilePhase(
  workflowName: string,
  phase: NormalizedPhase,
  context: {
    buildPhase: NormalizedPhase;
    buildSemantics: Extract<PhaseSemantics, { block: 'build' }>;
    contractPhase?: NormalizedPhase;
    finishOwner: TailOwner;
    hasDocLoopAfter: boolean;
    isFirstPlanningFrame: boolean;
  },
): WorkflowSpecInput['phases'][number] {
  switch (phase.expr.block) {
    case 'frame':
      return {
        name: phase.name,
        semantics: { block: 'frame', examplesKey: context.hasDocLoopAfter ? 'frame' : 'research' },
        gate: frameGate(context.hasDocLoopAfter),
        artifactLabel: 'direction analysis',
        reviewLoop: false,
        roundCap: 2,
        orchestratorBudgetUsd: 15,
        workerBudgetUsd: 10,
        workerTurnTimeoutMs: thirtyMinutes(),
        ...(context.isFirstPlanningFrame ? { consultantCheckpoint: 'frame' as const } : {}),
      };
    case 'doc': {
      const checkpoint = docCheckpointFor(phase.expr);
      return {
        name: phase.name,
        semantics: { block: 'doc-loop', artifactKind: phase.expr.artifact, examplesKey: phase.expr.artifact },
        gate: docGate(phase.expr.artifact),
        artifactLabel: phase.expr.artifact === 'design' ? 'design doc' : phase.expr.artifact,
        reviewLoop: true,
        roundCap: phase.expr.rounds ?? defaultDocRounds(phase.expr.artifact),
        orchestratorBudgetUsd: 15,
        workerBudgetUsd: 10,
        workerTurnTimeoutMs: thirtyMinutes(),
        ...(checkpoint ? { consultantCheckpoint: checkpoint } : {}),
      };
    }
    case 'build': {
      const checkpoint = buildCheckpointFor(workflowName, phase, context.contractPhase);
      return {
        name: phase.name,
        semantics: context.buildSemantics,
        gate: buildGate(context.buildSemantics.shipPacket),
        artifactLabel: 'implementation',
        reviewLoop: true,
        roundCap: buildRoundCap(context.buildSemantics.reviewPosture),
        orchestratorBudgetUsd: 30,
        workerBudgetUsd: 25,
        workerTurnTimeoutMs: ninetyMinutes(),
        ...(checkpoint ? { consultantCheckpoint: checkpoint } : {}),
      };
    }
    case 'finish':
      return {
        name: phase.name,
        semantics: { block: 'finish', finishOwner: context.finishOwner },
        gate: finishGate(),
        artifactLabel: 'PR',
        reviewLoop: false,
        roundCap: 2,
        orchestratorBudgetUsd: 15,
        workerBudgetUsd: 15,
        workerTurnTimeoutMs: thirtyMinutes(),
      };
  }
}

function normalizePhases(definition: WorkflowDefinition): readonly NormalizedPhase[] {
  const names = new Set<string>();
  const phases = definition.phases.map((expr, index) => {
    const name = phaseName(expr);
    if (!name.trim()) throw new Error(`workflow "${definition.name}" phase ${index + 1} has an empty name`);
    if (names.has(name)) throw new Error(`workflow "${definition.name}" declares two phases named "${name}"`);
    names.add(name);
    return { expr, name, index };
  });
  if (phases[0]?.expr.block !== 'frame') {
    throw new Error(`workflow "${definition.name}" must start with a frame block — planning's first frame owns the frame consultant checkpoint`);
  }
  return phases;
}

function onlyPhase(phases: readonly NormalizedPhase[], block: 'build' | 'finish', workflowName: string): NormalizedPhase {
  const matches = phases.filter((p) => p.expr.block === block);
  if (matches.length !== 1) {
    throw new Error(`workflow "${workflowName}" must declare exactly one ${block} block (got ${matches.length})`);
  }
  return matches[0]!;
}

function phaseName(expr: PhaseExpr): string {
  switch (expr.block) {
    case 'frame':
      return expr.name ?? 'frame';
    case 'doc':
      return expr.name ?? expr.artifact;
    case 'build':
      return expr.name ?? 'implement';
    case 'finish':
      return expr.name ?? 'finish';
  }
}

function upstreamArtifactFor(phases: readonly NormalizedPhase[], buildIndex: number): ArtifactKind | undefined {
  const docs = phases.slice(0, buildIndex).filter((p): p is NormalizedPhase & { expr: DocExpr } => p.expr.block === 'doc');
  return docs.at(-1)?.expr.artifact;
}

function buildSemanticsFor(
  workflowName: string,
  phase: NormalizedPhase,
  upstreamArtifact: ArtifactKind | undefined,
  deliveryFresh: boolean,
): Extract<PhaseSemantics, { block: 'build' }> {
  if (phase.expr.block !== 'build') throw new Error(`workflow "${workflowName}" phase "${phase.name}" is not a build block`);
  const entrySeed = entrySeedFor(workflowName, phase.name, upstreamArtifact, deliveryFresh);
  const reviewPosture = phase.expr.review;
  return {
    block: 'build',
    entrySeed,
    reviewPosture,
    midpoint: reviewPosture === 'writable' ? 'none' : 'judgment',
    shipPacket: reviewPosture === 'writable' ? 'lean' : 'ceo-summary',
    buildTailOwner: reviewPosture === 'fixer' ? 'checker' : 'maker',
    examplesKey: buildExamplesKeyFor(workflowName, phase.name, reviewPosture, upstreamArtifact),
  };
}

function entrySeedFor(
  workflowName: string,
  phaseNameForError: string,
  upstreamArtifact: ArtifactKind | undefined,
  deliveryFresh: boolean,
): EntrySeed {
  if (!deliveryFresh && upstreamArtifact === 'plan') return 'compact-for-impl';
  if (!deliveryFresh && upstreamArtifact === 'design') return 'implement-design';
  if (!deliveryFresh && upstreamArtifact === undefined) return 'implement-direct';
  if (deliveryFresh && upstreamArtifact === 'design') return 'fresh-seed';
  throw new Error(
    `workflow "${workflowName}" build "${phaseNameForError}" has ${upstreamArtifact ?? 'none'} + ${deliveryFresh ? 'fresh' : 'continuing'} delivery, but no prose world exists for that combination (and therefore no entry-seed ritual can be derived)`,
  );
}

function buildExamplesKeyFor(
  workflowName: string,
  phaseNameForError: string,
  reviewPosture: ReviewPosture,
  upstreamArtifact: ArtifactKind | undefined,
): Extract<PhaseSemantics, { block: 'build' }>['examplesKey'] {
  if (reviewPosture === 'critique' && upstreamArtifact === 'plan') return 'impl';
  if (reviewPosture === 'critique' && upstreamArtifact === 'design') return 'blueprint-impl';
  if (reviewPosture === 'writable' && upstreamArtifact === undefined) return 'short-impl';
  if (reviewPosture === 'fixer' && upstreamArtifact === 'design') return 'relay-impl';
  const valid = registryForCompile().briefWorlds.build[reviewPosture].join(', ');
  throw new Error(
    `workflow "${workflowName}" build "${phaseNameForError}" has review "${reviewPosture}" after upstream ${upstreamArtifact ?? 'none'}, but no ${reviewPosture} build prose world is declared for that upstream artifact — valid ${reviewPosture} worlds: ${valid}`,
  );
}

function finishOwnerFor(reviewPosture: ReviewPosture): TailOwner {
  return reviewPosture === 'fixer' ? 'checker' : 'maker';
}

function buildRoundCap(reviewPosture: ReviewPosture): number {
  return reviewPosture === 'critique' ? 3 : 1;
}

function docCheckpointFor(expr: DocExpr): ConsultantCheckpoint | undefined {
  if (expr.audit) return 'specGate';
  if (expr.contract) return 'contract';
  return undefined;
}

function buildCheckpointFor(workflowName: string, phase: NormalizedPhase, contractPhase: NormalizedPhase | undefined): ConsultantCheckpoint | undefined {
  if (contractPhase) return 'verify';
  if (phase.expr.block !== 'build') throw new Error(`workflow "${workflowName}" phase "${phase.name}" is not a build block`);
  return phase.expr.audit ? 'implGate' : undefined;
}

function stagesFor(
  phases: readonly NormalizedPhase[],
  buildIndex: number,
  reviewPosture: ReviewPosture,
): WorkflowSpecInput['stages'] {
  const planning = phases.slice(0, buildIndex).map((p) => p.name);
  const delivery = phases.slice(buildIndex).map((p) => p.name);
  const checker = reviewPosture === 'fixer' ? 'judge' : 'critic';
  return [
    { name: 'planning', phases: planning, duties: { maker: 'architect', checker: 'analyst' } },
    {
      name: 'delivery',
      phases: delivery,
      duties: { maker: 'builder', checker },
      ...(reviewPosture === 'fixer' ? {} : { edges: { builder: { from: 'architect' as const }, [checker]: { from: 'analyst' as const } } }),
    },
  ];
}

function entryFor(phases: readonly NormalizedPhase[]): WorkflowSpecInput['entry'] {
  const firstDoc = phases.find((p) => p.expr.block === 'doc');
  return {
    firstPhase: phases[0]!.name,
    ...(firstDoc ? { specSkipsTo: firstDoc.name } : {}),
  };
}

function presetsFor(definition: WorkflowDefinition): Record<string, readonly string[]> {
  const presets: Record<string, readonly string[]> = { ...(definition.presets ?? {}) };
  if (presets.afk === undefined) {
    presets.afk = [];
  } else if (presets.afk.length !== 0) {
    throw new Error(`workflow "${definition.name}" preset "afk" is provided universally as attend-none — set it to [] or omit it`);
  }
  return presets;
}

function defaultPreAuthorizedFor(definition: WorkflowDefinition, phases: readonly NormalizedPhase[]): readonly string[] {
  if (definition.attend === undefined) return [];
  const gates = phases.map((p) => p.name);
  const unknown = definition.attend.filter((gate) => !gates.includes(gate));
  if (unknown.length > 0) {
    throw new Error(
      `workflow "${definition.name}" attend names unknown gate(s) ${unknown.map((g) => `"${g}"`).join(', ')} — valid gates: ${gates.join(', ')}`,
    );
  }
  return gates.filter((gate) => !definition.attend!.includes(gate)) as readonly GatePhase[];
}

function hasDocLoopAfter(phases: readonly NormalizedPhase[], index: number, buildIndex: number): boolean {
  return phases.slice(index + 1, buildIndex).some((p) => p.expr.block === 'doc');
}

function isFirstPlanningFrame(phases: readonly NormalizedPhase[], index: number, buildIndex: number): boolean {
  return phases.find((p) => p.index < buildIndex && p.expr.block === 'frame')?.index === index;
}

function defaultDocRounds(artifact: ArtifactKind): number {
  return artifact === 'design' ? 2 : 3;
}

function frameGate(docLoopFollows: boolean): WorkflowSpecInput['phases'][number]['gate'] {
  return {
    state: 'directionGate',
    heading: 'DIRECTION gate — the synthesized direction',
    ready: 'Direction gate — synthesized direction ready',
    hint: docLoopFollows
      ? null
      : '(approving hands off to AFK implementation — these decisions are the spec; there is no separate spec or plan)',
  };
}

function docGate(artifact: ArtifactKind): WorkflowSpecInput['phases'][number]['gate'] {
  switch (artifact) {
    case 'spec':
      return {
        state: 'commitSpecGate',
        heading: "SPEC gate — the orchestrator's summary",
        ready: 'Commit-spec gate — spec ready for review',
        hint: null,
      };
    case 'plan':
      return {
        state: 'planApprovalGate',
        heading: "PLAN gate — the orchestrator's summary",
        ready: 'Plan-approval gate — plan ready for review',
        hint: null,
      };
    case 'design':
      return {
        state: 'designGate',
        heading: "DESIGN gate — the orchestrator's summary",
        ready: 'Design gate — design doc ready for review',
        hint: '(approving hands off to AFK implementation — the design doc is the single design artifact; there is no separate spec or plan)',
      };
  }
}

function buildGate(packet: Extract<PhaseSemantics, { block: 'build' }>['shipPacket']): WorkflowSpecInput['phases'][number]['gate'] {
  return {
    state: 'shipGate',
    heading: packet === 'ceo-summary' ? 'SHIP gate — the orchestrator’s packet (CEO summary first)' : 'SHIP gate — the implementation packet',
    ready: 'Ship gate — implementation packet ready',
    hint: '(verify in your environment before deciding — migrations, smoke tests; docs are reconciled here too, so approving enters FINISH = open the PR)',
  };
}

function finishGate(): WorkflowSpecInput['phases'][number]['gate'] {
  return {
    state: 'openPrGate',
    heading: 'OPEN-PR gate — docs reconciled, PR open',
    ready: 'Open-PR gate — PR open, ready for your review',
    hint: '(the PR is already open and auto-crosses to done by default; list `finish` in gates_at for a post-open review stop — approve marks it done, reject amends the open PR. The merge is always yours.)',
  };
}

function assertKnownKeys(value: object, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${context} received unknown workflow SDK option "${key}" — valid keys: ${allowed.join(', ')}`);
    }
  }
}

function assertPositiveInteger(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${context} must be a positive integer`);
}

function presentName(name: string | undefined): { readonly name?: string } {
  return name === undefined ? {} : { name };
}

function presentBoolean<K extends string>(key: K, value: boolean | undefined): { readonly [P in K]?: boolean } {
  return value === undefined ? {} : { [key]: value } as { readonly [P in K]?: boolean };
}

function presentNumber<K extends string>(key: K, value: number | undefined): { readonly [P in K]?: number } {
  return value === undefined ? {} : { [key]: value } as { readonly [P in K]?: number };
}

function workflowArtifacts(): readonly ArtifactKind[] {
  return ['spec', 'plan', 'design'] as const satisfies readonly ArtifactKind[];
}

function workflowReviews(): readonly ReviewPosture[] {
  return ['critique', 'writable', 'fixer'] as const satisfies readonly ReviewPosture[];
}

function thirtyMinutes(): number {
  return 30 * 60_000;
}

function ninetyMinutes(): number {
  return 90 * 60_000;
}
