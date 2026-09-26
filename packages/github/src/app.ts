import { App } from "@octokit/app";
import type { GitHubEnv } from "./config";

/**
 * The type returned by `app.getInstallationOctokit(id)`.
 *
 * `@octokit/app` exports the `App` class but not the composed Octokit type
 * that its installation method returns. That composed type is what carries
 * the `.rest` namespace (REST endpoint methods, pagination, auth). We derive
 * it from the method signature rather than importing from `@octokit/core`,
 * which only gives the bare client without `.rest`.
 */
export type InstallationOctokit = Awaited<
  ReturnType<InstanceType<typeof App>["getInstallationOctokit"]>
>;

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
