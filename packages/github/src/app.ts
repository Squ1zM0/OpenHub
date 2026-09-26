import { App } from "@octokit/app";
import type { Octokit } from "@octokit/rest";
import type { GitHubEnv } from "./config";

/**
 * The composed Octokit instance — core + REST endpoint methods + pagination
 * + auth. `@octokit/app`'s `getInstallationOctokit` return type is the bare
 * `@octokit/core` Octokit, which lacks `.rest` even though the runtime
 * object has it. We use `@octokit/rest`'s `Octokit` type, which is the
 * properly composed one, and assert at the boundary.
 */
export type InstallationOctokit = Octokit;

export function createApp(env: GitHubEnv): App {
  return new App({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    oauth:
      env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET
        ? {
            clientId: env.GITHUB_APP_CLIENT_ID,
            clientSecret: env.GITHUB_APP_CLIENT_SECRET,
          }
        : undefined,
    webhooks: { secret: env.GITHUB_WEBHOOK_SECRET },
  });
}

let cached: App | null = null;

/**
 * Process-wide singleton. In a serverless environment this is per-instance,
 * not global — noted in the README.
 */
export function getApp(env?: GitHubEnv): App {
  if (!cached) {
    cached = createApp(env ?? (process.env as unknown as GitHubEnv));
  }
  return cached;
}

/**
 * Get an installation-scoped Octokit with the composed type.
 *
 * The `as unknown as` cast is deliberate: `@octokit/app`'s type says the
 * return value lacks `.rest`, but at runtime it has it (the App composes
 * the REST plugin internally). This is the single place we bridge that gap.
 */
export async function getInstallationOctokit(
  app: App,
  installationId: number,
): Promise<InstallationOctokit> {
  const octokit = await app.getInstallationOctokit(installationId);
  return octokit as unknown as InstallationOctokit;
}
