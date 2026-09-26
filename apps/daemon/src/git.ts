import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Thin wrapper around the git CLI. Never invokes a shell — args are passed
 * directly to execFile, so paths with spaces and metacharacters are safe.
 */
export async function git(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; allowFail?: boolean } = {},
): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    const { stdout, stderr } = await exec("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (opts.allowFail) {
      return {
        ok: false,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        code: typeof err.code === "number" ? err.code : -1,
      };
    }
    throw new Error(
      `git ${args.join(" ")} failed: ${(err.stderr ?? err.message).trim()}`,
    );
  }
}
