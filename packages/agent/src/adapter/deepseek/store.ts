import type { StoredCredentials } from "./credentials.js";

/**
 * Where encrypted DeepSeek credentials live, keyed by user id.
 *
 * Single-user v1 means there's effectively one key ("default"). Multi-user
 * later means one entry per authenticated user id.
 *
 * The agent package doesn't import a storage backend — the web app supplies
 * the implementation (Vercel KV in production, in-memory in dev).
 */
export interface CredentialStore {
  get(userId: string): Promise<StoredCredentials | null>;
  put(userId: string, creds: StoredCredentials): Promise<void>;
  delete(userId: string): Promise<void>;
}

export const DEFAULT_USER_ID = "default";

/**
 * In-memory implementation, for local dev where everything runs in one
 * process. Credentials are lost on restart — reconnect.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private data = new Map<string, StoredCredentials>();

  async get(userId: string): Promise<StoredCredentials | null> {
    return this.data.get(userId) ?? null;
  }

  async put(userId: string, creds: StoredCredentials): Promise<void> {
    this.data.set(userId, creds);
  }

  async delete(userId: string): Promise<void> {
    this.data.delete(userId);
  }
}

/**
 * Pending connect flows. A connect flow is a short-lived (10 min) record of
 * a Browserless session the user is logging into. We need it to survive
 * between the start request and the polling requests.
 */
export interface PendingConnect {
  connect_id: string;
  user_id: string;
  /** Browserless session id. */
  session_id: string;
  /** CDP connect URL — server-side only. Never sent to the client. */
  connect_url: string;
  /** Stop URL — used to close the session when done. */
  stop_url: string;
  /** Live view URL — embedded in the dashboard's iframe. */
  live_url: string;
  /** Unix ms. Reaper closes the session past this. */
  expires_at: number;
  created_at: string;
}

export interface ConnectStore {
  get(connectId: string): Promise<PendingConnect | null>;
  put(pending: PendingConnect, ttlMs: number): Promise<void>;
  delete(connectId: string): Promise<void>;
}

export class InMemoryConnectStore implements ConnectStore {
  private data = new Map<string, { pending: PendingConnect; expires: number }>();

  async get(connectId: string): Promise<PendingConnect | null> {
    const entry = this.data.get(connectId);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      this.data.delete(connectId);
      return null;
    }
    return entry.pending;
  }

  async put(pending: PendingConnect, ttlMs: number): Promise<void> {
    this.data.set(pending.connect_id, {
      pending,
      expires: Date.now() + ttlMs,
    });
  }

  async delete(connectId: string): Promise<void> {
    this.data.delete(connectId);
  }
}
