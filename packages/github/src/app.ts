import { App } from "@octokit/app";
import type { GitHubEnv } from "./config.js";

/**
 * The App instance is the root of every GitHub operation. It holds the App
 * private key and webhook secret, and it mints installation tokens on demand.
 *
 * `@octokit/app` caches installation tokens internally (in an LRU keyed by
 * installation id, expiring ~1 minute before GitHub's 60-minute lifetime).
 * In a long-lived server that cache is a real win. In a serverless function
 * every cold start loses it — see the README Open Questions.
 *
 * The private key must be PKCS#8 (the format GitHub serves). If you're
 * loading a PKCS#1 key from a PEM file, convert it:
 *   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key.pkcs8
 */
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
