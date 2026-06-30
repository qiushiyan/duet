import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consultantIdentityClause } from './harness/orchestrator-prompts.ts';
import { loadRunState, runDirOf, saveRunState, workflowOf } from './run-store.ts';
import type { RunState } from './run-store.ts';
import { locateSessionTranscripts } from './sessions.ts';

/**
 * The `duet orchestrate <runId>` launcher (Stage 1) — the one place that brings
 * up the human's interactive Claude Code session wired to drive a run over its
 * attended arc up to the workflow's handoff gate (full: FRAME → PLAN; rir:
 * RESEARCH → Direction), and the one place that applies the single gate-safety
 * permission rule. The orchestrator role can't be installed by a slash command
 * (a skill can't do launch-time wiring — the runId is dynamic), so the launcher
 * feeds `prompts/orchestrator-identity.md` to the session as a system prompt
 * (`--append-system-prompt-file`) instead — there is no `/duet` command.
 *
 * The process spawn is the Environment seam (modeled on providers/pane.ts'
 * PaneFactory): runOrchestrate takes an injectable ClaudeLauncher so tests
 * capture the launch spec and never spawn claude.
 */

// The orchestrator identity fed to the session as system-prompt-strength text
// (durable across compaction, unlike a skill body). It is a prompt asset, not a
// skill — no SKILL.md, fed as a file by the launcher — so it lives under
// prompts/, not skills/. Resolved package-relative from this module like
// snippets.ts resolves snippets.toml — and, like snippets.toml, shipped only
// because the `prompts` entry is in package.json `files` (tests/skill.test.ts
// pins this target into the publish surface). Drop `prompts` from `files` and a
// packed build points --append-system-prompt-file at a missing file.
// (docs/engineering.md §Build.)
export const IDENTITY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'orchestrator-identity.md');

/**
 * Where the per-run COMPOSED identity lives when a consultant is bound: the
 * shipped identity plus the arc's consultant clause (`consultantIdentityClause` —
 * the SAME clause the headless system prompt appends via `orchestratorSystemPrompt`,
 * so both hosts gain it identically and only when bound). Written under the run
 * dir so the launcher feeds a single `--append-system-prompt-file`: the Claude
 * CLI doesn't document `--append-system-prompt-file` composing with a second
 * `--append-system-prompt`, so we compose into one file rather than trust two
 * flags to both apply. Unbound, the launcher feeds the shipped `IDENTITY_PATH`
 * directly and writes nothing — byte-for-byte the pre-consultant launch.
 */
function composedIdentityPath(state: RunState): string {
  return join(runDirOf(state.cwd, state.runId), 'orchestrator-identity.md');
}

/**
 * The single gate-safety rule: an `ask` prompt on `duet continue`. It survives
 * `bypassPermissions` — deny/ask rules apply in every permission mode, only
 * `allow` becomes a no-op under bypass — so the one tap protects the gate even
 * when the human launches every session with permissions bypassed.
 *
 * Colon prefix form, matching the documented Claude Code rule shape
 * (`Bash(git status:*)`) and the shipped concierge's `Bash(duet status:*)`
 * (skills/duet-concierge/SKILL.md, pinned by tests/skill.test.ts) — so no
 * concierge migration is needed.
 */
export const GATE_ASK_RULE = 'Bash(duet continue:*)';

/**
 * Family A — the first user turn, seeded so the wired session opens *working*
 * instead of at a blank prompt. The launcher already feeds the orchestrator
 * identity as the system prompt (`--append-system-prompt-file`), so the role is
 * loaded before any turn; this is the kickoff *user* message that gets the
 * session to act. Gentle by design: orient and propose, then wait for the
 * human's go before spending worker turns — a fresh session that auto-spawned
 * workers on launch would surprise.
 */
export const KICKOFF_PROMPT =
  'Read get_task to anchor on the current phase and the framing, then give me a one-paragraph plan of attack and wait for my go before sending the first worker prompt.';

