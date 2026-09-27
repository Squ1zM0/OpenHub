import { randomUUID } from "node:crypto";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createBrowserlessSession, stopBrowserlessSession } from "./browserless";
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
    browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
      defaultViewport: null,
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });

    const liveUrl = await mintLiveUrl(page, ttl, cfg.debug);

    // Flag the browser as reconnectable, then disconnect. Puppeteer's
    // disconnect() detaches without terminating — the browser stays alive
    // server-side for `ttl` ms. Playwright cannot do this.
    await browser.disconnect();

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

    if (cfg.debug) console.log(`[deepseek.connect] started ${connectId}`);
    return { connectId, liveUrl, expiresAt: pending.expires_at };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    await stopBrowserlessSession(session.stopUrl, cfg.debug);
    throw e;
  }
}

async function mintLiveUrl(page: Page, timeoutMs: number, debug?: boolean): Promise<string> {
  const cdp = await page.createCDPSession();
  const result = (await cdp.send("Browserless.liveURL" as never, {
    timeout: Math.min(timeoutMs, MAX_SESSION_MS),
    interactable: true,
    resizable: true,
    showBrowserInterface: true,
    quality: 70,
  } as never)) as { liveURL?: string; error?: string | null };

  if (result.error) throw new Error(`browserless liveURL failed: ${result.error}`);
  if (!result.liveURL) throw new Error("browserless liveURL returned no URL");
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
    const page = (await browser.pages())[0] ?? (await browser.newPage());

    if (!page.url().startsWith(DEEPSEEK_URL)) {
      await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 1500));
    }

    const loggedIn = await detectLoggedIn(page);
    const remaining = pending.expires_at - Date.now();
    let liveUrl = pending.live_url;
    if (!loggedIn && remaining < LIVE_URL_REFRESH_WINDOW_MS) {
      try {
        liveUrl = await mintLiveUrl(page, MAX_SESSION_MS, cfg.debug);
      } catch { /* old URL keeps working */ }
    }

    if (!loggedIn) {
      await browser.disconnect();
      return { status: "pending", liveUrl, expiresAt: pending.expires_at, message: "Waiting for login..." };
    }

    const cookies = await page.cookies();
    const accountHint = await scrapeAccountHint(page).catch(() => undefined);
    const discovery = await discoverSelectors(page);

    const stored = encryptCredentials(
      { cookies: cookies as unknown as PlaywrightCookie[], selectors: discovery.selectors },
      cfg.credentialKeyHex,
    );
    if (accountHint) stored.account_hint = accountHint;
    await credentialStore.put(pending.user_id, stored);

    await browser.close();
    browser = null;
    await stopBrowserlessSession(pending.stop_url, cfg.debug);
    await connectStore.delete(connectId);

    if (cfg.debug) console.log(`[deepseek.connect] ${connectId} connected`);
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
  const candidates = ["textarea", "div[contenteditable='true']", "[role='textbox']"];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el && await el.isIntersectingViewport()) return true;
    } catch { /* try next */ }
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
      if (el) {
        const label = await el.evaluate((n) => n.getAttribute("aria-label"));
        if (label && label.length < 120) return label;
      }
    } catch { /* try next */ }
  }
  return undefined;
}
