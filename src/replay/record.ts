import {
  ASK_HUMAN_HEADER,
  HUMAN_STEER_CARRIED_HEADER,
  HUMAN_STEER_DELIVERED_HEADER,
  PHASE_CLOSE_HEADER,
  PHASE_OPEN_HEADER,
  WORKER_ABORTED_HEADER,
  WORKER_BUDGET_HEADER,
  WORKER_FAILED_HEADER,
  WORKER_PROMPT_HEADER,
  WORKER_RESPONSE_HEADER,
  parseVoiceLogBlocks,
} from '../run/voice-log.ts';

export type ProtocolEventKind =
  | 'phase_brief'
  | 'worker_prompt'
  | 'worker_response'
  | 'worker_terminal'
  | 'terminal'
  | 'steer';

export type TerminalVerb = 'advance_phase' | 'ask_human';
export type WorkerTerminalStatus = 'ok' | 'budget' | 'failed' | 'aborted';
export type SteerDelivery = 'carried' | 'live';

export interface ProtocolEventBase {
  readonly kind: ProtocolEventKind;
  readonly at: string;
  readonly atMs: number;
  readonly order: number;
  readonly phase?: string;
}

export interface PhaseBriefEvent extends ProtocolEventBase {
  readonly kind: 'phase_brief';
  readonly phase: string;
  readonly body: string;
}

export interface WorkerPromptEvent extends ProtocolEventBase {
  readonly kind: 'worker_prompt';
  readonly voice: string;
  readonly ordinal: number;
  readonly tag: string;
  readonly body: string;
  readonly fanoutId?: string;
}

export interface WorkerResponseEvent extends ProtocolEventBase {
  readonly kind: 'worker_response';
  readonly voice: string;
  readonly ordinal: number;
  readonly sessionId: string;
  readonly body: string;
  readonly contextPercent?: number;
}

export interface WorkerTerminalEvent extends ProtocolEventBase {
  readonly kind: 'worker_terminal';
  readonly voice: string;
  readonly ordinal: number;
  readonly status: Exclude<WorkerTerminalStatus, 'ok'>;
  readonly body: string;
}

export interface TerminalEvent extends ProtocolEventBase {
  readonly kind: 'terminal';
  readonly verb: TerminalVerb;
  readonly body: string;
}

export interface SteerEvent extends ProtocolEventBase {
  readonly kind: 'steer';
  readonly delivery: SteerDelivery;
  readonly stagedAt: string;
  readonly body: string;
}

export type ProtocolEvent =
  | PhaseBriefEvent
  | WorkerPromptEvent
  | WorkerResponseEvent
  | WorkerTerminalEvent
  | TerminalEvent
  | SteerEvent;

export interface WorkerTurnTrace {
  readonly voice: string;
  readonly ordinal: number;
  readonly prompt?: WorkerPromptEvent;
  readonly terminal?: WorkerResponseEvent | WorkerTerminalEvent;
}

export interface FanoutTrace {
  readonly id: string;
  readonly promptEventOrders: readonly number[];
  readonly voices: readonly string[];
  readonly tag: string;
  readonly body: string;
}

export interface ProtocolTrace {
  readonly events: readonly ProtocolEvent[];
  readonly workerTurns: readonly WorkerTurnTrace[];
  readonly fanouts: readonly FanoutTrace[];
  readonly notes: readonly string[];
}

export interface ProtocolTraceInput {
  readonly orchestratorLog?: string;
  readonly workerLogs: readonly { voice: string; log?: string }[];
}

type DraftMeta = {
  readonly order: number;
  readonly sourceIndex: number;
  readonly phase?: string;
  readonly fanoutId?: string;
};

type DraftEvent =
  | (Omit<PhaseBriefEvent, 'order'> & DraftMeta)
  | (Omit<WorkerPromptEvent, 'order' | 'phase' | 'fanoutId'> & DraftMeta)
  | (Omit<WorkerResponseEvent, 'order' | 'phase'> & DraftMeta)
  | (Omit<WorkerTerminalEvent, 'order' | 'phase'> & DraftMeta)
  | (Omit<TerminalEvent, 'order' | 'phase'> & DraftMeta)
  | (Omit<SteerEvent, 'order' | 'phase'> & DraftMeta);

