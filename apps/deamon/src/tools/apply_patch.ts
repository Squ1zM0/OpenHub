import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { applyPatch } from "diff";
import type { Tool } from "./types";
import { safeResolve } from "./path";
import { checkpoint } from "../snapshot";

const Input = z.object({
  path: z.string().min(1),
  patch: z.string().min(1),
  dry_run: z.boolean().default(false),
  max_bytes: z.number().int().positive().max(10_000_000).default(2_000_000),
});

function normalizePatch(path: string, patch: string): string {
  const trimmed = patch.replace(/^\s+/, "");
  if (trimmed.startsWith("---")) return patch;
  return `--- a/${path}\n+++ b/${path}\n${patch}`;
}

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
      throw new Error(
        `file exceeds max_bytes (${originalBytes} > ${args.max_bytes})`,
      );
    }

    const patch = normalizePatch(args.path, args.patch);
    const result = applyPatch(original, patch, { fuzzFactor: 2 });

    if (result === false) {
      throw new Error(
        "patch did not apply cleanly. The file may have changed since the " +
          "patch was generated. Re-read the file and try a smaller patch.",
      );
    }

    const changed = result !== original;
    const resultBytes = Buffer.byteLength(result, "utf8");

    let checkpointSha: string | null = null;
    if (!args.dry_run && changed) {
      checkpointSha = await checkpoint(ctx.workspace, `apply_patch ${args.path}`);
      await writeFile(abs, result, "utf8");
    }

    return {
      path: args.path,
      applied: changed,
      dry_run: args.dry_run,
      bytes_before: originalBytes,
      bytes_after: resultBytes,
      checkpoint: checkpointSha,
    };
  },
};
