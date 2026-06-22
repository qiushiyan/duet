import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Snapshot } from 'xstate';
import type { RoleBindings } from './config.ts';
import { PHASE, WORKFLOWS, defaultPosture, defaultPreAuthorizedOf, gatePhasesOf } from './phases.ts';
import type { GatePhase, PhaseName, WorkflowName } from './phases.ts';
import type { ContextUsage, WorkerRole } from './providers/types.ts';
import { locateSessionTranscripts } from './sessions.ts';
import type { ErrorClass, RetryState } from './worker-health.ts';

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

/**
 * A structured echo of a genuine human decision a gate carries (#3) — what the
 * orchestrator would otherwise write only in prose. SIGNAL-ONLY: the human /
 * concierge reads it to decide hold-vs-relay; duet never reads it in the
 * gate-crossing path (gates cross only on the human's tap). `high` = a real
 * product/direction call the human must make; `low` = notable, not blocking.
 */
export interface HumanDecision {
  title: string;
  severity: 'low' | 'high';
}

/**
 * Human input staged by the CLI for the next driver invocation to consume.
 * `answer` resolves a queued question; `feedback` rides a gate rejection
 * back into the same phase; `approval` is a rider on a gate approval —
 * agreement with the direction plus adjustments, carried into the next
 * phase's entry prompt as gate feedback in approving form.
 */
export interface HumanMessage {
  kind: 'answer' | 'feedback' | 'approval';
  text: string;
}

/**
 * The persisted terminal decision of a phase — set by the first of
 * advance_phase/ask_human in a turn, written atomically with the gate packet
 * (phaseSummaries) or queued question (pendingQuestion) it carries. This is
 * the one cross-process channel for "which phase.* event to emit at
 * quiescence": the in-process driver reads it off its live RunState, the
 * stdio host runner reads it off disk after the orchestrator session quiesces.
 * It is honored only when `phase` matches the running phase (markerToEvent),
 * and cleared in driveToQuiescence after the resulting snapshot is durable
 * (deliver-before-clear), so a crash across the non-transactional
 * state.json/machine.json boundary re-delivers rather than loses the event.
 */
export interface TerminalMarker {
  phase: PhaseName;
  kind: 'advance' | 'flag';
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
  /**
   * Which workflow arc this run is on (additive — set at creation). A missing
   * value (a pre-feature or hand-written state.json) resolves to `'full'` via
   * `workflowOf`; old state files are never rewritten on read.
   */
  workflow?: WorkflowName;
  /** Project briefing from --framing — the only place project knowledge enters. */
  framing?: string;
  /** The run's working branch (captured at creation; updated by create_branch). */
  branch?: string;
  bindings: RoleBindings;
  /**
   * The resolved per-turn budget multiplier (#3a — account/billing posture, the
   * same family as the bindings' `transport`). FROZEN at creation, never mutated
   * (the lifetime contrast with mutable `gatesAt` — billing posture does not
   * change mid-run). Absent ⇒ OFF: `budgetFor` returns undefined caps and no
   * `--max-budget-usd`/orchestrator cap is set. A positive number scales the
   * per-phase profile ("default" resolves to 1); it is never `0`.
   */
  budget?: number;
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
  /**
   * Set by `duet abandon`: the human deliberately stopped this run. The marker
   * exists so a deliberate kill isn't read as a crash — `probeRunPosition`
   * short-circuits to an `abandoned` position instead of `crashed`. The
   * transcripts stay intact, so the run is still revivable (`duet continue`
   * clears the marker; `duet takeover` is unaffected) — abandonment is
   * reversible, per docs/automation-design.md §"Ending a run". `--purge`
   * removes the run outright instead of marking it.
   */
  abandoned?: { at: string };
  /**
   * Set by `duet orchestrate` when the human's interactive Claude Code session
   * is the orchestrator for this run (FRAME → PLAN). A run-level marker, NOT a
   * config role-binding (src/config.ts stays role→provider/model only). Two
   * readers: `duet continue` chooses the interactive rest-vs-handoff path from
   * it, and `probeRunPosition` reads a resting phase-loop snapshot as
   * interactive-active rather than crashed. Cleared at the plan-gate handoff to
   * headless impl (and the `--headless` fallback); absent on every headless run,
   * so the headless path is byte-for-byte unchanged. Never traps a run —
   * `takeover`/`abandon` ignore it.
   */
  orchestrationHost?: 'interactive';

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
  phaseSummaries: Partial<Record<PhaseName, { summary: string; artifacts: string[]; humanDecisions?: HumanDecision[] }>>;

