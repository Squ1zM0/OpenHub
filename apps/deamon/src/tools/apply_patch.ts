import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { applyPatch } from "diff";
import type { Tool } from "./types.js";
import { safeResolve } from "./path.js";

const Input = z.object({
  path: z.string().min(1),
  /**
   * Unified diff. May include full `--- a/...` / `+++ b/...` headers or just
   * one or more `@@ ... @@` hunks. If headers are omitted, they're synthesized
   * from `path`.
   */
  patch: z.string().min(1),
  /** If true, compute and return the result without writing. */
  dry_run: z.boolean().default(false),
  max_bytes: z.number().int().positive().max(10_000_000).default(2_000_000),
});

/**
 * Synthesize missing file headers. The `diff` package tolerates both forms,
 * but being explicit makes the applied change self-describing in error output.
 */
function normalizePatch(path: string, patch: string): string {
  const trimmed = patch.replace(/^\s+/, "");
  if (trimmed.startsWith("---")) return patch;
  return `--- a/${path}\n+++ b/${path}\n${patch}`;
}

/**
 * Surgical edit. The agent's primary editing tool. Prefer this over
 * `write_file` for any change to an existing file — the patch is reviewable
 * and the failure mode (won't apply) is recoverable, unlike a bad full
 * rewrite.
 */
export const applyPatchTool: Tool<z.infer<typeof Input>> = {
  name: "apply_patch",
  description:
    "Apply a unified diff to an existing file in the workspace. Prefer this over write_file for editing existing files.",
  input: Input,
  async execute(args, ctx) {
    const abs = safeResolve(ctx.workspace, args.path);

    let original: string;
    try {
      original = await readFile(abs, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `file does not exist: ${args.path}. Use write_file to create it.`,
        );
      }
      throw e;
    }

    const originalBytes = Buffer.byteLength(original, "utf8");
    if (originalBytes > args.max_bytes) {
      throw new Error(`file exceeds max_bytes (${originalBytes} > ${args.max_bytes})`);
    }

    const patch = normalizePatch(args.path, args.patch);

    // fuzzFactor: 2 allows the patch to apply if surrounding context lines
    // have drifted by up to two lines. This is the same tolerance `git apply`
    // gives by default and handles whitespace/line-shift churn well.
    const result = applyPatch(original, patch, { fuzzFactor: 2 });

    if (result === false) {
      throw new Error(
        "patch did not apply cleanly. The file may have changed since the " +
          "patch was generated. Re-read the file and try a smaller patch.",
      );
    }

    const changed = result !== original;
    const resultBytes = Buffer.byteLength(result, "utf8");

    if (!args.dry_run && changed) {
      await writeFile(abs, result, "utf8");
    }

    return {
      path: args.path,
      applied: changed,
      dry_run: args.dry_run,
      bytes_before: originalBytes,
      bytes_after: resultBytes,
    };
  },
};
