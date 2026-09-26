import { readGitHubEnv, getApp } from "@openhub/github";

export const runtime = "nodejs";

/**
 * GitHub App user OAuth callback.
 *
 * GitHub redirects here after a user authorizes the App. The `code` is
 * exchanged for a user-to-server token, which we persist (later — needs a
 * real store). The `installation_id` query param tells us which installation
 * the user selected; that's what we actually care about for repo access.
 *
 * v1 is a stub: it validates the params and redirects back to the dashboard
 * with a marker in the URL. Persisting user→installation mappings requires
 * the KV store (tracked in README Open Questions).
 */
export async function GET(req: Request): Promise<Response> {
  const env = readGitHubEnv();
  const url = new URL(req.url);

  const code = url.searchParams.get("code");
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");

  if (!code) {
    return new Response("missing code", { status: 400 });
  }

  // The App instance is created to prove the env is wired correctly. Once
  // the KV store lands, this route will use `getApp(env).oauth` to exchange
  // the code and persist the token.
  void getApp(env);

  console.log(
    `github callback: installation=${installationId ?? "-"} state=${state ?? "-"}`,
  );

  return Response.redirect(`${url.origin}/?github=connected`, 302);
}
