#!/usr/bin/env node
/**
 * Add @types/node to each workspace package's devDependencies, and ensure
 * its tsconfig.build.json includes "types": ["node"] and the Node lib.
 *
 * Why: the packages use node:crypto, node:fs/promises, Buffer, process,
 * etc. Without @types/node and an explicit types field, tsc cannot find
 * those ambient declarations.
 *
 * Idempotent.
 */
const fs = require("node:fs");
const path = require("node:path");

const PACKAGES = [
  "packages/manifest",
  "packages/protocol",
  "packages/github",
  "packages/agent",
];

const cwd = process.cwd();

function readJson(p) {
  return JSON.parse(fs.readFileSync(path.join(cwd, p), "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(
    path.join(cwd, p),
    JSON.stringify(obj, null, 2) + "\n",
    "utf8",
  );
}

const TSCONFIG_BUILD = {
  extends: "./tsconfig.json",
  compilerOptions: {
    noEmit: false,
    outDir: "./dist",
    rootDir: "./src",
    declaration: true,
    declarationMap: true,
    sourceMap: true,
    // Node types are required for node:crypto, Buffer, process, fs/promises.
    // "types": ["node"] restricts the ambient declarations to only @types/node
    // (not @types/react and friends), which keeps the compile fast and
    // prevents accidental DOM lib leaks.
    types: ["node"],
  },
  include: ["src"],
  exclude: ["node_modules", "dist", "scripts", "**/*.test.ts"],
};

let changed = 0;

for (const pkgDir of PACKAGES) {
  const pkgPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(path.join(cwd, pkgPath))) {
    console.log(`  skip: ${pkgPath} (does not exist)`);
    continue;
  }

  // 1. package.json — add @types/node to devDependencies
  const pkg = readJson(pkgPath);
  const before = JSON.stringify(pkg);

  pkg.devDependencies = pkg.devDependencies ?? {};
  if (!pkg.devDependencies["@types/node"]) {
    pkg.devDependencies["@types/node"] = "^22.0.0";
  }
  // Sort devDependencies for stable diffs.
  pkg.devDependencies = Object.fromEntries(
    Object.entries(pkg.devDependencies).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );

  if (JSON.stringify(pkg) !== before) {
    writeJson(pkgPath, pkg);
    console.log(`  updated: ${pkgPath}`);
    changed++;
  } else {
    console.log(`  unchanged: ${pkgPath}`);
  }

  // 2. tsconfig.build.json — regenerate with types: ["node"]
  const buildTsconfigPath = path.join(pkgDir, "tsconfig.build.json");
  const newTsconfig = JSON.stringify(TSCONFIG_BUILD, null, 2) + "\n";
  const existing = fs.existsSync(path.join(cwd, buildTsconfigPath))
    ? fs.readFileSync(path.join(cwd, buildTsconfigPath), "utf8")
    : null;
  if (existing !== newTsconfig) {
    fs.writeFileSync(path.join(cwd, buildTsconfigPath), newTsconfig, "utf8");
    console.log(`  wrote: ${buildTsconfigPath}`);
    changed++;
  }
}

console.log("");
console.log(changed === 0 ? "Nothing to do." : `${changed} change(s) applied.`);
