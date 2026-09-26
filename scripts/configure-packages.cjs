#!/usr/bin/env node
/**
 * Configure workspace packages to compile to dist/.
 *
 * Why: webpack's resolve.extensionAlias does not apply to files inside
 * transpilePackages. The fix is to stop shipping TypeScript source as the
 * package entry point. Compile to JS first; the app consumes plain .js.
 *
 * For each package under packages/:
 *   1. Rewrite package.json: main/types/exports → dist, add build script,
 *      add files field.
 *   2. Write tsconfig.build.json that emits to dist/.
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
  },
  include: ["src"],
  exclude: ["node_modules", "dist", "scripts", "**/*.test.ts"],
};

let changed = 0;

for (const pkgDir of PACKAGES) {
  const pkgPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(path.join(cwd, pkgPath))) {
    console.log(`  skip: ${pkgPath} does not exist`);
    continue;
  }

  const pkg = readJson(pkgPath);
  const before = JSON.stringify(pkg);

  // Entry points → dist
  pkg.main = "./dist/index.js";
  pkg.types = "./dist/index.d.ts";
  pkg.exports = {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    },
  };

  // Only ship dist to consumers (harmless for private packages, correct
  // for the eventual publish).
  pkg.files = ["dist"];

  // Build script
  pkg.scripts = pkg.scripts ?? {};
  pkg.scripts.build = "tsc -p tsconfig.build.json";
  if (!pkg.scripts.typecheck) {
    pkg.scripts.typecheck = "tsc --noEmit";
  }

  const after = JSON.stringify(pkg);
  if (after !== before) {
    writeJson(pkgPath, pkg);
    console.log(`  updated: ${pkgPath}`);
    changed++;
  } else {
    console.log(`  unchanged: ${pkgPath}`);
  }

  // Write tsconfig.build.json
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
