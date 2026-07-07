import type { CapturedToolEvent } from './host.ts';
import type { ProtocolTrace, TerminalEvent, WorkerPromptEvent } from './record.ts';
import type { ScriptedWorkerCall } from './scripted-worker.ts';

export interface ReplayDiffInput {
  readonly original: ProtocolTrace;
  readonly phase: string;
  readonly freshEvents: readonly CapturedToolEvent[];
  readonly scriptedCalls?: readonly ScriptedWorkerCall[];
}

export interface SendComparison {
  readonly index: number;
  readonly original?: SendShape;
  readonly fresh?: SendShape;
  readonly structural?: string;
  readonly adaptation?: BodyDrift;
  readonly compactCascade?: boolean;
  readonly unanchored?: true;
}

export interface SendShape {
  readonly duties: readonly string[];
  readonly tag: string;
  readonly body: string;
  readonly compact: boolean;
  readonly ordinalsByDuty: Readonly<Record<string, number>>;
}

export interface BodyDrift {
  readonly originalBody: string;
  readonly freshBody: string;
}

export interface TerminalComparison {
  readonly original?: { verb: 'advance_phase' | 'ask_human'; body: string };
  readonly fresh?: { verb: 'advance_phase' | 'ask_human'; body: string };
  readonly structural?: string;
}

export interface ReplayDiff {
  readonly sends: readonly SendComparison[];
  readonly terminal: TerminalComparison;
  readonly firstStructuralDivergence?: string;
  readonly unanchoredFromIndex?: number;
}

export function diffReplay(input: ReplayDiffInput): ReplayDiff {
  const originalSends = originalSendShapes(input.original, input.phase);
  const freshSends = freshSendShapes(input.freshEvents);
  const exhausted = new Set((input.scriptedCalls ?? []).filter((call) => call.exhausted).map((call) => `${call.voice}:${call.ordinal}`));

  const sends: SendComparison[] = [];
  let firstStructuralDivergence: string | undefined;
  let unanchoredFromIndex: number | undefined;
  const max = Math.max(originalSends.length, freshSends.length);
  for (let index = 0; index < max; index += 1) {
    const original = originalSends[index];
    const fresh = freshSends[index];
    const unanchored = unanchoredFromIndex !== undefined && index > unanchoredFromIndex;
    let structural: string | undefined;
    let adaptation: BodyDrift | undefined;
    if (!unanchored) {
      if (fresh && exhaustedForSend(fresh, exhausted)) structural = 'scripted worker exhausted for this send_prompt';
      else if (!original || !fresh) structural = original ? 'fresh trace is missing this send_prompt' : 'fresh trace has an extra send_prompt';
      else if (original.tag !== fresh.tag) structural = `snippet tag changed from ${original.tag} to ${fresh.tag}`;
      else if (!sameSet(original.duties, fresh.duties)) structural = `fan-out membership changed from ${original.duties.join(',')} to ${fresh.duties.join(',')}`;
      else if (!sameOrdinals(original, fresh)) structural = 'per-duty ordinal changed for this send_prompt';
      else if (original.body !== fresh.body) adaptation = { originalBody: original.body, freshBody: fresh.body };
    }
    if (structural && firstStructuralDivergence === undefined) {
      firstStructuralDivergence = `send_prompt[${index}]: ${structural}`;
      unanchoredFromIndex = index;
    }
    sends.push({
      index,
      ...(original ? { original } : {}),
      ...(fresh ? { fresh } : {}),
      ...(structural ? { structural } : {}),
      ...(adaptation ? { adaptation } : {}),
      ...(original?.compact || fresh?.compact ? { compactCascade: true } : {}),
      ...(unanchored ? { unanchored: true } : {}),
    });
  }

  const terminal = terminalComparison(input.original, input.phase, input.freshEvents);
  if (terminal.structural && firstStructuralDivergence === undefined) firstStructuralDivergence = `terminal: ${terminal.structural}`;
  return {
    sends,
    terminal,
    ...(firstStructuralDivergence ? { firstStructuralDivergence } : {}),
    ...(unanchoredFromIndex !== undefined ? { unanchoredFromIndex } : {}),
  };
}

