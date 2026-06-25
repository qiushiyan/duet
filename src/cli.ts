#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { execa } from 'execa';
import { createActor } from 'xstate';
import { colorizeDriverLine, colorizeVoiceLine } from './colorize.ts';
import { bindingFor, loadRunConfig } from './config.ts';
import type { BindableRole } from './config.ts';
import { sessionPolicyFor, voicesFor } from './roles.ts';
import { DEFAULT_FRAMING_FILE, composeInEditor, parseGatesAt, resolveHumanText, resolveRunInputs } from './framing.ts';
import {
  aliveDriverPid,
  crossInteractive,
  driveToQuiescence,
  enterAfk,
  freezeContractAt,
  interactiveContinueAction,
  killDriver,
  probeRunPosition,
  spawnDrive,
  validateInteractiveCrossing,
  waitForTurnOrStop,
} from './harness/lifecycle.ts';
import type { HumanEvent } from './harness/lifecycle.ts';
import { machineFor } from './harness/machine.ts';
import { serveKernelStdio, serveRunScopedKernelStdio } from './harness/mcp-server.ts';
import { buildDoctorModel, renderDoctor } from './doctor.ts';
import { runOrchestrate } from './orchestrate.ts';
import { entryOf, handoffWatchLabel, phaseOfGateState } from './phases.ts';
import { getEffectiveSnippet, loadEffectiveSnippets, runtimeLibraryContext } from './snippets.ts';
import type { EffectiveSnippet } from './snippets.ts';
import { buildBrief, buildStatusModel, renderBrief, renderStatus, steerRefusal } from './status.ts';
import { openTmuxView } from './tmux-view.ts';
import {
  clearPendingTurn,
  createRun,
  gateAttended,
  latestRun,
  listPendingSteers,
  listRuns,
  loadMachineSnapshot,
  loadRunState,
  markAbandoned,
  purgeRun,
  runDirOf,
  saveRunState,
  stageHumanInput,
  stageSteer,
  workflowOf,
} from './run-store.ts';
import type { RunState, Voice } from './run-store.ts';

/**
 * duet — the command surface. Parsing and validation live here; everything
 * with behavior lives behind it: the run store (src/run-store.ts), the
 * process lifecycle (src/harness/lifecycle.ts), status rendering
 * (src/status.ts), and the viewer (src/tmux-view.ts). Commands return
 * immediately — phases run in the detached `_drive` child.
 */

function showStatus(state: RunState, json = false, brief = false): void {
  const model = buildStatusModel(state, probeRunPosition(state), listPendingSteers(state));
  // Three orthogonal axes: --brief = projection (lean vs full), --json =
  // renderer (machine vs text), --wait = timing (handled by the caller).
  if (brief) {
    const lean = buildBrief(model);
    console.log(json ? JSON.stringify(lean, null, 2) : renderBrief(lean));
    return;
  }
  console.log(json ? JSON.stringify(model, null, 2) : renderStatus(model));
}

function printWatchHints(state: RunState, pid: number, phaseLabel: string): void {
  console.log(`${phaseLabel} running in the background (pid ${pid})`);
  console.log(`  inline logs:  duet logs ${state.runId}`);
  console.log(`  tmux panes:   duet view ${state.runId}`);
  console.log(`  status:       duet status ${state.runId}`);
  console.log(`you'll get a notification at the next gate or queued question`);
}

/**
 * Render the `duet snippets` listing: a summary line, then every effective key
 * in shipped order with the layer it resolved from (shipped / user / project).
 * Pure (the `console.log` is the thin action body), so it is tested directly.
 * Provenance lives ONLY here — the library served to workers carries no source
 * marker (that is what byte-for-byte identity requires).
 */
export function renderSnippetListing(snippets: EffectiveSnippet[]): string {
  const overridden = snippets.filter((s) => s.source !== 'shipped');
  const userCount = overridden.filter((s) => s.source === 'user').length;
  const projectCount = overridden.filter((s) => s.source === 'project').length;
  const summary =
    overridden.length === 0
      ? `${snippets.length} snippets — all shipped defaults (no overrides)`
      : `${snippets.length} snippets — ${overridden.length} overridden (user: ${userCount}, project: ${projectCount})`;
  const width = snippets.reduce((m, s) => Math.max(m, s.key.length), 0);
  const lines = snippets.map((s) => `${s.key.padEnd(width)}  ${s.source}`);
  return [summary, '', ...lines].join('\n');
}

/**
 * The command table, exported for the skill coherence test (tests/skill.test.ts),
 * which cross-checks every verb and flag the shipped concierge skill names.
 * Building it has no side effects; parsing runs only under import.meta.main.
 */
export const program = new Command();

/** Exit with an error message (commander's error() is typed never). */
// A function declaration so TS narrows after calls (never-returning arrows don't).
function fail(message: string): never {
  return program.error(message);
}

/**
 * Build `resolveRunInputs`'s option object from `duet new`'s raw flags. The one
 * subtlety the bare spread got wrong: `gatesAt` is forwarded KEY-PRESENT, not
 * truthy, so an explicit `--gates-at ""` reaches the parser and is rejected as
 * empty (its documented contract, framing.ts) instead of being silently dropped
 * to attend-all. spec/framing/template/workflow stay truthy-gated — they carry
 * no empty-value semantics, so an empty string there is just an omitted flag.
 * Pure and exported so the forward is testable without driving the whole action.
 */
export function newRunInputOpts(opts: {
  spec?: string;
  framing?: string;
  template?: string;
  workflow?: string;
  gatesAt?: string;
  retryInfra?: string;
}): { spec?: string; framing?: string; template?: string; workflow?: string; gatesAt?: string; retryInfra?: string } {
  return {
    ...(opts.spec ? { spec: opts.spec } : {}),
    ...(opts.framing ? { framing: opts.framing } : {}),
    ...(opts.template ? { template: opts.template } : {}),
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    ...(opts.gatesAt !== undefined ? { gatesAt: opts.gatesAt } : {}),
    ...(opts.retryInfra !== undefined ? { retryInfra: opts.retryInfra } : {}),
  };
}

