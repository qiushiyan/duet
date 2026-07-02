import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test as plain, vi } from 'vitest';
import { existsSync } from 'node:fs';
import {
  DEFAULT_FRAMING_FILE,
  FRAMING_TEMPLATE,
  composeInEditor,
  parseFramingFile,
  parseGatesAt,
  parseWorkflow,
  resolveHumanText,
  resolveRunInputs,
  resolveTemplateSeed,
} from '../src/framing.ts';
import { test } from './helpers/fixtures.ts';

describe('parseGatesAt', () => {
  plain.for([
    { input: 'frame,spec', expected: ['frame', 'spec'] },
    { input: 'frame spec  plan', expected: ['frame', 'spec', 'plan'] },
    { input: 'overnight', expected: ['frame', 'spec'] },
    { input: 'skip-plan', expected: ['frame', 'spec', 'implement'] },
    { input: 'finish', expected: ['finish'] }, // finish (Open-PR) is attended only when explicitly listed (opt-in)
    { input: 'frame,frame,spec', expected: ['frame', 'spec'] },
  ])('"$input" → $expected (no finish auto-appended; finish is opt-in now)', ({ input, expected }) => {
    expect(parseGatesAt(input)).toEqual(expected);
  });

  plain('an unknown phase fails with the full vocabulary', () => {
    expect(() => parseGatesAt('frame,ship')).toThrow(/"ship" is not a gate-bearing phase.*frame, spec, plan, implement, finish/);
  });

  plain('an empty list fails with how to fix it', () => {
    expect(() => parseGatesAt('  ,  ')).toThrow(/gates_at is empty/);
  });

  plain('validates against the chosen workflow — a Full-only phase is rejected for RIR', () => {
    expect(() => parseGatesAt('plan', 'rir')).toThrow(/"plan" is not a gate-bearing phase of the "rir" workflow.*research, implement/);
  });

  plain('RIR force-appends nothing — pr is Full-only', () => {
    // research is a RIR gate phase; no pr is appended (RIR's forceAttend is []).
    expect(parseGatesAt('research', 'rir')).toEqual(['research']);
  });

  plain('a matched preset may resolve to an empty attended-gates list (RIR afk = attend nothing)', () => {
    expect(parseGatesAt('afk', 'rir')).toEqual([]);
  });

  plain('S8: the full-arc afk preset resolves to attend-none ([]) — the missing launch rung', () => {
    expect(parseGatesAt('afk', 'full')).toEqual([]);
    expect(parseGatesAt('afk')).toEqual([]); // default workflow is full
  });

  plain('a literal empty list is still rejected for RIR (only a matched preset may be empty)', () => {
    expect(() => parseGatesAt('  ,  ', 'rir')).toThrow(/gates_at is empty/);
  });
});

describe('parseWorkflow', () => {
  plain.for([
    { input: 'full', expected: 'full' },
    { input: 'rir', expected: 'rir' },
    { input: '  rir  ', expected: 'rir' },
  ])('"$input" → $expected', ({ input, expected }) => {
    expect(parseWorkflow(input)).toBe(expected);
  });

  plain('an unknown workflow fails with the valid set', () => {
    expect(() => parseWorkflow('xyz')).toThrow(/"xyz" is not a duet workflow.*full, rir/);
  });
});

