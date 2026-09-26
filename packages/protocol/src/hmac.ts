import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Canonical JSON serialization — sorted keys, no whitespace.
 * Both sides must serialize identically or HMACs will not match.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]));
  return "{" + pairs.join(",") + "}";
}

export function sign(payload: unknown, secret: string): string {
  return createHmac("sha256", secret)
    .update(canonicalize(payload))
    .digest("hex");
}

export function verify(
  payload: unknown,
  signature: string,
  secret: string,
): boolean {
  const expected = sign(payload, secret);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
