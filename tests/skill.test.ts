import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, test } from 'vitest';
import { program } from '../src/cli.ts';
import { FRAMING_TEMPLATE } from '../src/framing.ts';
import { IDENTITY_PATH } from '../src/orchestrate.ts';

/**
 * Coherence guard for the shipped concierge skill (skills/duet-concierge/):
 * every duet verb and flag the skill or its reference names must exist on
 * the real command table, and the skill must pre-approve read verbs only.
 * A renamed flag fails here in five seconds, not in a phone session.
 * (Importing the program is itself the guard that cli.ts stays side-effect
 * free under import — parsing runs only under import.meta.main.)
 */

const skillDir = new URL('../skills/duet-concierge/', import.meta.url);
const skillMd = readFileSync(new URL('SKILL.md', skillDir), 'utf8');
const referenceMd = readFileSync(new URL('references/cli-reference.md', skillDir), 'utf8');

const publicCommands = new Map(program.commands.filter((c) => !c.name().startsWith('_')).map((c) => [c.name(), c]));

/** Code-span lines: fenced blocks split into lines, plus inline `…` spans. Prose is not checked. */
function codeLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const block of markdown.match(/```[\s\S]*?```/g) ?? []) lines.push(...block.split('\n'));
  lines.push(...(markdown.replace(/```[\s\S]*?```/g, '').match(/`[^`\n]+`/g) ?? []));
  return lines;
}

function frontmatterOf(markdown: string): Record<string, string> {
  const end = markdown.indexOf('\n---', 4);
  const fields: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fields;
}

describe('the consultant flags exist on the command table', () => {
  // The optional consultant is enabled per-run via `duet new --consultant` /
  // disabled via `--no-consultant`. Pin both onto the real command table so a
  // rename fails here, not at run time (the generic doc-scan guards below only
  // cover flags the shipped skill docs name).
  test('duet new advertises --consultant and --no-consultant', () => {
    const longs = new Set((publicCommands.get('new')?.options ?? []).map((o) => o.long));
    expect.soft(longs.has('--consultant')).toBe(true);
    expect.soft(longs.has('--no-consultant')).toBe(true);
  });
});

describe('the duet-concierge skill coheres with the CLI', () => {
  test('SKILL.md frontmatter is complete and pre-approves read verbs only', () => {
    const fm = frontmatterOf(skillMd);
    expect.soft(fm['name']).toBe('duet-concierge');
    expect.soft(fm['description']).toBeTruthy();
    // Explicit invocation only: auto-triggering would load the relay role
    // into any session that merely mentions runs and gates — including
    // sessions developing duet itself.
    expect.soft(fm['disable-model-invocation']).toBe('true');

    const tools = (fm['allowed-tools'] ?? '').split(',').map((t) => t.trim());
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      // The rogue-concierge property: gate verbs (continue), run starts (new),
      // and steers must never be silently pre-approved.
      expect.soft(tool, 'only read verbs may be pre-approved').toMatch(/^Bash\(duet (status|logs|runs):\*\)$/);
    }
  });

  test.for([
    ['SKILL.md', skillMd],
    ['references/cli-reference.md', referenceMd],
  ] as const)('every duet verb and flag named in %s exists on the CLI', ([, markdown]) => {
    expect.hasAssertions();
    for (const line of codeLines(markdown)) {
      const verbs = [...line.matchAll(/\bduet\s+([a-z_]+)/g)].map((m) => m[1]!);
      if (verbs.length === 0) continue;

      for (const verb of verbs) {
        expect.soft(publicCommands.has(verb), `"duet ${verb}" in: ${line.trim()}`).toBe(true);
      }

      const command = publicCommands.get(verbs[0]!);
      if (!command) continue;
      const longs = new Set(command.options.map((o) => o.long));
      longs.add('--help'); // commander provides it on every command
      for (const [flag] of line.matchAll(/--[a-z][a-z-]*/g)) {
        expect.soft(longs.has(flag), `"${flag}" is not a flag of "duet ${verbs[0]}" in: ${line.trim()}`).toBe(true);
      }
    }
  });

  test('the reference documents every public command', () => {
    for (const name of publicCommands.keys()) {
      expect.soft(referenceMd, `duet ${name} is missing from the reference`).toContain(`duet ${name}`);
    }
  });

  test.for([
    ['SKILL.md', skillMd],
    ['references/cli-reference.md', referenceMd],
  ] as const)('%s documents the run-start workflow surface (both arcs)', ([, markdown]) => {
    // The concierge starts runs from dictation, so its run-start surface must
    // name the arc selector and RIR — not just the Full arc. --workflow is also
    // pinned to exist on `duet new` by the per-file verb/flag guard above.
    expect.soft(markdown).toContain('--workflow');
    expect.soft(markdown).toContain('workflow:'); // the framing frontmatter key
    expect.soft(markdown.toLowerCase()).toContain('rir');
    expect.soft(markdown).toContain('afk'); // RIR's pre-authorization preset
  });
});

const duetIdentityMd = readFileSync(new URL('../prompts/orchestrator-identity.md', import.meta.url), 'utf8');

// The orchestrator identity is a prompt asset, not a skill: the launcher feeds
// prompts/orchestrator-identity.md as the session's system prompt
// (--append-system-prompt-file). There is no `/duet` slash command — the
// orchestrator role is brought up by `duet orchestrate` / `duet new
// --interactive`, never a manual invocation (which would load the role with no
// kernel tools). So this block guards the identity file and the launcher command,
// not a SKILL.md.
describe('the duet orchestrator identity coheres with the CLI', () => {
  test('orchestrate is a public command — the launcher that feeds the identity', () => {
    expect(publicCommands.has('orchestrate')).toBe(true);
  });

  test('the launcher identity target is inside the publish surface (package.json files)', () => {
    // M2: --append-system-prompt-file <pkg>/prompts/orchestrator-identity.md must
    // be a SHIPPED file. With no .npmignore, the `files` allowlist is the whole
    // publish surface, so the launcher's IDENTITY_PATH must fall under one of its
    // entries — drop `prompts` and a packed build feeds claude a missing file.
    const pkgUrl = new URL('../package.json', import.meta.url);
    const packageRoot = dirname(fileURLToPath(pkgUrl));
    const files: string[] = JSON.parse(readFileSync(pkgUrl, 'utf8')).files;
    const rel = relative(packageRoot, IDENTITY_PATH).replaceAll('\\', '/');
    const shipped = files.some((entry) => {
      const base = entry.replace(/\/$/, '');
      return rel === base || rel.startsWith(`${base}/`);
    });
    expect.soft(rel, 'IDENTITY_PATH resolves under the package root').toBe('prompts/orchestrator-identity.md');
    expect.soft(shipped, `${rel} is not covered by package.json files: ${files.join(', ')}`).toBe(true);
  });

  test('every duet verb and flag named in identity.md exists on the CLI', () => {
    expect.hasAssertions();
    for (const line of codeLines(duetIdentityMd)) {
      // Only `duet <verb>` spans are CLI verbs; kernel tool names (get_task,
      // send_prompt, advance_phase, …) appear in spans too but are never
      // preceded by "duet ", so the extractor skips them.
      const verbs = [...line.matchAll(/\bduet\s+([a-z_]+)/g)].map((m) => m[1]!);
      if (verbs.length === 0) continue;

      for (const verb of verbs) {
        expect.soft(publicCommands.has(verb), `"duet ${verb}" in: ${line.trim()}`).toBe(true);
      }

      const command = publicCommands.get(verbs[0]!);
      if (!command) continue;
      const longs = new Set(command.options.map((o) => o.long));
      longs.add('--help');
      for (const [flag] of line.matchAll(/--[a-z][a-z-]*/g)) {
        expect.soft(longs.has(flag), `"${flag}" is not a flag of "duet ${verbs[0]}" in: ${line.trim()}`).toBe(true);
      }
    }
  });

  test('the identity is workflow-neutral — no hardcoded single-arc, anchored on get_task', () => {
    // Slice 4 made it arc-neutral: it must not name a fixed phase arc (the old
    // "FRAME → SPEC → PLAN") and must point the session at get_task + a generic
    // handoff gate, so a RIR session isn't told it's in the Full arc.
    expect.soft(duetIdentityMd).not.toMatch(/FRAME\s*→\s*SPEC\s*→\s*PLAN/);
    expect.soft(duetIdentityMd).not.toContain('plan-approval gate, the human');
    expect.soft(duetIdentityMd).toContain('get_task');
    expect.soft(duetIdentityMd).toContain('handoff gate');
  });
});

const duetFrameDir = new URL('../skills/duet-frame/', import.meta.url);
const duetFrameMd = readFileSync(new URL('SKILL.md', duetFrameDir), 'utf8');

describe('the duet-frame skill coheres with the CLI', () => {
  test('SKILL.md frontmatter names the skill and is explicit-invocation only', () => {
    const fm = frontmatterOf(duetFrameMd);
    expect.soft(fm['name']).toBe('duet-frame');
    expect.soft(fm['description']).toBeTruthy();
    // Explicit invocation only — a session shouldn't auto-adopt the framing-author
    // role (mirrors the concierge and the orchestrator identity).
    expect.soft(fm['disable-model-invocation']).toBe('true');
  });

  test('every duet verb and flag named in SKILL.md exists on the CLI', () => {
    expect.hasAssertions();
    for (const line of codeLines(duetFrameMd)) {
      const verbs = [...line.matchAll(/\bduet\s+([a-z_]+)/g)].map((m) => m[1]!);
      if (verbs.length === 0) continue;

      for (const verb of verbs) {
        expect.soft(publicCommands.has(verb), `"duet ${verb}" in: ${line.trim()}`).toBe(true);
      }

      const command = publicCommands.get(verbs[0]!);
      if (!command) continue;
      const longs = new Set(command.options.map((o) => o.long));
      longs.add('--help');
      for (const [flag] of line.matchAll(/--[a-z][a-z-]*/g)) {
        expect.soft(longs.has(flag), `"${flag}" is not a flag of "duet ${verbs[0]}" in: ${line.trim()}`).toBe(true);
      }
    }
  });

  test('the framing author picks the workflow and emits the --workflow selector', () => {
    // Slice 7: duet-frame settles the arc and emits it; --workflow must be a
    // real flag of `duet new`, and the skill must name both arcs so the author
    // can choose between them.
    expect.soft(duetFrameMd).toContain('--workflow');
    expect.soft(publicCommands.get('new')?.options.some((o) => o.long === '--workflow')).toBe(true);
    expect.soft(duetFrameMd.toLowerCase()).toContain('rir');
    expect.soft(duetFrameMd).toContain('afk'); // RIR's pre-authorization preset
  });
});

describe('no CLI help / template copy carries a Full-only-arc claim', () => {
  // Every user-facing copy string: each command's description, each option's
  // description (the altitude the broad earlier test missed), and the rendered
  // help (which includes the addHelpText run-shape blocks).
  function cliCopyStrings(): { label: string; text: string }[] {
    const out: { label: string; text: string }[] = [];
    const walk = (cmd: Command): void => {
      out.push({ label: `${cmd.name()} description`, text: cmd.description() ?? '' });
      for (const o of cmd.options) out.push({ label: `${cmd.name()} ${o.long ?? o.flags}`, text: o.description ?? '' });
      for (const sub of cmd.commands) walk(sub);
    };
    walk(program);
    // Capture the rendered top-level help (addHelpText 'after' included).
    const prev = program.configureOutput();
    let rendered = '';
    program.configureOutput({ writeOut: (s) => void (rendered += s) });
    program.outputHelp();
    program.configureOutput(prev);
    out.push({ label: 'rendered --help', text: rendered });
    return out;
  }

  // Phrases that are Full-arc-specific: legal only inside an explicitly two-arc
  // string (one that also names rir). A refactor-survivable guard — it bans the
  // bad pattern, not a particular wording.
  const FULL_ONLY_MARKERS = [
    'pr is always attended',
    'spec → plan → implementation → PR',
    'FRAME → PLAN',
    'plan-gate handoff',
  ];

  test('no command/option/help string names a Full-only marker without also naming rir', () => {
    for (const { label, text } of cliCopyStrings()) {
      const lower = text.toLowerCase();
      for (const marker of FULL_ONLY_MARKERS) {
        if (lower.includes(marker.toLowerCase())) {
          expect.soft(lower, `"${label}" carries Full-only copy "${marker}" without naming rir`).toContain('rir');
        }
      }
    }
  });

  test('no user-facing surface teaches the deleted `pr` gate token or the old docs/pr/open tail (H/Critical)', () => {
    // After H, `pr` is no longer a gate token (parseGatesAt rejects it), so any
    // surface that tells a user to list `pr`, lists pr as a full gate, or shows
    // the old docs→pr→open tail points them at an invalid value. Covers every
    // user-facing surface — the CLI help, the framing seed, AND the shipped-skill
    // .md narrative (all migrated to the post-open `finish` model).
    const surfaces = [
      ...cliCopyStrings(),
      { label: 'framing seed template', text: FRAMING_TEMPLATE },
      { label: 'duet-frame SKILL.md', text: duetFrameMd },
      { label: 'concierge SKILL.md', text: skillMd },
      { label: 'concierge cli-reference.md', text: referenceMd },
    ];
    for (const { label, text } of surfaces) {
      const lower = text.toLowerCase();
      expect.soft(lower, `"${label}" still tells users to list \`pr\``).not.toContain('list `pr`');
      expect.soft(lower, `"${label}" still lists pr as a full gate`).not.toContain('impl, pr');
      expect.soft(lower, `"${label}" still describes a pre-open stop`).not.toContain('pre-open');
      expect.soft(lower, `"${label}" still shows the "docs (one pass)" tail`).not.toContain('docs (one pass)');
    }
  });

  test('the arc-bearing surfaces name both arcs (the finding-1 residual sites)', () => {
    const opt = (cmd: string, long: string) =>
      (publicCommands.get(cmd)?.options.find((o) => o.long === long)?.description ?? '').toLowerCase();
    // --gates-at: both arcs' presets, including rir's afk.
    expect.soft(opt('new', '--gates-at')).toContain('rir');
    expect.soft(opt('new', '--gates-at')).toContain('afk');
    // --interactive and orchestrate: the handoff gate per arc.
    expect.soft(opt('new', '--interactive')).toContain('rir');
    expect.soft(publicCommands.get('orchestrate')?.description().toLowerCase()).toContain('rir');
  });

  test('the framing template seed names both arcs (workflow:, rir, afk)', () => {
    expect.soft(FRAMING_TEMPLATE).toContain('workflow:');
    expect.soft(FRAMING_TEMPLATE.toLowerCase()).toContain('rir');
    expect.soft(FRAMING_TEMPLATE).toContain('afk');
    // No Full-only-arc claim survives in the seed.
    for (const marker of FULL_ONLY_MARKERS) {
      if (FRAMING_TEMPLATE.toLowerCase().includes(marker.toLowerCase())) {
        expect.soft(FRAMING_TEMPLATE.toLowerCase(), `template carries "${marker}" without rir`).toContain('rir');
      }
    }
  });
});

describe('shipped gate-posture copy teaches the overnight-default, post-open finish model', () => {
  // full pre-authorizes plan/impl/finish by default now (phases.ts:
  // defaultPreAuthorized: ['plan','impl','finish']), so `overnight` is the default
  // posture and the Open-PR gate sits AFTER the PR open. Any "always
  // attended" claim about the Open-PR gate, or an unqualified "Default: every
  // gate", is the pre-bundle model — a shipped skill that teaches it would steer
  // the framing author / concierge to the wrong posture. These guards pin the
  // corrected model so a future edit can't quietly reintroduce the old one.
  const gatesAtHelp = (publicCommands.get('new')?.options.find((o) => o.long === '--gates-at')?.description ?? '');
  // All three shipped prose surfaces — including the root concierge SKILL.md the
  // round-1 guard missed (round 2).
  const shippedDocs = [
    ['duet-frame SKILL.md', duetFrameMd],
    ['concierge SKILL.md', skillMd],
    ['concierge cli-reference.md', referenceMd],
  ] as const;

  test('no shipped surface still says the PR/Open-PR gate is always attended', () => {
    // Broad enough to catch "always attended" AND "always stays attended" (the
    // concierge SKILL.md variant) — any "always … attended" within one sentence.
    for (const [label, md] of shippedDocs) {
      expect.soft(md, `${label} still claims the PR gate is always attended`).not.toMatch(/always[^.]*attended/i);
    }
  });

  test('no help/template copy carries an unqualified "Default: every gate"', () => {
    // "default: every gate" is false for Full now — the corrected copy reads
    // "default: attend every gate except full's auto-opening PR".
    expect.soft(FRAMING_TEMPLATE).not.toMatch(/default:\s*every gate/i);
    expect.soft(gatesAtHelp).not.toMatch(/default:\s*every gate/i);
  });

  test('the gate-posture surfaces teach the post-open finish model (overnight default, finish token)', () => {
    // Every gate-posture surface names the new default (`overnight`) and the new
    // attend token (`finish`) — so a framing author / concierge reading any of
    // them is steered to the live posture, not the retired auto-open-`pr` one.
    const surfaces = [...shippedDocs, ['framing seed', FRAMING_TEMPLATE], ['--gates-at help', gatesAtHelp]] as const;
    for (const [label, text] of surfaces) {
      const lower = text.toLowerCase();
      expect.soft(lower, `${label} omits the overnight default`).toContain('overnight');
      expect.soft(lower, `${label} omits the finish gate token`).toContain('finish');
    }
  });

  test('the concierge cause docs name the budget cause (slice 5)', () => {
    // stop.cause gained `budget` (slice 5) — the relay docs must list it so the
    // concierge triages a budget stop as resumable, not an outage.
    expect.soft(skillMd, 'concierge SKILL.md omits the budget cause').toMatch(/cause[\s\S]{0,200}budget/i);
    expect.soft(referenceMd, 'concierge cli-reference omits the budget cause').toMatch(/cause[\s\S]{0,200}budget/i);
  });
});

describe('the infra-retry copy teaches the materialized default-3, not the retired opt-in/off story', () => {
  // The AFK change flipped the headless infra auto-retry default to 3,
  // materialized at createRun (run-store.ts DEFAULT_RETRY_INFRA). The behavior
  // test lives in run-store.test.ts; this is the WORDING-LOCK the reviewer asked
  // for — the user-facing help + the shipped concierge reference must teach
  // "default 3 for new runs; 0 disables", never the retired opt-in / default-off
  // copy, so the surfaces can't silently drift back behind the behavior again.
  const retryHelp = publicCommands.get('new')?.options.find((o) => o.long === '--retry-infra')?.description ?? '';
  const retryRow = referenceMd.split('\n').find((l) => l.includes('--retry-infra')) ?? '';

  test('both the --retry-infra help and the concierge reference row name the default-3 model', () => {
    for (const [label, text] of [
      ['--retry-infra help', retryHelp],
      ['concierge reference row', retryRow],
    ] as const) {
      const lower = text.toLowerCase();
      expect.soft(lower, `${label} omits the default-3 wording`).toMatch(/default[^.]*\b3\b/);
      expect.soft(lower, `${label} omits that 0 disables`).toContain('0');
      // The retired framing — opt-in / "opt … into" / default-off / off by default.
      expect.soft(lower, `${label} still calls retry opt-in`).not.toContain('opt-in');
      expect.soft(lower, `${label} still frames retry as opt-into`).not.toMatch(/opt\s+the\b.*\binto/);
      expect.soft(lower, `${label} still says default-off`).not.toMatch(/default-?off|off by default|default:\s*off/);
    }
  });
});
