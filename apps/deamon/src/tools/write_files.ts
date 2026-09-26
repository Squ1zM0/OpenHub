import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool } from "./types.js";
import { safeResolve } from "./path.js";

const Input = z.object({
  path: z.string().min(1),
  content: z.string(),
  /**
   * If true, refuse to overwrite an existing file. The agent should use this
   * when creating new files, to catch accidental clobbers.
   */
  create_only: z.boolean().default(false),
  max_bytes: z.number().int().positive().max(10_000_000).default(2_000_000),
});

/**
 * Whole-file write. For editing existing files, prefer `apply_patch` — it's
 * surgical and produces a reviewable diff. This tool is for creating new
 * files or the rare case where a full rewrite is genuinely correct.
 */
export const writeFileTool: Tool<z.infer<typeof Input>> = {
  name: "write_file",
  description:
    "Write UTF-8 text to a file in the workspace. Creates parent directories. Use apply_patch for surgical edits to existing files.",
  input: Input,
  async execute(args, ctx) {
    const abs = safeResolve(ctx.workspace, args.path);

    const bytes = Buffer.byteLength(args.content, "utf8");
    if (bytes > args.max_bytes) {
      throw new Error(
        `content exceeds max_bytes (${bytes} > ${args.max_bytes})`,
      );
    }

    let existed = false;
    try {
      await readFile(abs);
      existed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    if (args.create_only && existed) {
      throw new Error(`file already exists: ${args.path}`);
    }

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, args.content, "utf8");

    return {
      path: args.path,
      bytes,
      created: !existed,
      overwrote: existed,
    };
  },
};