  /**
   * Persisted hint: which worker has a turn in flight right now, set at a
   * send_prompt turn's start and cleared in its `finally`. A SEPARATE process
   * (`duet doctor`) reads it to tell `long-inference` from `idle`, reconciled
   * against driver liveness — an entry under a dead driver is an interrupted
   * turn, not a live one. Distinct from the in-memory `turnsInFlight`
   * concurrency guard, which never persists. A hint like everything here:
   * stale-after-crash is acceptable because doctor cross-checks it.
   */
  activeTurns?: Partial<Record<WorkerRole, { tag: string; startedAt: string }>>;
  /**
   * The interactive-host pending-turn lifecycle projection (async send_prompt):
   * a dispatched worker turn carried through `running` → `ready`|`failed` →
   * (removed at collect). Distinct from `activeTurns` (which stays doctor's
   * running/idle health hint): this carries a STATUS and is the durable signal
   * the same-role guard, the phase-exit gate, the reconnect-orphan detection,
   * and `duet status --wait` all read. Written only by the lease-holding
   * run-scoped server, via the markPendingTurn / settlePendingTurn /
   * clearPendingTurn mutators (the fresh-load → mutate-this-role → save
   * discipline of markTurnActive). Absent on the headless host, which never
   * leaves a turn in flight.
   */
  pendingTurns?: Partial<Record<WorkerRole, { tag: string; startedAt: string; status: 'running' | 'ready' | 'failed' }>>;
  /**
   * The branch-fixed-after-first-prompt flag, durable and ONE-WAY: set at the
   * first async dispatch, never cleared. create_branch reads it so the branch
   * stays fixed through the dispatched-but-uncollected window (and even if that
   * first turn fails and its pending record is cleared) — a worker prompt was
   * issued, so the one-branch-per-run invariant has bound the branch. Headless
   * never sets it (it reads workerSessions, written at settle, which suffices
   * there because the blocking call never returns mid-turn).
   */
  workerDispatched?: true;
  /**
   * A queued flag awaiting `duet continue --answer`. `cause` distinguishes the
   * supervisor's actual decision — escalate vs resume/retry: `human` (an
   * ask_human-originated question — product, environment, blocker, or
   * "asked twice" escalation, all human-owned), `infra` (a caught infrastructure
   * failure), or `budget` (the orchestrator itself hit its cost cap — a real
   * stop, but resumable: raise the budget / resume, never an infra-retry and
   * never a product question). `errorClass` (taxonomy class) is infra-only —
   * absent for a budget stop, since budget is not an infra class. Absent cause =
   * pre-feature flags (read as human-owned).
   */
  pendingQuestion?: { question: string; context?: string; cause?: 'human' | 'infra' | 'budget'; errorClass?: ErrorClass };
  /**
   * Opt-in bounded auto-retry of transient infra failures (#4b) — the attempt
   * budget. 0/absent ⇒ off (the default; behavior is byte-for-byte as before).
   * Set from `--retry-infra <n>` or framing `retry_infra:`.
   */
  retryInfra?: number;
  /** The per-episode retry budget state — persisted so the cap holds across a driver re-spawn; reset on a clean phase outcome. */
  retryState?: RetryState;
  /** Staged human input — written via stageHumanInput, read via consumeHumanInput. */
  pendingMessage?: HumanMessage;
  /**
   * The phase's terminal decision (advance/flag), written by the first
   * advance_phase/ask_human in a turn and consumed at quiescence. See
   * TerminalMarker; absent in the normal continue/nudge/crash paths.
   */
  terminalMarker?: TerminalMarker;