/**
 * Disambiguate `duet afk`'s two optional positionals. `duet afk <runId>` (bare
 * attend-none posture for a specific run) and `duet afk <preset>` (a posture for
 * the latest run) are indistinguishable to commander when only one is given, so
 * resolve here: a lone first arg that names an existing run dir is the runId;
 * otherwise it is the preset/list. Run ids (YYYYMMDD-HHMM-hhhh) and preset/phase
 * names are disjoint by shape, so this never misreads one for the other. Pure
 * (modulo the run-dir probe) and exported for test.
 */
export function resolveAfkArgs(
  cwd: string,
  preset: string | undefined,
  runId: string | undefined,
): { preset?: string; runId?: string } {
  if (runId === undefined && preset !== undefined && existsSync(runDirOf(cwd, preset))) {
    return { runId: preset };
  }
  return { ...(preset !== undefined ? { preset } : {}), ...(runId !== undefined ? { runId } : {}) };
}

/**
 * The takeover decision, pure and exported for test (the action is thin IO over
 * it — console + execa). It sorts a role into: a captured session to `open` (the
 * persistent roles RESUME it; an ephemeral role only INSPECTS — `ephemeral`
 * carries that distinction into the copy), a `clear-orphan` (a pending record
 * with no session — read-only-safe for an ephemeral role, an ABANDON for a
 * persistent one), or `no-session`. Ephemerality keys on the session policy
 * (sessionPolicyFor), never a `role === 'consultant'` check.
 */
export type TakeoverPlan =
  | { kind: 'open'; sessionId: string; ephemeral: boolean }
  | { kind: 'clear-orphan'; ephemeral: boolean }
  | { kind: 'no-session' };

export function takeoverPlan(state: RunState, role: BindableRole): TakeoverPlan {
  const ephemeral = role !== 'orchestrator' && sessionPolicyFor(role) === 'ephemeral';
  const sessionId = role === 'orchestrator' ? state.orchestratorSessionId : state.workerSessions[role];
  if (!sessionId) {
    if (role !== 'orchestrator' && state.pendingTurns?.[role]) return { kind: 'clear-orphan', ephemeral };
    return { kind: 'no-session' };
  }
  return { kind: 'open', sessionId, ephemeral };
}
program
  .name('duet')
  .description(
    'Semi-AFK orchestrator for a two-agent AI engineering workflow: an LLM orchestrator routes an implementer and a reviewer through a multi-phase arc, pausing at human gates.',
  )
  .version('0.1.0')
  .addHelpText(
    'after',
    `
The shape of a run (pick the arc with --workflow on duet new):
  full:  frame → DIRECTION gate → spec → COMMIT-SPEC gate → plan → PLAN gate (walk away)
         → impl (AFK, often hours) → SHIP gate → docs (one pass) → pr → OPEN-PR gate → done
  rir:   research → DIRECTION gate (walk away) → implement (AFK) → SHIP gate → done

Each phase runs in a detached background driver; every command above returns
immediately, and nothing runs between stops. A stop is a gate (decision), a
queued question, a mid-phase crash, or completion — and every stop names its
next command in duet status.

Acting on a run:
  at a gate           duet continue --approve | --reject "<feedback>"
  at a question       duet continue --answer "<text>"
  into a live phase   duet steer "<note>"     (delivered to the orchestrator mid-flight)
  after a crash       duet continue           (re-enters from the transcripts)
  done with a run     duet abandon            (stops a live driver; --purge also deletes the sessions)

Watching:  duet status [--json] [--wait] · duet logs · duet view (tmux panes)
Run state: .duet/runs/<id>/ — state.json is a hint; the JSONL transcripts are truth.`,
  );