interface PendingPrompt {
  readonly event: WorkerPromptEvent;
}

export function parseProtocolTrace(input: ProtocolTraceInput): ProtocolTrace {
  const notes: string[] = [];
  const drafts: DraftEvent[] = [];
  let sourceIndex = 0;

  if (input.orchestratorLog === undefined) {
    notes.push('missing orchestrator.log');
  } else {
    for (const block of parseVoiceLogBlocks(input.orchestratorLog)) {
      const atMs = Date.parse(block.stamp);
      if (Number.isNaN(atMs)) {
        notes.push(`ignored orchestrator block with invalid timestamp ${block.stamp}`);
        continue;
      }
      const phaseOpen = PHASE_OPEN_HEADER.exec(block.header);
      if (phaseOpen) {
        drafts.push({
          kind: 'phase_brief',
          at: block.stamp,
          atMs,
          order: -1,
          sourceIndex: sourceIndex++,
          phase: phaseOpen[1]!,
          body: block.body ?? '',
        });
        continue;
      }
      const phaseClose = PHASE_CLOSE_HEADER.exec(block.header);
      if (phaseClose) {
        drafts.push({
          kind: 'terminal',
          at: block.stamp,
          atMs,
          order: -1,
          sourceIndex: sourceIndex++,
          phase: phaseClose[1]!,
          verb: 'advance_phase',
          body: block.body ?? '',
        });
        continue;
      }
      if (ASK_HUMAN_HEADER.test(block.header)) {
        drafts.push({
          kind: 'terminal',
          at: block.stamp,
          atMs,
          order: -1,
          sourceIndex: sourceIndex++,
          verb: 'ask_human',
          body: block.body ?? '',
        });
        continue;
      }
      const carried = HUMAN_STEER_CARRIED_HEADER.exec(block.header);
      const delivered = HUMAN_STEER_DELIVERED_HEADER.exec(block.header);
      if (carried || delivered) {
        drafts.push({
          kind: 'steer',
          at: block.stamp,
          atMs,
          order: -1,
          sourceIndex: sourceIndex++,
          delivery: carried ? 'carried' : 'live',
          stagedAt: (carried ?? delivered)![1]!,
          body: block.body ?? '',
        });
      }
    }
  }

  for (const { voice, log } of input.workerLogs) {
    if (log === undefined) {
      notes.push(`missing ${voice}.log`);
      continue;
    }
    let ordinal = 0;
    for (const block of parseVoiceLogBlocks(log)) {
      const atMs = Date.parse(block.stamp);
      if (Number.isNaN(atMs)) {
        notes.push(`ignored ${voice} block with invalid timestamp ${block.stamp}`);
        continue;
      }
      const prompt = WORKER_PROMPT_HEADER.exec(block.header);
      if (prompt) {
        ordinal += 1;
        drafts.push({
          kind: 'worker_prompt',
          at: block.stamp,
          atMs,
          order: -1,
          sourceIndex: sourceIndex++,
          voice,
          ordinal,
          tag: prompt[1]!,
          body: block.body ?? '',
        });
        continue;
      }
      const response = WORKER_RESPONSE_HEADER.exec(block.header);
      if (response) {
        drafts.push({
          kind: 'worker_response',
          at: block.stamp,
          atMs,
          order: -1,
          sourceIndex: sourceIndex++,
          voice,
          ordinal,
          sessionId: response[1]!,
          body: block.body ?? '',
          ...(response[2] ? { contextPercent: Number(response[2]) } : {}),
        });
        continue;
      }
      const budget = WORKER_BUDGET_HEADER.exec(block.header);
      const failed = WORKER_FAILED_HEADER.exec(block.header);
      const aborted = WORKER_ABORTED_HEADER.exec(block.header);
      if (budget || failed || aborted) {
        drafts.push({
          kind: 'worker_terminal',
          at: block.stamp,
          atMs,
          order: -1,
          sourceIndex: sourceIndex++,
          voice,
          ordinal,
          status: budget ? 'budget' : failed ? 'failed' : 'aborted',
          body: block.body ?? budget?.[1] ?? failed?.[1] ?? aborted?.[1] ?? '',
        });
      }
    }
  }

  const ordered = drafts
    .sort((a, b) => a.atMs - b.atMs || a.sourceIndex - b.sourceIndex)
    .map((event, order) => ({ ...event, order }));
  const phased = assignPhases(ordered);
  const withFanouts = assignFanouts(phased);

  return {
    events: withFanouts,
    workerTurns: pairWorkerTurns(withFanouts, notes),
    fanouts: buildFanouts(withFanouts),
    notes,
  };
}

