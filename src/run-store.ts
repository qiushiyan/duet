import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Snapshot } from 'xstate';
import type { RoleBindings } from './config.ts';
import type { GatePhase, PhaseName } from './phases.ts';

/**
 * Per-run working data under `.duet/runs/<run_id>/` in the target project —
 * the one module that reads and writes it.
 *
 * The state file is a fast-access HINT — the source of truth is the three
 * JSONL transcripts in the providers' standard locations (augmentation
 * principle). Everything here must stay human-readable and survivable: the
 * user can stop duet mid-run, continue manually with `claude --resume` /
 * `codex exec resume`, and come back (or never).
 *
 * Concurrency model: at most one process writes at a time (the CLI stages
 * input, then hands off to the detached driver — the pid guard enforces the
 * handoff), but several RunState copies can be alive in one process. The
 * discipline: re-`loadRunState` after any point where another component may
 * have written (the lifecycle loop does this at each quiescence), and treat
 * a loaded copy as stale once you hand control away.
 */

export type Voice = 'orchestrator' | 'implementer' | 'reviewer';

/** Human input staged by the CLI for the next driver invocation to consume. */
export interface HumanMessage {
  kind: 'answer' | 'feedback';
  text: string;
}

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
  /**
   * Phases whose gates the human attends (gates_at — docs/automation-design.md
   * §"Gate pre-authorization"). Absent = every gate attended (the default and
   * the pre-feature behavior). Gates of phases not listed are pre-authorized:
   * the harness records the packet, notifies, and auto-approves. `pr` is
   * always present — the Open-PR gate cannot be pre-authorized.
   */
  gatesAt?: GatePhase[];
  /** Gates auto-crossed under pre-authorization, for the morning review. */
  autoApprovals?: Array<{ gate: string; at: string }>;

  /** Mirror of the machine's state value, for humans and `duet status`. */
  machineState?: string;
  orchestratorSessionId?: string;
  workerSessions: Partial<Record<'implementer' | 'reviewer', string>>;

  /** Which phases have had their entry prompt sent (drives entry-vs-resume). */
  phaseStarted: Partial<Record<PhaseName, true>>;
  /** Review rounds run per phase (backstop caps compare against this). */
  rounds: Partial<Record<PhaseName, number>>;
  /**
   * Base snippet tags sent per phase per worker. Drives the once-per-phase
   * template discipline: a duplicate full-template send gets a warn-once
   * steering refusal, and list_snippets annotates already-sent snippets.
   */
  sentSnippets?: Partial<Record<PhaseName, Partial<Record<'implementer' | 'reviewer', string[]>>>>;
  /** advance_phase outputs, shown at gates. */
  phaseSummaries: Partial<Record<PhaseName, { summary: string; artifacts: string[] }>>;

  /** A queued ask_human flag awaiting `duet continue --answer`. */
  pendingQuestion?: { question: string; context?: string };
  /** Staged human input — written via stageHumanInput, read via consumeHumanInput. */
  pendingMessage?: HumanMessage;

  costs: {
    orchestratorUsd: number;
    claudeWorkersUsd: number;
    codexTokens: { input: number; output: number };
  };
  snippetProposals: Array<{ snippetKey: string; proposedBody: string; rationale: string; at: string }>;
  lastActivity?: string;
}

/**
 * Whether a phase's exit gate is attended by the human (vs pre-authorized at
 * run start). Absent gatesAt means every gate is attended; the Open-PR gate
 * is attended unconditionally.
 */
export function gateAttended(state: RunState, phase: GatePhase): boolean {
  if (phase === 'pr') return true;
  return state.gatesAt === undefined || state.gatesAt.includes(phase);
}

/**
 * Create `.duet/` with a self-ignoring `.gitignore` (`*`) so duet's runtime
 * artifacts never show up in the project's git status. The user's own
 * .gitignore is never touched (augmentation principle); committing a run
 * record deliberately stays possible with `git add -f`.
 */
export function ensureDuetDir(cwd: string): string {
  const dir = join(cwd, '.duet');
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}

export function runsRoot(cwd: string): string {
  return join(cwd, '.duet', 'runs');
}

export function runDirOf(cwd: string, runId: string): string {
  return join(runsRoot(cwd), runId);
}

const STATE_FILE = 'state.json';
const SNAPSHOT_FILE = 'machine.json';

/**
 * Write-temp-then-rename so a crash mid-write never corrupts the previous
 * version — state.json and machine.json are exactly what crash recovery
 * reads, so they must never be half-written.
 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function createRun(opts: {
  cwd: string;
  specPath?: string;
  /** The framing body the orchestrator sees (frontmatter already stripped). */
  framing?: string;
  /** The verbatim file the human wrote, for the run-dir archive. */
  framingRaw?: string;
  branch?: string;
  bindings: RoleBindings;
  gatesAt?: GatePhase[];
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
    ...(opts.gatesAt ? { gatesAt: opts.gatesAt } : {}),
    workerSessions: {},
    phaseStarted: {},
    rounds: {},
    phaseSummaries: {},
    costs: { orchestratorUsd: 0, claudeWorkersUsd: 0, codexTokens: { input: 0, output: 0 } },
    snippetProposals: [],
  };
  ensureDuetDir(opts.cwd);
  const dir = runDirOf(opts.cwd, runId);
  mkdirSync(dir, { recursive: true });
  saveRunState(state);
  // The run dir is self-contained: the framing is archived next to the logs
  // (state.json also embeds it, but the file is the human-readable artifact).
  const archive = opts.framingRaw ?? opts.framing;
  if (archive) writeFileSync(join(dir, 'framing.md'), archive);
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
  atomicWrite(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

/**
 * Stage human input (a gate rejection's feedback, or an answer to a queued
 * question) for the next driver invocation. One half of the CLI→driver
 * handshake; consumeHumanInput is the other.
 */
export function stageHumanInput(state: RunState, message: HumanMessage): void {
  state.pendingMessage = message;
  saveRunState(state);
}

/**
 * Consume the staged human input, if any. An answer also clears the pending
 * question it answers. Persists immediately so a crash can't replay the
 * input into a second invocation.
 */
export function consumeHumanInput(state: RunState): HumanMessage | undefined {
  const message = state.pendingMessage;
  delete state.pendingMessage;
  if (message?.kind === 'answer') delete state.pendingQuestion;
  saveRunState(state);
  return message;
}

/**
 * The statechart snapshot (xstate's persisted form), written only at
 * quiescent states. Typed as Snapshot<unknown> at this boundary so hydration
 * sites can pass it straight to createActor without casts.
 */
export function saveMachineSnapshot(state: RunState, snapshot: Snapshot<unknown>): void {
  atomicWrite(join(runDirOf(state.cwd, state.runId), SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2) + '\n');
}

export function loadMachineSnapshot(state: RunState): Snapshot<unknown> | undefined {
  const path = join(runDirOf(state.cwd, state.runId), SNAPSHOT_FILE);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot<unknown>;
}

/**
 * One append-only log per voice (docs/automation-design.md §"Visualization").
 * Plain text, inspectable without duet; `--tmux` (src/tmux-view.ts) opens
 * panes running `tail -n +1 -F` on these files.
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