describe('parseFramingFile (the machine/prose boundary)', () => {
  plain('a file without frontmatter passes through untouched', () => {
    const { meta, body } = parseFramingFile('# Problem\nbuild the thing');
    expect(meta).toEqual({});
    expect(body).toBe('# Problem\nbuild the thing');
  });

  plain('frontmatter is parsed and stripped from the body', () => {
    const { meta, body } = parseFramingFile(
      '---\n# a comment\ngates_at: overnight\nspec: docs/spec.md\n---\n\n# Problem\nthe prose',
    );
    expect(meta).toEqual({ gatesAt: ['frame', 'spec'], spec: 'docs/spec.md' });
    expect(body).toBe('# Problem\nthe prose');
  });

  plain('an unknown key fails loudly, pointing judgment-stuff at the prose body', () => {
    expect(() => parseFramingFile('---\nplan_dir: docs/plans\n---\nbody')).toThrow(
      /unknown key\(s\): plan_dir.*belongs in the prose body/,
    );
  });

  plain('an unclosed block names the fix', () => {
    expect(() => parseFramingFile('---\ngates_at: frame\nbody without closing')).toThrow(/never closed/);
  });

  plain('a file ending at the closing --- has an empty body, not a leaked frontmatter', () => {
    const { meta, body } = parseFramingFile('---\ngates_at: frame\n---');
    expect(meta.gatesAt).toEqual(['frame']);
    expect(body).toBe('');
  });

  plain('a non key:value line in the block is rejected', () => {
    expect(() => parseFramingFile('---\njust some words\n---\nbody')).toThrow(/is not "key: value"/);
  });

  plain('retry_infra parses to a non-negative int; a bad value fails', () => {
    expect.soft(parseFramingFile('---\nretry_infra: 2\n---\nbody').meta.retryInfra).toBe(2);
    expect.soft(() => parseFramingFile('---\nretry_infra: -1\n---\nbody')).toThrow(/non-negative integer/);
    expect.soft(() => parseFramingFile('---\nretry_infra: lots\n---\nbody')).toThrow(/non-negative integer/);
  });

  plain('a workflow key parses, and gates_at validates against it', () => {
    const { meta } = parseFramingFile('---\nworkflow: rir\ngates_at: afk\n---\nbody');
    expect.soft(meta.workflow).toBe('rir');
    expect.soft(meta.gatesAt).toEqual([]); // afk against rir → attend nothing
  });

  plain('an unknown workflow value fails with the valid set', () => {
    expect(() => parseFramingFile('---\nworkflow: turbo\n---\nbody')).toThrow(/"turbo" is not a duet workflow/);
  });

  plain('a literal empty gates_at is rejected (key-present, not silently ignored)', () => {
    expect(() => parseFramingFile('---\ngates_at:\n---\nbody')).toThrow(/gates_at is empty/);
  });

  plain('a gateless boolean key parses; a non-boolean fails loudly', () => {
    expect.soft(parseFramingFile('---\ngateless: true\n---\nbody').meta.gateless).toBe(true);
    expect.soft(parseFramingFile('---\ngateless: false\n---\nbody').meta.gateless).toBe(false);
    expect.soft(() => parseFramingFile('---\ngateless: yes\n---\nbody')).toThrow(/gateless: "yes" is not a boolean/);
  });

  plain('interactive and the consultant toggle parse; a binding-shaped consultant is rejected', () => {
    expect.soft(parseFramingFile('---\ninteractive: true\n---\nbody').meta.interactive).toBe(true);
    expect.soft(parseFramingFile('---\nconsultant: on\n---\nbody').meta.consultant).toBe('on');
    expect.soft(parseFramingFile('---\nconsultant: off\n---\nbody').meta.consultant).toBe('off');
    // The toggle never binds — a provider/model value points to where bindings live.
    expect.soft(() => parseFramingFile('---\nconsultant: claude:opus\n---\nbody')).toThrow(/is not on or off/);
  });
});

describe('composeInEditor (the no-inline-text path for riders and feedback)', () => {
  test('returns what the editor saved, instruction seed stripped, verbatim otherwise', async ({ projectDir }) => {
    const editor = join(projectDir, 'editor.sh');
    writeFileSync(editor, '#!/bin/sh\nprintf "approved — but cap it at 3\\n\\n# and keep this heading\\n" >> "$1"\n', {
      mode: 0o755,
    });
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', editor);

    // The user's own text is never mangled — markdown headings included.
    expect(await composeInEditor('test instructions')).toBe('approved — but cap it at 3\n\n# and keep this heading');
  });

  test('an untouched (or emptied) file returns empty — the caller decides what empty means', async () => {
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'true'); // exits 0, writes nothing
    expect(await composeInEditor('test')).toBe('');
  });

  test('a failing editor throws without sending', async () => {
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'false'); // exits 1
    await expect(composeInEditor('test')).rejects.toThrow(/editor exited with an error.*nothing was sent/);
  });
});

