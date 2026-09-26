import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PlaywrightCookie } from "./types";
import type { DeepSeekSelectors } from "./types";

/**
 * Encrypted credential blob. Cookies give full account access — they never
 * leave the server unencrypted, and never land in logs.
 *
 * AES-256-GCM. Key from DEEPSEEK_CREDENTIAL_KEY, 32 bytes hex. Rotate by
 * re-running the connect flow.
 */
export interface StoredCredentials {
  /** Schema version, for future migrations. */
  v: 1;
  /** ISO timestamp of when the user completed login. */
  connected_at: string;
  /** DeepSeek account email or handle, if we can scrape it. Best-effort. */
  account_hint?: string;
  /** Encrypted JSON of { cookies, selectors }. */
  ciphertext: string;
  /** Initialization vector, base64. */
  iv: string;
  /** Auth tag, base64. */
  tag: string;
}

export interface CredentialPayload {
  cookies: PlaywrightCookie[];
  selectors: DeepSeekSelectors;
}

function keyFromHex(hex: string): Buffer {
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error(
      `DEEPSEEK_CREDENTIAL_KEY must be 32 bytes (64 hex chars), got ${buf.length} bytes. ` +
        `Generate with: openssl rand -hex 32`,
    );
  }
  return buf;
}

export function encryptCredentials(
  payload: CredentialPayload,
  keyHex: string,
): StoredCredentials {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(payload);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    connected_at: new Date().toISOString(),
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptCredentials(
  stored: StoredCredentials,
  keyHex: string,
): CredentialPayload {
  const key = keyFromHex(keyHex);
  const iv = Buffer.from(stored.iv, "base64");
  const tag = Buffer.from(stored.tag, "base64");
  const ct = Buffer.from(stored.ciphertext, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as CredentialPayload;
}