/**
 * The WARM-START kickoff — the first user turn when the session being launched is
 * the user's own discussion session, resumed (`--resume <id>`) to become this
 * run's orchestrator. It fires once, at the transition moment, so it does the one
 * job a user turn does well: flip the session into the role and trigger the first
 * act. It deliberately does NOT re-spec the role or repeat the worker-prompting
 * discipline — that durable posture lives in the appended identity (system
 * prompt), one source of truth. Framed positively (a senior engineer who
 * delegates and monitors, not a list of prohibitions) and points at get_task as
 * the source of truth, so the rich discussion context informs without overriding
 * the framing. Used only on a warm start; a fresh launch and a plain reconnect
 * both use the re-anchoring KICKOFF_PROMPT above.
 */
export const RESUME_KICKOFF_PROMPT =
  "We've turned everything we worked through in this discussion into a duet framing, so the thinking is settled — and from here your job changes. You're the orchestrator for this run now: the senior engineer who hands the actual building to an implementer and a reviewer, keeps the run on track, and holds it to the product goals we just agreed on.\n\n" +
  "First, read get_task to see where the run really stands — the phase, the framing, the brief. That's the source of truth to work from; our conversation is the shared understanding behind it. Then give me a one-paragraph plan of attack, and wait for my go before you send the first worker prompt.\n\n" +
  'What we worked out here stays useful the whole way through — for briefing the workers well, and for judging what comes back against what we were actually trying to build.';

export interface LaunchSpec {
  command: string;
  args: string[];
}

/**
 * The current CLI's own executable + entry, so the MCP server is launched as the
 * SAME duet that is running — not whatever `duet` happens to be on PATH (a
 * missing link, a different checkout, a version skew). Mirrors spawnDrive
 * (lifecycle.ts), which self-references the detached driver the same way.
 * Injectable so buildLaunchSpec stays a pure argv builder under test.
 */
export interface CliSelfRef {
  exec: string;
  entry: string;
}
const currentSelfRef = (): CliSelfRef => ({ exec: process.execPath, entry: process.argv[1]! });

/**
 * Build the `claude` argv that wires an interactive session to drive `state`.
 *
 * When `state.interactiveOrchestratorSessionId` is set, the session is RESUMED
 * (`--resume <id>`) rather than opened fresh — a warm start (the user's discussion
 * session) or a reconnect (the same orchestrator session after a drop). The
 * appended identity, MCP config, and settings are re-passed every launch (they are
 * per-invocation and do not persist across resume), so a resumed session gets the
 * orchestrator role, the kernel surface, and the gate-safety rule identically.
 * `opts.warmStart` only chooses the kickoff: the transition prompt on a first
 * attach, the re-anchoring KICKOFF_PROMPT on a fresh launch or a plain reconnect.
 */
