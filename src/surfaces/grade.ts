import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { decisionPoints } from './decision-points.ts';
import type { DecisionPoint } from './decision-points.ts';
import { probeRunPosition } from '../run/position.ts';
import { loadRunState, runDirOf, scanRuns, upsertGrade } from '../run/store.ts';
import type { Grade, RunState } from '../run/store.ts';
import { phasesOf } from '../registry/workflows.ts';
import { workflowFor } from '../run/workflow.ts';

export interface GradeCommandOptions {
  list?: boolean;
  json?: boolean;
  set?: string[];
  note?: string[];
  missed?: string[];
}

export interface GradeCommandIo {
  isTTY?: boolean;
  ask?: (prompt: string) => Promise<string>;
  now?: () => Date;
}

export type GradeCommandResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

function readOrchestratorLog(state: RunState): string | undefined {
  const path = join(runDirOf(state.cwd, state.runId), 'orchestrator.log');
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function resolveTarget(cwd: string, runId: string | undefined): RunState | string {
  if (runId) return loadRunState(cwd, runId);
  const { runs, unloadable } = scanRuns(cwd);
  const done = runs.find((r) => probeRunPosition(r).kind === 'done');
  if (done) return done;
  return unloadable.length === 0
    ? 'no done runs found in this project — pass a run id to grade an incomplete quiescent run'
    : `no done runs found in this project\n\n${unloadable.map((u) => u.reason).join('\n')}`;
}

function parseAssignment(raw: string, flag: string): { key: string; value: string } | string {
  const eq = raw.indexOf('=');
  if (eq === -1) return `${flag} ${raw}: expected <key>=<value>`;
  const key = raw.slice(0, eq).trim();
  if (!key) return `${flag} ${raw}: key is empty`;
  return { key, value: raw.slice(eq + 1) };
}

function existingGrade(state: RunState, key: string): Grade | undefined {
  return state.grades?.find((g) => g.key === key);
}

function pointLine(point: DecisionPoint, grade: Grade | undefined): string {
  const verdict = grade ? ` [${grade.verdict}${grade.note ? `; note: ${grade.note}` : ''}]` : '';
  if (point.kind === 'question') {
    const answer = point.context.answer ? `  → answered: ${point.context.answer}` : '';
    return `${point.key}  ${point.phase}  question  ${point.context.question}${answer}${verdict}`;
  }
  const stop = point.polarity === 'stopped' ? 'stopped' : 'did not stop';
  const summary = point.context.summary ? `  ${point.context.summary}` : '';
  // The disposition-specific hold finding: what made the human own this crossing
  // (the design keeps the three dispositions "distinct in context"). Named
  // inline so a held-high point is judgeable — "was that high worth stopping?" —
  // without a separate --list --json read.
  const highs = point.context.humanDecisions.filter((d) => d.severity === 'high');
  const findings = highs.length > 0 ? `  ⚑ ${highs.map((d) => d.title).join('; ')}` : '';
  const rejected = point.context.rejectionCount > 0 ? `  rejected ${point.context.rejectionCount}x before approval` : '';
  return `${point.key}  ${point.phase}  gate:${point.disposition}  ${stop}${summary}${findings}${rejected}${verdict}`;
}

function renderList(state: RunState, points: DecisionPoint[], notes: string[], json: boolean): string {
  if (json) {
    return JSON.stringify({ runId: state.runId, points, grades: state.grades ?? [], notes }, null, 2);
  }
  const lines = [`decision points for ${state.runId}`];
  if (points.length === 0) lines.push('  none');
  for (const point of points) lines.push(`  ${pointLine(point, existingGrade(state, point.key))}`);
  for (const grade of state.grades ?? []) {
    if (grade.key.startsWith('missed:')) lines.push(`  ${grade.key}  missed stop  ${grade.note ?? ''} [wrong]`);
  }
  for (const note of notes) lines.push(`\nnote: ${note}`);
  return lines.join('\n');
}

function knownPointKeys(points: readonly DecisionPoint[], state: RunState): Set<string> {
  return new Set([...points.map((p) => p.key), ...(state.grades ?? []).filter((g) => g.key.startsWith('missed:')).map((g) => g.key)]);
}

function phaseNames(state: RunState): Set<string> {
  return new Set(phasesOf(workflowFor(state)).map((p) => p.name));
}

function parseMissed(raw: string, state: RunState): Grade | string {
  const parsed = parseAssignment(raw, '--missed');
  if (typeof parsed === 'string') return parsed;
  const colon = parsed.key.indexOf(':');
  if (colon === -1) return `--missed ${raw}: expected <phase>:<id>=<description>`;
  const phase = parsed.key.slice(0, colon);
  const id = parsed.key.slice(colon + 1);
  if (!phase || !id) return `--missed ${raw}: phase and id are required`;
  if (!phaseNames(state).has(phase)) return `--missed ${raw}: unknown phase "${phase}" for workflow ${state.workflow}`;
  if (!parsed.value.trim()) return `--missed ${raw}: description is required`;
  return { key: `missed:${phase}:${id}`, verdict: 'wrong', note: parsed.value, gradedAt: '' };
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** The plain verdict question, phrased by polarity (design §"The walkthrough"). */
function verdictPrompt(point: DecisionPoint): string {
  return point.polarity === 'stopped' ? 'was stopping here right?' : 'should this have stopped you?';
}

async function runInteractiveWalkthrough(
  state: RunState,
  points: DecisionPoint[],
  notes: string[],
  io: Required<Pick<GradeCommandIo, 'ask' | 'now'>>,
): Promise<string> {
  const lines = [`grading ${state.runId}`];
  // Coverage notes lead the ritual so the human knows the point set was shrunk
  // (a missing log, dropped questions) BEFORE grading — the walkthrough must
  // not present a partial set as if it were complete (design §Test standards,
  // "a shrunken point set with an empty notes is the bug this guards").
  for (const note of notes) lines.push(`note: ${note}`);
  // Consumed once, on the first prompt shown (a point, or the missed-stop prompt
  // when there are no points), so it reaches the interactive human live rather
  // than only in the trailing transcript.
  let preamble = notes.length > 0 ? `${notes.map((n) => `note: ${n}`).join('\n')}\n\n` : '';
  for (const point of points) {
    const context = pointLine(point, existingGrade(state, point.key));
    lines.push(context);
    const answer = (await io.ask(`${preamble}${context}\n  ${verdictPrompt(point)} right/wrong/skip: `)).trim().toLowerCase();
    preamble = '';
    if (answer !== 'right' && answer !== 'wrong') continue;
    const note = (await io.ask(`  note for ${point.key} (blank ok): `)).trim();
    upsertGrade(state, {
      key: point.key,
      verdict: answer,
      ...(note ? { note } : {}),
      gradedAt: io.now().toISOString(),
    });
  }
  // The missed-stop lead — the half of the signal a generous pass skips: shown
  // once, before the first missed prompt, with the question that surfaces an FN.
  let missedLead =
    "any stop that SHOULD have happened but didn't? Check the run's autonomous calls against the triage rules — a merge target chosen, an environment step assumed, scope quietly absorbed. All-right with no missed stops teaches the calibration nothing.\n";
  for (;;) {
    const missed = (await io.ask(`${preamble}${missedLead}missed stop <phase>:<id>=<description> (blank to finish): `)).trim();
    preamble = '';
    missedLead = '';
    if (!missed) break;
    const parsed = parseMissed(missed, state);
    if (typeof parsed === 'string') {
      lines.push(parsed);
      continue;
    }
    upsertGrade(state, { ...parsed, gradedAt: io.now().toISOString() });
  }
  lines.push('grades recorded');
  return lines.join('\n');
}

function applyNonTtyWrites(state: RunState, points: DecisionPoint[], opts: GradeCommandOptions, now: Date): string | undefined {
  const keys = knownPointKeys(points, state);
  const notes = new Map<string, string>();
  for (const raw of opts.note ?? []) {
    const parsed = parseAssignment(raw, '--note');
    if (typeof parsed === 'string') return parsed;
    notes.set(parsed.key, parsed.value);
  }

  for (const raw of opts.set ?? []) {
    const parsed = parseAssignment(raw, '--set');
    if (typeof parsed === 'string') return parsed;
    if (parsed.value !== 'right' && parsed.value !== 'wrong') return `--set ${raw}: verdict must be right or wrong`;
    if (!keys.has(parsed.key)) return `--set ${raw}: unknown decision point key`;
    const prev = existingGrade(state, parsed.key);
    upsertGrade(state, {
      key: parsed.key,
      verdict: parsed.value,
      ...(notes.has(parsed.key) ? { note: notes.get(parsed.key)! } : prev?.note ? { note: prev.note } : {}),
      gradedAt: now.toISOString(),
    });
  }

  for (const raw of opts.note ?? []) {
    const parsed = parseAssignment(raw, '--note');
    if (typeof parsed === 'string') return parsed;
    if ((opts.set ?? []).some((set) => set.startsWith(`${parsed.key}=`))) continue;
    const prev = existingGrade(state, parsed.key);
    if (!prev) return `--note ${raw}: note-only updates require an existing grade or a matching --set`;
    upsertGrade(state, { ...prev, note: parsed.value, gradedAt: now.toISOString() });
  }

  for (const raw of opts.missed ?? []) {
    const parsed = parseMissed(raw, state);
    if (typeof parsed === 'string') return parsed;
    upsertGrade(state, { ...parsed, gradedAt: now.toISOString() });
  }
  return undefined;
}

export async function gradeCommand(
  cwd: string,
  runId: string | undefined,
  opts: GradeCommandOptions,
  io: GradeCommandIo = {},
): Promise<GradeCommandResult> {
  const target = resolveTarget(cwd, runId);
  if (typeof target === 'string') return { ok: false, error: target };
  const state = target;
  const discovery = decisionPoints(state, readOrchestratorLog(state));
  const hasWrites = Boolean((opts.set?.length ?? 0) + (opts.note?.length ?? 0) + (opts.missed?.length ?? 0));
  const position = probeRunPosition(state);

  if (opts.list) return { ok: true, output: renderList(state, discovery.points, discovery.notes, Boolean(opts.json)) };
  if (position.kind === 'running') {
    return { ok: false, error: `run ${state.runId} is actively running (pid ${position.pid}); grade writes are refused while the driver owns state.json. Use --list for a read-only view, or grade after the run stops.` };
  }

  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY);
  const now = io.now ?? (() => new Date());
  // Coverage notes ride every write path, not just --list — a scripted or
  // interactive grader must see a shrunken point set, never a rosy silent one.
  const noteBlock = discovery.notes.length > 0 ? `${discovery.notes.map((n) => `note: ${n}`).join('\n')}\n` : '';
  if (hasWrites) {
    const error = applyNonTtyWrites(state, discovery.points, opts, now());
    if (error) return { ok: false, error };
    const warning = runId && position.kind !== 'done' ? `warning: run ${state.runId} is ${position.kind}; later stops may not be in the record yet.\n` : '';
    return { ok: true, output: `${warning}${noteBlock}grades recorded for ${state.runId}` };
  }
  if (!isTTY) {
    return { ok: false, error: 'non-interactive grading needs --list, --set <key>=right|wrong, or --missed <phase>:<id>=<description>' };
  }
  const warning = runId && position.kind !== 'done' ? `warning: run ${state.runId} is ${position.kind}; later stops may not be in the record yet.\n` : '';
  const output = await runInteractiveWalkthrough(state, discovery.points, discovery.notes, { ask: io.ask ?? defaultAsk, now });
  return { ok: true, output: `${warning}${output}` };
}
