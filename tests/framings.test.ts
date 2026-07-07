import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect } from 'vitest';
import { test } from './helpers/fixtures.ts';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import { createRun, loadRunState, runDirOf } from '../src/run/store.ts';
import {
  buildFramingsModel,
  framingTitle,
  matchesRepo,
  readArchivedFraming,
  renderFramingsList,
  shortenHome,
} from '../src/surfaces/framings.ts';
import { localStamp } from '../src/view/timefmt.ts';

/**
 * The framings gatherer: the repo-identity stamp createRun records, and the
 * `duet framings` surface that browses the corpus archive merged with the
 * local runs. Filesystem and git run real, in tmpdirs (testing strategy);
 * the corpus config is injected via the surface's `configPath` parameter —
 * the same seam the account default flows through.
 */

const extraDirs: string[] = [];

/** A throwaway dir beyond the fixture's projectDir, cleaned after each test. */
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'duet-framings-'));
  extraDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (extraDirs.length > 0) rmSync(extraDirs.pop()!, { recursive: true, force: true });
});

async function initGitRepo(dir: string, opts: { remote?: string; commit?: boolean } = {}): Promise<void> {
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  if (opts.remote) await execa('git', ['remote', 'add', 'origin', opts.remote], { cwd: dir });
  if (opts.commit) {
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  }
}

/** Write a config.toml with a [corpus] dir key and return its path. */
function corpusConfig(corpusDir: string): string {
  const dir = tmpDir();
  const path = join(dir, 'config.toml');
  writeFileSync(path, `[corpus]\ndir = "${corpusDir}"\n`);
  return path;
}

describe('the repo-identity stamp (createRun)', () => {
  test('a run created in a git repo carries root + remote; the stamp round-trips through state.json', async () => {
    const repo = tmpDir();
    await initGitRepo(repo, { remote: 'https://example.com/proj.git' });
    const created = createRun({ cwd: repo, bindings: defaultBindingsFor('full'), framing: 'f' });

    expect.soft(created.repo).toEqual({ root: realpathSync(repo), remote: 'https://example.com/proj.git' });
    expect.soft(loadRunState(repo, created.runId).repo).toEqual(created.repo);
  });

  test('a repo with no origin remote stamps root alone (remote absent, not empty)', async () => {
    const repo = tmpDir();
    await initGitRepo(repo);
    const created = createRun({ cwd: repo, bindings: defaultBindingsFor('full'), framing: 'f' });

    expect(created.repo).toEqual({ root: realpathSync(repo) });
  });

  test('a git-less dir leaves the stamp absent and creation still succeeds', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: 'f' });

    expect.soft(created.repo).toBeUndefined();
    expect.soft('repo' in loadRunState(projectDir, created.runId)).toBe(false);
  });

  test('a run created in a linked worktree stamps the MAIN checkout as its root', async () => {
    const container = tmpDir();
    const main = join(container, 'main');
    mkdirSync(main);
    await initGitRepo(main, { commit: true });
    await execa('git', ['worktree', 'add', join(container, 'wt')], { cwd: main });

    const created = createRun({ cwd: join(container, 'wt'), bindings: defaultBindingsFor('full'), framing: 'f' });

    expect(created.repo?.root).toBe(realpathSync(main));
  });
});

describe('matchesRepo — the scope rule', () => {
  const identity = { root: '/repos/proj', remote: 'https://example.com/proj.git' };

  test('a stamped record matches on the same root', () => {
    expect(matchesRepo({ cwd: '/dead/wt', repo: { root: '/repos/proj' } }, { cwd: '/repos/other-wt', identity })).toBe(true);
  });

  test('a stamped record matches on the same remote when roots differ (two clones)', () => {
    expect(
      matchesRepo(
        { cwd: '/dead/wt', repo: { root: '/elsewhere/proj', remote: 'https://example.com/proj.git' } },
        { cwd: '/repos/proj', identity },
      ),
    ).toBe(true);
  });

  test('an unstamped record falls back to cwd equality', () => {
    expect.soft(matchesRepo({ cwd: '/repos/proj' }, { cwd: '/repos/proj', identity })).toBe(true);
    expect.soft(matchesRepo({ cwd: '/dead/wt' }, { cwd: '/repos/proj', identity })).toBe(false);
  });

  test('a stamped record from a foreign repo does not match', () => {
    expect(
      matchesRepo(
        { cwd: '/dead/wt', repo: { root: '/elsewhere/other', remote: 'https://example.com/other.git' } },
        { cwd: '/repos/proj', identity },
      ),
    ).toBe(false);
  });

  test('with no derivable self identity, cwd equality is the only match (git-less current dir)', () => {
    expect.soft(matchesRepo({ cwd: '/proj', repo: { root: '/proj' } }, { cwd: '/proj' })).toBe(true);
    expect.soft(matchesRepo({ cwd: '/dead/wt', repo: { root: '/proj' } }, { cwd: '/proj' })).toBe(false);
  });
});

