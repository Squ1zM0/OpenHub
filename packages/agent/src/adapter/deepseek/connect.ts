import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright-core";
import { createBrowserlessSession, stopBrowserlessSession } from "./browserless";
import { discoverSelectors } from "./discovery";
import { encryptCredentials } from "./credentials";
import type {
  ConnectStore,
  CredentialStore,
  PendingConnect,
} from "./store";
import type { DeepSeekAdapterConfig, PlaywrightCookie } from "./types";

const DEEPSEEK_URL = "https://chat.deepseek.com/";
const CONNECT_TTL_MS = 10 * 60 * 1000;

export interface ConnectConfig {
  browserlessToken: string;
  browserlessUrl: string;
  credentialKeyHex: string;
  debug?: boolean;
}

export interface StartConnectResult {
  connectId: string;
  /** Embed this in an iframe or open in a new tab. */
  liveUrl: string;
  expiresAt: number;
}

/**
 * Start a connect flow. Creates a Browserless session with live view enabled
 * and returns the URL the user opens to log in.
 */
export async function startConnect(
  cfg: ConnectConfig,
  connectStore: ConnectStore,
  userId: string,
): Promise<StartConnectResult> {
  const session = await createBrowserlessSession({
    token: cfg.browserlessToken,
    baseUrl: cfg.browserlessUrl,
    ttlMs: CONNECT_TTL_MS,
    debug: cfg.debug,
    // Request live view. Browserless returns liveURL when this is set.
    live: true,
    // DeepSeek challenges common datacenter IPs. stealth helps against the
    // easy challenges; if 2FA or CAPTCHA appears, the user solves it in the
    // live view like they would anywhere else.
    stealth: true,
  });

  if (!session.liveUrl) {
    // Clean up before throwing — we don't want an orphaned session.
    await stopBrowserlessSession(session.stopUrl, cfg.debug);
    throw new Error(
      "Browserless did not return a live view URL. The connect flow requires " +
        "live view. Check that your Browserless plan supports it.",
    );
  }

  const connectId = randomUUID();
  const pending: PendingConnect = {
    connect_id: connectId,
    user_id: userId,
    session_id: session.id,
    connect_url: session.connectUrl,
    stop_url: session.stopUrl,
    live_url: session.liveUrl,
    expires_at: Date.now() + CONNECT_TTL_MS,
    created_at: new Date().toISOString(),
  };

  await connectStore.put(pending, CONNECT_TTL_MS);

  if (cfg.debug) {
    console.log(`[deepseek.connect] started ${connectId} session=${session.id}`);
  }

  return {
    connectId,
    liveUrl: session.liveUrl,
    expiresAt: pending.expires_at,
  };
}

export type ConnectStatus =
  | { status: "pending"; liveUrl: string; expiresAt: number; message: string }
  | { status: "connected"; accountHint?: string; verified: string[] }
  | { status: "failed"; error: string }
  | { status: "expired" }
  | { status: "not_found" };

/**
 * Poll a connect flow. Called by the dashboard every couple of seconds.
 *
 * Not idempotent in the "connected" case — once we see login, we capture
 * credentials, store them, and close the session. A subsequent poll of the
 * same connectId returns "not_found" because we deleted the pending record.
 */
