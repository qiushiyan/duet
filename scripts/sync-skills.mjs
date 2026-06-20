#!/usr/bin/env node
// Symlink the in-development skills under ./skills into the Claude Code skills
// directory, so edits in this repo are live immediately (no copy step to re-run).
//
// Usage:
//   pnpm sync-skills            create/update the symlinks
//   pnpm sync-skills --dry-run  show what would change, touch nothing
//
// Links are relative (matching the convention already in the dotfiles skills
// dir). Destination defaults to the dotfiles-managed skills dir; override with
// DUET_SKILLS_DIR if your Claude config lives elsewhere.

import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(repoRoot, "skills");
const destDir =
  process.env.DUET_SKILLS_DIR ?? path.join(homedir(), "dotfiles", "claude", ".claude", "skills");

const dryRun = process.argv.includes("--dry-run");

if (!existsSync(destDir)) {
  console.error(
    `destination skills dir not found: ${destDir}\n` +
      `set DUET_SKILLS_DIR to your Claude Code skills directory`,
  );
  process.exit(1);
}

// A skill is any subdir of ./skills that carries a SKILL.md (auto-discovered, so
// new skills are picked up without editing this script).
const skills = readdirSync(srcDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(srcDir, e.name, "SKILL.md")))
  .map((e) => e.name);

if (skills.length === 0) {
  console.error(`no skills (dir with a SKILL.md) found under ${srcDir}`);
  process.exit(1);
}

const isSymlink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

let changed = 0;
for (const name of skills) {
  const link = path.join(destDir, name);
  const target = path.relative(destDir, path.join(srcDir, name));

  let state;
  if (isSymlink(link)) {
    state = readlinkSync(link) === target ? "ok" : "relink";
  } else if (existsSync(link)) {
    state = "replace"; // a real file/dir (e.g. a stale copy) sits here
  } else {
    state = "create";
  }

  if (state === "ok") {
    console.log(`  ok      ${name} -> ${target}`);
    continue;
  }

  console.log(`  ${dryRun ? "would " : ""}${state.padEnd(7)} ${name} -> ${target}`);
  changed++;
  if (dryRun) continue;

  if (state !== "create") rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link);
}

console.log(
  dryRun
    ? `\n${changed} change(s) pending (dry run) in ${destDir}`
    : `\n${changed} change(s) applied; ${skills.length} skill(s) linked into ${destDir}`,
);