  costs: {
    orchestratorUsd: number;
    /**
     * True once the orchestrator ran on the interactive host (the human's
     * Claude Code session, flat subscription quota — no `total_cost_usd`), so
     * `orchestratorUsd` is partial/unmetered. Sticky: set at launch and NEVER
     * cleared, because the fact that orchestrator spend went unmetered must
     * outlive the plan-gate handoff that clears `orchestrationHost`. Mirrors
     * claudeWorkersCostPartial; never overload orchestratorUsd.
     */
    orchestratorCostPartial: boolean;
    /**
     * The KNOWN claude-worker cost. A turn reports `costUsd` only when the
     * provider includes it (headless does; the interactive transport omits it
     * by P5 — cost shown unavailable, never faked). When any claude turn
     * reports no cost, `claudeWorkersCostPartial` flips so consumers never read
     * this sum as the complete total.
     */
    claudeWorkersUsd: number;
    /** True once a claude-worker turn reported no cost — the claudeWorkersUsd total is partial/unknown. */
    claudeWorkersCostPartial: boolean;
    codexTokens: { input: number; output: number };
  };
  /**
   * Context-window fill per voice, captured at turn boundaries (claude roles
   * report it in-band; codex from its rollout tail). A hint like everything
   * here — stale after manual takeover turns, refreshed on the next driven
   * turn.
   */
  contextUsage?: Partial<Record<Voice, ContextUsage & { at: string }>>;
  snippetProposals: Array<{ snippetKey: string; proposedBody: string; rationale: string; at: string }>;
  lastActivity?: string;
}

/** The run's workflow, defaulting a missing/pre-feature value to `'full'`. */
export function workflowOf(state: RunState): WorkflowName {
  return state.workflow ?? 'full';
}

/**
 * Whether a phase's exit gate is attended by the human (vs pre-authorized at
 * run start). Absent gatesAt means every gate is attended; the workflow's
 * force-attended gates (Full's Open-PR gate) are attended unconditionally.
 */
export function gateAttended(state: RunState, phase: GatePhase): boolean {
  if ((WORKFLOWS[workflowOf(state)].forceAttend as readonly string[]).includes(phase)) return true;
  return state.gatesAt === undefined || state.gatesAt.includes(phase);
}

/**
 * The effective per-turn budget caps for a phase — the one source every worker-
 * and orchestrator-construction site reads, replacing direct
 * `PHASE[phase].*BudgetUsd` reads. A cap is a number, or `undefined` when off.
 * The opt-in knob (#3a) is `state.budget`: absent ⇒ OFF (both caps undefined,
 * the maintainer's default), else the per-phase profile scaled by the frozen
 * multiplier. Lives beside gateAttended: both resolve run-state policy against
 * the phase registry.
 */
