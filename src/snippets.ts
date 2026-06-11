import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

/**
 * Duet's snippet library — `snippets.toml` at the repo root, seeded from the
 * user's tabtype config plus the documented `ceo-summary` (Q12). The
 * orchestrator reads it via `list_snippets`; approved `propose_snippet_edit`
 * diffs apply here, and porting back to tabtype stays a manual human step.
 */

export interface Snippet {
  key: string;
  expand: string;
}

const SNIPPETS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'snippets.toml');

let cache: Snippet[] | undefined;

export function loadSnippets(): Snippet[] {
  if (!cache) {
    const parsed = parse(readFileSync(SNIPPETS_PATH, 'utf8')) as unknown as { snippets: Snippet[] };
    cache = parsed.snippets;
  }
  return cache;
}

export function getSnippet(key: string): Snippet | undefined {
  return loadSnippets().find((s) => s.key === key);
}

/** Render the library for the orchestrator: keys + bodies, XML-tagged per the prompting conventions. */
export function renderSnippetLibrary(keys?: string[]): string {
  const snippets = loadSnippets().filter((s) => !keys || keys.includes(s.key));
  return [
    '<snippet_library>',
    ...snippets.map((s) => `<snippet key="${s.key}">\n${s.expand}\n</snippet>`),
    '</snippet_library>',
  ].join('\n');
}
