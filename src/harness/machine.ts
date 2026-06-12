import { fromPromise, setup } from 'xstate';
import { runPhase } from './driver.ts';
import type { DriverInput, DriverOutput } from './driver.ts';
import { PHASES } from '../phases.ts';
import type { PhaseName } from '../phases.ts';

/**
 * The harness statechart — Layer 1 of the three-layer architecture
 * (docs/automation-design.md). Each phase is a state that runs the
 * orchestrator agent (an invoked promise actor); each gate and flag-wait is
 * an actor-less state that transitions ONLY on human events. Agent code has
 * no channel to send machine events, so gate-skipping is unrepresentable,
 * not merely forbidden.
 *
 * The states are built from the phase table (src/phases.ts) — the arc is a
 * linear chain, so each phase contributes `<name>Loop` + `<name>FlagWait` +
 * its gate state; a gate's approve targets the next phase's loop, its reject
 * re-enters the loop it gates. `open` has no gate and advances straight to
 * done. The full arc:
 *
 * ```
 * route ─(no spec)─▶ frameLoop ──▶ directionGate ─approve─▶ specLoop ──▶ commitSpecGate
 *   └──(spec given)───────────────────────────────────────────▲              │ approve
 *                                                                            ▼
 *               shipGate ◀── implLoop ◀─approve── planApprovalGate ◀── planLoop
 *                  │ approve                                  ▲ (walk away)
 *                  ▼
 *               docsLoop ──▶ docsPlanGate ─approve─▶ prLoop ──▶ openPrGate
 *                                                                  │ approve
 *                                          done ◀── openLoop ◀─────┘
 * ```
 *
 * Persistence guardrail: snapshots are persisted only in `quiescent`-tagged states
 * (no live actors), so a restored snapshot never has to blind-restart an
 * in-flight invoke. The machine's context is the run id + cwd + entry mode —
 * all operational state lives on disk in the run dir, owned by the driver.
 */

export interface MachineInput {
  runId: string;
  cwd: string;
  /** Spec-entry runs (a draft spec exists) skip the frame phase. */
  hasSpec: boolean;
}

function phaseState(
  phase: PhaseName,
  targets: { advanced: string; flagWait: string },
): object {
  return {
    tags: ['phase'],
    invoke: {
      src: 'phaseDriver',
      input: ({ context }: { context: MachineInput }) => ({
        runId: context.runId,
        cwd: context.cwd,
        phase,
      }),
      onDone: [
        {
          guard: {
            type: 'isAdvanced',
            params: ({ event }: { event: { output: DriverOutput } }) => ({ output: event.output }),
          },
          target: targets.advanced,
        },
        { target: targets.flagWait },
      ],
      // Driver errors are caught inside runPhase and surfaced as flags; this
      // is the backstop for bugs in the driver itself.
      onError: { target: targets.flagWait },
    },
  };
}

function flagWaitState(resumeTarget: string): object {
  return {
    tags: ['quiescent', 'flag-wait'],
    on: {
      'human.answer': { target: resumeTarget },
    },
  };
}

function gateState(targets: { approve: string; reject: string }): object {
  return {
    tags: ['quiescent', 'gate'],
    on: {
      'human.approve': { target: targets.approve },
      'human.reject': { target: targets.reject },
    },
  };
}

function buildStates(): Record<string, object> {
  const states: Record<string, object> = {
    // Transient entry choice — never persisted (not quiescent-tagged), the
    // machine moves through it immediately.
    route: {
      always: [{ guard: 'hasSpec', target: 'specLoop' }, { target: 'frameLoop' }],
    },
  };
  PHASES.forEach((spec, i) => {
    const loop = `${spec.name}Loop`;
    const flagWait = `${spec.name}FlagWait`;
    const next = PHASES[i + 1];
    states[loop] = phaseState(spec.name, { advanced: spec.gate?.state ?? 'done', flagWait });
    states[flagWait] = flagWaitState(loop);
    if (spec.gate) {
      states[spec.gate.state] = gateState({ approve: next ? `${next.name}Loop` : 'done', reject: loop });
    }
  });
  states['done'] = { type: 'final', tags: ['quiescent'] };
  return states;
}

export const duetMachine = setup({
  types: {} as {
    context: MachineInput;
    input: MachineInput;
    events: { type: 'human.approve' } | { type: 'human.reject' } | { type: 'human.answer' };
  },
  guards: {
    isAdvanced: (_, params: { output: DriverOutput }) => params.output.outcome === 'advanced',
    hasSpec: ({ context }) => context.hasSpec,
  },
  actors: {
    phaseDriver: fromPromise<DriverOutput, DriverInput>(({ input }) => runPhase(input)),
  },
}).createMachine({
  id: 'duet',
  context: ({ input }) => input,
  initial: 'route',
  states: buildStates(),
});
