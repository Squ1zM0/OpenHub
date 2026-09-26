import { z } from "zod";
import type { Tool } from "./types";
import { git } from "../git";
import { safeResolve } from "./path";
import { relative } from "node:path";

const Input = z.object({
  path: z.string().min(1),
  ref: z.string().default("HEAD"),
});

/**
 * Revert a file to a prior state. Defaults to HEAD (the most recent
 * checkpoint), which is what "undo the last edit" means in practice.
 */
export const gitRestoreTool: Tool<z.infer<typeof Input>> = {
  name: "git_restore",
  description:
    "Restore a file in the workspace to its state at <ref> (default HEAD, i.e. the last checkpoint).",
  input: Input,
  async execute(args, ctx) {
    const abs = safeResolve(ctx.workspace, args.path);
    const rel = relative(ctx.workspace, abs) || ".";

    // Ensure ref exists. rev-parse --verify fails cleanly for unknown refs.
    const verify = await git(
      ctx.workspace,
      ["rev-parse", "--verify", `${args.ref}^{commit}`],
      { allowFail: true },
    );
    if (!verify.ok) {
      throw new Error(`unknown ref: ${args.ref}`);
    }

    const res = await git(
      ctx.workspace,
      ["restore", `--source=${args.ref}`, "--worktree", "--", rel],
      { allowFail: true },
    );

    if (!res.ok) {
      throw new Error(
        `could not restore ${rel} from ${args.ref}: ${res.stderr.trim()}. ` +
          `If the file is untracked at that ref, there is nothing to restore to.`,
      );
    }

    const head = await git(ctx.workspace, ["rev-parse", "--short", "HEAD"]);
    return { path: args.path, ref: args.ref, head: head.stdout.trim() };
  },
};