describe('framingTitle — heading first, first non-empty line as fallback, real frontmatter parse', () => {
  test('the first markdown heading of the body wins, even after prose', () => {
    expect(framingTitle('some context line\nmore prose\n\n## Fix the flaky retry\nbody')).toBe('Fix the flaky retry');
  });

  test('frontmatter is parsed off with the real parser — its keys never become the title', () => {
    expect(framingTitle('---\nworkflow: full\n---\n\n# The real title\nprose')).toBe('The real title');
  });

  test('with no heading, the first non-empty body line is the title', () => {
    expect(framingTitle('---\nworkflow: short\n---\n\nfix the login timeout seen in prod\nmore')).toBe(
      'fix the login timeout seen in prod',
    );
  });

  test('a framing whose frontmatter no longer parses degrades to scanning the raw content', () => {
    expect(framingTitle('---\nbogus_key: x\n---\n\n# Still found\n')).toBe('Still found');
  });

  test('an empty framing yields no title', () => {
    expect(framingTitle('\n\n')).toBeUndefined();
  });
});

describe('buildFramingsModel — merge, dedup, scope', () => {
  test('corpus and local records merge, deduped by runId with the corpus copy winning', ({ projectDir }) => {
    const corpusRoot = tmpDir();
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: '# Mirrored\nbody', corpusRoot });

    const model = buildFramingsModel(projectDir, { configPath: corpusConfig(corpusRoot) });

    const mine = model.records.filter((r) => r.runId === created.runId);
    expect.soft(mine).toHaveLength(1);
    expect.soft(mine[0]!.source).toBe('corpus');
    expect.soft(mine[0]!.runDir).toBe(join(corpusRoot, created.runId));
    expect.soft(mine[0]!.title).toBe('Mirrored');
  });

  test('default scope keeps this repo; a foreign record needs --all', ({ projectDir }) => {
    const corpusRoot = tmpDir();
    const configPath = corpusConfig(corpusRoot);
    const mine = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: 'mine', corpusRoot });
    const elsewhere = tmpDir();
    const foreign = createRun({ cwd: elsewhere, bindings: defaultBindingsFor('short'), workflow: 'short', framing: 'theirs', corpusRoot });

    const scoped = buildFramingsModel(projectDir, { configPath });
    expect.soft(scoped.scope).toBe('repo');
    expect.soft(scoped.records.map((r) => r.runId)).toContain(mine.runId);
    expect.soft(scoped.records.map((r) => r.runId)).not.toContain(foreign.runId);

    const all = buildFramingsModel(projectDir, { configPath, all: true });
    expect.soft(all.scope).toBe('all');
    expect.soft(all.records.map((r) => r.runId)).toEqual(expect.arrayContaining([mine.runId, foreign.runId]));
  });

  test('a stamped record from a deleted worktree still lists from the main checkout (the point of the stamp)', async () => {
    const corpusRoot = tmpDir();
    const container = tmpDir();
    const main = join(container, 'main');
    mkdirSync(main);
    await initGitRepo(main, { commit: true });
    await execa('git', ['worktree', 'add', join(container, 'wt')], { cwd: main });
    const created = createRun({ cwd: join(container, 'wt'), bindings: defaultBindingsFor('full'), framing: '# From the worktree', corpusRoot });
    rmSync(join(container, 'wt'), { recursive: true, force: true }); // the worktree cwd is now a dead path

    const model = buildFramingsModel(main, { configPath: corpusConfig(corpusRoot) });

    const record = model.records.find((r) => r.runId === created.runId);
    expect.soft(record?.source).toBe('corpus');
    expect.soft(record?.title).toBe('From the worktree');
    expect.soft(record?.repo?.root).toBe(realpathSync(main));
  });

  test('two clones sharing an origin remote match even when their roots differ', async () => {
    const corpusRoot = tmpDir();
    const cloneA = tmpDir();
    const cloneB = tmpDir();
    await initGitRepo(cloneA, { remote: 'https://example.com/proj.git' });
    await initGitRepo(cloneB, { remote: 'https://example.com/proj.git' });
    const created = createRun({ cwd: cloneA, bindings: defaultBindingsFor('full'), framing: 'shared', corpusRoot });

    const model = buildFramingsModel(cloneB, { configPath: corpusConfig(corpusRoot) });

    expect(model.records.map((r) => r.runId)).toContain(created.runId);
  });

  test('an unconfigured corpus still lists local runs, with one note naming the [corpus] dir key', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: 'local only' });

    const model = buildFramingsModel(projectDir, { configPath: join(projectDir, 'no-config.toml') });

    expect.soft(model.corpusDir).toBeUndefined();
    expect.soft(model.note).toContain('[corpus] dir');
    const record = model.records.find((r) => r.runId === created.runId);
    expect.soft(record?.source).toBe('local');
  });

  test('a configured corpus dir that does not exist notes the silently-off mirror and lists local runs', ({ projectDir }) => {
    const missing = join(tmpDir(), 'never-created');
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: 'local only' });

    const model = buildFramingsModel(projectDir, { configPath: corpusConfig(missing) });

    expect.soft(model.note).toContain('does not exist');
    expect.soft(model.note).toContain('[corpus] dir');
    expect.soft(model.records.map((r) => r.runId)).toContain(created.runId);
  });

  test('a corpus record the codecs refuse is skipped with a count, never an abort', ({ projectDir }) => {
    const corpusRoot = tmpDir();
    const dead = join(corpusRoot, '20200101-0000-dead');
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, 'state.json'), JSON.stringify({ runId: '20200101-0000-dead', bindings: {}, workerSessions: {} }));
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: 'live', corpusRoot });

    const model = buildFramingsModel(projectDir, { configPath: corpusConfig(corpusRoot) });

    expect.soft(model.skipped).toBe(1);
    expect.soft(model.records.map((r) => r.runId)).toContain(created.runId);
  });

  test('--json shape: the model keeps raw UTC timestamps and verbatim paths (additive-only schema)', ({ projectDir }) => {
    const corpusRoot = tmpDir();
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('short'), workflow: 'short', framing: '# T', corpusRoot });

    const model = buildFramingsModel(projectDir, { configPath: corpusConfig(corpusRoot) });
    const record = model.records.find((r) => r.runId === created.runId)!;

    expect.soft(record.createdAt).toBe(created.createdAt); // raw UTC ISO, never localized
    expect.soft(record.createdAt.endsWith('Z')).toBe(true);
    expect.soft(record.workflow).toBe('short');
    expect.soft(record.cwd).toBe(projectDir); // verbatim — ~-shortening is view-time only
    expect.soft(record.runDir).toBe(join(corpusRoot, created.runId));
  });
});