describe('resolveHumanText (inline / editor / non-TTY sentinel)', () => {
  test('an inline string is returned verbatim — no editor, TTY or not', async () => {
    // The inline short-circuit is independent of interactivity: the value is
    // what the human typed after the flag.
    expect.soft(await resolveHumanText('approve, but cap at 3', 'instr', { isTTY: false })).toBe('approve, but cap at 3');
    expect.soft(await resolveHumanText('approve, but cap at 3', 'instr', { isTTY: true })).toBe('approve, but cap at 3');
  });

  test('a bare flag on a TTY opens the editor and returns what it saved', async ({ projectDir }) => {
    const editor = join(projectDir, 'editor.sh');
    writeFileSync(editor, '#!/bin/sh\nprintf "from the editor\\n" >> "$1"\n', { mode: 0o755 });
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', editor);
    expect(await resolveHumanText(true, 'instr', { isTTY: true })).toBe('from the editor');
  });

  test('a bare flag off a TTY returns the sentinel and never opens the editor', async ({ projectDir }) => {
    // The non-interactive trap (#6): a headless caller must not block on an
    // editor it can't drive. An EDITOR that would leave a marker proves it
    // never ran; the result is the undefined sentinel the caller maps per intent.
    const marker = join(projectDir, 'editor-ran.marker');
    const editor = join(projectDir, 'editor.sh');
    writeFileSync(editor, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', editor);
    expect.soft(await resolveHumanText(undefined, 'instr', { isTTY: false })).toBeUndefined();
    expect.soft(await resolveHumanText(true, 'instr', { isTTY: false })).toBeUndefined();
    expect.soft(existsSync(marker)).toBe(false);
  });
});

describe('resolveTemplateSeed (the framing draft seed)', () => {
  const templatesDir = (projectDir: string) => join(projectDir, '.duet', 'templates');

  test('with no name and no project templates, returns the built-in template', ({ projectDir }) => {
    expect(resolveTemplateSeed(projectDir)).toBe(FRAMING_TEMPLATE);
  });

  test('with no name, a project default.md overrides the built-in', ({ projectDir }) => {
    const dir = templatesDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default.md'), '# Problem\nproject default seed');
    expect(resolveTemplateSeed(projectDir)).toBe('# Problem\nproject default seed');
  });

  test('a named template is read from .duet/templates/<name>.md', ({ projectDir }) => {
    const dir = templatesDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bug.md'), 'bug template body');
    expect.soft(resolveTemplateSeed(projectDir, 'bug')).toBe('bug template body');
    // an explicit .md suffix selects the same file, not bug.md.md
    expect.soft(resolveTemplateSeed(projectDir, 'bug.md')).toBe('bug template body');
  });

  test('a missing named template fails loudly, listing what is available', ({ projectDir }) => {
    const dir = templatesDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bug.md'), 'x');
    writeFileSync(join(dir, 'feature.md'), 'y');
    expect(() => resolveTemplateSeed(projectDir, 'nope')).toThrow(
      /template "nope" not found.*available: (bug, feature|feature, bug)/,
    );
  });

  test('a missing template with no templates dir points at how to make one', ({ projectDir }) => {
    expect(() => resolveTemplateSeed(projectDir, 'bug')).toThrow(/no \.duet\/templates\/ directory yet/);
  });

  test('a name with a path separator or traversal is rejected before any read', ({ projectDir }) => {
    expect.soft(() => resolveTemplateSeed(projectDir, '../secret')).toThrow(/not a plain name/);
    expect.soft(() => resolveTemplateSeed(projectDir, 'a/b')).toThrow(/not a plain name/);
    expect.soft(() => resolveTemplateSeed(projectDir, '..')).toThrow(/not a plain name/);
  });
});

describe('resolveRunInputs --template (seeding the editor draft)', () => {
  test('--template seeds the draft from the named project template, and the edit is used', async ({ projectDir }) => {
    const dir = join(projectDir, '.duet', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'feature.md'), '# Problem\nFEATURE SKELETON\n');
    const editor = join(projectDir, 'editor.sh');
    writeFileSync(editor, '#!/bin/sh\nprintf "filled in by hand\\n" >> "$1"\n', { mode: 0o755 });
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', editor);

    const inputs = await resolveRunInputs(projectDir, { template: 'feature' });
    expect.soft(inputs.framing).toContain('FEATURE SKELETON');
    expect.soft(inputs.framing).toContain('filled in by hand');
    expect.soft(inputs.framingFile).toBe(DEFAULT_FRAMING_FILE);
  });

  test('an untouched named template refuses to start (the guard tracks the seed)', async ({ projectDir }) => {
    const dir = join(projectDir, '.duet', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'feature.md'), '# Problem\nFEATURE SKELETON\n');
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'true'); // leaves the seeded draft untouched
    await expect(resolveRunInputs(projectDir, { template: 'feature' })).rejects.toThrow(/still the untouched template/);
  });

  test('bare entry seeds from a project default.md when present', async ({ projectDir }) => {
    const dir = join(projectDir, '.duet', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default.md'), '# Problem\nDEFAULT SKELETON\n');
    const editor = join(projectDir, 'editor.sh');
    writeFileSync(editor, '#!/bin/sh\nprintf "the specifics\\n" >> "$1"\n', { mode: 0o755 });
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', editor);

    const inputs = await resolveRunInputs(projectDir, {});
    expect.soft(inputs.framing).toContain('DEFAULT SKELETON');
    expect.soft(inputs.framing).toContain('the specifics');
  });

  test('a stale built-in draft is still caught as untouched after a default.md appears', async ({ projectDir }) => {
    // A prior bare run left an untouched built-in-seeded draft on disk (the
    // abort path preserves it)...
    mkdirSync(join(projectDir, '.duet'), { recursive: true });
    writeFileSync(join(projectDir, DEFAULT_FRAMING_FILE), FRAMING_TEMPLATE);
    // ...then the project gained a default.md — a different seed — before the
    // next run. The bare path reuses the stale draft without reseeding, so the
    // guard must still recognize the built-in template it holds.
    const dir = join(projectDir, '.duet', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default.md'), '# Problem\nDEFAULT SKELETON\n');
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'true'); // reuses the stale draft, no edit

    await expect(resolveRunInputs(projectDir, {})).rejects.toThrow(/still the untouched template/);
  });

  test('a missing --template surfaces the not-found error', async ({ projectDir }) => {
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'true');
    await expect(resolveRunInputs(projectDir, { template: 'ghost' })).rejects.toThrow(/template "ghost" not found/);
  });

  test('--template conflicts with --framing and with --spec', async ({ projectDir }) => {
    await expect(resolveRunInputs(projectDir, { template: 'x', framing: 'brief.md' })).rejects.toThrow(
      /conflicts with --spec\/--framing/,
    );
    await expect(resolveRunInputs(projectDir, { template: 'x', spec: 'docs/draft.md' })).rejects.toThrow(
      /conflicts with --spec\/--framing/,
    );
  });
});

