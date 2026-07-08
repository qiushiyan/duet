import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultBindingsFor } from '../../src/voices/bindings.ts';
import type { VoiceBindings } from '../../src/voices/bindings.ts';
import { acceptanceContractPathForSpec } from '../../src/registry/workflows.ts';
import type { GatePhase, WorkflowName } from '../../src/registry/workflows.ts';
import { createRun } from '../../src/run/store.ts';
import type { RunState } from '../../src/run/store.ts';
import { consultantBindingsFor } from '../helpers/fixtures.ts';

/**
 * The parity matrix — deterministic run states for the byte-identical pins
 * (docs/specs/2026-07-03-workflow-vocabulary.md, one-PR plan step 2). Every
 * value that interpolates into a rendered surface is FIXED here (runId, branch,
 * framing, spec content, session ids, ledger timestamps), so a pin diff can
 * only mean the rendering changed, never the fixture.
 *
 * The knobs mirror the spec's matrix: consultant on/off, gateless, spec-entry,
 * attended vs pre-authorized gate posture, auto-crossed vs explicitly-approved
 * prior crossing (the autoApprovals ledger), acceptance contract
 * absent/draft/frozen/verified, and claude vs codex implementer.
 */

export const SPEC_PATH = 'docs/specs/parity-fixture.md';

const SPEC_CONTENT = `# Parity fixture spec

A fixed document the parity pins read through documentsBlock. Its content is
frozen so the rendered briefs are byte-stable; it stands in for a real spec or
plan seed, depending on the workflow under pin.
`;

const FRAMING = 'Parity framing: a fixed briefing used only by the parity pins.';
const AT = '2026-07-03T00:00:00.000Z';

export interface ParityRunOpts {
  workflow?: WorkflowName;
  /** Bind the consultant (the opt-in third voice). */
  consultant?: boolean;
  /** The gateless posture — pass with an explicit gatesAt: [] to mirror the CLI's materialization. */
  gateless?: boolean;
  /** Write the fixture spec file and enter with specPath set (the --spec entry / post-spec phases). */
  spec?: boolean;
  /** Branch name; null ⇒ no branch recorded (the 'unknown' rendering). Default 'feat/parity'. */
  branch?: string | null;
  /** Explicit gate posture; absent ⇒ the workflow's materialized default. */
  gatesAt?: GatePhase[];
  /** Gate-state names to ledger as auto-crossed (fixed timestamp). */
  autoApprovals?: string[];
  /** Run the implementer on codex (the compaction-prose branch). */
  codexImplementer?: boolean;
  /** Acceptance-contract state; absent ⇒ none. */
  contract?: 'draft' | 'frozen' | 'verified';
  /** Mark both worker sessions live (drops the first-prompt branch paragraph). */
  warmSessions?: boolean;
}

export function parityRun(projectDir: string, opts: ParityRunOpts = {}): RunState {
  const wf = opts.workflow ?? 'full';
  const bindings: VoiceBindings = opts.consultant ? consultantBindingsFor(wf) : defaultBindingsFor(wf);
  if (opts.codexImplementer) {
    // The whole maker lane on codex — both stages, so every phase's brief
    // renders the codex-implementer world.
    bindings.duties = { ...bindings.duties, architect: { provider: 'codex' }, builder: { provider: 'codex' } };
  }
  if (opts.spec) {
    const specFile = join(projectDir, SPEC_PATH);
    mkdirSync(dirname(specFile), { recursive: true });
    writeFileSync(specFile, SPEC_CONTENT);
  }
  const state = createRun({
    cwd: projectDir,
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    ...(opts.spec ? { specPath: SPEC_PATH } : {}),
    framing: FRAMING,
    ...(opts.branch === null ? {} : { branch: opts.branch ?? 'feat/parity' }),
    bindings,
    ...(opts.gatesAt ? { gatesAt: opts.gatesAt } : {}),
    ...(opts.gateless ? { gateless: true } : {}),
  });
  // The generated id embeds a timestamp and appears verbatim in the briefs
  // (the scratch-dir path), so pin determinism requires a fixed one. The
  // on-disk run dir keeps the generated id — the pins never read it.
  state.runId = 'PARITYRUN';
  if (opts.autoApprovals) {
    state.autoApprovals = opts.autoApprovals.map((gate) => ({ gate, at: AT }));
  }
  if (opts.contract) {
    const path = acceptanceContractPathForSpec(SPEC_PATH);
    if (opts.contract === 'draft') {
      state.acceptanceContractDraft = { path, sessionId: 'parity-consultant-session', authoredAt: AT };
    } else {
      state.acceptanceContract = {
        path,
        commit: 'abc1234',
        ...(opts.contract === 'verified' ? { verifiedAt: AT } : {}),
      };
    }
  }
  if (opts.warmSessions) {
    state.sessions = { 'planning.architect': { provider: 'claude', id: 'parity-impl-session' }, 'planning.analyst': { provider: 'codex', id: 'parity-rev-session' } };
  }
  return state;
}