program
  .command('new')
  .description('Start a run on the chosen arc (--workflow): full (spec → plan → implement → ship → docs → PR) or rir (research → implement → review → ship).')
  .option('--spec <path>', 'path to a draft spec file; omit to start from the framing alone (the FRAME phase drafts it)')
  .option('--framing <file>', 'project briefing file — the only place project knowledge enters; omit both flags to write it in your editor')
  .option('--template <name>', 'seed the editor draft from .duet/templates/<name>.md (bare `duet new` uses .duet/templates/default.md when present); conflicts with --spec/--framing')
  .option('--workflow <name>', 'which arc to run: full (spec → plan → implement → ship → docs → PR) or rir (research → implement → review); default full. Also settable via a workflow: framing key (flag wins)')
  .option(
    '--gates-at <phases>',
    'phases whose gates you attend — the set and presets are workflow-specific (full gates: frame, spec, plan, impl, pr; presets "skip-plan" = walk away at spec approval, return at the Ship gate, "overnight" = frame,spec, and full\'s PR auto-opens by default — list `pr` to attend a pre-open stop. rir gates: research, implement; preset "afk" = attend none). The rest are pre-authorized and auto-cross with their packets recorded; default: attend every gate except full\'s auto-opening PR (list `pr` to add a pre-open stop); rir attends both its gates',
  )
  .option(
    '--retry-infra <n>',
    'opt-in bounded auto-retry of TRANSIENT infra failures (network/server/rate-limit, and auth once) before flagging — n attempts. login/quota/persistent-auth are never retried; exhaustion always falls back to a flag. Default: off (every infra failure flags, as today)',
  )
  .option(
    '--budget <off|default|N>',
    'opt-in per-turn cost caps: off (default — unbounded, the flat-quota posture), default (the built-in per-phase profile), or a positive multiplier N scaling it (e.g. 0.5, 2). Overrides the config budget key; one knob covers both the worker and orchestrator caps',
  )
  .option('--orchestrator <provider[:model]>', 'role binding override (claude[:model] only in v1)')
  .option('--impl <provider[:model]>', 'implementer binding override')
  .option('--reviewer <provider[:model]>', 'reviewer binding override')
  .option(
    '--consultant <provider[:model]>',
    'enable the optional consultant — an independent cross-family second reviewer (read-only). provider[:model], e.g. claude:claude-opus-4-8; defaults to claude-opus-4-8 when no model is named. Off by default; settable for every run via [roles.consultant] in the config',
  )
  .option('--no-consultant', 'disable the consultant for this run even when the config binds one')
  .option('--tmux', 'open a tmux viewer: one live pane per voice, tailing the run logs')
  .option('--interactive', "orchestrate this run from your own interactive Claude Code session instead of the headless driver — brings up the wired session over the attended arc up to the workflow's handoff gate (full: through the plan gate; rir: through the Direction gate); implementation onward runs headless after that handoff")
  .action(async (opts: { spec?: string; framing?: string; template?: string; workflow?: string; gatesAt?: string; retryInfra?: string; budget?: string; orchestrator?: string; impl?: string; reviewer?: string; consultant?: string | boolean; tmux?: boolean; interactive?: boolean }) => {
    const cwd = process.cwd();

    // The framing's frontmatter is the machine/prose boundary: parsed
    // deterministically and stripped — the orchestrator sees only the prose
    // body plus the posture instructions the harness renders from the values.
    let inputs;
    try {
      inputs = await resolveRunInputs(cwd, newRunInputOpts(opts));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }

    const { bindings, budget } = loadRunConfig({
      roleOverrides: {
        ...(opts.orchestrator ? { orchestrator: opts.orchestrator } : {}),
        ...(opts.impl ? { implementer: opts.impl } : {}),
        ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
        // --consultant carries a spec (string); --no-consultant arrives as `false`.
        ...(typeof opts.consultant === 'string' ? { consultant: opts.consultant } : {}),
      },
      ...(opts.consultant === false ? { noConsultant: true } : {}),
      ...(opts.budget !== undefined ? { budgetOverride: opts.budget } : {}),
    });

    let branch: string | undefined;
    try {
      branch = (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
    } catch {
      // Not a git repo (or detached weirdness) — the orchestrator will surface it.
    }

    const { framingFile, ...runInputs } = inputs;
    const state = createRun({
      cwd,
      ...runInputs,
      ...(branch ? { branch } : {}),
      bindings,
      ...(budget !== undefined ? { budget } : {}),
    });
    // The editor draft is archived into the run dir by createRun; the
    // staging file is consumed so the next bare `duet new` starts fresh.
    if (framingFile === DEFAULT_FRAMING_FILE) unlinkSync(join(cwd, DEFAULT_FRAMING_FILE));
    console.log(`run ${state.runId} created`);
    if (opts.tmux) await openTmuxView(state);
    console.log(
      `roles: orchestrator=${bindings.orchestrator.provider}:${bindings.orchestrator.model ?? ''} implementer=${bindings.implementer.provider}${bindings.implementer.model ? ':' + bindings.implementer.model : ''} reviewer=${bindings.reviewer.provider}${bindings.reviewer.model ? ':' + bindings.reviewer.model : ''}${bindings.consultant ? ` consultant=${bindings.consultant.provider}${bindings.consultant.model ? ':' + bindings.consultant.model : ''}` : ''}`,
    );
    // gatesAt: [] is the afk "attend none" posture — explicit copy, not an empty join.
    if (state.gatesAt)
      console.log(
        state.gatesAt.length > 0
          ? `gates: attending ${state.gatesAt.join(', ')} — other gates pre-authorized (auto-cross, packets recorded)`
          : `gates: attending none — all gates pre-authorized (auto-cross, packets recorded)`,
      );
    console.log('');
    if (opts.interactive) {
      // Stage 1: orchestrate from the human's interactive orchestrator session instead
      // of the headless driver — no auto-spawnDrive. runOrchestrate marks the run
      // interactive and launches the wired claude session (it blocks until that
      // session ends). --gates-at still applies to the headless tail after the
      // workflow's handoff gate (full: plan; rir: Direction).
      console.log(`bringing up the interactive orchestrator for run ${state.runId} …`);
      const launched = runOrchestrate(state);
      if (launched.error) fail(launched.error.message);
      return;
    }
    const pid = spawnDrive(state);
    printWatchHints(state, pid, state.specPath ? 'SPEC review loop' : `${entryOf(workflowOf(state)).firstPhase.toUpperCase()} phase`);
  });

program
  .command('orchestrate')
  .description(
    'Bring up the interactive orchestrator for a run: a Claude Code session wired to drive it over the attended arc up to the handoff gate (full: FRAME → PLAN; rir: RESEARCH → Direction), with the single gate-safety ask rule applied. Relaunch to reconnect after a dropped session (it re-anchors on disk via get_task).',
  )
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .action((runId: string | undefined) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project — start one with duet new --interactive');
    console.log(`bringing up the interactive orchestrator for run ${state.runId} …`);
    const launched = runOrchestrate(state);
    if (launched.error) fail(launched.error.message);
  });

/** The continue/steer write-path opts: a flag may be bare, carry inline text,
 *  or (reject/answer) name a file (`-` = stdin) for quoting-safe verbatim relay. */
interface ContinueTextOpts {
  approve?: boolean | string;
  reject?: boolean | string;
  answer?: boolean | string;
  rejectFile?: string;
  answerFile?: string;
  edit?: boolean;
}