describe('readArchivedFraming — duet framings show', () => {
  test('returns the archived framing.md verbatim (exact bytes, frontmatter included)', ({ projectDir }) => {
    const raw = '---\nworkflow: full\n---\n\n# Exact bytes\n\ntrailing spaces  \n';
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: 'body', framingRaw: raw });

    const result = readArchivedFraming(projectDir, created.runId, { configPath: join(projectDir, 'no-config.toml') });

    expect(result).toEqual({ content: raw });
  });

  test('the corpus copy wins over a diverged local file', ({ projectDir }) => {
    const corpusRoot = tmpDir();
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: 'the archived text', corpusRoot });
    writeFileSync(join(runDirOf(projectDir, created.runId), 'framing.md'), 'locally mutated');

    const result = readArchivedFraming(projectDir, created.runId, { configPath: corpusConfig(corpusRoot) });

    expect(result).toEqual({ content: 'the archived text' });
  });

  test('an unknown runId errors with a pointer to the listing', ({ projectDir }) => {
    const result = readArchivedFraming(projectDir, 'no-such-run', { configPath: join(projectDir, 'no-config.toml') });

    expect('error' in result && result.error).toContain('duet framings');
  });

  test('a run that archived no framing errors honestly instead of printing nothing', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') }); // spec-entry shape: no framing

    const result = readArchivedFraming(projectDir, created.runId, { configPath: join(projectDir, 'no-config.toml') });

    expect('error' in result && result.error).toContain('no framing.md');
  });
});

describe('rendering — view-time localization and ~-shortening only', () => {
  test('shortenHome maps the home prefix to ~ and leaves foreign paths alone', () => {
    expect.soft(shortenHome('/home/u', '/home/u')).toBe('~');
    expect.soft(shortenHome('/home/u/dev/proj', '/home/u')).toBe('~/dev/proj');
    expect.soft(shortenHome('/srv/data', '/home/u')).toBe('/srv/data');
    expect.soft(shortenHome('/home/ubuntu/x', '/home/u')).toBe('/home/ubuntu/x'); // prefix, not path-segment, collision
  });

  test('the text listing renders local time, the ~-shortened repo, workflow, and title', () => {
    const createdAt = '2026-07-06T12:00:00.000Z';
    const model = {
      scope: 'repo' as const,
      corpusDir: '/home/u/duet-corpus',
      skipped: 0,
      records: [
        {
          runId: '20260706-1200-abcd',
          createdAt,
          workflow: 'full',
          cwd: '/home/u/dev/proj-wt',
          repo: { root: '/home/u/dev/proj' },
          source: 'corpus' as const,
          runDir: '/home/u/duet-corpus/20260706-1200-abcd',
          title: 'Fix the flaky retry',
        },
      ],
    };

    const text = renderFramingsList(model, '/home/u');

    expect.soft(text).toContain('20260706-1200-abcd');
    expect.soft(text).toContain(localStamp(createdAt)); // local render; the model stays raw UTC
    expect.soft(text).toContain('full');
    expect.soft(text).toContain('~/dev/proj'); // the stamp's root, home-shortened
    expect.soft(text).toContain('Fix the flaky retry');
    expect.soft(text).toContain('duet framings show');
  });

  test('an empty scoped list still surfaces the corpus note', () => {
    const text = renderFramingsList({ scope: 'repo', skipped: 0, note: 'no corpus archive configured — set [corpus] dir', records: [] }, '/home/u');

    expect.soft(text).toContain('0 framing record(s)');
    expect.soft(text).toContain('[corpus] dir');
  });
});
