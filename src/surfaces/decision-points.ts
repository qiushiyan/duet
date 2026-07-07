import { gateAttended, highDecisionsAt } from '../run/store.ts';
import type { Grade, HumanDecision, RunState } from '../run/store.ts';
import { gatePhasesOf } from '../registry/workflows.ts';
import type { GatePhase, PhaseName } from '../registry/workflows.ts';
import { workflowFor } from '../run/workflow.ts';
import { VOICE_LOG_TIMESTAMP_PATTERN } from './stats.ts';

export type GateDisposition = 'attended' | 'auto-crossed' | 'held-high';
export type DecisionVerdict = Grade['verdict'];

export interface GateContext {
  summary?: string;
  artifacts: string[];
  humanDecisions: HumanDecision[];
  rejectionCount: number;
}

export interface QuestionContext {
  question: string;
  answer?: string;
}

export interface GateDecisionPoint {
  key: `gate:${string}:${number}`;
  kind: 'gate';
  phase: PhaseName;
  polarity: 'stopped' | 'did-not-stop';
  disposition: GateDisposition;
  context: GateContext;
}

export interface QuestionDecisionPoint {
  key: `question:${string}:${number}`;
  kind: 'question';
  phase: PhaseName;
  polarity: 'stopped';
  context: QuestionContext;
}

export type DecisionPoint = GateDecisionPoint | QuestionDecisionPoint;

export interface DecisionDiscovery {
  points: DecisionPoint[];
  notes: string[];
}

export interface DecisionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  missed: number;
  graded: number;
  total: number;
}

const HEADER = new RegExp(`^${VOICE_LOG_TIMESTAMP_PATTERN} (.*)$`);
const PHASE_OPEN = /^◀ harness prompt \(phase=(\w+)\)$/;
const PHASE_CLOSE = /^advance_phase \((\w+)\)$/;
const QUESTION = /^ask_human queued$/;
const ANSWER = /^The human answered your queued question: (.*)\. Continue the phase from where you paused, taking their answer into account\.$/s;

interface LogBlock {
  atMs: number;
  header: string;
  body: string;
  index: number;
}

interface GateLog {
  phase: GatePhase;
  closes: LogBlock[];
}

interface QuestionLog {
  phase?: PhaseName;
  question: string;
  answer?: string;
  atMs: number;
  index: number;
}
type ResolvedQuestionLog = QuestionLog & { phase: PhaseName };

function parseBlocks(log: string): LogBlock[] {
  const blocks: LogBlock[] = [];
  let current: { atMs: number; header: string; body: string[]; index: number } | undefined;
  for (const line of log.split('\n')) {
    const header = HEADER.exec(line);
    if (header) {
      if (current) blocks.push({ atMs: current.atMs, header: current.header, body: current.body.join('\n').trim(), index: current.index });
      const atMs = Date.parse(header[1]!);
      current = {
        atMs: Number.isNaN(atMs) ? 0 : atMs,
        header: header[2]!,
        body: [],
        index: blocks.length,
      };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) blocks.push({ atMs: current.atMs, header: current.header, body: current.body.join('\n').trim(), index: current.index });
  return blocks;
}

function parseAnswer(body: string): string | undefined {
  const match = ANSWER.exec(body.trim());
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]!) as string;
  } catch {
    return undefined;
  }
}

function parseLog(log: string | undefined, gatePhases: ReadonlySet<string>): { gates: Map<GatePhase, GateLog>; questions: ResolvedQuestionLog[]; droppedQuestions: number } {
  const gates = new Map<GatePhase, GateLog>();
  const questions: QuestionLog[] = [];
  if (log === undefined) return { gates, questions: [], droppedQuestions: 0 };

  const blocks = parseBlocks(log);
  let currentPhase: PhaseName | undefined;
  let lastQuestionInPhase: QuestionLog | undefined;
  const pendingPhaseQuestions: QuestionLog[] = [];

  for (const block of blocks) {
    const open = PHASE_OPEN.exec(block.header);
    if (open) {
      currentPhase = open[1] as PhaseName;
      const answer = parseAnswer(block.body);
      if (answer && lastQuestionInPhase && lastQuestionInPhase.phase === currentPhase && lastQuestionInPhase.answer === undefined) {
        lastQuestionInPhase.answer = answer;
      }
      continue;
    }

    const close = PHASE_CLOSE.exec(block.header);
    if (close) {
      const phase = close[1] as PhaseName;
      for (const question of pendingPhaseQuestions.splice(0)) {
        if (question.phase === undefined) question.phase = phase;
      }
      if (gatePhases.has(phase)) {
        const gate = gates.get(phase as GatePhase) ?? { phase: phase as GatePhase, closes: [] };
        gate.closes.push(block);
        gates.set(phase as GatePhase, gate);
      }
      currentPhase = undefined;
      continue;
    }

    if (QUESTION.test(block.header)) {
      const question: QuestionLog = {
        ...(currentPhase ? { phase: currentPhase } : {}),
        question: block.body,
        atMs: block.atMs,
        index: block.index,
      };
      questions.push(question);
      lastQuestionInPhase = question;
      if (!currentPhase) pendingPhaseQuestions.push(question);
    }
  }

  const resolved = questions.filter((q): q is ResolvedQuestionLog => q.phase !== undefined);
  return { gates, questions: resolved, droppedQuestions: questions.length - resolved.length };
}

