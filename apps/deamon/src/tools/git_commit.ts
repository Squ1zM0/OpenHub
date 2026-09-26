import { z } from "zod";
import type { Tool } from "./types.js";
import { git } from "../git.js";

const Input = z.object({
  message: z.string().min(1).max(500),
});

/**
 * Explicit commit — used by the agent when it's satisfied with a set of
 * changes. Distinct from the automatic checkpoints that mutating tools
 * create; those are for undo, this is for narrative.
 */
export const gitCommitTool: Tool<z.infer<typeof Input>> = {
  name: "git_commit",
  description:
    "Commit the current working tree with the given message. Use after making a coherent set of edits.",
  input: Input,
  async execute(args, ctx) {
    const status = await git(ctx.workspace, ["status", "--porcelain"]);
    if (!status.stdout.trim()) {
      return { committed: false, reason: "nothing to commit" as const };
    }

    await git(ctx.workspace, ["add", "-A"]);
    await git(ctx.workspace, [
      "commit",
      "-q",
      "--no-verify",
      "-m",
      args.message,
    ]);
    const head = await git(ctx.workspace, ["rev-parse", "--short", "HEAD"]);
    return {
      committed: true,
      head: head.stdout.trim(),
      message: args.message,
    };
  },
};
