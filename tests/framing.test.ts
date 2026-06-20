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
  resolveHumanText,
  resolveRunInputs,
  resolveTemplateSeed,
} from '../src/framing.ts';
import { test } from './helpers/fixtures.ts';

describe('parseGatesAt', () => {
  plain.for([
    { input: 'frame,spec', expected: ['frame', 'spec', 'pr'] },
    { input: 'frame spec  plan', expected: ['frame', 'spec', 'plan', 'pr'] },
    { input: 'overnight', expected: ['frame', 'spec', 'pr'] },
    { input: 'skip-plan', expected: ['frame', 'spec', 'impl', 'docs', 'pr'] },
    { input: 'pr', expected: ['pr'] },
    { input: 'frame,frame,spec', expected: ['frame', 'spec', 'pr'] },
  ])('"$input" → $expected (pr always attended)', ({ input, expected }) => {
    expect(parseGatesAt(input)).toEqual(expected);
  });

  plain('an unknown phase fails with the full vocabulary', () => {
    expect(() => parseGatesAt('frame,ship')).toThrow(/"ship" is not a gate-bearing phase.*frame, spec, plan, impl, docs, pr/);
  });

  plain('an empty list fails with how to fix it', () => {
    expect(() => parseGatesAt('  ,  ')).toThrow(/gates_at is empty/);
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
    expect(meta).toEqual({ gatesAt: ['frame', 'spec', 'pr'], spec: 'docs/spec.md' });
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
    expect(meta.gatesAt).toEqual(['frame', 'pr']);
    expect(body).toBe('');
  });

  plain('a non key:value line in the block is rejected', () => {
    expect(() => parseFramingFile('---\njust some words\n---\nbody')).toThrow(/is not "key: value"/);
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
    expect.soft(fromFrontmatter.gatesAt).toEqual(['frame', 'spec', 'pr']);

    const flagWins = await resolveRunInputs(projectDir, { framing: 'brief.md', gatesAt: 'impl', spec: 'docs/draft.md' });
    expect.soft(flagWins.gatesAt).toEqual(['impl', 'pr']);
    expect.soft(flagWins.specPath).toBe('docs/draft.md');
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