/** Read all of stdin to a string — the `--reject-file -` / `--answer-file -` path. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Read a decision file verbatim, failing with the path on an unreadable file. */
function readDecisionFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    return fail(`could not read ${path}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

/**
 * Resolve one decision's text in priority order: a `--*-file <path>` (or `-`
 * for stdin) read VERBATIM wins; otherwise resolveHumanText (inline value, or
 * the editor on a TTY, or the non-TTY `undefined` sentinel). The file/stdin
 * forms exist so the human's exact words never pass through shell quoting.
 */
async function resolveDecisionText(
  inline: string | boolean | undefined,
  file: string | undefined,
  instructions: string,
  io: { isTTY: boolean; readStdin: () => Promise<string>; compose: (instructions: string) => Promise<string> },
): Promise<string | undefined> {
  if (file !== undefined) return file === '-' ? io.readStdin() : readDecisionFile(file);
  return resolveHumanText(inline, instructions, { isTTY: io.isTTY, compose: io.compose });
}

/**
 * Stage the human's verbatim text for a gate/flag crossing — reject feedback,
 * an approval rider, or a flag answer. Shared by the headless and interactive
 * continue paths. Text arrives inline, from a file/stdin (`--reject-file` /
 * `--answer-file`, reject/answer only), or composed in $EDITOR.
 *
 * The editor default tracks whether the human content is *required*: reject and
 * answer need content, so a bare flag opens the editor on a TTY (and FAILS FAST
 * off one, naming the inline/file/stdin forms). Approve's rider is *optional*,
 * so a bare `--approve` means "no rider" — the editor is opt-in via `--edit`
 * (which FAILS FAST off a TTY rather than silently approving with no rider).
 * `io` is the environment seam for tests: injectable isTTY, stdin reader, and
 * editor launcher (`compose`) — so a test exercises the editor path without
 * spawning an editor child.
 */
export async function stageContinueText(
  state: RunState,
  opts: ContinueTextOpts,
  io: { isTTY?: boolean; readStdin?: () => Promise<string>; compose?: (instructions: string) => Promise<string> } = {},
): Promise<void> {
  const env = {
    isTTY: io.isTTY ?? Boolean(process.stdin.isTTY),
    readStdin: io.readStdin ?? readAllStdin,
    compose: io.compose ?? composeInEditor,
  };

  // One source per intent — mixing the inline flag with its file form is almost
  // always a mistake, so fail fast rather than silently pick one (consistent
  // with the mutually-exclusive --approve/--reject/--answer guard).
  if (opts.reject !== undefined && opts.rejectFile !== undefined) {
    fail('choose one rejection source — inline --reject "<text>" or --reject-file <path> (or "-" for stdin), not both.');
  }
  if (opts.answer !== undefined && opts.answerFile !== undefined) {
    fail('choose one answer source — inline --answer "<text>" or --answer-file <path> (or "-" for stdin), not both.');
  }

  if (opts.reject !== undefined || opts.rejectFile !== undefined) {
    const feedback = await resolveDecisionText(
      opts.reject,
      opts.rejectFile,
      'Rejecting the gate: write the feedback that sends the artifact back. It reaches the orchestrator verbatim, as editor-in-chief input.',
      env,
    );
    if (feedback === undefined) {
      fail(
        'a rejection needs feedback and this is a non-interactive shell — pass it inline (--reject "<text>"), from a file (--reject-file <path>), or on stdin (--reject-file -).',
      );
    }
    if (!feedback.trim()) {
      fail('rejection aborted — no feedback written. A reject sends the artifact back, and the orchestrator routes the rework from your why.');
    }
    stageHumanInput(state, { kind: 'feedback', text: feedback });
  }
  if (opts.approve !== undefined) {
    // The rider is OPTIONAL, so a bare --approve approves with no rider and the
    // editor is opt-in via --edit — unlike reject/answer, whose content is
    // required and so default to the editor. Inline text stages as-is.
    let rider: string | undefined;
    if (typeof opts.approve === 'string') {
      rider = opts.approve;
    } else if (opts.edit) {
      // Explicit editor opt-in. Off a TTY there is no editor to drive, so fail
      // fast naming the inline form rather than silently approving plain.
      rider = await resolveDecisionText(
        true,
        undefined,
        'Approving the gate: write a rider — adjustments that ride into the next phase with your approval. Save empty to approve without one.',
        env,
      );
      if (rider === undefined) {
        fail('--edit opens an editor to compose a rider, but this is a non-interactive shell — pass it inline instead: duet continue --approve "<text>".');
      }
    }
    // bare --approve (no --edit) → no rider; an empty editor result → no rider.
    if (rider !== undefined && rider.trim()) stageHumanInput(state, { kind: 'approval', text: rider.trim() });
  }
  if (opts.answer !== undefined || opts.answerFile !== undefined) {
    const answer = await resolveDecisionText(
      opts.answer,
      opts.answerFile,
      'Answering the queued question: write your answer. It reaches the orchestrator verbatim.',
      env,
    );
    if (answer === undefined) {
      fail(
        'an answer is required and this is a non-interactive shell — pass it inline (--answer "<text>"), from a file (--answer-file <path>), or on stdin (--answer-file -).',
      );
    }
    if (!answer.trim()) {
      fail('answer aborted — nothing written. The queued question is still waiting; answer it with duet continue --answer "<text>".');
    }
    stageHumanInput(state, { kind: 'answer', text: answer });
  }
}

/**
 * Catch the certain mistake where an optional-value flag swallowed a run id as
 * its text (`duet continue --approve <runId>`): a run id parsed as flag text is
 * never what the human meant.
 */
function guardRunIdAsText(
  cwd: string,
  opts: { approve?: boolean | string; reject?: boolean | string; answer?: boolean | string },
): void {
  for (const value of [opts.approve, opts.reject, opts.answer]) {
    if (typeof value === 'string' && listRuns(cwd).some((r) => r.runId === value)) {
      fail(
        `"${value}" is a run id, but it was parsed as the flag's text — put the run id before the flag (duet continue ${value} --approve), or quote the text if you really meant it.`,
      );
    }
  }
}

