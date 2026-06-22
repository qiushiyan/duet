import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { GATE_ASK_RULE, KICKOFF_PROMPT, buildLaunchSpec, gateAskRuleLive, runOrchestrate } from '../src/orchestrate.ts';
import type { ClaudeLauncher } from '../src/orchestrate.ts';
import { CONSULTANT_IDENTITY_CLAUSE } from '../src/harness/orchestrator-prompts.ts';
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
  test('self-references the running CLI for the MCP server, with the runId baked in (injected self)', ({ run }) => {
    const self = { exec: '/opt/node/bin/node', entry: '/checkout/src/cli.ts' };
    const spec = buildLaunchSpec(run, self);
    const args = spec.args;
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    // The MCP server is THIS cli's exec + entry, not a bare `duet` PATH lookup —
    // so the kernel that attaches is the same duet that launched (the spawnDrive
    // pattern). The runId is baked into the args (no phase — resolved per call).
    expect.soft(mcp.mcpServers.duet).toEqual({
      command: self.exec,
      args: [self.entry, '_mcp', run.runId],
    });
  });

  test('the default self-reference is the live process exec + entry, never a PATH lookup', ({ run }) => {
    const spec = buildLaunchSpec(run);
    const args = spec.args;
    const duet = JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.duet;
    // Mirrors spawnDrive (lifecycle.ts): process.execPath runs process.argv[1].
    expect.soft(duet.command).toBe(process.execPath);
    expect.soft(duet.args).toEqual([process.argv[1], '_mcp', run.runId]);
    expect.soft(duet.command).not.toBe('duet'); // the bug this replaced
  });

  test('carries hygiene + identity + the ask rule', ({ run }) => {
    const spec = buildLaunchSpec(run);
    expect.soft(spec.command).toBe('claude');
    const args = spec.args;

    expect.soft(args).toContain('--strict-mcp-config'); // MCP-surface hygiene

    // The identity file fed as system-prompt-strength text.
    expect.soft(args[args.indexOf('--append-system-prompt-file') + 1]).toMatch(/prompts[/\\]orchestrator-identity\.md$/);

    // The single gate-safety ask rule, colon prefix form.
    expect.soft(gateAskRuleLive(spec)).toBe(true);
    expect.soft(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({
      permissions: { ask: ['Bash(duet continue:*)'] },
    });
  });

  test('seeds the kickoff user turn as the trailing [prompt] operand (Family A)', ({ run }) => {
    const args = buildLaunchSpec(run).args;
    // The kickoff is claude's positional prompt, so it must be the LAST arg —
    // after every option and its value, or claude would read it as a flag value.
    // This is what opens the wired session working instead of at a blank prompt.
    expect.soft(args[args.length - 1]).toBe(KICKOFF_PROMPT);
    // It drives the session to its first act — anchoring via get_task.
    expect.soft(KICKOFF_PROMPT).toMatch(/get_task/);
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

  test('an immediate launch failure (ENOENT) rolls the interactive marking back', ({ projectDir, run }) => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const result = runOrchestrate(run, { launcher: () => ({ error: enoent }) });

    // The error is surfaced for the caller to fail on, with prescribed recovery.
    expect.soft(result.error).toBeDefined();
    expect.soft(result.error?.message).toContain('claude');
    expect.soft(result.error?.message).toContain('not found on PATH');
    // The run is NOT left claiming a phantom interactive owner.
    const after = loadRunState(projectDir, run.runId);
    expect.soft(after.orchestrationHost).toBeUndefined();
    // No orchestrator turn ran, so the partial flag returns to false.
    expect.soft(after.costs.orchestratorCostPartial).toBe(false);
  });

  test('a failed RELAUNCH of an already-interactive run preserves its host and cost-partial', ({
    projectDir,
    run,
  }) => {
    // The run is already interactively orchestrated, with real prior interactive
    // spend recorded (orchestratorCostPartial true). The spec's crash-recovery
    // path is "relaunch duet orchestrate", so a relaunch whose spawn fails must
    // NOT discard that valid state.
    run.orchestrationHost = 'interactive';
    run.costs.orchestratorCostPartial = true;
    saveRunState(run);

    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const result = runOrchestrate(run, { launcher: () => ({ error: enoent }) });
    expect.soft(result.error).toBeDefined();

    // The failure must not flip a valid interactive rest into headless-crash
    // semantics (probeRunPosition keys off orchestrationHost), nor zero out
    // telemetry from real interactive turns.
    const after = loadRunState(projectDir, run.runId);
    expect.soft(after.orchestrationHost).toBe('interactive');
    expect.soft(after.costs.orchestratorCostPartial).toBe(true);
  });

  test('a missing identity file is refused at preflight, before the run is marked', ({ projectDir, run }) => {
    const rec = recordingLauncher();
    const result = runOrchestrate(run, {
      launcher: rec.launcher,
      identityPath: join(projectDir, 'no', 'such', 'identity.md'),
    });

    expect.soft(result.error).toBeDefined();
    expect.soft(result.error?.message).toContain('identity file is missing');
    expect.soft(rec.calls).toHaveLength(0); // never reached the launcher
    // Marking happens only after preflight, so the run is untouched.
    const after = loadRunState(projectDir, run.runId);
    expect.soft(after.orchestrationHost).toBeUndefined();
    expect.soft(after.costs.orchestratorCostPartial).toBe(false);
  });
});

