// Shared voice-log vocabulary. appendVoiceLog writes one stamped header line
// followed by an optional body and a blank separator; readers should parse that
// format once instead of each surface growing its own timestamp anchors.

export const VOICE_LOG_TIMESTAMP_PATTERN = String.raw`\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\]`;

export const STAMPED_HEADER_LINE = new RegExp(`^${VOICE_LOG_TIMESTAMP_PATTERN} (.*)$`);
export const PHASE_OPEN_LINE = new RegExp(`^${VOICE_LOG_TIMESTAMP_PATTERN} ◀ harness prompt \\(phase=(\\w+)\\)`);
export const PHASE_CLOSE_LINE = new RegExp(`^${VOICE_LOG_TIMESTAMP_PATTERN} advance_phase \\((\\w+)\\)`);
export const TURN_START_LINE = new RegExp(`^${VOICE_LOG_TIMESTAMP_PATTERN} ◀ prompt \\(tag=([^,)]+)`);
export const TURN_END_LINE = new RegExp(`^${VOICE_LOG_TIMESTAMP_PATTERN} (▶ response|◼ budget-control stop|✗ turn failed(?::\\s*(.*))?|⚠ .*aborted.*)`);
export const HEARTBEAT_LINE = new RegExp(`^${VOICE_LOG_TIMESTAMP_PATTERN} ⏳ .*?(\\d+)m elapsed`);

export const PHASE_OPEN_HEADER = /^◀ harness prompt \(phase=(\w+)\)$/;
export const PHASE_CLOSE_HEADER = /^advance_phase \((\w+)\)$/;
export const WORKER_PROMPT_HEADER = /^◀ prompt \(tag=([^,)]+)(?:, from orchestrator)?\)$/;
export const WORKER_RESPONSE_HEADER = /^▶ response \(session ([^)]+)\)(?: · context (\d+)%)?$/;
export const ASK_HUMAN_HEADER = /^ask_human queued$/;

export interface VoiceLogBlock {
  readonly stamp: string;
  readonly header: string;
  readonly body?: string;
}

export function parseVoiceLogBlocks(log: string): VoiceLogBlock[] {
  const blocks: VoiceLogBlock[] = [];
  let current: { stamp: string; header: string; bodyLines: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    const bodyLines = [...current.bodyLines];
    if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
    blocks.push({
      stamp: current.stamp,
      header: current.header,
      ...(current.bodyLines.length > 0 ? { body: bodyLines.join('\n') } : {}),
    });
  };

  const lines = log.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const header = STAMPED_HEADER_LINE.exec(line);
    if (header) {
      flush();
      current = { stamp: header[1]!, header: header[2]!, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  flush();
  return blocks;
}
