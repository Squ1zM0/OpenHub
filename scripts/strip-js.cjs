#!/usr/bin/env node
/**
 * Strip `.js` from relative imports and re-exports across the monorepo.
 *
 * Why: packages use TypeScript source-level imports. Under NodeNext
 * moduleResolution, TS requires `.js` extensions on relative imports even
 * when the file on disk is `.ts`. Next.js webpack doesn't follow that
 * convention and fails to resolve them. Stripping the extensions makes
 * both TS (in Bundler mode) and webpack happy.
 *
 * Scope: packages/ and apps/. webpack is idempotent — running this twice
 * produces no diff.
 *
 * What it matches:
 *   from "./foo.js"          → from "./foo"
 *   from "../foo.js"         → from "../foo"
 *   from "./a/b.js"          → from "./a/b"
 *   from './foo.js'          → from './foo'   (single quotes too)
 *   export * from "./x.js"   → export * from "./x"
 *   export { A } from "./x.js" → export { A } from "./x"
 *
 * What it does NOT match:
 *   from "playwright-core"      (bare specifier — no ./ or ../)
 *   from "@openhub/agent"       (package name)
 *   from "./data.json"          (not .js)
 *   import "./styles.css"       (side-effect import, we don't have any)
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOTS = ["packages", "apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", ".git"]);
const EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

// from "./x.js"  or  from "../x.js"  — captures the prefix, body, and closing quote.
// The `\.\.?\/` requires the path to start with ./ or ../, so bare specifiers
// and package names never match.
const RE = /(from\s+["'])(\.\.?\/[^"']+)\.js(["'])/g;

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
const changed = [];

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  const files = walk(root);

  for (const file of files) {
    const before = fs.readFileSync(file, "utf8");
    const matches = before.match(RE);
    if (!matches) continue;

    const after = before.replace(RE, "$1$2$3");
    if (after === before) continue;

    fs.writeFileSync(file, after);
    const n = matches.length;
    totalFiles++;
    totalEdits += n;
    changed.push({ file, n });
    console.log(`  ${file}  (${n} edit${n === 1 ? "" : "s"})`);
  }
}

console.log("");
if (totalFiles === 0) {
  console.log("No relative .js imports found. Nothing to do.");
} else {
  console.log(`${totalEdits} edits across ${totalFiles} files.`);
}
