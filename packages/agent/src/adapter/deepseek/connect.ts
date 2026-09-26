import {
  createBrowserlessSession,
  stopBrowserlessSession,
  type ProxyConfig,
} from "./browserless";

// ... unchanged imports and constants ...

const DEEPSEEK_URL = "https://chat.deepseek.com/";
const MAX_SESSION_MS = 120_000;
const LIVE_URL_REFRESH_WINDOW_MS = 30_000;

export interface ConnectConfig {
  browserlessToken: string;
  browserlessUrl: string;
  credentialKeyHex: string;
  sessionTtlMs?: number;
  /**
   * Route browser traffic through Browserless's built-in proxy. Required
   * for DeepSeek — CloudFront blocks datacenter IPs outright.
   */
  proxy?: ProxyConfig;
  /**
   * Browser engine. "stealth" (Brave + anti-detection) is worth trying
   * when a plain Chromium session is blocked.
   */
  browser?: "chrome" | "chromium" | "stealth";
  debug?: boolean;
}

export async function startConnect(
  cfg: ConnectConfig,
  connectStore: ConnectStore,
  userId: string,
): Promise<StartConnectResult> {
  const ttl = Math.min(cfg.sessionTtlMs ?? MAX_SESSION_MS, MAX_SESSION_MS);

  const session = await createBrowserlessSession({
    token: cfg.browserlessToken,
    baseUrl: cfg.browserlessUrl,
    ttlMs: ttl,
    stealth: true,
    browser: cfg.browser,
    proxy: cfg.proxy,
    debug: cfg.debug,
  });

  // ... rest unchanged ...
}

// In pollConnect, the second createBrowserlessSession-equivalent call
// doesn't exist — poll reuses pending.connect_url. No change needed there
// for proxy; the proxy was fixed at session creation.
