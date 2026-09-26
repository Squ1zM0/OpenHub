import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "./types.js";
import { safeResolve } from "./path.js";

const Input = z.object({
  path: z.string().min(1),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
  max_bytes: z.number().int().positive().max(1_000_000).default(200_000),
});

export const readFileTool: Tool<z.infer<typeof Input>> = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the session workspace.",
  input: Input,
  async execute(args, ctx) {
    const abs = safeResolve(ctx.workspace, args.path);
    const buf = await readFile(abs);
    const truncated = buf.byteLength > args.max_bytes;
    const slice = truncated ? buf.subarray(0, args.max_bytes) : buf;
    const lines = slice.toString("utf8").split("\n");

    let content: string;
    if (args.start || args.end) {
      const start = (args.start ?? 1) - 1;
      const end = args.end ?? lines.length;
      content = lines.slice(start, end).join("\n");
    } else {
      content = lines.join("\n");
    }

    return {
      path: args.path,
      content,
      total_lines: lines.length,
      truncated,
    };
  },
};
