#!/usr/bin/env node
// Vendor duet's PLAN-phase methodology lessons from the author's canonical
// ~/.config/lessons into ./lessons, so the snippets that cite them ship the
// discipline instead of pointing at a path on the author's machine.
//
// This is the MIRROR of sync-skills.mjs. That one symlinks the repo's authored
// Claude skills OUT to the live Claude config (repo -> Claude, so edits are
// live); this one copies the canonical methodology lessons IN as a frozen
// snapshot (lessons -> repo, so it ships in the package). Both are deliberate
// manual hand-syncs — the exact parallel of the snippets.toml <-> tabtype port,
// which also runs by hand. The provenance audit is `git diff` on ./lessons.
//
// The three-tier chain: mattpocock/skills -> ~/.config/lessons (the author's
// owned, forked source of truth, which pins its own upstream in .upstream/) ->
// duet/lessons (this vendored snapshot). We never vendor the source's .upstream/
// baseline — that is the author's diff anchor, not something a worker reads.
//
// Usage:
//   pnpm vendor-lessons            refresh ./lessons from the canonical copy
//   pnpm vendor-lessons --dry-run  show what would change, touch nothing
//
// Source defaults to ~/.config/lessons (the neutral, Stow-managed home);
// override with DUET_LESSONS_DIR if your lessons live elsewhere.

import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The vendored set is the dependency closure of the worker-facing PLAN snippets:
// the two lesson topics start-plan / review-plan / implement-direct cite. An
// explicit allowlist, not a registry — widen it only when a worker-facing
// snippet starts citing a new topic. Each topic dir is copied wholesale (its
// own .upstream/-style siblings never live inside a topic, so nothing is
// excluded within one); the source's top-level README and .upstream/ are
// deliberately left out — neither is read by a worker at runtime.
const TOPICS = ["codebase-design", "testing"];

const repoRoot = path.resolve(import.meta.dirname, "..");
// This "lessons" segment is the same fact as LESSONS_DIR in src/snippets.ts (the
// serve-time read path): the vendor writes here, the runtime reads there. Kept as
// two literals on purpose — a build script shouldn't import the runtime module
// (and its zod/smol-toml graph) for one path segment — so relocate both together.
const destRoot = path.join(repoRoot, "lessons");
const srcRoot =
  process.env.DUET_LESSONS_DIR ?? path.join(homedir(), ".config", "lessons");

const dryRun = process.argv.includes("--dry-run");

if (!existsSync(srcRoot)) {
  console.error(
    `canonical lessons dir not found: ${srcRoot}\n` +
      `set DUET_LESSONS_DIR to your lessons directory (e.g. ~/.config/lessons)`,
  );
  process.exit(1);
}

const missing = TOPICS.filter((name) => !existsSync(path.join(srcRoot, name)));
if (missing.length > 0) {
  console.error(`canonical lesson topic(s) missing under ${srcRoot}: ${missing.join(", ")}`);
  process.exit(1);
}

for (const name of TOPICS) {
  const src = path.join(srcRoot, name);
  const dest = path.join(destRoot, name);
  console.log(
    `  ${dryRun ? "would " : ""}vendor  ${name}  (${src} -> ${path.relative(repoRoot, dest)})`,
  );
  if (dryRun) continue;
  // Replace the topic dir wholesale so a file deleted upstream doesn't linger in
  // the snapshot. This only touches the named topic dirs — the duet-authored
  // lessons/README.md (provenance) is never removed.
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

console.log(
  dryRun
    ? `\n${TOPICS.length} topic(s) would be re-vendored (dry run) into ${path.relative(repoRoot, destRoot)}`
    : `\n${TOPICS.length} topic(s) re-vendored into ${path.relative(repoRoot, destRoot)} — review \`git diff\`, and update lessons/README.md if the provenance changed.`,
);
