import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { program } from '../src/cli.ts';

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

describe('the duet-concierge skill coheres with the CLI', () => {
  test('SKILL.md frontmatter is complete and pre-approves read verbs only', () => {
    const fm = frontmatterOf(skillMd);
    expect.soft(fm['name']).toBe('duet-concierge');
    expect.soft(fm['description']).toBeTruthy();

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
});