program
  .command('afk')
  .description(
    "Hand off mid-session from any interactive gate: re-set the downstream gate posture and drop to the headless driver in one tap. Legal at any interactive gate parked on the approve path — including a pre-authorized one. Bare = attend nothing downstream (maximum AFK).",
  )
  .argument('[preset]', 'a workflow gates_at preset or phase list for the downstream posture (bare = attend none)')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .action(async (preset: string | undefined, runId: string | undefined) => {
    const cwd = process.cwd();
    // `duet afk <runId>` (bare posture, specific run) and `duet afk <preset>`
    // (posture, latest run) share the first positional — resolveAfkArgs sorts it.
    const { preset: presetArg, runId: runIdArg } = resolveAfkArgs(cwd, preset, runId);
    const state = runIdArg ? loadRunState(cwd, runIdArg) : latestRun(cwd);
    if (!state) fail('no runs found in this project — start one with duet new');
    let split;
    try {
      // Bare afk → the empty "attend none" posture; a named arg → an existing
      // preset/list (no new presets). parseGatesAt validates against the workflow.
      const posture = presetArg ? parseGatesAt(presetArg, workflowOf(state)) : [];
      split = await enterAfk(state, posture);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    // Print the resulting split so the single tap is informed consent.
    console.log(
      split.attended.length > 0
        ? `gates: attending ${split.attended.join(', ')} — ${split.preAuthorized.join(', ') || 'nothing else'} pre-authorized (auto-cross, packets recorded)`
        : `gates: attending none — all downstream gates pre-authorized (auto-cross, packets recorded)`,
    );
    const pid = spawnDrive(state);
    printWatchHints(state, pid, 'handed off to headless (duet afk)');
  });

program
  .command('continue')
  .description('Resume a run past its gate or queued flag.')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .option(
    '--approve [rider]',
    'approve the current gate, optionally with a rider — adjustments that ride into the next phase as gate feedback in approving form. Bare --approve approves with no rider; add one inline (--approve "text") or compose it in $EDITOR with --approve --edit',
  )
  .option(
    '--reject [feedback]',
    'send the artifact back; the feedback reaches the orchestrator verbatim. Bare --reject opens $EDITOR to compose it (an empty result aborts the rejection)',
  )
  .option(
    '--answer [text]',
    'answer the queued question; the text reaches the orchestrator verbatim. Bare --answer opens $EDITOR to compose it (an empty result aborts)',
  )
  .option(
    '--reject-file <path>',
    'reject with feedback read VERBATIM from a file (or "-" for stdin) — for text with apostrophes, em-dashes, or newlines that shell quoting would mangle',
  )
  .option(
    '--answer-file <path>',
    'answer with text read VERBATIM from a file (or "-" for stdin) — the quoting-safe form of --answer',
  )
  .option(
    '--edit',
    'with --approve, compose the rider in $EDITOR (a TTY only) — the opt-in editor for an approval; reject/answer open the editor by default',
  )
  .option(
    '--headless',
    'drop an interactive run to the headless driver: with a gate decision it crosses then hands off to a detached _drive; bare (mid-phase) it continues the current phase headless. The fallback for a dead or unwanted interactive session.',
  )
  .option('--tmux', 'open (or reuse) the tmux viewer for this run')
  .action(async (runId: string | undefined, opts: ContinueTextOpts & { headless?: boolean; tmux?: boolean }) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project — start one with duet new (bare opens your editor on a framing draft)');
    if (opts.tmux) await openTmuxView(state);

    // Reviving an abandoned run — abandonment is reversible by design
    // (docs/automation-design.md §"Ending a run"). Clear the marker so the
    // probe stops reporting 'abandoned'; the logic below re-enters from
    // wherever the run last stopped (gate, flag, or mid-phase crash).
    if (state.abandoned) {
      console.log(`run ${state.runId} was abandoned — reviving it`);
      delete state.abandoned;
      saveRunState(state);
    }

    // A decision can arrive as a flag (--approve/--reject/--answer) or, for
    // reject/answer, as a file form (--reject-file/--answer-file) — fold both
    // into one intent per channel so every downstream check (chosen, eventType)
    // sees the file forms too.
    const approveIntent = opts.approve !== undefined;
    const rejectIntent = opts.reject !== undefined || opts.rejectFile !== undefined;
    const answerIntent = opts.answer !== undefined || opts.answerFile !== undefined;
    const chosen = [approveIntent, rejectIntent, answerIntent].filter(Boolean);
    if (chosen.length > 1) fail('choose one of --approve, --reject, --answer');

    // A phase driver already running owns this run — a second one would race
    // it on the orchestrator session and the state file.
    const runningPid = aliveDriverPid(state);
    if (runningPid !== undefined) {
      if (chosen.length > 0) {
        fail(
          `the phase is still running (pid ${runningPid}) — there's no gate or flag to act on yet; watch with: duet view ${state.runId}`,
        );
      }
      showStatus(state);
      console.log(`\nphase running in the background (pid ${runningPid}) — live logs: duet view ${state.runId}`);
      return;
    }

    const eventType = approveIntent
      ? ('approve' as const)
      : rejectIntent
        ? ('reject' as const)
        : answerIntent
          ? ('answer' as const)
          : undefined;

    // Stage 1: the human's interactive session is the orchestrator.
    // `duet continue` advances the machine inline (crossInteractive, no _drive)
    // until the workflow's handoff gate. Runs BEFORE the snapshot-based
    // validation below, because the run's first gate has no machine snapshot
    // until crossInteractive persists one — the headless path's "no snapshot ⇒
    // crash" would misfire on it.
    if (state.orchestrationHost === 'interactive') {
      const position = probeRunPosition(state);

      if (!eventType) {
        if (opts.headless) {
          // --headless with no decision is a mid-phase drop to the headless
          // driver. At a gate/flag the human owes a decision first, not a drop.
          if (position.kind === 'gate' || position.kind === 'flag') {
            fail(
              `the run is parked at its ${position.kind} — cross it with --headless --approve/--reject (a gate) or --answer (a flag); bare --headless is only for a mid-phase drop.`,
            );
          }
          delete state.orchestrationHost;
          saveRunState(state);
          const pid = spawnDrive(state);
          printWatchHints(state, pid, 'dropped to headless (mid-phase)');
          return;
        }
        showStatus(state); // bare continue on an interactive run: show the gate/rest
        return;
      }

      const invalid = validateInteractiveCrossing(position, eventType);
      if (invalid) fail(`run ${state.runId} ${invalid}.`);

      guardRunIdAsText(cwd, opts);
      await stageContinueText(state, opts);

      // Validation passed, so the position is a gate or flag — both carry a phase.
      if (position.kind !== 'gate' && position.kind !== 'flag') return;
      // Freeze the acceptance contract before an approve crosses the contract gate
      // (the human ratifies it by approving) — no-op at every other gate/event.
      if (eventType === 'approve') await freezeContractAt(state, position.phase);
      const action = interactiveContinueAction(workflowOf(state), position.phase, eventType, Boolean(opts.headless));
      crossInteractive(state, { type: `human.${eventType}` });

      if (action === 'handoff') {
        const handed = loadRunState(cwd, state.runId);
        delete handed.orchestrationHost;
        saveRunState(handed);
        const pid = spawnDrive(handed);
        printWatchHints(handed, pid, opts.headless ? 'handed off to headless' : handoffWatchLabel(workflowOf(handed)));
        return;
      }
      const rest = probeRunPosition(loadRunState(cwd, state.runId));
      const restPhase = rest.kind === 'interactive' ? rest.phase : undefined;
      console.log(
        `run ${state.runId}: crossed inline${restPhase ? ` — the interactive orchestrator session drives the ${restPhase} phase next (re-anchor with get_task)` : ''}.`,
      );
      return;
    }

    // A crashed-mid-phase run (no live driver, the snapshot — if any — parked
    // at the stop whose crossing died): bare continue re-enters from the
    // transcripts, re-uttering the crossing the run state already evidences
    // (probe docs: harness/lifecycle.ts). This is the command `duet status`
    // names at a crashed stop, so it must actually recover.
    const position = probeRunPosition(state);
    if (position.kind === 'crashed' && chosen.length === 0) {
      console.log(
        `run ${state.runId}: the ${position.phase} phase stopped mid-flight — re-entering from the transcripts`,
      );
      const pid = spawnDrive(state, position.resumeEvent);
      printWatchHints(state, pid, 'recovered phase');
      return;
    }

    const snapshot = loadMachineSnapshot(state);
    if (!snapshot) {
      // Crashed before the first quiescent stop AND a decision flag was
      // passed — there is nothing restored to validate a gate decision against.
      fail(
        'this run has no gate to act on (it stopped mid-phase) — rerun without flags to let it pick up from the transcripts',
      );
    }

    const probe = createActor(machineFor(workflowOf(state)), {
      input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
      snapshot,
    });
    const restored = probe.getSnapshot();

    // A snapshot parked at a pre-authorized gate means the driver died after
    // reaching it but before the next attended stop — re-enter; the driver
    // crosses it again on the standing authorization.
    const restoredGatePhase = typeof restored.value === 'string' ? phaseOfGateState(workflowOf(state), restored.value) : undefined;
    if (chosen.length === 0 && restoredGatePhase && !gateAttended(state, restoredGatePhase) && restored.status !== 'done') {
      console.log(
        `run ${state.runId}: stopped at the pre-authorized ${String(restored.value)} — re-entering (it auto-crosses)`,
      );
      const pid = spawnDrive(state);
      printWatchHints(state, pid, 'recovered phase');
      return;
    }

    if (!eventType) {
      showStatus(state);
      return;
    }
    const event: HumanEvent = { type: `human.${eventType}` };

    // Validate the event against the restored state before committing side
    // effects (or opening an editor), so a wrong flag gets a friendly error
    // instead of a no-op.
    if (restored.status === 'done') fail(`run ${state.runId} is complete — nothing to continue`);
    if (!restored.can(event)) {
      fail(
        `--${event.type.split('.')[1]} is not valid at ${JSON.stringify(restored.value)} — ` +
          (restored.hasTag('gate') ? 'this is a gate: use --approve or --reject "<feedback>"' : 'a question is queued: use --answer "<text>"'),
      );
    }

    guardRunIdAsText(cwd, opts);
    await stageContinueText(state, opts);

    const pid = spawnDrive(state, eventType);
    printWatchHints(state, pid, `phase (after --${eventType})`);
  });

