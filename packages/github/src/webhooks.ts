import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a GitHub webhook signature.
 *
 * GitHub signs the raw request body with HMAC-SHA256 and sends the hex
 * digest in `X-Hub-Signature-256`, prefixed with `sha256=`. The comparison
 * must be constant-time.
 *
 * The single most common failure is passing the parsed JSON body instead of
 * the raw bytes. Express's `express.json()` and Next's `req.json()` both
 * destroy the exact byte sequence GitHub signed. Always use `req.text()`
 * (Next App Router) or `express.raw({ type: "application/json" })`.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
): boolean {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type GitHubWebhookEvent =
  | "push"
  | "pull_request"
  | "installation"
  | "installation_repositories"
  | "ping"
  | string;

export interface GitHubWebhookHeaders {
  event: GitHubWebhookEvent;
  delivery: string;
  signature256: string;
}

export function readWebhookHeaders(headers: Headers): GitHubWebhookHeaders | null {
  const event = headers.get("x-github-event");
  const delivery = headers.get("x-github-delivery");
  const signature256 = headers.get("x-hub-signature-256");
  if (!event || !delivery || !signature256) return null;
  return { event, delivery, signature256 };
}
