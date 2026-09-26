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
 *
 * Proxy: DeepSeek's CloudFront WAF blocks datacenter IP ranges. Routing
 * through Browserless's built-in proxy presents a different egress IP.
 * Proxy config is read once at session creation and cannot be changed
 * mid-session.
 */

export interface BrowserlessSession {
  id: string;
  connectUrl: string;
  stopUrl: string;
}

export interface ProxyConfig {
  /** "residential" is more reliable against bot detection; "datacenter" is cheaper. */
  type: "residential" | "datacenter";
  /** Keep the same exit IP for the full session. Required for login flows. */
  sticky?: boolean;
  /** Two-letter country code, e.g. "us". */
  country?: string;
  /** Match browser locale to the proxy country. */
  localeMatch?: boolean;
}

export interface CreateSessionOptions {
  token: string;
  baseUrl?: string;
  ttlMs?: number;
  stealth?: boolean;
  /**
   * Browser engine. "stealth" uses Brave with advanced anti-detection —
   * worth trying when a plain Chromium session gets blocked.
   */
  browser?: "chrome" | "chromium" | "stealth";
  proxy?: ProxyConfig;
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

  const body: Record<string, unknown> = {
    ttl,
    stealth: opts.stealth ?? true,
  };

  if (opts.browser) body.browser = opts.browser;

  if (opts.proxy) {
    body.proxy = {
      type: opts.proxy.type,
      sticky: opts.proxy.sticky ?? true,
      ...(opts.proxy.country ? { country: opts.proxy.country } : {}),
      ...(opts.proxy.localeMatch ? { localeMatch: true } : {}),
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `browserless session create failed: ${res.status} ${res.statusText} ${text}`,
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
    console.log(
      `[browserless] session created: ${json.id}` +
        (opts.proxy ? ` proxy=${opts.proxy.type}` : ""),
    );
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