// Internal: the detached phase driver `new`/`continue` spawn. Drives the
// statechart to the next quiescent stop, persists, notifies, exits.
const driveCommand = new Command('_drive')
  .argument('<runId>')
  .argument('[eventType]')
  .action(async (runId: string, eventType?: string) => {
    const state = loadRunState(process.cwd(), runId);
    const snapshot = loadMachineSnapshot(state);
    const event: HumanEvent | undefined =
      eventType === 'approve' || eventType === 'reject' || eventType === 'answer'
        ? { type: `human.${eventType}` }
        : undefined;
    const stop = await driveToQuiescence(state, {
      ...(snapshot ? { snapshot } : {}),
      ...(event ? { event } : {}),
    });
    showStatus(stop.state);
  });
program.addCommand(driveCommand, { hidden: true });

// Internal harness: serve a run's kernel tool surface over stdio MCP, so a
// client process outside duet can call the orchestrator tools. Two modes:
// with an explicit <phase>, a single-phase server (the Stage-0 boundary/test
// path); without it, the run-scoped phase-less server the Stage-1 interactive
// session connects to — it resolves the active phase from disk per call and
// follows the run across its gates. Production headless still drives in-process
// (_drive). All narration goes to stderr — stdout is the JSON-RPC channel.
const mcpCommand = new Command('_mcp')
  .argument('<runId>')
  .argument('[phase]')
  .action(async (runId: string, phase: string | undefined) => {
    try {
      if (phase) await serveKernelStdio(process.cwd(), runId, phase);
      else await serveRunScopedKernelStdio(process.cwd(), runId);
    } catch (err) {
      console.error(`[_mcp] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });
program.addCommand(mcpCommand, { hidden: true });

program
  .command('steer')
  .description(
    'Send a mid-phase note to the orchestrator — delivered on its next tool result, as your voice. Only legal while a phase is live (or down mid-phase); at a gate or flag, duet continue is the channel.',
  )
  .argument('[text]', 'the note, verbatim — it reaches the orchestrator unparaphrased; omit it to compose the note in $EDITOR')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .action(async (text: string | undefined, runId: string | undefined) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project');
    const position = probeRunPosition(state);
    if (position.kind !== 'running' && position.kind !== 'crashed') {
      fail(steerRefusal(position, state.runId) ?? `nothing to steer at ${position.kind}`);
    }
    const note = await resolveHumanText(
      text,
      'Steering the live phase: write the note for the orchestrator. It reaches it verbatim, as your editor-in-chief voice, on the next tool result.',
    );
    // Off a TTY a bare `duet steer` resolves to the sentinel (resolveHumanText
    // won't open an editor a headless caller can't drive) — fail fast naming the
    // inline form, the same non-TTY treatment continue's reject/answer get.
    if (note === undefined) {
      fail('no note written and this is a non-interactive shell — pass it inline: duet steer "<note>".');
    }
    if (!note.trim()) {
      fail('steer aborted — nothing written. A steer is your voice mid-phase; send one with duet steer "<note>".');
    }
    stageSteer(state, note, position.phase);
    console.log(
      position.kind === 'running'
        ? `steer staged — delivered on the orchestrator's next tool result (usually within minutes; watch with: duet logs ${state.runId})`
        : `steer staged — the ${position.phase} phase is down; the note rides the recovery prompt when the run re-enters (resume with: duet continue ${state.runId})`,
    );
  });

program
  .command('abandon')
  .description(
    'Stop a run for good: kill its live driver if one is running, and mark it abandoned. The transcripts stay, so duet continue/takeover still revive it. With --purge, also delete the run dir and the three session transcripts (irreversible).',
  )
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .option(
    '--purge',
    'also delete .duet/runs/<id>/ and the orchestrator + worker session transcripts in ~/.claude and ~/.codex — irreversible',
  )
  .action(async (runId: string | undefined, opts: { purge?: boolean }) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project');

    // abandon is the one command that acts ON a live driver (continue/takeover
    // refuse while it runs) — kill it first, then mark or purge with the driver
    // dead so its state writes can't race us.
    const killed = await killDriver(state);
    if (killed !== undefined) console.log(`stopped the live driver (pid ${killed})`);

    // Reload: the now-dead driver may have written newer state (session ids,
    // rounds, costs) than we loaded — the purge needs the freshest session ids,
    // and the marker must not clobber the driver's last save.
    const fresh = loadRunState(cwd, state.runId);

    if (opts.purge) {
      const result = purgeRun(fresh);
      console.log(`purged run ${fresh.runId}:`);
      console.log(`  removed ${result.runDir}`);
      for (const path of result.transcripts) console.log(`  removed ${path}`);
      if (result.transcripts.length === 0) console.log('  (no session transcripts found to remove)');
      return;
    }

    markAbandoned(fresh);
    console.log(
      `run ${fresh.runId} abandoned — transcripts kept (revive with: duet continue ${fresh.runId}, or wipe with: duet abandon ${fresh.runId} --purge)`,
    );
  });

