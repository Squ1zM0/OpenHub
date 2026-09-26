#!/usr/bin/env node
/**
 * Fix naming typos in the repo:
 *
 *   1. apps/deamon  →  apps/daemon
 *   2. apps/daemon/src/tools/read_files.ts  →  read_file.ts
 *   3. apps/daemon/src/tools/write_files.ts →  write_file.ts
 *
 * Also rewrites any import in the daemon source that references the old
 * filenames. Handles both singular and plural forms so it's safe to run
 * regardless of the current state.
 *
 * Idempotent — running twice does nothing the second time.
 */
const fs = require("node:fs");
const path = require("node:path");

const cwd = process.cwd();

// ── helpers ─────────────────────────────────────────────────────────────────
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function rename(oldRel, newRel) {
  const from = path.join(cwd, oldRel);
  const to = path.join(cwd, newRel);
  if (!exists(from)) {
    console.log(`  skip: ${oldRel} does not exist`);
    return false;
  }
  if (exists(to)) {
    console.error(`  ERROR: cannot rename ${oldRel} → ${newRel}: target exists`);
    process.exitCode = 1;
    return false;
  }
  fs.renameSync(from, to);
  console.log(`  renamed: ${oldRel} → ${newRel}`);
  return true;
}

// Walk a directory and yield every .ts/.tsx file.
const SKIP = new Set(["node_modules", ".git", ".next", "dist", ".turbo"]);
function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Rewrite import paths inside every daemon source file.
function rewriteImportsIn(dir) {
  if (!exists(dir)) return 0;

  // Patterns and their replacements. Applied across all daemon sources.
  const rules = [
    { re: /(from\s+["'][^"']*\/)read_files(["'])/g, to: "$1read_file$2" },
    { re: /(from\s+["'][^"']*\/)write_files(["'])/g, to: "$1write_file$2" },
    { re: /(from\s+["'][^"']*\/)read_file\.js(["'])/g, to: "$1read_file.js$2" },
    { re: /(from\s+["'][^"']*\/)write_file\.js(["'])/g, to: "$1write_file.js$2" },
    // Bare "./read_files" or "./read_files.js" forms
    { re: /(from\s+["']\.\/)read_files(["'])/g, to: "$1read_file$2" },
    { re: /(from\s+["']\.\/)write_files(["'])/g, to: "$1write_file$2" },
  ];

  let edits = 0;
  let files = 0;
  for (const file of walk(dir)) {
    const before = fs.readFileSync(file, "utf8");
    let after = before;
    for (const { re, to } of rules) {
      after = after.replace(re, to);
    }
    if (after !== before) {
      fs.writeFileSync(file, after);
      files++;
      const beforeLines = before.split("\n");
      const afterLines = after.split("\n");
      let changed = 0;
      for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
        if (beforeLines[i] !== afterLines[i]) changed++;
      }
      edits += changed;
      console.log(`  updated: ${path.relative(cwd, file)}  (${changed} line${changed === 1 ? "" : "s"})`);
    }
  }
  console.log(`  ${edits} line edits across ${files} file${files === 1 ? "" : "s"}`);
  return files;
}

// ── 1. rename apps/deamon → apps/daemon ────────────────────────────────────
console.log("\nRenaming daemon directory:");
rename("apps/deamon", "apps/daemon");

// ── 2. rename tool files ───────────────────────────────────────────────────
console.log("\nRenaming tool files:");
const toolsDir = "apps/daemon/src/tools";
rename(`${toolsDir}/read_files.ts`, `${toolsDir}/read_file.ts`);
rename(`${toolsDir}/write_files.ts`, `${toolsDir}/write_file.ts`);

// ── 3. rewrite imports that referenced the old filenames ───────────────────
console.log("\nRewriting daemon imports:");
rewriteImportsIn("apps/daemon/src");

// ── 4. sanity check ────────────────────────────────────────────────────────
console.log("\nSanity check:");
const expected = [
  "apps/daemon/package.json",
  "apps/daemon/src/index.ts",
  `${toolsDir}/read_file.ts`,
  `${toolsDir}/write_file.ts`,
];
let missing = 0;
for (const p of expected) {
  if (exists(path.join(cwd, p))) {
    console.log(`  ok: ${p}`);
  } else {
    console.log(`  MISSING: ${p}`);
    missing++;
  }
}

if (missing === 0) {
  console.log("\nAll expected paths present.");
} else {
  console.log(`\n${missing} expected path(s) missing.`);
  console.log("Check the daemon source for other references to the old names.");
}

console.log("\nDone.");