function assignPhases(events: readonly DraftEvent[]): ProtocolEvent[] {
  let currentPhase: string | undefined;
  return events.map((event) => {
    if (event.kind === 'phase_brief') {
      currentPhase = event.phase;
      return event as ProtocolEvent;
    }
    const phase = event.phase ?? currentPhase;
    const phased = phase ? { ...event, phase } : event;
    if (event.kind === 'terminal' && event.verb === 'advance_phase') currentPhase = undefined;
    return phased as ProtocolEvent;
  });
}

function assignFanouts(events: readonly ProtocolEvent[]): ProtocolEvent[] {
  const promptGroups = new Map<string, WorkerPromptEvent[]>();
  for (const event of events) {
    if (event.kind !== 'worker_prompt') continue;
    const key = `${event.at}\0${event.tag}\0${event.body}`;
    const group = promptGroups.get(key) ?? [];
    group.push(event);
    promptGroups.set(key, group);
  }
  const fanoutByOrder = new Map<number, string>();
  let fanoutOrdinal = 0;
  for (const group of promptGroups.values()) {
    if (group.length < 2) continue;
    fanoutOrdinal += 1;
    const id = `fanout-${fanoutOrdinal}`;
    for (const event of group) fanoutByOrder.set(event.order, id);
  }
  return events.map((event) => {
    if (event.kind !== 'worker_prompt') return event;
    const fanoutId = fanoutByOrder.get(event.order);
    return fanoutId ? { ...event, fanoutId } : event;
  });
}

function buildFanouts(events: readonly ProtocolEvent[]): FanoutTrace[] {
  const groups = new Map<string, WorkerPromptEvent[]>();
  for (const event of events) {
    if (event.kind !== 'worker_prompt' || !event.fanoutId) continue;
    const group = groups.get(event.fanoutId) ?? [];
    group.push(event);
    groups.set(event.fanoutId, group);
  }
  return [...groups.entries()].map(([id, prompts]) => ({
    id,
    promptEventOrders: prompts.map((p) => p.order),
    voices: prompts.map((p) => p.voice),
    tag: prompts[0]?.tag ?? '',
    body: prompts[0]?.body ?? '',
  }));
}

function pairWorkerTurns(events: readonly ProtocolEvent[], notes: string[]): WorkerTurnTrace[] {
  const pending = new Map<string, PendingPrompt>();
  const turns: WorkerTurnTrace[] = [];
  for (const event of events) {
    if (event.kind === 'worker_prompt') {
      pending.set(`${event.voice}:${event.ordinal}`, { event });
      continue;
    }
    if (event.kind !== 'worker_response' && event.kind !== 'worker_terminal') continue;
    const key = `${event.voice}:${event.ordinal}`;
    const prompt = pending.get(key)?.event;
    if (!prompt) {
      notes.push(`${event.voice} ordinal ${event.ordinal} has a terminal without a prompt`);
      turns.push({ voice: event.voice, ordinal: event.ordinal, terminal: event });
      continue;
    }
    turns.push({ voice: event.voice, ordinal: event.ordinal, prompt, terminal: event });
    pending.delete(key);
  }
  for (const prompt of pending.values()) {
    notes.push(`${prompt.event.voice} ordinal ${prompt.event.ordinal} has a prompt without a terminal`);
    turns.push({ voice: prompt.event.voice, ordinal: prompt.event.ordinal, prompt: prompt.event });
  }
  return turns.sort((a, b) => (a.prompt?.order ?? a.terminal?.order ?? 0) - (b.prompt?.order ?? b.terminal?.order ?? 0));
}
