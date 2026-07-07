import type { VoiceAddress, WorkerProvider, WorkerProviders, WorkerTurn } from '../voices/providers/types.ts';
import { voiceBindingFor } from '../voices/bindings.ts';
import type { RunState } from '../run/store.ts';
import type { ProtocolTrace, WorkerResponseEvent, WorkerTerminalEvent } from './record.ts';
import { phaseAddressesFor } from '../voices/policy.ts';
import type { PhaseName } from '../registry/workflows.ts';

export const SCRIPT_EXHAUSTED_TEXT = '[duet replay] scripted worker exhausted: no recorded response for this duty ordinal.';

export interface ScriptedWorkerCall {
  readonly voice: VoiceAddress;
  readonly ordinal: number;
  readonly prompt: string;
  readonly expectedResponse?: WorkerResponseEvent | WorkerTerminalEvent;
  readonly exhausted: boolean;
}

export interface ScriptedWorkerHarness {
  readonly providers: WorkerProviders;
  readonly calls: readonly ScriptedWorkerCall[];
}

export function scriptedWorkersForTrace(state: RunState, trace: ProtocolTrace, phase: PhaseName): ScriptedWorkerHarness {
  const calls: ScriptedWorkerCall[] = [];
  const byVoice = new Map<VoiceAddress, Array<WorkerResponseEvent | WorkerTerminalEvent>>();
  for (const turn of trace.workerTurns) {
    if (turn.prompt?.phase !== phase || !turn.terminal) continue;
    const voice = turn.voice as VoiceAddress;
    const script = byVoice.get(voice) ?? [];
    script.push(turn.terminal);
    byVoice.set(voice, script);
  }

  const providers: WorkerProviders = {};
  for (const voice of phaseAddressesFor(state, phase)) {
    const script = byVoice.get(voice) ?? [];
    const provider = voiceBindingFor(state.bindings, voice).provider;
    providers[voice] = new ScriptedRecordWorker(provider, voice, script, calls);
  }
  return { providers, calls };
}

class ScriptedRecordWorker implements WorkerProvider {
  readonly name: 'claude' | 'codex';
  private ordinal = 0;
  private readonly voice: VoiceAddress;
  private readonly script: readonly (WorkerResponseEvent | WorkerTerminalEvent)[];
  private readonly calls: ScriptedWorkerCall[];

  constructor(
    name: 'claude' | 'codex',
    voice: VoiceAddress,
    script: readonly (WorkerResponseEvent | WorkerTerminalEvent)[],
    calls: ScriptedWorkerCall[],
  ) {
    this.name = name;
    this.voice = voice;
    this.script = script;
    this.calls = calls;
  }

  async runTurn(opts: { prompt: string }): Promise<WorkerTurn> {
    this.ordinal += 1;
    const expected = this.script[this.ordinal - 1];
    const exhausted = expected === undefined;
    this.calls.push({ voice: this.voice, ordinal: this.ordinal, prompt: opts.prompt, ...(expected ? { expectedResponse: expected } : {}), exhausted });
    if (!expected) return { text: SCRIPT_EXHAUSTED_TEXT, sessionId: `replay-${this.voice}-${this.ordinal}` };
    if (expected.kind === 'worker_response') {
      return { text: expected.body, sessionId: `replay-${this.voice}-${this.ordinal}` };
    }
    return { text: `[duet replay] recorded worker terminal: ${expected.status}\n${expected.body}`, sessionId: `replay-${this.voice}-${this.ordinal}` };
  }
}
