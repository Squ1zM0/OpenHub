import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createBrowserlessSession, stopBrowserlessSession } from "./browserless";
import { mergeSelectors } from "./selectors";
import { parseToolCalls, type ToolCall } from "../../types";
import type { DeepSeekSelectors, PlaywrightCookie } from "./types";

const DEEPSEEK_URL = "https://chat.deepseek.com/";
const SESSION_TTL_MS = 180_000;
const POLL_INTERVAL_MS = 250;
const STABLE_WINDOW_MS = 1_500;
const RESPONSE_TIMEOUT_MS = 240_000;
const REUSE_PROBE_MS = 4_000;

export interface ChatTurnOptions {
  cookies: PlaywrightCookie[];
  selectors: Partial<DeepSeekSelectors>;
  browserlessToken: string;
  browserlessUrl?: string;
  userMessage: string;
  /**
   * If a live Browserless session URL is provided, we attempt to reuse it
   * instead of creating a fresh session. Cookies, localStorage, and page
   * state carry over, which skips the 3–5s cold start and preserves
   * DeepSeek's client-side chat history.
   */
  existingSessionUrl?: string | null;
  /**
   * Extend the session's TTL on each turn so it doesn't expire mid-thread.
   * Uses the Browserless.reconnect CDP command.
   */
  extendOnUse?: boolean;
  signal?: AbortSignal;
  debug?: boolean;
}

export type ChatEvent =
  | {
      type: "session_ready";
      /** Whether we reused an existing session or created a new one. */
      reused: boolean;
      /** The WebSocket URL of the session, for the caller to cache. */
      session_url: string;
      /** The stop URL, for explicit teardown if needed. */
      stop_url: string;
      /** Unix ms when the session TTL expires. */
      expires_at: number;
    }
  | { type: "message_delta"; text: string }
  | { type: "message_done"; text: string; toolCalls: ToolCall[] }
  | { type: "error"; message: string };