function originalSendShapes(trace: ProtocolTrace, phase: string): SendShape[] {
  const prompts = trace.events.filter((event): event is WorkerPromptEvent => event.kind === 'worker_prompt' && event.phase === phase);
  const emitted = new Set<number>();
  const sends: SendShape[] = [];
  for (const prompt of prompts) {
    if (emitted.has(prompt.order)) continue;
    if (prompt.fanoutId) {
      const group = prompts.filter((candidate) => candidate.fanoutId === prompt.fanoutId).sort((a, b) => a.order - b.order);
      for (const member of group) emitted.add(member.order);
      sends.push({
        duties: group.map((member) => member.voice),
        tag: prompt.tag,
        body: prompt.body,
        compact: isCompactBody(prompt.body),
        ordinalsByDuty: Object.fromEntries(group.map((member) => [member.voice, member.ordinal])),
      });
      continue;
    }
    emitted.add(prompt.order);
    sends.push({
      duties: [prompt.voice],
      tag: prompt.tag,
      body: prompt.body,
      compact: isCompactBody(prompt.body),
      ordinalsByDuty: { [prompt.voice]: prompt.ordinal },
    });
  }
  return sends;
}

function freshSendShapes(events: readonly CapturedToolEvent[]): SendShape[] {
  const ordinals = new Map<string, number>();
  return events
    .filter((event): event is Extract<CapturedToolEvent, { kind: 'send_prompt' }> => event.kind === 'send_prompt')
    .map((event) => {
      const ordinalsByDuty: Record<string, number> = {};
      for (const duty of event.duty) {
        const ordinal = (ordinals.get(duty) ?? 0) + 1;
        ordinals.set(duty, ordinal);
        ordinalsByDuty[duty] = ordinal;
      }
      return { duties: event.duty, tag: event.tag, body: event.body, compact: isCompactBody(event.body), ordinalsByDuty };
    });
}

function terminalComparison(original: ProtocolTrace, phase: string, freshEvents: readonly CapturedToolEvent[]): TerminalComparison {
  const originalTerminal = original.events.find((event): event is TerminalEvent => event.kind === 'terminal' && event.phase === phase);
  const freshTerminal = freshEvents.find((event): event is Extract<CapturedToolEvent, { kind: 'terminal' }> => event.kind === 'terminal');
  const originalShape = originalTerminal ? { verb: originalTerminal.verb, body: originalTerminal.body } : undefined;
  const freshShape = freshTerminal ? { verb: freshTerminal.verb, body: freshTerminal.body } : undefined;
  if (!originalShape || !freshShape) {
    return {
      ...(originalShape ? { original: originalShape } : {}),
      ...(freshShape ? { fresh: freshShape } : {}),
      structural: originalShape ? 'fresh trace has no terminal call' : 'original trace has no terminal call',
    };
  }
  if (originalShape.verb !== freshShape.verb) return { original: originalShape, fresh: freshShape, structural: `terminal verb changed from ${originalShape.verb} to ${freshShape.verb}` };
  if (originalShape.body !== freshShape.body) return { original: originalShape, fresh: freshShape, structural: 'terminal decision payload changed' };
  return { original: originalShape, fresh: freshShape };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
}

function sameOrdinals(a: SendShape, b: SendShape): boolean {
  return a.duties.every((duty) => a.ordinalsByDuty[duty] === b.ordinalsByDuty[duty]);
}

function exhaustedForSend(send: SendShape, exhausted: ReadonlySet<string>): boolean {
  return send.duties.some((duty) => exhausted.has(`${duty}:${send.ordinalsByDuty[duty]}`));
}

export function isCompactBody(body: string): boolean {
  return body.trimStart().startsWith('/compact');
}
