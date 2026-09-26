import type { Octokit } from "@octokit/app";

export interface OpenPullRequestOptions {
  owner: string;
  repo: string;
  title: string;
  body: string;
  /** Source branch — the one containing the changes. */
  head: string;
  /** Target branch — usually the default branch. */
  base: string;
  draft?: boolean;
}

export interface PullRequestRef {
  number: number;
  url: string;
  head: string;
  base: string;
  draft: boolean;
}

export async function openPullRequest(
  octokit: Octokit,
  opts: OpenPullRequestOptions,
): Promise<PullRequestRef> {
  const { data } = await octokit.rest.pulls.create({
    owner: opts.owner,
    repo: opts.repo,
    title: opts.title,
    body: opts.body,
    head: opts.head,
    base: opts.base,
    draft: opts.draft ?? false,
  });

  return {
    number: data.number,
    url: data.html_url,
    head: data.head.ref,
    base: data.base.ref,
    draft: data.draft ?? false,
  };
}

/**
 * Find an existing open PR for a head/base pair. Used by the workflow to
 * avoid opening a duplicate when a task is retried.
 */
export async function findOpenPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<PullRequestRef | null> {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    head: `${owner}:${head}`,
    base,
    per_page: 1,
  });
  const pr = data[0];
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.html_url,
    head: pr.head.ref,
    base: pr.base.ref,
    draft: pr.draft ?? false,
  };
}
