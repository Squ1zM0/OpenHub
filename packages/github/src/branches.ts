import type { Octokit } from "@octokit/core";

export async function getDefaultBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

export async function getBranchSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const { data } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  return data.object.sha;
}

/**
 * Create a branch pointing at `fromSha`. Idempotent — if the branch already
 * exists, this is a no-op rather than an error.
 */
export async function ensureBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  fromSha: string,
): Promise<{ created: boolean; sha: string }> {
  try {
    const existing = await getBranchSha(octokit, owner, repo, branch);
    return { created: false, sha: existing };
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }

  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: fromSha,
  });
  return { created: true, sha: fromSha };
}

/**
 * Branch names are constrained by git. Slashes are allowed (and common:
 * `feature/foo`, `openhub/task-abc`). Leading/trailing slashes and `..`
 * are not. This is a conservative sanity check, not a full git refname
 * validator — GitHub will reject anything truly invalid.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.includes("..")) return false;
  if (name.includes("//")) return false;
  if (/[\s~^:?*\[\\]/.test(name)) return false;
  if (name.endsWith(".lock")) return false;
  return true;
}
