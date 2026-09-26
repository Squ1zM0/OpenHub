import { z } from "zod";
import type { Tool } from "./types.js";
import { git } from "../git.js";
import { safeResolve } from "./path.js";
import { relative } from "node:path";

const Input = z.object({
  path: z.string().optional(),
  staged: z.boolean().default(false),
  max_bytes: z.number().int().positive().max(2_000_000).default(200_000),
});

export const gitDiffTool: Tool<z.infer<typeof Input>> = {
  name: "git_diff",
  description:
    "Show the working-tree diff (or staged diff with staged=true). Optionally scoped to a single path.",
  input: Input,
  async execute(args, ctx) {
    const gitArgs = ["diff", "--no-color"];
    if (args.staged) gitArgs.push("--staged");
    if (args.path) {
      const abs = safeResolve(ctx.workspace, args.path);
      const rel = relative(ctx.workspace, abs) || ".";
      gitArgs.push("--", rel);
    }

    const res = await git(ctx.workspace, gitArgs);
    const bytes = Buffer.byteLength(res.stdout, "utf8");
    const truncated = bytes > args.max_bytes;
    const diff = truncated
      ? Buffer.from(res.stdout, "utf8")
          .subarray(0, args.max_bytes)
          .toString("utf8")
      : res.stdout;

    return {
      path: args.path ?? null,
      staged: args.staged,
      empty: res.stdout.length === 0,
      diff,
      bytes,
      truncated,
    };
  },
};