program
  .command('view')
  .description('Open (or reuse) the tmux viewer: one live pane per voice, tailing the run logs.')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .action(async (runId: string | undefined) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project');
    await openTmuxView(state);
    // The voice set is the run's bound voices (consultant included when bound),
    // not a static list — the slice-3 enumeration rule reaches this hint too.
    const logNames = [...voicesFor(state), 'driver'].join(',');
    console.log(`raw logs: ${join(runDirOf(state.cwd, state.runId))}/{${logNames}}.log`);
  });

program
  .command('takeover')
  .description('Hand a role’s session to you: opens the provider’s interactive CLI resumed on that session. Duet stays out until you return; your turns land in the same transcript the orchestrator continues from.')
  .argument('<role>', 'orchestrator | implementer | reviewer | consultant')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .action(async (role: string, runId: string | undefined) => {
    if (role !== 'orchestrator' && role !== 'implementer' && role !== 'reviewer' && role !== 'consultant') {
      fail(`unknown role "${role}" — use orchestrator, implementer, reviewer, or consultant`);
    }
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project');

    const runningPid = aliveDriverPid(state);
    if (runningPid !== undefined) {
      fail(
        `the phase is still running (pid ${runningPid}) — taking over a session mid-phase would race the orchestrator on it. Wait for the next gate or flag (or kill the driver if you mean to take over for good).`,
      );
    }

    const plan = takeoverPlan(state, role);
    if (plan.kind === 'no-session') fail(`the ${role} has no session yet in run ${state.runId}`);

    if (plan.kind === 'clear-orphan') {
      // §7 — a pending record with no captured session. Clear it without a resume
      // target. The hazard differs by policy: a persistent role's old worker may
      // still be editing the repo (a deliberate ABANDON); the ephemeral consultant
      // is read-only, so the discard is benign.
      console.log(
        plan.ephemeral
          ? `the ${role}'s interrupted turn left no session — it is ephemeral and read-only, so there is nothing to resume and no repo write to race. Clearing the orphan re-opens the role; the next send_prompt seeds a fresh session.`
          : `no session was captured for the ${role}'s interrupted turn — the old worker process may still be running and touching the repo. Dropping the orphan abandons that in-flight turn so you can re-send.`,
      );
      if (role !== 'orchestrator') clearPendingTurn(state, role);
      console.log(`orphan cleared — the ${role} is re-opened for the next send_prompt.`);
      return;
    }

    // §4 — a captured session exists. A persistent role RESUMES it (duet picks the
    // session back up); the ephemeral consultant only INSPECTS its latest
    // checkpoint — duet will not resume it, so the messaging must not imply
    // continuity.
    const provider = role === 'orchestrator' ? state.bindings.orchestrator.provider : bindingFor(state.bindings, role).provider;
    const cmd = provider === 'claude' ? ['claude', '--resume', plan.sessionId] : ['codex', 'resume', plan.sessionId];
    console.log(
      plan.ephemeral
        ? `opening the ${role}'s latest checkpoint session (${plan.sessionId}) for inspection — it is ephemeral, so duet will not resume it: the next ${role} turn seeds a fresh session.`
        : `handing over the ${role} session (${plan.sessionId})`,
    );
    console.log(`  ${cmd.join(' ')}`);
    console.log(
      plan.ephemeral
        ? `inspect freely — anything you do here stays in this checkpoint's session and won't carry into the next ${role} turn.\n`
        : `your turns append to the run's transcript; pick duet back up afterwards with duet continue.\n`,
    );
    await execa(cmd[0]!, cmd.slice(1), { cwd: state.cwd, stdio: 'inherit', reject: false });
    // Clear any pending record the human has now inspected/finished, re-opening
    // the role for the next send_prompt.
    if (role !== 'orchestrator' && state.pendingTurns?.[role]) clearPendingTurn(state, role);
  });

