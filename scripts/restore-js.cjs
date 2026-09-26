#!/usr/bin/env node
/**
 * Add `.js` back to relative imports that target `.ts`/`.tsx` sources.
 *
 * Why: webpack's `resolve.extensionAlias` maps `.js` specifiers to `.ts`
 * sources. It does NOT map extensionless specifiers. So the source must
 * carry `.js` for the alias to fire.
 *
 * This reverses the earlier strip-js.cjs.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOTS = ["packages", "apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", ".git"]);
const EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

// Match relative imports that do NOT already end in .js or another extension.
// from "./types"   → from "./types.js"
// from "../foo"    → from "../foo.js"
// Skips: "./foo.js", "./foo.json", "./foo.css", bare specifiers
const RE = /(from\s+["'])(\.\.?\/[^"']+?)(?<!\.(js|json|css|md|wasm|node))(["'])/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

let totalFiles = 0;
let totalEdits = 0;

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const before = fs.readFileSync(file, "utf8");
    const matches = before.match(RE);
    if (!matches) continue;

    const after = before.replace(RE, "$1$2.js$4");
    if (after === before) continue;

    fs.writeFileSync(file, after);
    const n = matches.length;
    totalFiles++;
    totalEdits += n;
    console.log(`  ${file}  (${n} edit${n === 1 ? "" : "s"})`);
  }
}

console.log("");
console.log(totalFiles === 0
  ? "Nothing to restore."
  : `${totalEdits} edits across ${totalFiles} files.`);