export function buildLaunchSpec(state: RunState, self: CliSelfRef = currentSelfRef(), opts: { warmStart?: boolean } = {}): LaunchSpec {
  // The MCP server is THIS cli's own executable + entry (self.exec self.entry),
  // not a bare `duet` PATH lookup — so the kernel the session attaches is the
  // same duet that launched it (the spawnDrive pattern, lifecycle.ts). The runId
  // is baked into the args at launch — what a static project .mcp.json or a
  // mid-session skill cannot do. No `cwd` field: the Claude Code stdio MCP schema
  // is command/args/env only, so the server inherits claude's launch cwd (the
  // project dir, where the human runs `duet orchestrate`); `_mcp` reads
  // process.cwd() from there.
  const mcpConfig = JSON.stringify({
    mcpServers: { duet: { command: self.exec, args: [self.entry, '_mcp', state.runId] } },
  });
  const settings = JSON.stringify({ permissions: { ask: [GATE_ASK_RULE] } });
  return {
    command: 'claude',
    args: [
      // Resume an existing session as the orchestrator when one is recorded (warm
      // start / reconnect); absent, claude opens a fresh session. The resume id
      // is the human's own session, so the orchestrator keeps its conversation.
      ...(state.interactiveOrchestratorSessionId ? ['--resume', state.interactiveOrchestratorSessionId] : []),
      '--mcp-config', mcpConfig,
      // The session's MCP surface is exactly the duet kernel — no user/global
      // MCP leakage, the hygiene the headless host gets from strictMcpConfig.
      // On a resume this also drops the discussion session's other MCP servers,
      // which is the wanted clean surface (their old tool calls stay inert in
      // history); a newly added server may prompt for trust once, fine attended.
      '--strict-mcp-config',
      // Bound: the run-dir composed identity (base + consultant clause), written
      // by runOrchestrate before launch. Unbound: the shipped identity, verbatim.
      // Re-fed every launch — appended prompts are per-invocation, so a resumed
      // session would otherwise lose the orchestrator role.
      '--append-system-prompt-file', state.bindings.consultant ? composedIdentityPath(state) : IDENTITY_PATH,
      '--settings', settings,
      // Family A: the first user turn, as claude's positional [prompt] operand,
      // so the session opens working instead of blank. It trails every option —
      // the variadic `--mcp-config` stopped at `--strict-mcp-config`, and
      // `--settings` takes a single value — so claude parses it as [prompt]. The
      // warm-start variant marks the discussion→orchestrator transition.
      opts.warmStart ? RESUME_KICKOFF_PROMPT : KICKOFF_PROMPT,
    ],
  };
}

/**
 * The process-spawn seam — a fake captures the spec; the default hands the
 * terminal to claude. `error` carries an IMMEDIATE spawn failure (the session
 * never started: ENOENT when claude isn't on PATH, EACCES, bad args) — distinct
 * from a non-zero exit AFTER a real session, which the blocking launcher reports
 * only on return and is a normal session end, not a launch failure.
 */
export type ClaudeLauncher = (spec: { command: string; args: string[]; env: NodeJS.ProcessEnv }) => {
  pid?: number;
  error?: Error;
};

const defaultLauncher: ClaudeLauncher = (spec) => {
  // spawnSync hands the terminal fully to claude and blocks until it exits — the
  // right shape for an interactive handoff (duet returns when the session ends),
  // and synchronous like the seam. result.error is the spawn-layer failure
  // (ENOENT etc.); result.status is the session's exit code, which we ignore —
  // a real session that exits non-zero is not a launch failure.
  const result = spawnSync(spec.command, spec.args, { stdio: 'inherit', env: spec.env });
  return { pid: result.pid, ...(result.error ? { error: result.error } : {}) };
};

/** Whether the built spec carries the gate-safety ask rule the launcher promised. */
export function gateAskRuleLive(spec: LaunchSpec): boolean {
  const idx = spec.args.indexOf('--settings');
  if (idx < 0) return false;
  try {
    const parsed = JSON.parse(spec.args[idx + 1] ?? '') as { permissions?: { ask?: unknown } };
    return Array.isArray(parsed.permissions?.ask) && parsed.permissions.ask.includes(GATE_ASK_RULE);
  } catch {
    return false;
  }
}

/**
 * Mark the run interactively orchestrated and launch the wired session. Two
 * failure surfaces are made explicit so a setup problem can't leave the run
 * claiming a phantom interactive owner:
 *
 *  - PREFLIGHT, before marking: the identity file the launcher feeds
 *    --append-system-prompt-file must exist (a packed build missing prompts/, or
 *    a corrupt checkout, would otherwise bring up a session with no orchestrator
 *    role). Refuse without touching the run.
 *  - LAUNCH error, after marking: an immediate spawn failure (ENOENT etc.) means
 *    no session started, so RESTORE the pre-call state — a fresh launch reverts
 *    to unmarked, but a failed relaunch of an already-interactive run keeps its
 *    valid interactive rest and any real prior spend, so `duet status` stays
 *    honest either way.
 *
 * The ask-rule self-check is a WARNING, not a failure: it warns loudly (to
 * stderr) if the gate-safety rule isn't in the spec — gate protection is not a
 * setup step the human can silently forget — but still launches, because the
 * session is attended and the human sees it. Returns `{ error }` for the caller
 * to surface (a non-zero exit); the launch and warning paths return `{ pid }`.
 */