describe('resolveRunInputs', () => {
  test('a --framing file supplies the body; its frontmatter supplies defaults the flags can override', async ({
    projectDir,
  }) => {
    writeFileSync(join(projectDir, 'brief.md'), '---\ngates_at: overnight\n---\n\nthe briefing');
    mkdirSync(join(projectDir, 'docs'));
    writeFileSync(join(projectDir, 'docs', 'draft.md'), 'a draft spec');

    const fromFrontmatter = await resolveRunInputs(projectDir, { framing: 'brief.md' });
    expect.soft(fromFrontmatter.framing).toBe('the briefing');
    expect.soft(fromFrontmatter.framingRaw).toContain('gates_at: overnight');
    expect.soft(fromFrontmatter.gatesAt).toEqual(['frame', 'spec']);

    const flagWins = await resolveRunInputs(projectDir, { framing: 'brief.md', gatesAt: 'implement', spec: 'docs/draft.md' });
    expect.soft(flagWins.gatesAt).toEqual(['implement']);
    expect.soft(flagWins.specPath).toBe('docs/draft.md');
  });

  test('workflow precedence: flag > frontmatter > full default', async ({ projectDir }) => {
    writeFileSync(join(projectDir, 'full.md'), '---\nworkflow: full\n---\nbody');
    writeFileSync(join(projectDir, 'rir.md'), '---\nworkflow: rir\n---\nbody');
    writeFileSync(join(projectDir, 'plain.md'), 'no frontmatter body');

    expect.soft((await resolveRunInputs(projectDir, { framing: 'plain.md' })).workflow).toBe('full'); // neither → full
    expect.soft((await resolveRunInputs(projectDir, { framing: 'rir.md' })).workflow).toBe('rir'); // frontmatter
    expect.soft((await resolveRunInputs(projectDir, { framing: 'full.md', workflow: 'rir' })).workflow).toBe('rir'); // flag wins
  });

  test('an unknown --workflow fails with the valid set', async ({ projectDir }) => {
    writeFileSync(join(projectDir, 'b.md'), 'body');
    await expect(resolveRunInputs(projectDir, { framing: 'b.md', workflow: 'turbo' })).rejects.toThrow(
      /"turbo" is not a duet workflow/,
    );
  });

  test('--workflow rir rejects --spec with an actionable message', async ({ projectDir }) => {
    mkdirSync(join(projectDir, 'docs'));
    writeFileSync(join(projectDir, 'docs', 'draft.md'), 'a draft spec');
    await expect(resolveRunInputs(projectDir, { workflow: 'rir', spec: 'docs/draft.md' })).rejects.toThrow(
      /--workflow rir takes no --spec/,
    );
  });

  test('gates_at re-validates against a flag-overridden workflow (a Full list can’t ride into a RIR run)', async ({
    projectDir,
  }) => {
    // frontmatter declares full + a Full gates_at; the flag overrides to rir,
    // so the Full-shaped list must be rejected against rir.
    writeFileSync(join(projectDir, 'b.md'), '---\nworkflow: full\ngates_at: frame, spec\n---\nbody');
    await expect(resolveRunInputs(projectDir, { framing: 'b.md', workflow: 'rir' })).rejects.toThrow(
      /not a gate-bearing phase of the "rir" workflow/,
    );
    // The afk preset, parsed against rir, resolves to attend-nothing.
    writeFileSync(join(projectDir, 'r.md'), '---\nworkflow: rir\ngates_at: afk\n---\nbody');
    expect((await resolveRunInputs(projectDir, { framing: 'r.md' })).gatesAt).toEqual([]);
  });

  test('an explicit empty --gates-at "" is rejected, matching frontmatter key-present semantics', async ({
    projectDir,
  }) => {
    writeFileSync(join(projectDir, 'b.md'), 'body');
    // A literal empty flag value reaches parseGatesAt and fails, rather than
    // being silently dropped to attend-all the way a truthiness check would.
    await expect(resolveRunInputs(projectDir, { framing: 'b.md', gatesAt: '' })).rejects.toThrow(/gates_at is empty/);
  });

  test('gateless materializes attend-nothing (the posture axis) and carries the flag (the consultant axis)', async ({
    projectDir,
  }) => {
    writeFileSync(join(projectDir, 'plain.md'), 'body');
    // The flag form — attend nothing, gateless carried onto the inputs.
    const fromFlag = await resolveRunInputs(projectDir, { framing: 'plain.md', gateless: true });
    expect.soft(fromFlag.gatesAt).toEqual([]);
    expect.soft(fromFlag.gateless).toBe(true);
    // The frontmatter form does the same.
    writeFileSync(join(projectDir, 'g.md'), '---\ngateless: true\n---\nbody');
    const fromFrontmatter = await resolveRunInputs(projectDir, { framing: 'g.md' });
    expect.soft(fromFrontmatter.gatesAt).toEqual([]);
    expect.soft(fromFrontmatter.gateless).toBe(true);
    // A non-gateless run never carries the flag (default-off, byte-for-byte).
    expect.soft((await resolveRunInputs(projectDir, { framing: 'plain.md' })).gateless).toBeUndefined();
  });

  test('gateless conflicts with an explicit attend-something gates_at, but not with an attend-none preset', async ({
    projectDir,
  }) => {
    writeFileSync(join(projectDir, 'plain.md'), 'body');
    // Naming gates to attend while going gateless is a contradiction — reject it,
    // whether the attend-set comes from the flag or the frontmatter.
    await expect(resolveRunInputs(projectDir, { framing: 'plain.md', gateless: true, gatesAt: 'spec' })).rejects.toThrow(
      /a gateless run attends no gates/,
    );
    writeFileSync(join(projectDir, 'gx.md'), '---\ngateless: true\ngates_at: frame, spec\n---\nbody');
    await expect(resolveRunInputs(projectDir, { framing: 'gx.md' })).rejects.toThrow(/a gateless run attends no gates/);
    // An explicit attend-NONE preset (rir afk → []) is the same posture, so it's compatible.
    writeFileSync(join(projectDir, 'r.md'), '---\nworkflow: rir\ngates_at: afk\n---\nbody');
    const ok = await resolveRunInputs(projectDir, { framing: 'r.md', gateless: true });
    expect.soft(ok.gatesAt).toEqual([]);
    expect.soft(ok.gateless).toBe(true);
  });

  test('interactive and the consultant toggle surface as frontmatter passthrough for the CLI', async ({ projectDir }) => {
    writeFileSync(join(projectDir, 'f.md'), '---\ninteractive: true\nconsultant: off\n---\nbody');
    const inputs = await resolveRunInputs(projectDir, { framing: 'f.md' });
    expect.soft(inputs.interactive).toBe(true);
    expect.soft(inputs.consultantToggle).toBe('off');
    // Absent with no frontmatter — the CLI falls back to its flags / defaults.
    writeFileSync(join(projectDir, 'plain.md'), 'body');
    const bare = await resolveRunInputs(projectDir, { framing: 'plain.md' });
    expect.soft(bare.interactive).toBeUndefined();
    expect.soft(bare.consultantToggle).toBeUndefined();
  });

  test('--retry-infra overrides frontmatter retry_infra (flag wins)', async ({ projectDir }) => {
    writeFileSync(join(projectDir, 'brief.md'), '---\nretry_infra: 2\n---\nbody');
    expect.soft((await resolveRunInputs(projectDir, { framing: 'brief.md' })).retryInfra).toBe(2);
    expect.soft((await resolveRunInputs(projectDir, { framing: 'brief.md', retryInfra: '5' })).retryInfra).toBe(5);
  });

  test('a missing spec file fails by name', async ({ projectDir }) => {
    await expect(resolveRunInputs(projectDir, { spec: 'docs/nope.md' })).rejects.toThrow(
      'spec file not found: docs/nope.md',
    );
  });

  test('a frontmatter error is prefixed with the framing file name', async ({ projectDir }) => {
    writeFileSync(join(projectDir, 'brief.md'), '---\nbad_key: x\n---\nbody');
    await expect(resolveRunInputs(projectDir, { framing: 'brief.md' })).rejects.toThrow(/^brief\.md: framing frontmatter/);
  });

  test('bare entry opens the editor on the draft and uses what the human saved', async ({ projectDir }) => {
    // The editor is the boundary; `true` exits 0 leaving the pre-seeded draft.
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'true');
    mkdirSync(join(projectDir, '.duet'), { recursive: true });
    writeFileSync(join(projectDir, DEFAULT_FRAMING_FILE), '# Problem\nwritten by hand');

    const inputs = await resolveRunInputs(projectDir, {});
    expect.soft(inputs.framing).toBe('# Problem\nwritten by hand');
    expect.soft(inputs.framingFile).toBe(DEFAULT_FRAMING_FILE);
  });

  test('bare entry refuses to start from an untouched template', async ({ projectDir }) => {
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'true');
    // No pre-seeded draft: editFramingForRun seeds the template, `true` leaves it.
    await expect(resolveRunInputs(projectDir, {})).rejects.toThrow(/still the untouched template/);
  });

  test('bare entry refuses an emptied draft', async ({ projectDir }) => {
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'true');
    mkdirSync(join(projectDir, '.duet'), { recursive: true });
    writeFileSync(join(projectDir, DEFAULT_FRAMING_FILE), '  \n');
    await expect(resolveRunInputs(projectDir, {})).rejects.toThrow(/is empty/);
  });

  test('a failing editor aborts with the draft preserved', async ({ projectDir }) => {
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'false'); // exits 1
    await expect(resolveRunInputs(projectDir, {})).rejects.toThrow(/editor exited with an error/);
  });
});