program
  .command('logs')
  .description('Stream the run’s driver narration inline — replays from the start, then follows. Ctrl-C detaches; the run is unaffected.')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .action(async (runId: string | undefined) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project');
    const path = join(runDirOf(state.cwd, state.runId), 'driver.log');
    console.log(`following ${path} — Ctrl-C detaches (the run keeps going)\n`);
    // tail -F waits for the file if the driver hasn't written yet; SIGINT
    // here kills only the tail, never the detached driver. The file is plain
    // text — the [tag] palette is applied at view time.
    const tail = execa('tail', ['-n', '+1', '-F', path], { stdio: ['ignore', 'pipe', 'inherit'], reject: false });
    const lines = createInterface({ input: tail.stdout! });
    lines.on('line', (line) => console.log(colorizeDriverLine(line)));
    await tail;
  });

// Internal: the view-time colorizer the tmux panes (and anything else
// tailing a voice log) pipe through. The log files stay plain text; color
// exists only in the live view. Unknown voices pass lines through untouched.
const colorizeCommand = new Command('_colorize')
  .argument('<voice>', 'orchestrator | implementer | reviewer | consultant')
  .action(async (voice: string) => {
    const known = voice === 'orchestrator' || voice === 'implementer' || voice === 'reviewer' || voice === 'consultant';
    process.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(0); // pane closed mid-stream
    });
    for await (const line of createInterface({ input: process.stdin })) {
      console.log(known ? colorizeVoiceLine(voice as Voice, line) : line);
    }
  });
program.addCommand(colorizeCommand, { hidden: true });

program
  .command('status')
  .description('Show a run’s position, the gate packet or queued question, rounds, costs, and the next command.')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .option('--json', 'machine-readable status: the StatusModel, with a discriminated "stop" naming the channel that acts there (the schema the concierge skill reads; additive-only)')
  .option('--brief', 'lean digest: position, stop kind, a one-line headline, the next command, pending-steer count, auto-approvals, and any human-decision flags — the fields that drive the next action, without the full packet. Composes with --json (lean JSON) and --wait')
  .option('--wait', 'block until the run reaches its next stop — gate, question, crash, or done — then print; read-only and safe to interrupt. With --json this is the supervision primitive: run it in the background and report when it exits')
  .action(async (runId: string | undefined, opts: { json?: boolean; wait?: boolean; brief?: boolean }) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project — start one with duet new (bare opens your editor on a framing draft)');
    if (opts.wait) {
      // Turn-aware: wakes on a worker turn settling (interactive host) as well as
      // a run stop. When a turn woke it, foreground WHY before the status block.
      const woke = await waitForTurnOrStop(cwd, state.runId);
      if (woke.kind === 'turn-ready') {
        console.log(`worker turn ready (${woke.roles.join(', ')}) — have the orchestrator collect it with check_turns.`);
      }
      showStatus(loadRunState(cwd, state.runId), opts.json ?? false, opts.brief ?? false);
      return;
    }
    showStatus(state, opts.json ?? false, opts.brief ?? false);
  });

program
  .command('doctor')
  .description(
    'Per-role health: working / long-inference / retrying / silent-stuck / crashed, with last-activity age, retry count, recent classified errors, the resolved transcript path, and a connectivity probe. Reads the workers’ own transcripts and the network (heavier than status) — the answer to "is this run healthy?"',
  )
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .option('--json', 'emit the full health model (including resolved session paths) for automation')
  .action(async (runId: string | undefined, opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project — start one with duet new (bare opens your editor on a framing draft)');
    const model = await buildDoctorModel(state, { now: Date.now() });
    console.log(opts.json ? JSON.stringify(model, null, 2) : renderDoctor(model));
  });

program
  .command('runs')
  .description('List known runs in this project.')
  .action(() => {
    const all = listRuns(process.cwd());
    if (all.length === 0) {
      console.log('no runs');
      return;
    }
    for (const r of all) {
      const waiting = r.abandoned ? 'abandoned' : r.pendingQuestion ? 'waiting-on-answer' : '';
      console.log(`${r.runId}  ${r.machineState ?? '?'}  ${waiting}  ${r.specPath ?? '(framing-only)'}`);
    }
  });

// Read-only inspector for the effective snippet library (shipped base + the user
// and project override layers), resolved as a run launched from here would see
// it. The override channel is fully unrestricted by design — any key is
// overridable, the guardrail against overriding the safety-coupled snippets is
// documentation, not code — so this listing stays uniform: keys + provenance, no
// per-key risk markers.
const snippetsCmd = program
  .command('snippets')
  .description('List the effective snippet library and where each snippet resolves from (shipped / user / project override).')
  .action(() => {
    // A malformed/unknown-key override fails closed — surface the (already
    // recovery-worded) message cleanly via fail(), not a raw stack trace.
    let snippets: EffectiveSnippet[];
    try {
      snippets = loadEffectiveSnippets(runtimeLibraryContext(process.cwd()));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    console.log(renderSnippetListing(snippets));
  });

snippetsCmd
  .command('show <key>')
  .description('Print the full effective body of one snippet, with the layer it resolved from.')
  .action((key: string) => {
    let snippet: EffectiveSnippet | undefined;
    try {
      snippet = getEffectiveSnippet(key, runtimeLibraryContext(process.cwd()));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    if (!snippet) fail(`unknown snippet key "${key}" — run "duet snippets" to list valid keys.`);
    // The stored form: the {{skills_dir}} token is left unresolved (readable and
    // machine-independent — the serve-time resolution is the orchestrator's concern).
    console.log(`# key: ${snippet.key}`);
    console.log(`# source: ${snippet.source}`);
    console.log(snippet.expand);
  });

if (import.meta.main) {
  await program.parseAsync(process.argv);
}
