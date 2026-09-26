/**
 * Browserless.io session management.
 *
 * Endpoints used:
 *   POST /session?token=...    → create a session (supports live=true)
 *   CDP connect URL            → consumed by playwright.chromium.connectOverCDP
 *   DELETE stop URL            → release early (TTL is the backstop)
 *
 * Live view: when `live: true` is set, the response includes a `liveURL`
 * suitable for embedding in an iframe. This is what lets the user log in
 * through the dashboard instead of exporting cookies manually.
 */

export interface BrowserlessSession {
  id: string;
  connectUrl: string;
  stopUrl: string;
  /** Present when the session was created with live=true. */
  liveUrl?: string;
}

export interface CreateSessionOptions {
  token: string;
  baseUrl?: string;
  ttlMs?: number;
  live?: boolean;
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
  const ttl = opts.ttlMs ?? 10 * 60 * 1000;
  const params = new URLSearchParams({ token: opts.token });
  if (opts.live) params.set("live", "true");

  const url = `${base}/session?${params.toString()}`;
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
    liveURL?: string;
    liveUrl?: string;
  };

  if (!json.id || !json.connect) {
    throw new Error(
      `browserless session response missing id/connect: ${JSON.stringify(json)}`,
    );
  }

  if (opts.debug) {
    console.log(
      `[browserless] session created: ${json.id}${json.liveURL || json.liveUrl ? " (live)" : ""}`,
    );
  }

  return {
    id: json.id,
    connectUrl: json.connect,
    stopUrl:
      json.stop ?? `${base}/session/${json.id}?token=${encodeURIComponent(opts.token)}`,
    liveUrl: json.liveURL ?? json.liveUrl,
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