export async function* runChatTurn(
  opts: ChatTurnOptions,
): AsyncGenerator<ChatEvent, void, void> {
  const selectors = mergeSelectors(opts.selectors);
  const debug = opts.debug ?? false;
  const log = (m: string) => {
    if (debug) console.log(`[chat] ${m}`);
  };

  let browser: Browser | null = null;
  let sessionUrl: string;
  let stopUrl: string;
  let expiresAt: number;
  let reused = false;

  // ── 1. Try to reuse an existing session ────────────────────────────────
  if (opts.existingSessionUrl) {
    log("attempting to reuse existing session");
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: opts.existingSessionUrl,
        defaultViewport: { width: 1280, height: 900 },
      });
      const page = await pickDeepSeekPage(browser);
      if (!page) throw new Error("no DeepSeek page in reused session");

      const ok = await probeLoggedIn(page, selectors, REUSE_PROBE_MS);
      if (!ok) throw new Error("reused session is not logged in");

      sessionUrl = opts.existingSessionUrl;
      stopUrl = "";
      expiresAt = Date.now() + SESSION_TTL_MS;
      reused = true;

      if (opts.extendOnUse) {
        try {
          const cdp = await page.createCDPSession();
          await cdp.send("Browserless.reconnect" as never, {
            timeout: SESSION_TTL_MS,
          } as never);
          expiresAt = Date.now() + SESSION_TTL_MS;
          log("session TTL extended via Browserless.reconnect");
        } catch (e) {
          // Not fatal — we'll fall back to creating a fresh session next
          // turn if the old one expires.
          log(`reconnect command failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      log(`reuse failed: ${(e as Error).message} — creating fresh session`);
      if (browser) await browser.close().catch(() => {});
      browser = null;
    }
  }

  // ── 2. Otherwise, create a fresh session ───────────────────────────────
  if (!browser) {
    log("creating fresh browserless session");
    const session = await createBrowserlessSession({
      token: opts.browserlessToken,
      baseUrl: opts.browserlessUrl,
      ttlMs: SESSION_TTL_MS,
      stealth: true,
      debug,
    });
    sessionUrl = session.connectUrl;
    stopUrl = session.stopUrl;
    expiresAt = Date.now() + SESSION_TTL_MS;

    browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
      defaultViewport: { width: 1280, height: 900 },
    });

    const context = browser.defaultBrowserContext();
    await context.setCookie(
      ...opts.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? "/",
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
    );

    const page = (await browser.pages())[0] ?? (await browser.newPage());
    log(`navigating to ${DEEPSEEK_URL}`);
    await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });

    const ok = await probeLoggedIn(page, selectors, 15_000);
    if (!ok) {
      yield {
        type: "error",
        message:
          "Not logged in — cookies may have expired. Reconnect DeepSeek.",
      };
      return;
    }
  }

  // ── 3. Run the turn ────────────────────────────────────────────────────
  try {
    const page = await pickDeepSeekPage(browser!);
    if (!page) throw new Error("no DeepSeek page after session setup");

    yield {
      type: "session_ready",
      reused,
      session_url: sessionUrl,
      stop_url: stopUrl,
      expires_at: expiresAt,
    };

    log(`sending message (reused=${reused})`);
    await typeAndSend(page, opts.userMessage, selectors);

    const beforeCount = await countAssistantMessages(page, selectors);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    await waitForNewMessage(page, selectors, beforeCount, deadline, opts.signal);

    let lastText = "";
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error("aborted");
      await sleep(POLL_INTERVAL_MS);

      const text = await readLastAssistant(page, selectors);
      const stopVisible = await anyVisible(page, selectors.stopButton);

      if (text !== lastText) {
        if (text.length > lastText.length && text.startsWith(lastText)) {
          yield { type: "message_delta", text: text.slice(lastText.length) };
        } else {
          yield { type: "message_delta", text };
        }
        lastText = text;
        stableSince = Date.now();
        continue;
      }

      if (!stopVisible && Date.now() - stableSince >= STABLE_WINDOW_MS) {
        const toolCalls = parseToolCalls(lastText).calls;
        yield { type: "message_done", text: lastText, toolCalls };
        return;
      }
    }

    throw new Error(`timed out after ${RESPONSE_TIMEOUT_MS}ms`);
  } catch (e) {
    yield { type: "error", message: (e as Error).message };
  } finally {
    // Disconnect only — do NOT close the browser. The caller owns the
    // session lifetime and will reuse it on the next turn.
    if (browser) {
      await browser.disconnect().catch(() => {});
    }
  }
}

// ─── Internals ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pickDeepSeekPage(browser: Browser): Promise<Page | null> {
  const pages = await browser.pages();
  const chat = pages.find((p) => p.url().startsWith(DEEPSEEK_URL));
  if (chat) return chat;
  // If no page is on DeepSeek but we have a page, use it (fresh session
  // before navigation).
  return pages[0] ?? null;
}

async function probeLoggedIn(
  page: Page,
  selectors: DeepSeekSelectors,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors.loggedInIndicator) {
      try {
        const el = await page.$(sel);
        if (el) {
          const box = await el.boundingBox();
          if (box && box.width > 0 && box.height > 0) return true;
        }
      } catch {
        // try next
      }
    }
    await sleep(250);
  }
  return false;
}

async function typeAndSend(
  page: Page,
  text: string,
  selectors: DeepSeekSelectors,
): Promise<void> {
  const input = await waitForSelector(page, selectors.input, 10_000);
  if (!input) throw new Error("chat input not found");

  await input.click();
  await input.evaluate((el) => {
    if (el instanceof HTMLTextAreaElement) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (el instanceof HTMLElement && el.isContentEditable) {
      el.innerText = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  await page.keyboard.type(text, { delay: 1 });

  const sendBtn = await waitForSelector(page, selectors.sendButton, 1_500);
  if (sendBtn) {
    await sendBtn.click();
  } else {
    await input.press("Enter");
  }
}

async function waitForSelector(
  page: Page,
  candidates: readonly string[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of candidates) {
      try {
        const el = await page.$(sel);
        if (el) {
          const box = await el.boundingBox();
          if (box && box.width > 0 && box.height > 0) return el;
        }
      } catch {
        // try next
      }
    }
    await sleep(200);
  }
  return null;
}

async function countAssistantMessages(
  page: Page,
  selectors: DeepSeekSelectors,
): Promise<number> {
  for (const sel of selectors.assistantMessage) {
    try {
      const els = await page.$$(sel);
      if (els.length > 0) return els.length;
    } catch {
      // try next
    }
  }
  return 0;
}

async function waitForNewMessage(
  page: Page,
  selectors: DeepSeekSelectors,
  beforeCount: number,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    const count = await countAssistantMessages(page, selectors);
    if (count > beforeCount) return;
    await sleep(200);
  }
  throw new Error("no new assistant message appeared");
}

async function readLastAssistant(
  page: Page,
  selectors: DeepSeekSelectors,
): Promise<string> {
  for (const sel of selectors.assistantMessage) {
    try {
      const els = await page.$$(sel);
      if (els.length === 0) continue;
      const last = els[els.length - 1]!;
      const text = await last.evaluate((el) => el.textContent ?? "");
      if (text !== null) return text;
    } catch {
      // try next
    }
  }
  return "";
}

async function anyVisible(
  page: Page,
  candidates: readonly string[],
): Promise<boolean> {
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
