import { z } from 'zod';
import type { GatePhase } from './run-state.ts';

/**
 * The framing file's optional YAML-style frontmatter — the machine/prose
 * boundary inside the one file the human writes per run.
 *
 * The rule for what earns a key here (settled 2026-06-12, see
 * docs/automation-design.md §"Gate pre-authorization"): a key belongs in
 * frontmatter only when its practical expression is a FIXED VALUE and a
 * DETERMINISTIC CONSUMER (the harness) acts on it without judgment. If the
 * value is natural language with riders, or the consumer is the orchestrator
 * applying judgment, it stays in the prose body. Spec/plan locations,
 * verification posture, skills, planning style: prose, always — the planlab
 * run is the evidence (the framing's literal spec dir was wrong relative to
 * the worktree root and judgment resolved it).
 *
 * Current keys: `gates_at`, `spec`. Pre-approved for later: `budget_usd`,
 * if open-questions Q19 resolves in favor of a run-level budget model.
 *
 * Frontmatter is parsed by the CLI at `duet new` and STRIPPED before the
 * framing body is embedded in the orchestrator's prompt — the orchestrator
 * sees only the rendered posture instructions, never the raw config, so
 * there is exactly one source of truth in its context.
 */

export const GATE_PHASES = ['frame', 'spec', 'plan', 'impl', 'docs', 'pr'] as const;

/** Named presets — pure aliases for gate lists, never a separate vocabulary. */
const GATES_AT_PRESETS: Record<string, GatePhase[]> = {
  overnight: ['frame', 'spec'],
};

export interface FramingFrontmatter {
  gatesAt?: GatePhase[];
  spec?: string;
}

const frontmatterSchema = z.object({
  gates_at: z.string().optional(),
  spec: z.string().optional(),
});

/**
 * Parse a `--gates-at` value: a preset name or a comma/space-separated list
 * of gate-bearing phase names. `pr` is force-appended — the Open-PR gate is
 * never pre-authorizable. Throws with the full vocabulary on bad input.
 */
export function parseGatesAt(value: string): GatePhase[] {
  const preset = GATES_AT_PRESETS[value.trim()];
  const names = preset ?? value.split(/[,\s]+/).filter(Boolean);
  const gates: GatePhase[] = [];
  for (const name of names) {
    if (!(GATE_PHASES as readonly string[]).includes(name)) {
      throw new Error(
        `gates_at: "${name}" is not a gate-bearing phase — use a list from {${GATE_PHASES.join(', ')}} or the preset "overnight" (= frame,spec). The open phase has no gate; pr is always attended.`,
      );
    }
    if (!gates.includes(name as GatePhase)) gates.push(name as GatePhase);
  }
  if (gates.length === 0) {
    throw new Error(`gates_at is empty — list the phases whose gates you will attend (from {${GATE_PHASES.join(', ')}}), or omit it to attend every gate.`);
  }
  if (!gates.includes('pr')) gates.push('pr');
  return gates;
}

/**
 * Split a framing file into its frontmatter (parsed, validated) and its
 * prose body (what the orchestrator gets). Files without a leading `---`
 * block pass through untouched. Unknown keys and bad values fail loudly —
 * a config typo that silently became prose would change run behavior.
 */
export function parseFramingFile(content: string): { meta: FramingFrontmatter; body: string } {
  if (!content.startsWith('---\n')) return { meta: {}, body: content };
  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error('framing frontmatter opened with "---" but never closed — add the closing "---" line or remove the block');
  }
  const block = content.slice(4, end);
  const body = content.slice(content.indexOf('\n', end + 1) + 1).replace(/^\n/, '');

  const raw: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      throw new Error(`framing frontmatter line "${trimmed}" is not "key: value" — only key/value pairs and # comments are allowed in the block`);
    }
    const key = trimmed.slice(0, colon).trim();
    raw[key] = trimmed.slice(colon + 1).trim();
  }

  const parsed = frontmatterSchema.strict().safeParse(raw);
  if (!parsed.success) {
    const unknown = Object.keys(raw).filter((k) => !(k in frontmatterSchema.shape));
    throw new Error(
      unknown.length > 0
        ? `framing frontmatter has unknown key(s): ${unknown.join(', ')} — valid keys are gates_at and spec. Everything the orchestrator should weigh with judgment belongs in the prose body, not here.`
        : `framing frontmatter is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const meta: FramingFrontmatter = {};
  if (parsed.data.gates_at) meta.gatesAt = parseGatesAt(parsed.data.gates_at);
  if (parsed.data.spec) meta.spec = parsed.data.spec;
  return { meta, body };
}
