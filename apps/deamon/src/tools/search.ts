import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { z } from "zod";
import type { Tool } from "./types";
import { safeResolve } from "./path";

const Input = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  max_results: z.number().int().positive().max(1000).default(200),
  max_file_bytes: z
    .number()
    .int()
    .positive()
    .max(5_000_000)
    .default(1_000_000),
});

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  ".turbo",
  ".cache",
]);

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".txt", ".yml", ".yaml", ".toml",
  ".css", ".html", ".sql", ".sh",
]);

interface Match {
  path: string;
  line: number;
  text: string;
}

export const searchTool: Tool<z.infer<typeof Input>> = {
  name: "search",
  description: "Regex-search text files in the workspace.",
  input: Input,
  async execute(args, ctx) {
    const root = safeResolve(ctx.workspace, args.path);
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch (e) {
      throw new Error(`invalid regex: ${(e as Error).message}`);
    }

    const matches: Match[] = [];
    let truncated = false;

    async function walk(dir: string): Promise<void> {
      if (truncated) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (truncated) return;
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name)) continue;
          await walk(join(dir, e.name));
        } else if (e.isFile()) {
          const ext = extname(e.name).toLowerCase();
          if (!TEXT_EXTS.has(ext) && !e.name.startsWith(".")) continue;
          const full = join(dir, e.name);
          const s = await stat(full);
          if (s.size > args.max_file_bytes) continue;
          let content: string;
          try {
            content = await readFile(full, "utf8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (re.test(line)) {
              if (matches.length >= args.max_results) {
                truncated = true;
                return;
              }
              matches.push({
                path: full.slice(ctx.workspace.length + 1),
                line: i + 1,
                text: line.length > 300 ? line.slice(0, 300) + "…" : line,
              });
            }
          }
        }
      }
    }

    await walk(root);
    return { matches, truncated };
  },
};
