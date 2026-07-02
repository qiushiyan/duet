import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Snapshot } from 'xstate';
import { bindingFor } from './config.ts';
import type { RoleBinding, RoleBindings } from './config.ts';
import { PHASE, WORKFLOWS, defaultPosture, defaultPreAuthorizedOf, gatePhasesOf } from './phases.ts';
import type { GatePhase, PhaseName, WorkflowName } from './phases.ts';
import type { ContextUsage, WorkerRole } from './providers/types.ts';
import { workerRolesFor } from './roles.ts';
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

export type Voice = 'orchestrator' | 'implementer' | 'reviewer' | 'consultant';

/**
 * A structured echo of a genuine human decision a gate carries (#3) — what the
 * orchestrator would otherwise write only in prose. `high` = a real
 * product/direction call the human must make; `low` = notable, not blocking.
 *
 * A `high` WITHHOLDS a non-explicit crossing (consultant reviewer, slice 5): the
 * headless `driveToQuiescence` auto-cross and the one-tap `duet afk` handoff both
 * refuse to manufacture an approval over a `high`, converting it to an attended
 * stop. An EXPLICIT human approval (`duet continue --approve`, crossInteractive)
 * always crosses — blocking the human's own tap would fight the gate model. `low`
 * stays advisory and rides the packet. The single resolver `highDecisionsAt`
 * (beside gateAttended) is what every consumer reads; advance_phase itself stays
 * signal-only (it records a normal advance — the hold lives in the crossing path,
 * not the tool).
 */
export interface HumanDecision {
  title: string;
  severity: 'low' | 'high';
}

/**
 * One context intervention on a worker session (the `contextEvents` ledger).
 * `compact` / `salvage-compact` kept the session (compacted in place);
 * `session-reset` replaced it (the next send seeds fresh); `cutoff` is a turn
 * cut at the context deadline. The in-place vs fresh distinction matters for
 * auditability: a reset breaks manual `--resume` continuity, a compact does not.
 */
