import { InMemoryStore, type SessionStore } from "./store.js";

const g = globalThis as unknown as { __openhub_store?: SessionStore };

export function getStore(): SessionStore {
  if (!g.__openhub_store) {
    g.__openhub_store = new InMemoryStore();
  }
  return g.__openhub_store;
}
