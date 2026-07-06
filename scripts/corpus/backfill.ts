#!/usr/bin/env node
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { allocateCorpusRecordDir, reconcileRecord } from '../../src/run/corpus.ts';
import { loadRunStateFromDir, UnloadableRunError } from '../../src/run/store.ts';
import { workflowForRunDir } from '../../src/run/workflow.ts';
import { captureRunTranscripts } from '../../src/voices/sessions.ts';
import {
  configuredCorpusDir,
  defaultSweepRoots,
  findLiveRunDirs,
  parseCorpusCliArgs,
} from './lib.ts';

function main(): void {
  const opts = parseCorpusCliArgs(process.argv.slice(2));
  const corpusRoot = opts.corpusDir ?? configuredCorpusDir();
  if (!corpusRoot) {
    throw new Error('no corpus dir configured — add [corpus] dir to ~/.config/duet/config.toml or pass --corpus <dir>');
  }
  const roots = opts.sweepRoots.length > 0 ? opts.sweepRoots : defaultSweepRoots();
  const dirs = findLiveRunDirs(roots);
  let mirrored = 0;
  let transcripts = 0;
  let skippedUnloadable = 0;
  let skippedForeign = 0;
  for (const runDir of dirs) {
    try {
      const state = loadRunStateFromDir(runDir);
      workflowForRunDir(state, runDir);
      const corpusDir = state.corpusDir ?? allocateCorpusRecordDir(corpusRoot, state.runId, state.cwd);
      const mirrorState = { ...state, corpusDir };
      reconcileRecord(mirrorState);
      transcripts += captureRunTranscripts(mirrorState).length;
      mirrored += 1;
    } catch (err) {
      if (err instanceof UnloadableRunError) skippedUnloadable += 1;
      else skippedForeign += 1;
    }
  }
  const source = roots.map((root) => (existsSync(root) ? root : `${root} (missing)`)).join(', ');
  console.log(`swept ${dirs.length} live run dir(s) under ${source}`);
  console.log(`mirrored ${mirrored} run(s) into ${corpusRoot}`);
  console.log(`captured ${transcripts} transcript file(s)`);
  console.log(`skipped unloadable=${skippedUnloadable}, foreign=${skippedForeign}`);
  console.log(`record layout: ${join(corpusRoot, '<runId>')}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
