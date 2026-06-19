import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { GATE_ASK_RULE, buildLaunchSpec, gateAskRuleLive, runOrchestrate } from '../src/orchestrate.ts';
import type { ClaudeLauncher } from '../src/orchestrate.ts';
import { loadRunState, runDirOf, saveRunState } from '../src/run-store.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The `duet orchestrate` launcher — over the process-spawn seam, so no test ever
 * launches claude. buildLaunchSpec is pure (argv assertions); runOrchestrate is
 * driven with a recording ClaudeLauncher that captures the spec.
 */

function recordingLauncher() {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const launcher: ClaudeLauncher = (spec) => {
    calls.push(spec);
    return { pid: 4242 };
  };
  return { calls, launcher };
}

describe('buildLaunchSpec — the wired claude argv', () => {
  test('bakes the runId into the MCP server args and carries hygiene + identity + the ask rule', ({ run }) => {
    const spec = buildLaunchSpec(run);
    expect.soft(spec.command).toBe('claude');
    const args = spec.args;

    // --mcp-config declares the one duet kernel server with the runId baked into
    // its args (no phase — the run-scoped server resolves it per call).
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    expect.soft(mcp.mcpServers.duet).toEqual({ command: 'duet', args: ['_mcp', run.runId] });

    expect.soft(args).toContain('--strict-mcp-config'); // MCP-surface hygiene

    // The identity file fed as system-prompt-strength text.
    expect.soft(args[args.indexOf('--append-system-prompt-file') + 1]).toMatch(/skills[/\\]duet[/\\]identity\.md$/);

    // The single gate-safety ask rule, colon prefix form.
    expect.soft(gateAskRuleLive(spec)).toBe(true);
    expect.soft(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({
      permissions: { ask: ['Bash(duet continue:*)'] },
    });
  });
});

describe('runOrchestrate — marks the run and launches over the seam', () => {
  test('sets orchestrationHost (persisted), launches exactly once, and spawns no headless _drive', ({
    projectDir,
    run,
  }) => {
    const rec = recordingLauncher();
    runOrchestrate(run, { launcher: rec.launcher });

    const after = loadRunState(projectDir, run.runId);
    expect.soft(after.orchestrationHost).toBe('interactive');
    // The orchestrator now bills the flat subscription quota — the known total is partial.
    expect.soft(after.costs.orchestratorCostPartial).toBe(true);
    expect.soft(rec.calls).toHaveLength(1);
    expect.soft(rec.calls[0]!.args).toContain('--strict-mcp-config'); // the real spec reached the launcher
    // The interactive host has no _drive — nothing headless was spawned.
    expect.soft(existsSync(join(runDirOf(projectDir, run.runId), 'driver.pid'))).toBe(false);
  });

  test('orchestratorCostPartial is sticky — it outlives the handoff that clears orchestrationHost', ({
    projectDir,
    run,
  }) => {
    runOrchestrate(run, { launcher: recordingLauncher().launcher });
    // Simulate the plan-gate handoff: orchestrationHost is cleared, but the fact
    // that orchestrator spend went unmetered must persist.
    const handed = loadRunState(projectDir, run.runId);
    delete handed.orchestrationHost;
    saveRunState(handed);
    const final = loadRunState(projectDir, run.runId);
    expect.soft(final.orchestrationHost).toBeUndefined();
    expect.soft(final.costs.orchestratorCostPartial).toBe(true);
  });

  test('createRun defaults orchestratorCostPartial to false', ({ run }) => {
    expect(run.costs.orchestratorCostPartial).toBe(false);
  });

  test('warns loudly when the gate-safety rule is missing from the spec, but still launches', ({ run }) => {
    const rec = recordingLauncher();
    const warnings: string[] = [];
    runOrchestrate(run, {
      launcher: rec.launcher,
      buildSpec: () => ({ command: 'claude', args: ['--mcp-config', '{}'] }), // no --settings ask rule
      log: (l) => warnings.push(l),
    });
    const out = warnings.join('\n');
    expect.soft(out).toContain('gate-safety ask rule');
    expect.soft(out).toContain(GATE_ASK_RULE);
    expect.soft(rec.calls).toHaveLength(1); // still launched — the session is attended
  });
});