// The interactive analogue of the headless orchestratorSystemPrompt(state)
// clause: the identity the launcher feeds gains the consultant clause ONLY when
// bound, so the interactive orchestrator's identity matches the headless one's
// — and an unbound run's launch stays byte-for-byte the pre-consultant one.
describe('consultant identity composition (parity with the headless clause)', () => {
  test('unbound: the launcher feeds the shipped identity verbatim — no composed file written', ({ projectDir, run }) => {
    const rec = recordingLauncher();
    runOrchestrate(run, { launcher: rec.launcher });

    const args = rec.calls[0]!.args;
    const fed = args[args.indexOf('--append-system-prompt-file') + 1]!;
    expect.soft(fed).toMatch(/prompts[/\\]orchestrator-identity\.md$/); // the shipped file, not a composition
    // Nothing was written under the run dir — the unbound launch is unchanged.
    expect.soft(existsSync(join(runDirOf(projectDir, run.runId), 'orchestrator-identity.md'))).toBe(false);
  });

  test('bound: the launcher feeds a run-dir identity composed of the shipped base + the consultant clause', ({
    projectDir,
    consultantRun,
  }) => {
    const rec = recordingLauncher();
    runOrchestrate(consultantRun, { launcher: rec.launcher });

    const composed = join(runDirOf(projectDir, consultantRun.runId), 'orchestrator-identity.md');
    const args = rec.calls[0]!.args;
    const fed = args[args.indexOf('--append-system-prompt-file') + 1]!;
    // The fed path is the run-dir composition, never the shipped prompts/ file.
    expect.soft(fed).toBe(composed);
    expect.soft(fed).not.toMatch(/prompts[/\\]orchestrator-identity\.md$/);
    // The composed file carries BOTH the shipped base (its two-agent opening) and
    // the consultant clause verbatim — the SAME clause the headless system prompt
    // appends, so the two hosts gain it identically.
    const body = readFileSync(composed, 'utf8');
    expect.soft(body).toContain('two-agent engineering workflow'); // the shipped base survived
    expect.soft(body).toContain(CONSULTANT_IDENTITY_CLAUSE); // the appended clause, byte-identical to headless
  });

  test('buildLaunchSpec stays pure: it names the composed path when bound but writes nothing', ({
    projectDir,
    consultantRun,
  }) => {
    // The file write is runOrchestrate's job; buildLaunchSpec only computes argv,
    // so a direct call names the run-dir path without creating it.
    const args = buildLaunchSpec(consultantRun).args;
    const fed = args[args.indexOf('--append-system-prompt-file') + 1]!;
    expect.soft(fed).toBe(join(runDirOf(projectDir, consultantRun.runId), 'orchestrator-identity.md'));
    expect.soft(existsSync(fed)).toBe(false); // no FS side effect
  });
});
