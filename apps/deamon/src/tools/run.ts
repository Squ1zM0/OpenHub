import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Tool } from "./types.js";
import { safeResolve } from "./path.js";

const exec = promisify(execFile);

const Input = z.object({
  command: z.string().min(1),
  cwd: z.string().default("."),
  timeout_ms: z.number().int().positive().max(300_000).default(30_000),
});

/**
 * First-token allowlist. Anything not here is refused before execution.
 * Conservative by design — expand as needed.
 */
const ALLOW = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "find", "grep", "rg",
  "git", "node", "npx", "pnpm", "npm", "yarn", "bun", "tsx",
  "mkdir", "cp", "mv", "touch", "echo", "which", "env",
]);

/**
 * Dangerous two-token prefixes — denied even when the first token is
 * allowlisted. Matched exactly against the first two tokens.
 */
const DENY_PREFIXES = new Set([
  "git push",
  "git remote",
  "git fetch",
  "git pull",
  "git clone",
  "git reset",
  "git rebase",
  "git filter-branch",
  "npm publish",
  "pnpm publish",
  "yarn publish",
  "npm login",
  "pnpm login",
  "npm config",
  "pnpm config",
  "yarn config",
]);

const MAX_STREAM_BYTES = 200_000;

/**
 * Minimal shell-style tokenizer. Handles single quotes, double quotes, and
 * backslash escapes. Never interprets `;`, `|`, `&`, `$()`, or backticks —
 * those are just literal characters in tokens. This is what makes execFile
 * (no shell) safe to combine with a string command input.
 */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let esc = false;

  for (const ch of cmd) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (quote) throw new Error("unterminated quote in command");
  if (cur) out.push(cur);
  return out;
}

function truncateStream(s: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= MAX_STREAM_BYTES) return { text: s, truncated: false };
  return {
    text: Buffer.from(s, "utf8").subarray(0, MAX_STREAM_BYTES).toString("utf8"),
    truncated: true,
  };
}

export const runTool: Tool<z.infer<typeof Input>> = {
  name: "run",
  description:
    "Execute an allowlisted command inside the session workspace. No shell — arguments are passed directly to the executable.",
  input: Input,
  async execute(args, ctx) {
    const tokens = tokenize(args.command);
    if (tokens.length === 0) throw new Error("empty command");

    const bin = tokens[0]!;
    if (!ALLOW.has(bin)) {
      throw new Error(
        `command not allowlisted: ${bin}. Allowed: ${[...ALLOW].sort().join(", ")}`,
      );
    }

    if (tokens.length >= 2) {
      const prefix = `${tokens[0]} ${tokens[1]}`;
      if (DENY_PREFIXES.has(prefix)) {
        throw new Error(`command denied: ${prefix}`);
      }
    }

    const cwd = safeResolve(ctx.workspace, args.cwd);
    const started = Date.now();

    try {
      const { stdout, stderr } = await exec(bin, tokens.slice(1), {
        cwd,
        timeout: args.timeout_ms,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          CI: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });

      const so = truncateStream(stdout);
      const se = truncateStream(stderr);
      return {
        command: args.command,
        cwd: args.cwd,
        exit_code: 0,
        stdout: so.text,
        stderr: se.text,
        truncated: { stdout: so.truncated, stderr: se.truncated },
        duration_ms: Date.now() - started,
        timed_out: false,
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };

      const so = truncateStream(err.stdout ?? "");
      const se = truncateStream(err.stderr ?? err.message);
      const timedOut =
        err.killed === true ||
        err.signal === "SIGTERM" ||
        err.signal === "SIGKILL";

      return {
        command: args.command,
        cwd: args.cwd,
        exit_code: typeof err.code === "number" ? err.code : -1,
        stdout: so.text,
        stderr: se.text,
        truncated: { stdout: so.truncated, stderr: se.truncated },
        duration_ms: Date.now() - started,
        timed_out: timedOut,
      };
    }
  },
};
