import { verify } from "@openhub/protocol";

/**
 * v1 simplification: the daemon's bearer token is also used as the HMAC
 * signing key. In production these should be distinct — a per-session auth
 * token and a per-user signing key — so that a leaked auth token can't be
 * used to forge result payloads. Noted in README Open Questions.
 */
function getToken(): string | null {
  return process.env.OPENHUB_DAEMON_TOKEN ?? null;
}

/** Constant-time comparison, safe for short strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function checkBearer(req: Request): boolean {
  const token = getToken();
  if (!token) return false;
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  return safeEqual(auth, `Bearer ${token}`);
}

export function verifySignature(body: unknown, signature: string): boolean {
  const token = getToken();
  if (!token || !signature) return false;
  return verify(body, signature, token);
}
