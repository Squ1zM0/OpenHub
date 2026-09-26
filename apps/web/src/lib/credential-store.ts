import {
  InMemoryCredentialStore,
  InMemoryConnectStore,
  type ConnectStore,
  type CredentialStore,
} from "@openhub/agent";

/**
 * Process-wide singletons. In dev everything is in-memory. In production
 * these need a KV-backed implementation — the interface is the seam.
 *
 * Attached to globalThis so Next.js HMR doesn't reset them on every reload.
 */
const g = globalThis as unknown as {
  __openhub_credentials?: CredentialStore;
  __openhub_connects?: ConnectStore;
};

export function getCredentialStore(): CredentialStore {
  if (!g.__openhub_credentials) {
    g.__openhub_credentials = new InMemoryCredentialStore();
  }
  return g.__openhub_credentials;
}

export function getConnectStore(): ConnectStore {
  if (!g.__openhub_connects) {
    g.__openhub_connects = new InMemoryConnectStore();
  }
  return g.__openhub_connects;
}