export function budgetFor(
  state: RunState,
  phase: PhaseName,
): { worker: number | undefined; orchestrator: number | undefined } {
  if (state.budget === undefined) return { worker: undefined, orchestrator: undefined };
  return {
    worker: PHASE[phase].workerBudgetUsd * state.budget,
    orchestrator: PHASE[phase].orchestratorBudgetUsd * state.budget,
  };
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
  /** The run's workflow arc (absent ⇒ the `full` default via `workflowOf`). */
  workflow?: WorkflowName;
  specPath?: string;
  /** The framing body the orchestrator sees (frontmatter already stripped). */
  framing?: string;
  /** The verbatim file the human wrote, for the run-dir archive. */
  framingRaw?: string;
  branch?: string;
  bindings: RoleBindings;
  /** The resolved per-turn budget multiplier (frozen here; absent ⇒ off). */
  budget?: number;
  gatesAt?: GatePhase[];
  retryInfra?: number;
}): RunState {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const runId = `${stamp}-${randomBytes(2).toString('hex')}`;
  // Materialize the default gate posture at creation: an explicit gatesAt wins
  // (including an explicit `[]` attend-none — nullish, not truthy), else the
  // workflow's default-pre-authorized inverse. While defaultPreAuthorized is
  // empty this stays undefined, so a default run keeps absent gatesAt = the
  // pre-feature attend-all, written byte-for-byte as before.
  const wf = opts.workflow ?? 'full';
  const gatesAt = opts.gatesAt ?? defaultPosture(gatePhasesOf(wf), defaultPreAuthorizedOf(wf));
  const state: RunState = {
    runId,
    createdAt: now.toISOString(),
    cwd: opts.cwd,
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    ...(opts.specPath ? { specPath: opts.specPath } : {}),
    ...(opts.framing ? { framing: opts.framing } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
    bindings: opts.bindings,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(gatesAt ? { gatesAt } : {}),
    ...(opts.retryInfra ? { retryInfra: opts.retryInfra } : {}),
    workerSessions: {},
    phaseStarted: {},
    rounds: {},
    phaseSummaries: {},
    costs: { orchestratorUsd: 0, orchestratorCostPartial: false, claudeWorkersUsd: 0, claudeWorkersCostPartial: false, codexTokens: { input: 0, output: 0 } },
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
 * Mark a worker's turn in flight (the `activeTurns` hint), and clear it — each
 * via fresh load → mutate THIS role's entry → save, the same result-merge
 * discipline `send_prompt` uses, so a concurrent cross-role send can never
 * clobber the sibling role's entry with a stale full-object save. The passed
 * copy is updated too, so in-process reads after the call stay consistent.
 */
export function markTurnActive(state: RunState, role: WorkerRole, tag: string): void {
  const entry = { tag, startedAt: new Date().toISOString() };
  const fresh = loadRunState(state.cwd, state.runId);
  (fresh.activeTurns ??= {})[role] = entry;
  saveRunState(fresh);
  (state.activeTurns ??= {})[role] = entry;
}

export function clearTurnActive(state: RunState, role: WorkerRole): void {
  const fresh = loadRunState(state.cwd, state.runId);
  if (fresh.activeTurns?.[role]) {
    delete fresh.activeTurns[role];
    saveRunState(fresh);
  }
  if (state.activeTurns) delete state.activeTurns[role];
}

/**
 * The interactive pending-turn lifecycle mutators — each a fresh-load → mutate
 * THIS role's record → save, the same discipline as markTurnActive, so a
 * concurrent cross-role write never clobbers the sibling role's record. The
 * passed copy is re-synced so in-process reads after the call stay consistent.
 *
 * markPendingTurn (status `running`, at dispatch) · settlePendingTurn (→ `ready`
 * | `failed`, at worker-settle) · clearPendingTurn (at collect, or to resolve an
 * orphan). markWorkerDispatched sets the one-way branch-fixed flag.
 */
export function markPendingTurn(state: RunState, role: WorkerRole, tag: string): void {
  const entry = { tag, startedAt: new Date().toISOString(), status: 'running' as const };
  const fresh = loadRunState(state.cwd, state.runId);
  (fresh.pendingTurns ??= {})[role] = entry;
  saveRunState(fresh);
  (state.pendingTurns ??= {})[role] = entry;
}

export function settlePendingTurn(state: RunState, role: WorkerRole, status: 'ready' | 'failed'): void {
  const fresh = loadRunState(state.cwd, state.runId);
  const entry = fresh.pendingTurns?.[role];
  if (entry) {
    entry.status = status;
    saveRunState(fresh);
  }
  if (state.pendingTurns?.[role]) state.pendingTurns[role].status = status;
}

export function clearPendingTurn(state: RunState, role: WorkerRole): void {
  const fresh = loadRunState(state.cwd, state.runId);
  if (fresh.pendingTurns?.[role]) {
    delete fresh.pendingTurns[role];
    saveRunState(fresh);
  }
  if (state.pendingTurns) delete state.pendingTurns[role];
}

export function markWorkerDispatched(state: RunState): void {
  if (state.workerDispatched) return;
  const fresh = loadRunState(state.cwd, state.runId);
  fresh.workerDispatched = true;
  saveRunState(fresh);
  state.workerDispatched = true;
}

const OWNER_FILE = 'mcp-owner.json';

/**
 * The single-writer lease for the run-scoped interactive MCP server
 * (mcp-server.ts) — the interactive analogue of the headless `driver.pid`
 * guard. A run-dir file, NOT state.json, so it never races the server's own
 * state saves (the same reason driver.pid is its own file). acquireMcpOwner
 * stamps a fresh random nonce and returns it; the newest acquirer wins (last
 * atomic write). holdsMcpOwner(nonce) is true only while that nonce is still
 * the one on disk — so a superseded old server (a process that lingers after a
 * reconnect launches a newer one) reads false and refuses to write, leaving the
 * newest server the sole writer.
 */
export function acquireMcpOwner(state: RunState): string {
  const nonce = randomBytes(8).toString('hex');
  const dir = runDirOf(state.cwd, state.runId);
  mkdirSync(dir, { recursive: true });
  atomicWrite(
    join(dir, OWNER_FILE),
    JSON.stringify({ pid: process.pid, nonce, at: new Date().toISOString() }, null, 2) + '\n',
  );
  return nonce;
}

export function holdsMcpOwner(state: RunState, nonce: string): boolean {
  const path = join(runDirOf(state.cwd, state.runId), OWNER_FILE);
  if (!existsSync(path)) return false;
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as { nonce?: string };
    return owner.nonce === nonce;
  } catch {
    return false; // half-written or foreign — treat as not-held, never throw into a tool call
  }
}

/**
 * Mark a run as deliberately abandoned by the human (`duet abandon`). Stops
 * the position probe from reading the now-dead driver as a crash; the
 * transcripts are left intact so `continue`/`takeover` can still revive it
 * (abandonment is reversible — docs/automation-design.md §"Ending a run").
 * The caller kills the live driver first, so this never races a driver's saves.
 */
export function markAbandoned(state: RunState): void {
  state.abandoned = { at: new Date().toISOString() };
  saveRunState(state);
  appendNote(state, 'human', 'run abandoned (driver stopped; transcripts kept)');
}

export interface PurgeResult {
  /** The `.duet/runs/<id>/` dir that was removed. */
  runDir: string;
  /** The provider session transcripts that were removed (0–3 paths). */
  transcripts: string[];
}

/**
 * Delete everything a run created: its `.duet/runs/<id>/` dir AND the three
 * providers' session transcripts (orchestrator + both workers), located by
 * exact session-id match (src/sessions.ts). This is the one duet operation
 * that removes the user's standard-location CLI artifacts — hence opt-in
 * (`duet abandon --purge`) — so it returns exactly what it removed for the
 * caller to echo. Idempotent and provider-aware: each session is resolved
 * against ITS role's bound provider (roles are provider-decoupled), and
 * missing files are simply absent from the result.
 *
 * Transcripts are gathered from the in-memory state and removed before the run
 * dir, since the dir holds the only copy of the session ids on disk. `home` is
 * injectable (the environment seam, like loadRoleBindings's configPath) so
 * tests resolve transcripts under a tmp dir.
 */
export function purgeRun(state: RunState, home: string = homedir()): PurgeResult {
  const sessions: Array<{ provider: RoleBindings[keyof RoleBindings]['provider']; sessionId: string }> = [];
  if (state.orchestratorSessionId) {
    sessions.push({ provider: state.bindings.orchestrator.provider, sessionId: state.orchestratorSessionId });
  }
  if (state.workerSessions.implementer) {
    sessions.push({ provider: state.bindings.implementer.provider, sessionId: state.workerSessions.implementer });
  }
  if (state.workerSessions.reviewer) {
    sessions.push({ provider: state.bindings.reviewer.provider, sessionId: state.workerSessions.reviewer });
  }

  const transcripts = [
    ...new Set(sessions.flatMap((s) => locateSessionTranscripts(s.provider, s.sessionId, home))),
  ];
  for (const path of transcripts) rmSync(path, { force: true });

  const runDir = runDirOf(state.cwd, state.runId);
  rmSync(runDir, { recursive: true, force: true });
  return { runDir, transcripts };
}

/**
 * A mid-phase note from the human (`duet steer`), staged for delivery to the
 * orchestrator. Steers live OUTSIDE state.json: they arrive while a driver
 * is live and holds its in-memory RunState (saving at every tool call), so a
 * CLI write into the state file would race those saves and get clobbered.
 * One file per steer under `steers/`; consuming renames into
 * `steers/delivered/` — append and drain never collide.
 */
export interface Steer {
  /** Filename under steers/ — the rename handle. Lexicographic = staging order. */
  file: string;
  /** The human's words, verbatim. */
  text: string;
  stagedAt: string;
  /** Best-effort provenance: the phase that was running (or down) at staging time. */
  stagedDuring?: PhaseName;
}

function steersDir(state: RunState): string {
  return join(runDirOf(state.cwd, state.runId), 'steers');
}

/**
 * Stage a steer: an atomic file create (`wx` — never clobbers), logged into
 * the orchestrator voice log so staging is auditable end to end. The name's
 * hrtime suffix keeps same-millisecond stages in order within a process;
 * across processes the timestamp's resolution is already the ordering.
 */
export function stageSteer(state: RunState, text: string, stagedDuring?: PhaseName): Steer {
  const dir = steersDir(state);
  mkdirSync(dir, { recursive: true });
  const stagedAt = new Date().toISOString();
  const stamp = stagedAt.replace(/[-:]/g, '');
  const file = `${stamp}-${String(process.hrtime.bigint()).padStart(20, '0')}.json`;
  const body = { text, stagedAt, ...(stagedDuring ? { stagedDuring } : {}) };
  const steer: Steer = { file, ...body };
  writeFileSync(join(dir, file), JSON.stringify(body, null, 2) + '\n', { flag: 'wx' });
  appendVoiceLog(state, 'orchestrator', `human steer staged${stagedDuring ? ` (during ${stagedDuring})` : ''}`, text);
  return steer;
}

/** Undelivered steers in staging order. Unparseable files are skipped, like listRuns skips corrupt run dirs. */
export function listPendingSteers(state: RunState): Steer[] {
  const dir = steersDir(state);
  if (!existsSync(dir)) return [];
  const steers: Steer[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const body = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as Omit<Steer, 'file'>;
      steers.push({ file: entry.name, ...body });
    } catch {
      // Half-written or foreign file — skip rather than break delivery.
    }
  }
  return steers.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Consume delivered steers: rename into steers/delivered/ (kept, not deleted —
 * the audit trail). ENOENT is swallowed: the orchestrator may issue tool
 * calls in parallel, and a steer the other drain already moved is delivered,
 * not missing.
 */
export function markSteersDelivered(state: RunState, steers: Steer[]): void {
  const dir = steersDir(state);
  const delivered = join(dir, 'delivered');
  mkdirSync(delivered, { recursive: true });
  for (const steer of steers) {
    try {
      renameSync(join(dir, steer.file), join(delivered, steer.file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/** Whole percent of the context window in use (capped at 100). */
export function contextPercent(usage: ContextUsage): number {
  return usage.windowTokens > 0 ? Math.min(100, Math.round((usage.usedTokens / usage.windowTokens) * 100)) : 0;
}

/**
 * Record a voice's context-window fill: mutates the state (the caller owns
 * the save, as with every handler-side mutation) and refreshes the plain-text
 * sidecar `context/<voice>` ("41%") that the tmux pane titles re-read at
 * their refresh interval — a `cat` per interval, no JSON parsing at view time.
 */
export function recordContextUsage(state: RunState, voice: Voice, usage: ContextUsage): void {
  (state.contextUsage ??= {})[voice] = { ...usage, at: new Date().toISOString() };
  const dir = join(runDirOf(state.cwd, state.runId), 'context');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, voice), `${contextPercent(usage)}%\n`);
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

/** The notes file — the run's dogfooding journal, written by both the human and the orchestrator. */
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
