import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RoleBindings } from './config.ts';

/**
 * Per-run working data under `.duet/runs/<run_id>/` in the target project.
 *
 * The state file is a fast-access HINT — the source of truth is the three
 * JSONL transcripts in the providers' standard locations (augmentation
 * principle). Everything here must stay human-readable and survivable: the
 * user can stop duet mid-run, continue manually with `claude --resume` /
 * `codex exec resume`, and come back (or never).
 */

export type PhaseName = 'frame' | 'spec' | 'plan' | 'impl' | 'docs' | 'pr' | 'open';
export type Voice = 'orchestrator' | 'implementer' | 'reviewer';

export interface RunState {
  runId: string;
  createdAt: string;
  /** Project root the run operates on (workers and orchestrator run here). */
  cwd: string;
  /**
   * Path to the spec, relative to cwd. Set at creation on spec-entry runs;
   * on framing-only entry it's recorded when the spec phase advances
   * (the orchestrator reports it via advance_phase's spec_path).
   */
  specPath?: string;
  /** Project briefing from --framing — the only place project knowledge enters. */
  framing?: string;
  /** The run's working branch (captured at creation; updated by create_branch). */
  branch?: string;
  bindings: RoleBindings;

  /** Mirror of the machine's state value, for humans and `duet status`. */
  machineState?: string;
  orchestratorSessionId?: string;
  workerSessions: Partial<Record<'implementer' | 'reviewer', string>>;

  /** Which phases have had their entry prompt sent (drives entry-vs-resume). */
  phaseStarted: Partial<Record<PhaseName, true>>;
  /** Review rounds run per phase (backstop caps compare against this). */
  rounds: Partial<Record<PhaseName, number>>;
  /** advance_phase outputs, shown at gates. */
  phaseSummaries: Partial<Record<PhaseName, { summary: string; artifacts: string[] }>>;

  /** A queued ask_human flag awaiting `duet continue --answer`. */
  pendingQuestion?: { question: string; context?: string };
  /** Human input written by the CLI for the next driver invocation to consume. */
  pendingMessage?: { kind: 'answer' | 'feedback'; text: string };

  costs: {
    orchestratorUsd: number;
    claudeWorkersUsd: number;
    codexTokens: { input: number; output: number };
  };
  snippetProposals: Array<{ snippetKey: string; proposedBody: string; rationale: string; at: string }>;
  lastActivity?: string;
}

export function runsRoot(cwd: string): string {
  return join(cwd, '.duet', 'runs');
}

export function runDirOf(cwd: string, runId: string): string {
  return join(runsRoot(cwd), runId);
}

const STATE_FILE = 'state.json';
const SNAPSHOT_FILE = 'machine.json';

export function createRun(opts: {
  cwd: string;
  specPath?: string;
  framing?: string;
  branch?: string;
  bindings: RoleBindings;
}): RunState {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const runId = `${stamp}-${randomBytes(2).toString('hex')}`;
  const state: RunState = {
    runId,
    createdAt: now.toISOString(),
    cwd: opts.cwd,
    ...(opts.specPath ? { specPath: opts.specPath } : {}),
    ...(opts.framing ? { framing: opts.framing } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
    bindings: opts.bindings,
    workerSessions: {},
    phaseStarted: {},
    rounds: {},
    phaseSummaries: {},
    costs: { orchestratorUsd: 0, claudeWorkersUsd: 0, codexTokens: { input: 0, output: 0 } },
    snippetProposals: [],
  };
  const dir = runDirOf(opts.cwd, runId);
  mkdirSync(dir, { recursive: true });
  saveRunState(state);
  appendNote(state, 'human', `run created (${opts.specPath ? `spec: ${opts.specPath}` : 'framing-only entry'})`);
  return state;
}

export function loadRunState(cwd: string, runId: string): RunState {
  const path = join(runDirOf(cwd, runId), STATE_FILE);
  if (!existsSync(path)) throw new Error(`no run state at ${path} — is ${runId} a run of this project?`);
  return JSON.parse(readFileSync(path, 'utf8')) as RunState;
}

export function saveRunState(state: RunState): void {
  const dir = runDirOf(state.cwd, state.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

export function saveMachineSnapshot(state: RunState, snapshot: unknown): void {
  writeFileSync(join(runDirOf(state.cwd, state.runId), SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2) + '\n');
}

export function loadMachineSnapshot(state: RunState): unknown | undefined {
  const path = join(runDirOf(state.cwd, state.runId), SNAPSHOT_FILE);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * One append-only log per voice (docs/automation-design.md §"Visualization").
 * Plain text, inspectable without duet; a future `--tmux` opens panes running
 * `tail -n +1 -F` on these files.
 */
export function appendVoiceLog(state: RunState, voice: Voice, header: string, body?: string): void {
  const path = join(runDirOf(state.cwd, state.runId), `${voice}.log`);
  const stamp = new Date().toISOString();
  const block = body === undefined ? `[${stamp}] ${header}\n` : `[${stamp}] ${header}\n${body}\n\n`;
  appendFileSync(path, block);
}

/** The Q10 notes-file convention, written by both the human and the orchestrator. */
export function appendNote(state: RunState, author: 'human' | 'orchestrator', note: string): void {
  const path = join(runDirOf(state.cwd, state.runId), 'notes.md');
  appendFileSync(path, `- ${new Date().toISOString()} [${author}] ${note}\n`);
}

export function listRuns(cwd: string): RunState[] {
  const root = runsRoot(cwd);
  if (!existsSync(root)) return [];
  const runs: RunState[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      runs.push(loadRunState(cwd, entry.name));
    } catch {
      // Not a run dir (or corrupt state) — skip rather than break the listing.
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function latestRun(cwd: string): RunState | undefined {
  return listRuns(cwd)[0];
}
