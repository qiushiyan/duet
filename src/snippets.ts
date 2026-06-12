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

/**
 * Render the library for the orchestrator: keys + bodies, XML-tagged per the
 * prompting conventions. `sentTo` maps snippet key → roles already sent that
 * template this phase; those entries are annotated so the menu carries the
 * once-per-phase state at selection time.
 */
export function renderSnippetLibrary(sentTo?: Record<string, string[]>): string {
  return [
    '<snippet_library>',
    ...loadSnippets().map((s) => {
      const sent = sentTo?.[s.key];
      const attr = sent && sent.length > 0 ? ` already_sent_this_phase_to="${sent.join(', ')}"` : '';
      return `<snippet key="${s.key}"${attr}>\n${s.expand}\n</snippet>`;
    }),
    '</snippet_library>',
  ].join('\n');
}
