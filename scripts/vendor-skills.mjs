#!/usr/bin/env node
// Vendor duet's PLAN-phase methodology skills from the author's canonical
// ~/.claude/skills into ./skills/internal, so the snippets that cite them ship
// the discipline instead of pointing at a path on the author's machine.
//
// This is the MIRROR of sync-skills.mjs. That one symlinks the repo's authored
// skills OUT to the live Claude config (repo -> Claude, so edits are live); this
// one copies the canonical methodology IN as a frozen snapshot (Claude -> repo,
// so it ships in the package). Both are deliberate manual hand-syncs — the exact
// parallel of the snippets.toml <-> tabtype port, which also runs by hand.
//
// Usage:
//   pnpm vendor-skills            refresh skills/internal from the canonical copy
//   pnpm vendor-skills --dry-run  show what would change, touch nothing
//
// Source defaults to ~/.claude/skills (where the snippets used to point);
// override with DUET_CANONICAL_SKILLS_DIR if your Claude config lives elsewhere.

import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The vendored set is the dependency closure of the worker-facing PLAN snippets:
// exactly the two skills tdd-plan / review-plan cite. An explicit allowlist, not
// a registry — widen it only when a worker-facing snippet starts citing a new one.
const SKILLS = ["tdd", "improve-codebase-architecture"];

const repoRoot = path.resolve(import.meta.dirname, "..");
const destRoot = path.join(repoRoot, "skills", "internal");
const srcRoot =
  process.env.DUET_CANONICAL_SKILLS_DIR ?? path.join(homedir(), ".claude", "skills");

const dryRun = process.argv.includes("--dry-run");

if (!existsSync(srcRoot)) {
  console.error(
    `canonical skills dir not found: ${srcRoot}\n` +
      `set DUET_CANONICAL_SKILLS_DIR to your Claude Code skills directory`,
  );
  process.exit(1);
}

const missing = SKILLS.filter((name) => !existsSync(path.join(srcRoot, name)));
if (missing.length > 0) {
  console.error(`canonical skill(s) missing under ${srcRoot}: ${missing.join(", ")}`);
  process.exit(1);
}

for (const name of SKILLS) {
  const src = path.join(srcRoot, name);
  const dest = path.join(destRoot, name);
  console.log(
    `  ${dryRun ? "would " : ""}vendor  ${name}  (${src} -> ${path.relative(repoRoot, dest)})`,
  );
  if (dryRun) continue;
  // Replace wholesale so a file deleted upstream doesn't linger in the snapshot.
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

console.log(
  dryRun
    ? `\n${SKILLS.length} skill(s) would be re-vendored (dry run) into ${path.relative(repoRoot, destRoot)}`
    : `\n${SKILLS.length} skill(s) re-vendored into ${path.relative(repoRoot, destRoot)} — review \`git diff\`, and update skills/internal/README.md if the provenance changed.`,
);
