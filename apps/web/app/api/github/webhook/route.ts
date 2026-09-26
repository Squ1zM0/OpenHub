import { readGitHubEnv, verifyWebhookSignature, readWebhookHeaders } from "@openhub/github";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * GitHub App webhook receiver.
 *
 * The raw text body is critical here — `req.json()` would destroy the exact
 * bytes GitHub signed, and verification would always fail. This is the
 * single most common webhook bug.
 *
 * v1 just verifies and acknowledges. Real handlers (push → re-verify preview,
 * pull_request → update task state) land in the workflow layer.
 */
export async function POST(req: Request): Promise<Response> {
  const env = readGitHubEnv();

  const headers = readWebhookHeaders(req.headers);
  if (!headers) {
    return new Response("missing webhook headers", { status: 400 });
  }

  const rawBody = await req.text();

  if (!verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, headers.signature256)) {
    return new Response("bad signature", { status: 401 });
  }

  let payload: { action?: string; repository?: { full_name?: string } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const repo = payload.repository?.full_name ?? "(unknown)";
  console.log(
    `github webhook: event=${headers.event} action=${payload.action ?? "-"} repo=${repo} delivery=${headers.delivery}`,
  );

  return Response.json({ ok: true, event: headers.event });
}
