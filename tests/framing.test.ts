import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test as plain, vi } from 'vitest';
import { DEFAULT_FRAMING_FILE, composeInEditor, parseFramingFile, parseGatesAt, resolveRunInputs } from '../src/framing.ts';
import { test } from './helpers/fixtures.ts';

describe('parseGatesAt', () => {
  plain.for([
    { input: 'frame,spec', expected: ['frame', 'spec', 'pr'] },
    { input: 'frame spec  plan', expected: ['frame', 'spec', 'plan', 'pr'] },
    { input: 'overnight', expected: ['frame', 'spec', 'pr'] },
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
