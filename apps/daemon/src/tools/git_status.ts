import { z } from "zod";
import type { Tool } from "./types.js";
import { git } from "../git.js";

const Input = z.object({
  max_entries: z.number().int().positive().max(2000).default(500),
});

interface Entry {
  path: string;
  index_status: string;
  worktree_status: string;
}

export const gitStatusTool: Tool<z.infer<typeof Input>> = {
  name: "git_status",
  description:
    "Show git branch, HEAD, and the set of modified/untracked files in the workspace.",
  input: Input,
  async execute(args, ctx) {
    const res = await git(ctx.workspace, ["status", "--porcelain=v1", "-b"]);

    const lines = res.stdout.split("\n").filter(Boolean);
    const header = lines[0] ?? "";
    const branchMatch = header.match(/^## ([^.\s]+)/);
    const branch = branchMatch ? branchMatch[1]! : "(detached)";

    const entries: Entry[] = [];
    let truncated = false;
    for (const line of lines.slice(1)) {
      if (entries.length >= args.max_entries) {
        truncated = true;
        break;
      }
      const index = line[0] ?? " ";
      const worktree = line[1] ?? " ";
      const path = line.slice(3);
      entries.push({ path, index_status: index, worktree_status: worktree });
    }

    const head = await git(ctx.workspace, ["rev-parse", "--short", "HEAD"]);

    return {
      branch,
      head: head.stdout.trim(),
      clean: entries.length === 0,
      entries,
      truncated,
    };
  },
};
