import { fromPromise, setup } from 'xstate';
import { runPhase } from './driver.ts';
import type { DriverInput, DriverOutput } from './driver.ts';
import type { PhaseName } from '../run-state.ts';

/**
 * The harness statechart — Layer 1 of the three-layer architecture
 * (docs/automation-design.md). Each phase is a state that runs the
 * orchestrator agent (an invoked promise actor); each gate and flag-wait is
 * an actor-less state that transitions ONLY on human events. Agent code has
 * no channel to send machine events, so gate-skipping is unrepresentable,
 * not merely forbidden.
 *
 * Q15 guardrail: snapshots are persisted only in `quiescent`-tagged states
 * (no live actors), so a restored snapshot never has to blind-restart an
 * in-flight invoke. The machine's context is the run id + cwd + entry mode —
 * all operational state lives on disk in the run dir, owned by the driver.
 *
 * The full arc (each loop also has a flag-wait sibling, elided here;
 * `route` is a transient entry choice — spec-entry runs skip the frame
 * phase):
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
 * Every gate's reject re-enters the loop it gates; `openLoop` (push +
 * `gh pr create`) runs after the last gate and advances straight to done.
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
  states: {
    // Transient entry choice — never persisted (not quiescent-tagged), the
    // machine moves through it immediately.
    route: {
      always: [{ guard: 'hasSpec', target: 'specLoop' }, { target: 'frameLoop' }],
    },
    frameLoop: phaseState('frame', { advanced: 'directionGate', flagWait: 'frameFlagWait' }),
    frameFlagWait: flagWaitState('frameLoop'),
    directionGate: gateState({ approve: 'specLoop', reject: 'frameLoop' }),
    specLoop: phaseState('spec', { advanced: 'commitSpecGate', flagWait: 'specFlagWait' }),
    specFlagWait: flagWaitState('specLoop'),
    commitSpecGate: gateState({ approve: 'planLoop', reject: 'specLoop' }),
    planLoop: phaseState('plan', { advanced: 'planApprovalGate', flagWait: 'planFlagWait' }),
    planFlagWait: flagWaitState('planLoop'),
    planApprovalGate: gateState({ approve: 'implLoop', reject: 'planLoop' }),
    implLoop: phaseState('impl', { advanced: 'shipGate', flagWait: 'implFlagWait' }),
    implFlagWait: flagWaitState('implLoop'),
    shipGate: gateState({ approve: 'docsLoop', reject: 'implLoop' }),
    docsLoop: phaseState('docs', { advanced: 'docsPlanGate', flagWait: 'docsFlagWait' }),
    docsFlagWait: flagWaitState('docsLoop'),
    docsPlanGate: gateState({ approve: 'prLoop', reject: 'docsLoop' }),
    prLoop: phaseState('pr', { advanced: 'openPrGate', flagWait: 'prFlagWait' }),
    prFlagWait: flagWaitState('prLoop'),
    openPrGate: gateState({ approve: 'openLoop', reject: 'prLoop' }),
    // Runs after the last gate (approval authorized the mechanics): push the
    // branch, gh pr create, report the URL — then the run is done.
    openLoop: phaseState('open', { advanced: 'done', flagWait: 'openFlagWait' }),
    openFlagWait: flagWaitState('openLoop'),
    done: {
      type: 'final',
      tags: ['quiescent'],
    },
  },
});
