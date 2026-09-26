import { InMemoryStore, type SessionStore } from "./store.js";

/**
 * Next.js dev mode re-evaluates modules on hot reload, which would reset a
 * module-level singleton and lose every session. Attaching to globalThis
 * survives the reload.
 *
 * Production note: this must be swapped for a KV-backed implementation.
 * See the comment on SessionStore in store.ts.
 */
const g = globalThis as unknown as { __openhub_store?: SessionStore };

export function getStore(): SessionStore {
  if (!g.__openhub_store) {
    g.__openhub_store = new InMemoryStore();
  }
  return g.__openhub_store;
}