export interface ContextEvent {
  kind: 'cutoff' | 'compact' | 'salvage-compact' | 'session-reset';
  role: WorkerRole;
  at: string;
  /** The safety reading (tokens) just before the intervention, when one existed. */
  preTokens?: number;
  windowTokens?: number;
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
   * the pre-feature behavior); a new run materializes a concrete default at
   * createRun (gate phases − the workflow's defaultPreAuthorized). Gates of
   * phases not listed are pre-authorized: the harness records the packet,
   * notifies, and auto-approves. The Open-PR gate is pre-authorized by default
   * now (the PR auto-opens), attended only when `finish` is listed here.
   */
  gatesAt?: GatePhase[];
  /** Gates auto-crossed under pre-authorization, for the morning review. */
  autoApprovals?: Array<{ gate: string; at: string }>;
  /**
   * Infra failures auto-retried under the retry budget (#4b), for the morning
   * review — a SIBLING of autoApprovals, not the gate-shaped field (a retry has no
   * gate and no packet, so forcing it there would lie). Recovered-VISIBLE: count +
   * class + phase is the "is my environment degrading / am I churning" signal.
   */
  autoRetries?: Array<{ phase: PhaseName; errorClass: ErrorClass; attempt: number; at: string }>;
  /**
   * Context interventions on worker sessions, for the morning review — the
   * third "while you were away" ledger beside autoApprovals/autoRetries.
   * Recorded, never silent: a compaction (in place — the session survives), a
   * context-deadline cutoff, an automatic salvage compact, and a session reset
   * (a fresh session — resume history gone) are distinct kinds, so the review
   * can tell maintenance from escalation and a degrading session shows up as a
   * pattern instead of churning invisibly. `preTokens`/`windowTokens` carry the
   * fill just before the intervention where a reading existed.
   */
  contextEvents?: ContextEvent[];
  /**
   * The gateless posture (docs/automation-design.md §"Gate pre-authorization"):
   * a run the owner walks away from start to finish. Set by `--gateless` /
   * `gateless: true`, it is sugar over two orthogonal axes — it materializes
   * `gatesAt: []` (the posture axis: attend nothing) AND flips the consultant to
   * BACKSTOP-ONLY (the consultant axis this flag carries: the bet-level
   * checkpoints — frame/specGate/implGate — don't fire; only the
   * acceptance-contract author + verify run). It changes WHAT PRODUCES holds, not
   * the severity-hold mechanism, which is untouched; the universal verify
   * self-heal still holds a contract that stays broken (the AFK correctness
   * backstop). `ask_human` and the merge remain the two irreducible human points.
   * ADDITIVE and present-only: absent ⇒ not gateless, every surface byte-for-byte
   * as before.
   */
  gateless?: true;
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
  /**
   * The interactive orchestrator's OWN Claude Code session id — the human's
   * session that hosts the orchestrator over the attended arc. Set by
   * runOrchestrate: from `--resume-session <id>` on a warm start (the user
   * attaches the discussion session the framing grew out of), then carried
   * forward so a later `duet orchestrate <runId>` re-attaches the SAME session
   * after a drop instead of starting cold. buildLaunchSpec resumes from it
   * (`claude --resume`); a warm start also flips the kickoff to its transition
   * variant.
   *
   * Deliberately DISTINCT from `orchestratorSessionId` above, which is the
   * HEADLESS driver's in-process SDK orchestrator session (driver.ts resumes it
   * over the SDK) — conflating them would have the post-handoff headless driver
   * try to SDK-resume a human TUI session. ADDITIVE: absent on every run that
   * never warm-started, so cold-interactive and headless launches are unchanged.
   */
  interactiveOrchestratorSessionId?: string;
  workerSessions: Partial<Record<WorkerRole, string>>;

  /** Which phases have had their entry prompt sent (drives entry-vs-resume). */
  phaseStarted: Partial<Record<PhaseName, true>>;
  /** Review rounds run per phase (backstop caps compare against this). */
  rounds: Partial<Record<PhaseName, number>>;
  /**
   * Base snippet tags sent per phase per worker. Drives the once-per-phase
   * template discipline: a duplicate full-template send gets a warn-once
   * steering refusal, and list_snippets annotates already-sent snippets.
   */
  sentSnippets?: Partial<Record<PhaseName, Partial<Record<WorkerRole, string[]>>>>;
  /** advance_phase outputs, shown at gates. */
  phaseSummaries: Partial<Record<PhaseName, { summary: string; artifacts: string[]; humanDecisions?: HumanDecision[] }>>;
  /**
   * Proof THIS run's consultant authored a contract — set in `settleTurn` when a
   * consultant turn settles in the contract-author phase (full's plan), recording
   * the derived `path`, the authoring `sessionId`, and `authoredAt`. It is the
   * authorship evidence the freeze and the advance_phase rail require: a stale
   * pre-existing contract file with no draft marker is NOT this run's contract and
   * must not be frozen. ADDITIVE and consultant-only (absent otherwise).
   */
  acceptanceContractDraft?: { path: string; sessionId: string; authoredAt: string };
  /**
   * The frozen acceptance contract (the optional consultant's contract feature,
   * Full arc) — set when the contract gate (plan) is crossed and this run's
   * consultant authored a contract file (a matching draft marker): its
   * repo-relative `path`, the `commit` that froze it, and `verifiedAt` (stamped in
   * `settleTurn` when a consultant turn settles in the verify phase — evidence the
   * verify checkpoint RAN; pass/fail stays in the gate packet). ADDITIVE and
   * consultant-only: absent on every run with no consultant bound (and on any run
   * whose authoring did not produce a draft-backed file), so the default-off
   * byte-for-byte invariant holds — nothing reads it unless it is present. The
   * impl verify checkpoint reads it to know there is a frozen target to verify
   * against (absent ⇒ a noted skip), and the impl rail requires `verifiedAt`.
   */
  acceptanceContract?: { path: string; commit: string; verifiedAt?: string };

  /**
   * Persisted hint: which worker has a turn in flight right now, set at a
   * send_prompt turn's start and cleared in its `finally`. A SEPARATE process
   * (`duet doctor`) reads it to tell `long-inference` from `idle`, reconciled
   * against driver liveness — an entry under a dead driver is an interrupted
   * turn, not a live one. Distinct from the in-memory `turnsInFlight`
   * concurrency guard, which never persists. A hint like everything here:
   * stale-after-crash is acceptable because doctor cross-checks it.
   *
   * `sessionId` is THIS turn's provider session id, staged as soon as the
   * provider announces it (`recordTurnSessionId`, from RunTurnOptions.onSessionId)
   * — at/near turn start, not at settle. The live-activity heartbeat locates the
   * worker's transcript by it, so a worker's FIRST turn (and every ephemeral
   * consultant turn, whose settled `workerSessions` id is the *prior* session) is
   * no longer blind. Absent until the announce; never load-bearing.
   */
  activeTurns?: Partial<Record<WorkerRole, { tag: string; startedAt: string; sessionId?: string }>>;
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
   * Bounded auto-retry of transient infra failures (#4b) — the attempt budget.
   * Absent on a loaded OLD state.json ⇒ off (byte-for-byte as before); a NEW run
   * materializes `DEFAULT_RETRY_INFRA` (3) at `createRun`, and an explicit `0`
   * disables. Set from `--retry-infra <n>` or framing `retry_infra:`.
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
   * turn. `usedTokens` is the LAST honest reading (what displays render);
   * `highWaterTokens`, when present, is the max since this voice's last
   * compact/session reset — the safety reading (`contextSafetyPercent`) the
   * context-pressure guards act on, so a later lower reading (cache expiry
   * shrinking a request, codex auto-compacting) never relaxes a guard
   * mid-growth. Absent ⇒ usedTokens IS the high-water.
   */
  contextUsage?: Partial<Record<Voice, ContextUsage & { at: string; highWaterTokens?: number }>>;
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
 * force-attended gates (none, currently — the generic non-pre-authorizable
 * mechanism) are attended unconditionally.
 */
export function gateAttended(state: RunState, phase: GatePhase): boolean {
  if ((WORKFLOWS[workflowOf(state)].forceAttend as readonly string[]).includes(phase)) return true;
  return state.gatesAt === undefined || state.gatesAt.includes(phase);
}

/**
 * The `high`-severity human decisions a gate's packet carries — the single
 * resolver for the severity hold (consultant reviewer, slice 5), beside
 * gateAttended. A non-explicit crossing (driveToQuiescence's auto-cross,
 * enterAfk's handoff) is withheld when this is non-empty; the status renderer
 * reads the same list to name the hold. Returns the decisions (not a boolean) so
 * those surfaces can name them. An explicit `--approve` never consults it.
 */
export function highDecisionsAt(state: RunState, gatePhase: GatePhase): HumanDecision[] {
  return (state.phaseSummaries[gatePhase]?.humanDecisions ?? []).filter((d) => d.severity === 'high');
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

/**
 * The run's scratch dir for a worker's ephemeral verification harnesses
 * (throwaway tsconfigs, probe scripts). It lives *inside* the run dir — not a
 * top-level `.duet/scratch/` — so it shares the run's lifecycle: gitignored
 * like everything under `.duet/`, and torn down by `--purge` with the rest of
 * the run. That ownership is what lets the impl brief drop the old "delete it
 * before handoff" step: there is nothing for a worker to clean up, so a worker
 * is never asked to `rm` anything under `.duet/` (see ensureRunDir for why that
 * matters).
 */
export function scratchDirOf(cwd: string, runId: string): string {
  return join(runDirOf(cwd, runId), 'scratch');
}

/**
 * Re-ensure `.duet/` (with its self-ignore) and the run dir exist, then return
 * the run dir. Every run-dir write routes through here so a stray deletion of
 * `.duet/` mid-run self-heals instead of stranding the run: a worker runs with
 * full permissions in the run's own cwd, and one *did* delete the live run —
 * an implementer cleaning its scratch ran `rm -rf .duet` and the next voice-log
 * append threw ENOENT, ending the phase with no advance and no flag (the missing
 * docs/PR were downstream of exactly that). Restoring the dir (and its
 * `.gitignore`) here turns that into a recovered write, not a silent death.
 */
export function ensureRunDir(cwd: string, runId: string): string {
  ensureDuetDir(cwd);
  const dir = runDirOf(cwd, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
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

/**
 * The default infra auto-retry budget materialized for a NEW run (#4b). Three
 * attempts recover a transient network/server/rate-limit blip in ≤14 s of
 * duet-added backoff before flagging. Materialized at createRun (the gatesAt
 * discipline), so an absent/old `retryInfra` on a loaded state.json stays OFF
 * byte-for-byte — only newly-created runs get the default; `--retry-infra 0` is
 * the explicit opt-out.
 */
export const DEFAULT_RETRY_INFRA = 3;

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
  /** The gateless posture (the consultant axis; the posture axis rides gatesAt). */
  gateless?: boolean;
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
    ...(opts.gateless ? { gateless: true } : {}),
    // Nullish, not truthy: an explicit `--retry-infra 0` stays 0 (off), an absent
    // value materializes the default. Always present on a new run, so the default
    // is on for new runs while old/absent state.json stays off (host-runner reads
    // `state.retryInfra ?? 0`).
    retryInfra: opts.retryInfra ?? DEFAULT_RETRY_INFRA,
    workerSessions: {},
    phaseStarted: {},
    rounds: {},
    phaseSummaries: {},
    costs: { orchestratorUsd: 0, orchestratorCostPartial: false, claudeWorkersUsd: 0, claudeWorkersCostPartial: false, codexTokens: { input: 0, output: 0 } },
    snippetProposals: [],
  };
  const dir = ensureRunDir(opts.cwd, runId);
  // Pre-create the run's scratch dir so the impl brief can hand the implementer
  // a path that already exists (under the run dir, removed with the run).
  mkdirSync(scratchDirOf(opts.cwd, runId), { recursive: true });
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
  const dir = ensureRunDir(state.cwd, state.runId);
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
 * The fresh-load → mutate → save → sync discipline, in one place. Every per-role
 * crash-state mutator below runs this: load a FRESH copy from disk, apply `fn` to
 * it, save ONLY if `fn` reports a change, then apply the SAME `fn` to the passed
 * in-memory copy so reads after the call stay consistent. The fresh load is the
 * concurrency guard — a concurrent cross-role write that landed between the
 * caller's load and here is preserved, because `fn` touches only its own field
 * rather than saving a stale whole-object snapshot.
 *
 * Two behaviors callers rely on, both load-bearing:
 * - **Deletion-safe, surgical sync.** `fn` runs against BOTH copies, so a delete
 *   reflects in both and only the touched field changes — never a blanket
 *   `Object.assign(state, fresh)`, which would leave a deleted key behind and
 *   clobber unrelated in-memory fields.
 * - **No-op ⇒ no save.** `fn` returns whether it changed anything; a false return
 *   skips the disk write, so a clear-when-absent or set-when-already-set can't
 *   clobber a concurrent sibling write.
 *
 * **Replayable-callback contract:** because `fn` runs twice (fresh, then the
 * passed copy), any GENERATED value (a timestamp) must be computed ONCE by the
 * caller and closed over — never `new Date()` inside `fn`, or disk and memory
 * would diverge. With generated values lifted out, `fn` is idempotent and pure.
 */
function mutate(state: RunState, fn: (s: RunState) => boolean): void {
  const fresh = loadRunState(state.cwd, state.runId);
  if (fn(fresh)) saveRunState(fresh);
  fn(state);
}

/**
 * Mark a worker's turn in flight (the `activeTurns` hint), and clear it — each
 * through `mutate`, so a concurrent cross-role send can never clobber the sibling
 * role's entry. The `entry` (with its generated timestamp) is built ONCE here and
 * closed over, honoring the replayable-callback contract.
 */
export function markTurnActive(state: RunState, role: WorkerRole, tag: string): void {
  const entry = { tag, startedAt: new Date().toISOString() };
  mutate(state, (s) => {
    (s.activeTurns ??= {})[role] = entry;
    return true;
  });
}

export function clearTurnActive(state: RunState, role: WorkerRole): void {
  mutate(state, (s) => {
    if (!s.activeTurns?.[role]) return false;
    delete s.activeTurns[role];
    return true;
  });
}

/**
 * Stage THIS turn's provider session id onto the active-turn hint, as soon as the
 * provider announces it (RunTurnOptions.onSessionId). The live-activity heartbeat
 * locates the worker's transcript by this id — known at/near turn start — instead
 * of the settled `workerSessions` id (which only lands at settle, so a first turn
 * was blind, and which for the ephemeral consultant is the *prior* session). A
 * no-op when the role has no active-turn entry (a settle already cleared it), so
 * a late announce can't resurrect a finished turn.
 */
export function recordTurnSessionId(state: RunState, role: WorkerRole, sessionId: string): void {
  mutate(state, (s) => {
    const entry = s.activeTurns?.[role];
    if (!entry) return false;
    entry.sessionId = sessionId;
    return true;
  });
}

/**
 * The interactive pending-turn lifecycle mutators, each through `mutate`:
 * markPendingTurn (status `running`, at dispatch) · settlePendingTurn (→ `ready`
 * | `failed`, at worker-settle) · clearPendingTurn (at collect, or to resolve an
 * orphan). markWorkerDispatched sets the one-way branch-fixed flag.
 */
export function markPendingTurn(state: RunState, role: WorkerRole, tag: string): void {
  const entry = { tag, startedAt: new Date().toISOString(), status: 'running' as const };
  mutate(state, (s) => {
    (s.pendingTurns ??= {})[role] = entry;
    return true;
  });
}

export function settlePendingTurn(state: RunState, role: WorkerRole, status: 'ready' | 'failed'): void {
  mutate(state, (s) => {
    const entry = s.pendingTurns?.[role];
    if (!entry) return false;
    entry.status = status;
    return true;
  });
}

export function clearPendingTurn(state: RunState, role: WorkerRole): void {
  mutate(state, (s) => {
    if (!s.pendingTurns?.[role]) return false;
    delete s.pendingTurns[role];
    return true;
  });
}

export function markWorkerDispatched(state: RunState): void {
  // Cheap in-memory short-circuit before the fresh load (it is one-way, so once
  // our copy knows, there is nothing to do).
  if (state.workerDispatched) return;
  mutate(state, (s) => {
    if (s.workerDispatched) return false;
    s.workerDispatched = true;
    return true;
  });
}

/**
 * Set the run's gate posture mid-run (#1/0b — the one mutable-posture write).
 * Through `mutate`, so a step that saved the whole RunState between the caller's
 * load and here (a staged approval rider) is not clobbered. The cross-process
 * race (a live headless driver) does not apply: the only caller is `duet afk`,
 * which runs during the interactive arc and spawns the driver only AFTER this write.
 */
export function setGatesAt(state: RunState, gatesAt: GatePhase[]): void {
  mutate(state, (s) => {
    s.gatesAt = gatesAt;
    return true;
  });
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
  const dir = ensureRunDir(state.cwd, state.runId);
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
  const sessions: Array<{ provider: RoleBinding['provider']; sessionId: string }> = [];
  if (state.orchestratorSessionId) {
    sessions.push({ provider: state.bindings.orchestrator.provider, sessionId: state.orchestratorSessionId });
  }
  // Each BOUND worker's LATEST tracked transcript, by exact session-id match —
  // the consultant included when bound. Prior consultant checkpoint transcripts
  // are intentionally left on disk: state tracks only the latest id and
  // sessions.ts matches by exact id (never a directory sweep), so purge cannot
  // reach them. (The run dir — including consultant.log — is removed below, so
  // consultant.log is NOT a post-purge findability path; the surviving priors
  // are the provider transcripts in ~/.claude / ~/.codex.)
  for (const role of workerRolesFor(state)) {
    const sessionId = state.workerSessions[role];
    if (sessionId) sessions.push({ provider: bindingFor(state.bindings, role).provider, sessionId });
  }

  const transcripts = [
    ...new Set(sessions.flatMap((s) => locateSessionTranscripts(s.provider, s.sessionId, home))),
  ];
  for (const path of transcripts) rmSync(path, { force: true });

  const runDir = runDirOf(state.cwd, state.runId);
  rmSync(runDir, { recursive: true, force: true });
  return { runDir, transcripts };
}

/** Whole percent of the context window in use (capped at 100). */
export function contextPercent(usage: ContextUsage): number {
  return usage.windowTokens > 0 ? Math.min(100, Math.round((usage.usedTokens / usage.windowTokens) * 100)) : 0;
}

/**
 * Compact token count for display: 2_000_000 → "2.0M", 1_500 → "2k", else the
 * number. Shared by `duet status` (status.ts) and the per-turn footer
 * (harness/tools.ts) so the two render Codex tokens identically.
 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Record a voice's context-window fill: mutates the state (the caller owns
 * the save, as with every handler-side mutation) and refreshes the plain-text
 * sidecar `context/<voice>` ("41%") that the tmux pane titles re-read at
 * their refresh interval — a `cat` per interval, no JSON parsing at view time.
 *
 * Alongside the last reading it carries the high-water mark forward: the max
 * `usedTokens` since the voice's last compact/reset, kept because a session's
 * fill can legitimately read LOWER on a later turn without any compaction and a
 * safety guard must not relax on that. A window change (a mid-run model swap)
 * makes token comparison meaningless, so it restarts the mark. Compacts and
 * session resets clear the whole record via `clearContextUsage` instead — a
 * post-compact fill is unknown until the next turn reports it.
 */
export function recordContextUsage(state: RunState, voice: Voice, usage: ContextUsage): void {
  const prev = state.contextUsage?.[voice];
  const highWater =
    prev && prev.windowTokens === usage.windowTokens
      ? Math.max(prev.highWaterTokens ?? prev.usedTokens, usage.usedTokens)
      : usage.usedTokens;
  (state.contextUsage ??= {})[voice] = {
    ...usage,
    at: new Date().toISOString(),
    ...(highWater > usage.usedTokens ? { highWaterTokens: highWater } : {}),
  };
  const dir = join(ensureRunDir(state.cwd, state.runId), 'context');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, voice), `${contextPercent(usage)}%\n`);
}

/**
 * Append a context intervention to the ledger (the caller owns the save, like
 * every handler-side mutation). Capture the reading fields BEFORE the
 * intervention clears them — `contextEventReading` is the companion read.
 */
export function recordContextEvent(state: RunState, event: Omit<ContextEvent, 'at'>): void {
  (state.contextEvents ??= []).push({ ...event, at: new Date().toISOString() });
}

/**
 * The pre-intervention fill fields for a context event, from the voice's
 * current reading (the safety percent's token form) — empty when no reading
 * exists, so an event never carries a guessed number.
 */
export function contextEventReading(state: RunState, voice: Voice): { preTokens?: number; windowTokens?: number } {
  const usage = state.contextUsage?.[voice];
  if (!usage) return {};
  return { preTokens: Math.max(usage.usedTokens, usage.highWaterTokens ?? 0), windowTokens: usage.windowTokens };
}

/**
 * Drop a voice's context reading — after a successful `/compact` (the fill is
 * unknown until the next turn's honest reading re-establishes it) or a session
 * reset (a fresh session starts near-empty). Clearing rather than guessing keeps
 * the safety reading honest: `contextSafetyPercent` returns undefined and the
 * pressure guards stand down until real telemetry returns. The sidecar file is
 * removed too, so the pane shows nothing rather than a stale pre-compact number.
 */
export function clearContextUsage(state: RunState, voice: Voice): void {
  if (state.contextUsage?.[voice]) delete state.contextUsage[voice];
  rmSync(join(runDirOf(state.cwd, state.runId), 'context', voice), { force: true });
}

/**
 * The SAFETY reading of a voice's context fill: whole percent of the window at
 * the high-water mark since its last compact/reset (falling back to the last
 * reading when the mark is absent), or undefined when no reading exists. This —
 * never the display percent — is what the context-pressure guards consult, so a
 * turn that grew the session and then reported a lower number still trips them.
 */
export function contextSafetyPercent(state: RunState, voice: Voice): number | undefined {
  const usage = state.contextUsage?.[voice];
  if (!usage) return undefined;
  return contextPercent({ usedTokens: Math.max(usage.usedTokens, usage.highWaterTokens ?? 0), windowTokens: usage.windowTokens });
}

/**
 * Refresh the plain-text `context/phase` sidecar the tmux orchestrator pane border
 * re-reads at its refresh interval (a `cat` per interval, no view-time parsing),
 * so the pane shows which phase the run is in. The view-only twin of the context
 * sidecar — best-effort and fail-soft: a write failure is swallowed so a cosmetic
 * sidecar can never affect the run. Writes only the sidecar, never state.json.
 */
export function recordPhaseLabel(state: RunState, phase: PhaseName): void {
  try {
    const dir = join(ensureRunDir(state.cwd, state.runId), 'context');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'phase'), `${phase}\n`);
  } catch {
    // A view-time sidecar must never affect the run — drop the write silently.
  }
}

/**
 * The statechart snapshot (xstate's persisted form), written only at
 * quiescent states. Typed as Snapshot<unknown> at this boundary so hydration
 * sites can pass it straight to createActor without casts.
 */
export function saveMachineSnapshot(state: RunState, snapshot: Snapshot<unknown>): void {
  const dir = ensureRunDir(state.cwd, state.runId);
  atomicWrite(join(dir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2) + '\n');
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
  const path = join(ensureRunDir(state.cwd, state.runId), `${voice}.log`);
  const stamp = new Date().toISOString();
  const block = body === undefined ? `[${stamp}] ${header}\n` : `[${stamp}] ${header}\n${body}\n\n`;
  appendFileSync(path, block);
}

/** The notes file — the run's dogfooding journal, written by both the human and the orchestrator. */
export function appendNote(state: RunState, author: 'human' | 'orchestrator', note: string): void {
  const path = join(ensureRunDir(state.cwd, state.runId), 'notes.md');
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