export function runOrchestrate(
  state: RunState,
  opts: {
    launcher?: ClaudeLauncher;
    buildSpec?: (state: RunState, o: { warmStart: boolean }) => LaunchSpec;
    log?: (line: string) => void;
    /** Preflight target; defaults to the launcher's IDENTITY_PATH (test seam). */
    identityPath?: string;
    /**
     * Warm start: resume this existing Claude Code session as the orchestrator
     * instead of opening a fresh one (the discussion session the framing grew out
     * of). Persisted onto the run, so a later reconnect re-attaches the same
     * session. Absent ⇒ a fresh launch (or a reconnect that reuses the already-
     * persisted id) — byte-for-byte the pre-feature behavior.
     */
    resumeSessionId?: string;
    /** Transcript-lookup home (the environment seam); defaults to `homedir()`. */
    home?: string;
  } = {},
): { pid?: number; error?: Error } {
  const launcher = opts.launcher ?? defaultLauncher;
  const buildSpec = opts.buildSpec ?? ((s: RunState, o: { warmStart: boolean }) => buildLaunchSpec(s, undefined, o));
  const log = opts.log ?? ((line: string) => console.error(line));
  const identityPath = opts.identityPath ?? IDENTITY_PATH;
  // An explicit resume id is a first warm start (the discussion→orchestrator
  // transition); its absence is a fresh launch or a plain reconnect (which
  // resumes the already-persisted id, re-anchoring rather than re-transitioning).
  const warmStart = opts.resumeSessionId !== undefined;

  // Preflight before marking: if the identity file is missing the run must stay
  // untouched, so a broken install fails fast rather than launching a roleless
  // session and stranding the run as interactively owned.
  if (!existsSync(identityPath)) {
    return {
      error: new Error(
        `the orchestrator identity file is missing (${identityPath}) — the interactive orchestrator session would launch without its role. This is a broken install: confirm duet's prompts/ shipped (it is in package.json "files"), then retry: duet orchestrate ${state.runId}. The run is unchanged.`,
      ),
    };
  }

  // Warm-start resume preflight, before marking: a resume id with no transcript
  // on disk (a typo, a stale id, an id from another project) must NOT be
  // persisted — once it is, every reconnect re-resumes the dead id and fails the
  // same way, and `spawnSync` reports a spawned-then-rejected resume as a non-zero
  // EXIT (a `status`), not a spawn `error`, so the launch-failure rollback never
  // fires. Refuse here with the run untouched, mirroring the identity preflight
  // above. (The interactive orchestrator is always claude — buildLaunchSpec runs
  // `claude` — so the resume target is a claude transcript.)
  if (opts.resumeSessionId && locateSessionTranscripts('claude', opts.resumeSessionId, opts.home).length === 0) {
    return {
      error: new Error(
        `no Claude Code session "${opts.resumeSessionId}" was found to resume — check the id (capture it with \`printenv CLAUDE_CODE_SESSION_ID\` inside the session you want to continue), or omit --resume-session to start the orchestrator fresh. The run is unchanged.`,
      ),
    };
  }

  // Reconnect fallback: buildLaunchSpec resumes the persisted interactive session
  // id, but if that session's transcript has since vanished (purged, deleted),
  // resuming it would fail identically every time. Drop it so this launch opens a
  // FRESH session instead of looping on a dead id. Only on a reconnect — an
  // explicit resume id took the preflight path just above.
  if (
    !opts.resumeSessionId &&
    state.interactiveOrchestratorSessionId &&
    locateSessionTranscripts('claude', state.interactiveOrchestratorSessionId, opts.home).length === 0
  ) {
    log(`[orchestrate] the remembered orchestrator session ${state.interactiveOrchestratorSessionId} is gone — opening a fresh session instead`);
    delete state.interactiveOrchestratorSessionId;
  }

  // Capture the pre-marking state so an immediate launch failure can RESTORE it
  // rather than blanket-clear it. A fresh launch has {host absent, partial
  // false}, so restore == clear; but a failed RELAUNCH of an already-interactive
  // run (the spec's crash-recovery path is "relaunch duet orchestrate") must
  // keep its valid interactive rest and any real prior interactive spend —
  // clearing the host would flip probeRunPosition's phase-loop snapshot into
  // headless-crash semantics, and zeroing the partial flag would lie about cost.
  const prevHost = state.orchestrationHost;
  const prevPartial = state.costs.orchestratorCostPartial;
  const prevInteractiveId = state.interactiveOrchestratorSessionId;

  state.orchestrationHost = 'interactive';
  // Sticky: orchestrator spend now runs on the flat subscription quota, so the
  // known total is partial — and stays partial past the handoff that clears
  // orchestrationHost.
  state.costs.orchestratorCostPartial = true;
  // A warm start records the session to resume; a reconnect leaves the persisted
  // id untouched so buildLaunchSpec re-attaches the same session.
  if (opts.resumeSessionId) state.interactiveOrchestratorSessionId = opts.resumeSessionId;
  saveRunState(state);

  // When a consultant is bound, compose the identity the launcher will feed:
  // the shipped base plus the consultant clause, into one run-dir file (see
  // composedIdentityPath). Preflight already confirmed the base exists. Unbound,
  // this is skipped and the shipped identity is fed directly — byte-for-byte the
  // pre-consultant launch. A leftover composed file from a failed launch is
  // harmless: it lives under the self-ignored run dir, is overwritten next
  // launch, and is removed by `duet abandon --purge`.
  if (state.bindings.consultant) {
    const base = readFileSync(identityPath, 'utf8');
    writeFileSync(composedIdentityPath(state), `${base.trimEnd()}\n\n${consultantIdentityClause(workflowOf(state))}\n`);
  }

  const spec = buildSpec(state, { warmStart });
  if (!gateAskRuleLive(spec)) {
    log(
      `[orchestrate] WARNING: the gate-safety ask rule (${GATE_ASK_RULE}) is missing from the launch settings — a "duet continue" could cross a gate WITHOUT a permission prompt. Apply it manually before trusting this session for gate decisions.`,
    );
  }

  const result = launcher({ ...spec, env: { ...process.env } });
  if (result.error) {
    // The session never started. Restore the pre-call state: a fresh launch
    // reverts to unmarked; a relaunch keeps its prior interactive rest and spend.
    // Either way status stays honest and no phantom owner is left behind.
    const fresh = loadRunState(state.cwd, state.runId);
    if (prevHost === undefined) delete fresh.orchestrationHost;
    else fresh.orchestrationHost = prevHost;
    fresh.costs.orchestratorCostPartial = prevPartial;
    // A failed warm start must not strand a resume id pointing at a session no
    // launch ever attached: revert to the pre-call value (undefined on a fresh
    // warm start; the prior id on a failed reconnect), keeping "the run is unchanged".
    if (prevInteractiveId === undefined) delete fresh.interactiveOrchestratorSessionId;
    else fresh.interactiveOrchestratorSessionId = prevInteractiveId;
    saveRunState(fresh);
    const enoent = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      ...result,
      error: new Error(
        enoent
          ? `could not launch "claude" — it was not found on PATH. Install Claude Code (or put it on PATH), then retry: duet orchestrate ${state.runId}. The run is unchanged.`
          : `the interactive session failed to launch (${result.error.message}). The run is unchanged; fix the cause, then retry: duet orchestrate ${state.runId}.`,
      ),
    };
  }
  return result;
}
