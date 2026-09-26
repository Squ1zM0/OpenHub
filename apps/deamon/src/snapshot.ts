import { access } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.js";

/**
 * Ensure the session workspace is a git repo. If it already is (e.g. a
 * cloned repo later on), leave it alone.
 *
 * Returns true if we initialized a new repo, false if one already existed.
 */
export async function ensureRepo(workspace: string): Promise<boolean> {
  try {
    await access(join(workspace, ".git"));
    return false;
  } catch {
    // not a repo — fall through and initialize
  }

  await git(workspace, ["init", "-q", "-b", "main"]);
  await git(workspace, ["config", "user.email", "daemon@openhub.local"]);
  await git(workspace, ["config", "user.name", "openhub daemon"]);
  await git(workspace, ["config", "commit.gpgsign", "false"]);
  await git(workspace, ["commit", "--allow-empty", "-q", "-m", "session start"]);
  return true;
}

/**
 * Commit the current working tree as a checkpoint. Called by mutating tools
 * before they write, so the prior state is always one `git_restore` away.
 *
 * Returns the short SHA of the checkpoint, or null if the tree was clean
 * (nothing to snapshot).
 */
export async function checkpoint(
  workspace: string,
  label: string,
): Promise<string | null> {
  const status = await git(workspace, ["status", "--porcelain"]);
  if (!status.stdout.trim()) return null;

  await git(workspace, ["add", "-A"]);
  await git(workspace, [
    "commit",
    "-q",
    "--no-verify",
    "-m",
    `checkpoint: ${label}`,
  ]);
  const head = await git(workspace, ["rev-parse", "--short", "HEAD"]);
  return head.stdout.trim();
}
