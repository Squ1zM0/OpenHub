/**
 * Browserless.io session management.
 *
 * Endpoints used:
 *   POST /session?token=...    → create a session
 *   CDP connect URL            → consumed by playwright.chromium.connectOverCDP
 *   DELETE stop URL            → release early (TTL is the backstop)
 *
 * Live view: the session-creation response does NOT include a live URL.
 * Live URLs are minted over CDP via the `Browserless.liveURL` command after
 * a client connects. `connect.ts` handles that.
 */

export interface BrowserlessSession {
  id: string;
  connectUrl: string;
  stopUrl: string;
}

export interface CreateSessionOptions {
  token: string;
  baseUrl?: string;
  ttlMs?: number;
  stealth?: boolean;
  debug?: boolean;
}

function normalizeBase(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export async function createBrowserlessSession(
  opts: CreateSessionOptions,
): Promise<BrowserlessSession> {
  const base = normalizeBase(
    opts.baseUrl ?? "https://production-sfo.browserless.io",
  );
  const ttl = opts.ttlMs ?? 120_000;
  const url = `${base}/session?token=${encodeURIComponent(opts.token)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ttl,
      stealth: opts.stealth ?? true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `browserless session create failed: ${res.status} ${res.statusText} ${body}`,
    );
  }

  const json = (await res.json()) as {
    id?: string;
    connect?: string;
    stop?: string;
  };

  if (!json.id || !json.connect) {
    throw new Error(
      `browserless session response missing id/connect: ${JSON.stringify(json)}`,
    );
  }

  if (opts.debug) {
    console.log(`[browserless] session created: ${json.id}`);
  }

  return {
    id: json.id,
    connectUrl: json.connect,
    stopUrl:
      json.stop ??
      `${base}/session/${json.id}?token=${encodeURIComponent(opts.token)}`,
  };
}

export async function stopBrowserlessSession(
  stopUrl: string,
  debug?: boolean,
): Promise<void> {
  try {
    await fetch(stopUrl, { method: "DELETE" });
    if (debug) console.log(`[browserless] session stopped`);
  } catch (e) {
    if (debug) {
      console.warn(`[browserless] stop failed: ${(e as Error).message}`);
    }
  }
}