function phaseOrder(state: RunState): Map<string, number> {
  return new Map(workflowFor(state).phases.map((p, index) => [p.name, index]));
}

function gatePoint(state: RunState, phase: GatePhase, disposition: GateDisposition, rejectionCount: number): GateDecisionPoint {
  const packet = state.phaseSummaries[phase];
  return {
    key: `gate:${phase}:0`,
    kind: 'gate',
    phase,
    polarity: disposition === 'auto-crossed' ? 'did-not-stop' : 'stopped',
    disposition,
    context: {
      ...(packet?.summary ? { summary: packet.summary } : {}),
      artifacts: packet?.artifacts ?? [],
      humanDecisions: packet?.humanDecisions ?? [],
      rejectionCount,
    },
  };
}

function eventTimeForGate(state: RunState, phase: GatePhase, logGate: GateLog | undefined): number | undefined {
  const logged = logGate?.closes.at(-1)?.atMs;
  if (logged !== undefined) return logged;
  const auto = state.autoApprovals?.find((a) => a.gate === phase)?.at;
  if (!auto) return undefined;
  const atMs = Date.parse(auto);
  return Number.isNaN(atMs) ? undefined : atMs;
}

export function decisionPoints(state: RunState, orchestratorLog: string | undefined): DecisionDiscovery {
  const wf = workflowFor(state);
  const gates = gatePhasesOf(wf);
  const gateSet = new Set<string>(gates);
  const { gates: logGates, questions, droppedQuestions } = parseLog(orchestratorLog, gateSet);
  const notes: string[] = [];
  if (orchestratorLog === undefined) {
    notes.push('orchestrator log missing — attended gates and queued questions could not be reconstructed; state-sourced auto-crossed and held-high gates are still shown.');
  }
  if (droppedQuestions > 0) {
    notes.push(`${droppedQuestions} queued question(s) could not be attributed to a phase (no surrounding phase window or following advance) — omitted from the point set.`);
  }

  const byPhase = phaseOrder(state);
  const pointsWithOrder: Array<{ point: DecisionPoint; atMs?: number; phaseIndex: number; logIndex: number }> = [];
  const autoPhases = new Set((state.autoApprovals ?? []).map((a) => a.gate).filter((gate): gate is GatePhase => gateSet.has(gate)));

  for (const phase of gates) {
    const logGate = logGates.get(phase);
    const held = !gateAttended(state, phase) && highDecisionsAt(state, phase).length > 0;
    const disposition: GateDisposition | undefined = held
      ? 'held-high'
      : autoPhases.has(phase)
        ? 'auto-crossed'
        : logGate
          ? 'attended'
          : undefined;
    if (!disposition) continue;
    const rejectionCount = disposition === 'attended' || disposition === 'held-high' ? Math.max(0, (logGate?.closes.length ?? 1) - 1) : 0;
    pointsWithOrder.push({
      point: gatePoint(state, phase, disposition, rejectionCount),
      atMs: eventTimeForGate(state, phase, logGate),
      phaseIndex: byPhase.get(phase) ?? Number.MAX_SAFE_INTEGER,
      logIndex: logGate?.closes[0]?.index ?? Number.MAX_SAFE_INTEGER,
    });
  }

  const questionOrdinals = new Map<string, number>();
  for (const question of questions) {
    const ordinal = questionOrdinals.get(question.phase) ?? 0;
    questionOrdinals.set(question.phase, ordinal + 1);
    pointsWithOrder.push({
      point: {
        key: `question:${question.phase}:${ordinal}`,
        kind: 'question',
        phase: question.phase,
        polarity: 'stopped',
        context: {
          question: question.question,
          ...(question.answer ? { answer: question.answer } : {}),
        },
      },
      atMs: question.atMs,
      phaseIndex: byPhase.get(question.phase) ?? Number.MAX_SAFE_INTEGER,
      logIndex: question.index,
    });
  }

  pointsWithOrder.sort((a, b) => {
    if (a.atMs !== undefined && b.atMs !== undefined && a.atMs !== b.atMs) return a.atMs - b.atMs;
    if (a.phaseIndex !== b.phaseIndex) return a.phaseIndex - b.phaseIndex;
    return a.logIndex - b.logIndex;
  });
  return { points: pointsWithOrder.map((p) => p.point), notes };
}

export function gradeMatrix(points: readonly DecisionPoint[], grades: readonly Grade[] | undefined): DecisionMatrix {
  const byKey = new Map((grades ?? []).map((g) => [g.key, g]));
  const pointKeys = new Set<string>(points.map((p) => p.key));
  const matrix: DecisionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0, missed: 0, graded: 0, total: points.length };

  for (const point of points) {
    const grade = byKey.get(point.key);
    if (!grade) continue;
    matrix.graded += 1;
    if (point.polarity === 'stopped') {
      if (grade.verdict === 'right') matrix.tp += 1;
      else matrix.fp += 1;
    } else if (grade.verdict === 'right') matrix.tn += 1;
    else matrix.fn += 1;
  }

  for (const grade of grades ?? []) {
    if (pointKeys.has(grade.key) || !grade.key.startsWith('missed:')) continue;
    matrix.fn += 1;
    matrix.missed += 1;
    matrix.graded += 1;
    matrix.total += 1;
  }

  return matrix;
}
