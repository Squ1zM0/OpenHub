import type { InstallationOctokit } from "./app";

export interface FileChange {
  path: string;
  /** UTF-8 content. Omitted for deletions. */
  content?: string;
  encoding?: "utf-8" | "base64";
  mode?: "100644" | "100755" | "120000";
  /** If true, removes the file at `path`. `content` is ignored. */
  deleted?: boolean;
}

export interface CommitResult {
  commitSha: string;
  treeSha: string;
  parentSha: string;
}

/**
 * Commit a set of file changes to a branch in one operation.
 *
 * This is the Git Data API path (blob → tree → commit → ref), not the
 * Contents API. The Contents API is simpler but doesn't support atomic
 * multi-file commits and creates one commit per file. The Git Data API
 * gives us a single, reviewable commit with a correct parent.
 *
 * `parentSha` defaults to the current head of `branch`. Pass it explicitly
 * when you want to commit on top of a specific point (e.g. a branch you
 * just created from another branch).
 */
export async function commitFiles(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  branch: string,
  files: FileChange[],
  message: string,
  parentSha?: string,
): Promise<CommitResult> {
  if (files.length === 0) {
    throw new Error("commitFiles called with no files");
  }

  // Resolve the parent commit. If caller didn't provide one, use the
  // current head of the branch.
  const parent =
    parentSha ??
    (
      await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      })
    ).data.object.sha;

  const { data: parentCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: parent,
  });
  const baseTreeSha = parentCommit.tree.sha;

  // 1. Create a blob for every file. Deletions skip this step.
  const treeEntries = await Promise.all(
    files.map(async (file) => {
      if (file.deleted) {
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: null,
        };
      }
      if (file.content === undefined) {
        throw new Error(`file ${file.path} has no content and is not marked deleted`);
      }
      const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: file.encoding ?? "utf-8",
      });
      return {
        path: file.path,
        mode: file.mode ?? ("100644" as const),
        type: "blob" as const,
        sha: blob.sha,
      };
    }),
  );

  // 2. Create a tree on top of the parent tree.
  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  // 3. Create the commit.
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [parent],
  });

  // 4. Move the branch pointer. Fast-forward by construction — the new
  //    commit's parent is the branch's current head.
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
  });

  return {
    commitSha: newCommit.sha,
    treeSha: newTree.sha,
    parentSha: parent,
  };
}
