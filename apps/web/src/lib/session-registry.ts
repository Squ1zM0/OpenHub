/**
 * Process-wide registry of live Browserless sessions, keyed by user.
 *
 * In-memory only. On Vercel this survives within a single function
 * instance — enough for consecutive turns during a chat session, but not
 * across cold starts. That's acceptable: the worst case is a cold start,
 * which falls back to creating a fresh session. Cookies restore the
 * logged-in state either way.
 *
 * Production upgrade: back this with Vercel KV, keyed by userId, with
 * the connectUrl encrypted at rest (it contains the session token).
 */
export interface LiveSession {
  connectUrl: string;
  stopUrl: string;
  expiresAt: number;
}

class SessionRegistry {
  private map = new Map<string, LiveSession>();

  get(userId: string): LiveSession | null {
    const s = this.map.get(userId);
    if (!s) return null;
    // Treat as expired 10s before the actual TTL, so we never hand a
    // nearly-dead session to a caller.
    if (s.expiresAt - 10_000 < Date.now()) {
      this.map.delete(userId);
      return null;
    }
    return s;
  }

  set(userId: string, s: LiveSession): void {
    this.map.set(userId, s);
  }

  delete(userId: string): void {
    this.map.delete(userId);
  }
}

const g = globalThis as unknown as { __openhub_sessions?: SessionRegistry };

export function getSessionRegistry(): SessionRegistry {
  if (!g.__openhub_sessions) {
    g.__openhub_sessions = new SessionRegistry();
  }
  return g.__openhub_sessions;
}
