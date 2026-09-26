import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  createBrowserlessSession,
  stopBrowserlessSession,
} from "./browserless";
import { discoverSelectors } from "./discovery";
import { encryptCredentials } from "./credentials";
import type {
  ConnectStore,
  CredentialStore,
  PendingConnect,
} from "./store";
import type { DeepSeekAdapterConfig, PlaywrightCookie } from "./types";

const DEEPSEEK_URL = "https://chat.deepseek.com/";

/**
 * Free-tier Browserless caps session duration at 120,000 ms. We set both
 * the session TTL and the live URL timeout to that ceiling. When the user
 * needs longer to log in, the poll route re-mints the live URL.
 *
 * On a paid plan, raise both to whatever the plan allows.
 */
const MAX_SESSION_MS = 120_000;

export interface ConnectConfig {
  browserlessToken: string;
  browserlessUrl: string;
  credentialKeyHex: string;
  /** Session lifetime in ms. Capped at MAX_SESSION_MS by the Browserless plan. */
  sessionTtlMs?: number;
  debug?: boolean;
}

export interface StartConnectResult {
  connectId: string;
  liveUrl: string;
  expiresAt: number;
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
    debug: cfg.debug,
  });

  let browser: Browser | null = null;

  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });

    const liveUrl = await mintLiveUrl(page, ttl, cfg.debug);

    const connectId = randomUUID();
    const pending: PendingConnect = {
      connect_id: connectId,
      user_id: userId,
      session_id: session.id,
      connect_url: session.connectUrl,
      stop_url: session.stopUrl,
      live_url: liveUrl,
      expires_at: Date.now() + ttl,
      created_at: new Date().toISOString(),
    };

    await connectStore.put(pending, ttl);

    if (cfg.debug) {
      console.log(
        `[deepseek.connect] started ${connectId} session=${session.id} ttl=${ttl}ms`,
      );
    }

    return {
      connectId,
      liveUrl,
      expiresAt: pending.expires_at,
    };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    await stopBrowserlessSession(session.stopUrl, cfg.debug);
    throw e;
  }
  // Browser is intentionally left open — the poll route reconnects using
  // the same CDP URL to check login state.
}

async function mintLiveUrl(
  page: Page,
  timeoutMs: number,
  debug?: boolean,
): Promise<string> {
  const cdp = await page.context().newCDPSession(page);

  const result = (await cdp.send("Browserless.liveURL" as never, {
    timeout: Math.min(timeoutMs, MAX_SESSION_MS),
    interactable: true,
    resizable: true,
    quality: 70,
  } as never)) as { liveURL?: string; error?: string | null };

  if (result.error) {
    throw new Error(`browserless liveURL failed: ${result.error}`);
  }
  if (!result.liveURL) {
    throw new Error(
      "browserless liveURL returned no URL. Check that your plan supports " +
        "live view and that the token is valid.",
    );
  }

  if (debug) {
    console.log(`[deepseek.connect] live URL minted`);
  }

  return result.liveURL;
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
 * If the live URL has less than 30 seconds of life left and the user still
 * hasn't logged in, we mint a fresh one. That's what makes the free-tier
 * 2-minute cap workable — the page gets a new stream instead of dying.
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

  try {
    browser = await chromium.connectOverCDP(pending.connect_url);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    if (!page.url().startsWith(DEEPSEEK_URL)) {
      await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
    }

    const loggedIn = await detectLoggedIn(page);

    // Re-mint the live URL if it's about to die. Keeps the iframe alive
    // past the free-tier 120s cap so slow logins still complete.
    const remaining = pending.expires_at - Date.now();
    let liveUrl = pending.live_url;
    if (!loggedIn && remaining < 30_000) {
      try {
        liveUrl = await mintLiveUrl(page, MAX_SESSION_MS, cfg.debug);
      } catch {
        // If re-minting fails, the old URL keeps working until it expires.
      }
    }

    if (!loggedIn) {
      await browser.close();
      return {
        status: "pending",
        liveUrl,
        expiresAt: pending.expires_at,
        message: "Waiting for login...",
      };
    }

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

async function detectLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
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
