/**
 * Fixture builders for the interactive-claude transcript shape — the SINGLE
 * home for what a `~/.claude/projects/<slug>/<session>.jsonl` turn looks like.
 *
 * The shape here is hand-authored from what we already parse on the headless
 * path (the assistant `message.usage` blocks `claudeContextUsage` consumes —
 * src/providers/claude.ts:41) plus the Claude Code transcript conventions. The
 * exact event vocabulary (which record opens/closes a turn, the compact-boundary
 * record) is only confirmable against a real session (the plan's Slice 5), so a
 * real captured transcript becomes the fixture of record and any correction
 * lands HERE plus the matching predicate in src/providers/interactive-claude.ts.
 */

export interface TranscriptRecord {
  type: string;
  subtype?: string;
  sessionId?: string;
  /** Result-envelope-style window source, attached to a record when a fixture wants context populated. */
  modelUsage?: Record<string, { contextWindow?: number }>;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    stop_reason?: string | null;
    usage?: Record<string, number>;
  };
}

/** The per-turn correlation marker the injection appends to the prompt body (Slice 4 reuses this). */
export function turnMarker(nonce: string): string {
  return `[duet-turn:${nonce}]`;
}

/** Our injected user prompt, carrying the per-turn nonce the parser matches on. */
export function userTurn(prompt: string, nonce: string): TranscriptRecord {
  return { type: 'user', message: { role: 'user', content: `${prompt}\n\n${turnMarker(nonce)}` } };
}

/** A user message with no nonce — a decoy/other turn the parser must not pick. */
export function userMessage(content: string): TranscriptRecord {
  return { type: 'user', message: { role: 'user', content } };
}

/** The turn's final assistant message (`stop_reason: end_turn`) — the text the parser returns. */
export function assistantFinal(
  text: string,
  opts: { usage?: Record<string, number>; contextWindow?: number; model?: string } = {},
): TranscriptRecord {
  const model = opts.model ?? 'claude-opus-4-8';
  return {
    type: 'assistant',
    ...(opts.contextWindow ? { modelUsage: { [model]: { contextWindow: opts.contextWindow } } } : {}),
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
  };
}

/** One mid-turn tool step: an assistant `tool_use` (stop_reason: tool_use) then its tool_result. */
export function toolStep(toolName: string, resultText: string): TranscriptRecord[] {
  return [
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: toolName, input: {} }], stop_reason: 'tool_use' },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: resultText }] } },
  ];
}

/** The compact-boundary record a successful interactive `/compact` writes (exact shape: Slice 5). */
export function compactBoundary(): TranscriptRecord {
  return { type: 'system', subtype: 'compact_boundary' };
}

/** Serialize records into a session's JSONL, stamping each with the session id. */
export function session(id: string, ...records: Array<TranscriptRecord | TranscriptRecord[]>): string {
  return (
    records
      .flat()
      .map((r) => JSON.stringify({ ...r, sessionId: id }))
      .join('\n') + '\n'
  );
}