export async function pollConnect(
  connectId: string,
  cfg: ConnectConfig,
  connectStore: ConnectStore,
  credentialStore: CredentialStore,
): Promise<ConnectStatus> {
  const pending = await connectStore.get(connectId);
  if (!pending) return { status: "not_found" };

  if (pending.expires_at < Date.now()) {
    await stopBrowserlessSession(pending.stop_url, cfg.debug);
    await connectStore.delete(connectId);
    return { status: "expired" };
  }

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.connectOverCDP(pending.connect_url);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    page = context.pages()[0] ?? (await context.newPage());

    // Navigate on the first poll if we're not on DeepSeek yet.
    if (!page.url().startsWith(DEEPSEEK_URL)) {
      await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
    }

    // Login detection: the chat input is only rendered when authenticated.
    // We probe the *defaults* here — the point of this flow is to discover
    // the real selectors once login succeeds.
    const loggedIn = await detectLoggedIn(page);
    if (!loggedIn) {
      await browser.close();
      return {
        status: "pending",
        liveUrl: pending.live_url,
        expiresAt: pending.expires_at,
        message: "Waiting for login...",
      };
    }

    // Logged in. Capture everything.
    const cookies = await context.cookies();
    const accountHint = await scrapeAccountHint(page).catch(() => undefined);

    const discovery = await discoverSelectors(page);

    const stored = encryptCredentials(
      {
        cookies: cookies as PlaywrightCookie[],
        selectors: discovery.selectors,
      },
      cfg.credentialKeyHex,
    );
    if (accountHint) stored.account_hint = accountHint;

    await credentialStore.put(pending.user_id, stored);

    // Release resources. Order matters: browser first, then session.
    await browser.close();
    browser = null;
    await stopBrowserlessSession(pending.stop_url, cfg.debug);
    await connectStore.delete(connectId);

    if (cfg.debug) {
      console.log(
        `[deepseek.connect] ${connectId} connected user=${pending.user_id} ` +
          `verified=[${discovery.verified.join(",")}] ` +
          `probe=${JSON.stringify(discovery.probe)}`,
      );
    }

    return {
      status: "connected",
      accountHint,
      verified: discovery.verified,
    };
  } catch (e) {
    // Best-effort cleanup on unexpected errors.
    if (browser) await browser.close().catch(() => {});
    await connectStore.delete(connectId);
    await stopBrowserlessSession(pending.stop_url, cfg.debug).catch(() => {});
    return { status: "failed", error: (e as Error).message };
  }
}

export async function cancelConnect(
  connectId: string,
  connectStore: ConnectStore,
  debug = false,
): Promise<{ cancelled: boolean }> {
  const pending = await connectStore.get(connectId);
  if (!pending) return { cancelled: false };
  await stopBrowserlessSession(pending.stop_url, debug);
  await connectStore.delete(connectId);
  return { cancelled: true };
}

/**
 * Is the user logged in? Probe a small set of very likely indicators.
 * We don't use the stored selectors here because we don't have them yet —
 * this is the flow that discovers them.
 */
async function detectLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  // Login page is typically /sign_in or /login; the chat is at / or /chat.
  if (url.includes("/sign_in") || url.includes("/login")) return false;

  const candidates = [
    "textarea",
    "div[contenteditable='true']",
    "[role='textbox']",
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 500 })) return true;
    } catch {
      // try next
    }
  }
  return false;
}

/**
 * Best-effort scrape of the logged-in account identifier. Never fails the
 * connect — if we can't find it, we proceed without an account hint.
 */
async function scrapeAccountHint(page: Page): Promise<string | undefined> {
  const candidates = [
    "[data-testid*='user' i] [aria-label]",
    "[class*='avatar' i]",
    "header [aria-label*='account' i]",
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 })) {
        const label = await el.getAttribute("aria-label");
        if (label && label.length < 120) return label;
      }
    } catch {
      // try next
    }
  }
  return undefined;
}

/**
 * Build the config object the adapter expects, from stored credentials.
 * Used by the adapter's factory when a user has completed the connect flow.
 */
export function buildAdapterConfigFromStored(
  stored: { ciphertext: string; iv: string; tag: string; v: 1; connected_at: string },
  decrypted: DeepSeekAdapterConfig extends never ? never : {
    cookies: PlaywrightCookie[];
    selectors: DeepSeekAdapterConfig["selectors"] extends infer S ? S : never;
  },
  cfg: { browserlessToken: string; browserlessUrl: string; debug?: boolean },
): DeepSeekAdapterConfig {
  return {
    browserlessToken: cfg.browserlessToken,
    browserlessUrl: cfg.browserlessUrl,
    cookies: decrypted.cookies,
    selectors: decrypted.selectors,
    debug: cfg.debug,
  };
}
