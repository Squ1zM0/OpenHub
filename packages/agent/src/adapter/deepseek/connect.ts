import { randomUUID } from "node:crypto";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import {
  createBrowserlessSession,
  stopBrowserlessSession,
  type ProxyConfig,
} from "./browserless";
import { discoverSelectors } from "./discovery";
import { encryptCredentials } from "./credentials";
import type { ConnectStore, CredentialStore, PendingConnect } from "./store";
import type { DeepSeekAdapterConfig, PlaywrightCookie } from "./types";

const DEEPSEEK_URL = "https://chat.deepseek.com/";
const MAX_SESSION_MS = 120_000;
const LIVE_URL_REFRESH_WINDOW_MS = 30_000;

export interface ConnectConfig {
  browserlessToken: string;
  browserlessUrl: string;
  credentialKeyHex: string;
  sessionTtlMs?: number;
  /**
   * Route the browser's traffic through Browserless's built-in proxy.
   * Required for DeepSeek — its CloudFront WAF blocks datacenter IPs.
   * Fixed at session creation; cannot change mid-session.
   */
  proxy?: ProxyConfig;
  /**
   * Browser engine. "stealth" runs Brave with anti-detection patches.
   */
  browser?: "chrome" | "chromium" | "stealth";
  debug?: boolean;
}

export interface StartConnectResult {
  connectId: string;
  liveUrl: string;
  expiresAt: number;
}

/**
 * Find the page hosting DeepSeek. During OAuth, the popup is a separate
 * page — we must skip it and pick the chat tab.
 */
async function pickDeepSeekPage(browser: Browser): Promise<Page | null> {
  const pages = await browser.pages();
  const chat = pages.find((p) => p.url().startsWith(DEEPSEEK_URL));
  if (chat) return chat;
  return pages[0] ?? null;
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

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
      defaultViewport: null,
    });

    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });

    const liveUrl = await mintLiveUrl(page, ttl, cfg.debug);

    // Disconnect, don't close — the session must survive for the poll
    // route to check login state.
    await browser.disconnect();
    browser = null;

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

    return { connectId, liveUrl, expiresAt: pending.expires_at };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    await stopBrowserlessSession(session.stopUrl, cfg.debug);
    throw e;
  }
}

async function mintLiveUrl(
  page: Page,
  timeoutMs: number,
  debug?: boolean,
): Promise<string> {
  const cdp = await page.createCDPSession();
  const result = (await cdp.send("Browserless.liveURL" as never, {
    timeout: Math.min(timeoutMs, MAX_SESSION_MS),
    interactable: true,
    resizable: true,
    showBrowserInterface: true,
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
  if (debug) console.log(`[deepseek.connect] live URL minted`);
  return result.liveURL;
}

export type ConnectStatus =
  | { status: "pending"; liveUrl: string; expiresAt: number; message: string }
  | { status: "connected"; accountHint?: string; verified: string[] }
  | { status: "failed"; error: string }
  | { status: "expired" }
  | { status: "not_found" };

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
    browser = await puppeteer.connect({
      browserWSEndpoint: pending.connect_url,
      defaultViewport: null,
    });

    // Skip any OAuth popup — pick the chat page by URL.
    let page = await pickDeepSeekPage(browser);
    if (!page) {
      await browser.disconnect();
      browser = null;
      return {
        status: "pending",
        liveUrl: pending.live_url,
        expiresAt: pending.expires_at,
        message: "Waiting for login...",
      };
    }

    if (!page.url().startsWith(DEEPSEEK_URL)) {
      await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 1500));
      page = await pickDeepSeekPage(browser);
      if (!page) {
        await browser.disconnect();
        browser = null;
        return {
          status: "pending",
          liveUrl: pending.live_url,
          expiresAt: pending.expires_at,
          message: "Waiting for login...",
        };
      }
    }

    const loggedIn = await detectLoggedIn(page);
    const remaining = pending.expires_at - Date.now();
    let liveUrl = pending.live_url;
    if (!loggedIn && remaining < LIVE_URL_REFRESH_WINDOW_MS) {
      try {
        liveUrl = await mintLiveUrl(page, MAX_SESSION_MS, cfg.debug);
      } catch {
        // old URL keeps working
      }
    }

    if (!loggedIn) {
      await browser.disconnect();
      browser = null;
      return {
        status: "pending",
        liveUrl,
        expiresAt: pending.expires_at,
        message: "Waiting for login...",
      };
    }

    // Capture cookies from the browser context, not the page — DeepSeek
    // sets cookies on multiple subdomains.
    const context = browser.defaultBrowserContext();
    const cookies = await context.cookies();
    const accountHint = await scrapeAccountHint(page).catch(() => undefined);
    const discovery = await discoverSelectors(page);

    const stored = encryptCredentials(
      {
        cookies: cookies as unknown as PlaywrightCookie[],
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
          `verified=[${discovery.verified.join(",")}]`,
      );
    }

    return { status: "connected", accountHint, verified: discovery.verified };
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
  if (url.includes("accounts.google.com")) return false;

  const candidates = [
    "textarea",
    "div[contenteditable='true']",
    "[role='textbox']",
  ];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const box = await el.boundingBox();
      if (box && box.width > 0 && box.height > 0) return true;
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
      const el = await page.$(sel);
      if (!el) continue;
      const label = await el.evaluate((n) => n.getAttribute("aria-label"));
      if (label && label.length < 120) return label;
    } catch {
      // try next
    }
  }
  return undefined;
}
