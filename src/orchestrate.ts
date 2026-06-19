import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveRunState } from './run-store.ts';
import type { RunState } from './run-store.ts';

/**
 * The `duet orchestrate <runId>` launcher (Stage 1) — the one place that brings
 * up the human's interactive Claude Code session wired to drive a run over
 * FRAME → PLAN, and the one place that applies the single gate-safety
 * permission rule. A skill cannot do launch-time wiring (the runId is dynamic),
 * which is why the launcher and the `skills/duet/` identity coexist by design:
 * the skill is what `--append-system-prompt-file` carries.
 *
 * The process spawn is the Environment seam (modeled on providers/pane.ts'
 * PaneFactory): runOrchestrate takes an injectable ClaudeLauncher so tests
 * capture the launch spec and never spawn claude.
 */

// The orchestrator identity fed to the session as system-prompt-strength text
// (durable across compaction, unlike a skill body). Resolved package-relative
// from this module the same way snippets.ts resolves its data — survives the
// publish bundle (docs/engineering.md §Build).
const IDENTITY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'duet', 'identity.md');

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

export interface LaunchSpec {
  command: string;
  args: string[];
}

/** Build the `claude` argv that wires an interactive session to drive `state`. */
export function buildLaunchSpec(state: RunState): LaunchSpec {
  // The runId is baked into the MCP server args at launch — what a static
  // project .mcp.json or a mid-session skill cannot do.
  const mcpConfig = JSON.stringify({
    mcpServers: { duet: { command: 'duet', args: ['_mcp', state.runId] } },
  });
  const settings = JSON.stringify({ permissions: { ask: [GATE_ASK_RULE] } });
  return {
    command: 'claude',
    args: [
      '--mcp-config', mcpConfig,
      // The session's MCP surface is exactly the duet kernel — no user/global
      // MCP leakage, the hygiene the headless host gets from strictMcpConfig.
      '--strict-mcp-config',
      '--append-system-prompt-file', IDENTITY_PATH,
      '--settings', settings,
    ],
  };
}

/** The process-spawn seam — a fake captures the spec; the default hands the terminal to claude. */
export type ClaudeLauncher = (spec: { command: string; args: string[]; env: NodeJS.ProcessEnv }) => { pid?: number };

const defaultLauncher: ClaudeLauncher = (spec) => {
  // spawnSync hands the terminal fully to claude and blocks until it exits — the
  // right shape for an interactive handoff (duet returns when the session ends),
  // and synchronous like the seam.
  const result = spawnSync(spec.command, spec.args, { stdio: 'inherit', env: spec.env });
  return { pid: result.pid };
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
 * Mark the run interactively orchestrated and launch the wired session. The
 * ask-rule self-check warns loudly (to stderr) if the gate-safety rule isn't in
 * the spec — gate protection is not a setup step the human can silently forget —
 * but still launches, because the session is attended and the human sees it.
 */
export function runOrchestrate(
  state: RunState,
  opts: {
    launcher?: ClaudeLauncher;
    buildSpec?: (state: RunState) => LaunchSpec;
    log?: (line: string) => void;
  } = {},
): { pid?: number } {
  const launcher = opts.launcher ?? defaultLauncher;
  const buildSpec = opts.buildSpec ?? buildLaunchSpec;
  const log = opts.log ?? ((line: string) => console.error(line));

  state.orchestrationHost = 'interactive';
  saveRunState(state);

  const spec = buildSpec(state);
  if (!gateAskRuleLive(spec)) {
    log(
      `[orchestrate] WARNING: the gate-safety ask rule (${GATE_ASK_RULE}) is missing from the launch settings — a "duet continue" could cross a gate WITHOUT a permission prompt. Apply it manually before trusting this session for gate decisions.`,
    );
  }
  return launcher({ ...spec, env: { ...process.env } });
}
