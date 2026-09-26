import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool } from "./types.js";
import { safeResolve } from "./path.js";

const Input = z.object({
  path: z.string().default("."),
  depth: z.number().int().min(1).max(6).default(1),
  max_entries: z.number().int().positive().max(10_000).default(2_000),
});

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  ".turbo",
  ".cache",
]);

interface Entry {
  path: string;
  type: "file" | "dir";
  size?: number;
}

export const listDirTool: Tool<z.infer<typeof Input>> = {
  name: "list_dir",
  description: "List files and directories inside the workspace, up to a depth.",
  input: Input,
  async execute(args, ctx) {
    const root = safeResolve(ctx.workspace, args.path);
    const out: Entry[] = [];
    let truncated = false;

    async function walk(dir: string, depth: number): Promise<void> {
      if (truncated || depth < 1) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        if (out.length >= args.max_entries) {
          truncated = true;
          return;
        }
        const full = join(dir, e.name);
        const rel = full.slice(root.length + 1) || ".";
        if (e.isDirectory()) {
          out.push({ path: rel, type: "dir" });
          await walk(full, depth - 1);
        } else if (e.isFile()) {
          const s = await stat(full);
          out.push({ path: rel, type: "file", size: s.size });
        }
      }
    }

    await walk(root, args.depth);
    return {
      root: root === ctx.workspace ? "." : root.slice(ctx.workspace.length + 1),
      entries: out,
      truncated,
    };
  },
};
