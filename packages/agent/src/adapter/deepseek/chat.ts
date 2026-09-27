import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createBrowserlessSession, stopBrowserlessSession } from "./browserless";
import { mergeSelectors } from "./selectors";
import { parseToolCalls, type ToolCall } from "../../types";
import type { DeepSeekSelectors, PlaywrightCookie } from "./types";

const DEEPSEEK_URL = "https://chat.deepseek.com/";
const SESSION_TTL_MS = 180_000;      // 3 min ceiling
const POLL_INTERVAL_MS = 250;        // how often to read the DOM
const STABLE_WINDOW_MS = 1_500;      // text must be unchanged this long
const RESPONSE_TIMEOUT_MS = 240_000; // 4 min hard cap

export interface ChatTurnOptions {
  cookies: PlaywrightCookie[];
  selectors: Partial<DeepSeekSelectors>;
  browserlessToken: string;
  browserlessUrl?: string;
  userMessage: string;
  signal?: AbortSignal;
  debug?: boolean;
}

export type ChatEvent =
  | { type: "session_ready" }
  | { type: "message_delta"; text: string }
  | { type: "message_done"; text: string; toolCalls: ToolCall[] }
  | { type: "error"; message: string };

/**
 * Run one chat turn against DeepSeek.
 *
 * Lifecycle:
 *   1. Fresh Browserless session, TTL 180s.
 *   2. Puppeteer connects, cookies injected, navigate to chat.
 *   3. Verify logged in via the chat input selector.
 *   4. Type the user message, press send.
 *   5. Poll the last assistant message every 250ms, yield deltas.
 *   6. Done when the stop button disappears AND text is stable for 1.5s.
 *   7. Session closed in finally.
 *
 * Yields deltas, not the whole reply — the caller (SSE route) forwards
 * each event to the browser as it's produced.
 */
export async function* runChatTurn(
  opts: ChatTurnOptions,
): AsyncGenerator<ChatEvent, void, void> {
  const selectors = mergeSelectors(opts.selectors);
  const debug = opts.debug ?? false;
  const log = (m: string) => {
    if (debug) console.log(`[chat] ${m}`);
  };

  let browser: Browser | null = null;
  let sessionStopUrl: string | null = null;

  try {
    log("creating browserless session");
    const session = await createBrowserlessSession({
      token: opts.browserlessToken,
      baseUrl: opts.browserlessUrl,
      ttlMs: SESSION_TTL_MS,
      stealth: true,
      debug,
    });
    sessionStopUrl = session.stopUrl;

    browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
      defaultViewport: { width: 1280, height: 900 },
    });

    const context = browser.defaultBrowserContext();
    await context.setCookie(...opts.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? "/",
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })));

    const page = (await browser.pages())[0] ?? (await browser.newPage());
    log(`navigating to ${DEEPSEEK_URL}`);
    await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });

    // Verify logged in.
    const inputHandle = await waitForSelector(page, selectors.input, 15_000);
    if (!inputHandle) {
      yield {
        type: "error",
        message:
          "Not logged in — cookies may have expired. Reconnect DeepSeek.",
      };
      return;
    }

    yield { type: "session_ready" };

    // Send the user message.
    log("sending message");
    await typeAndSend(page, opts.userMessage, selectors);

    // Poll for the reply.
    log("waiting for reply");
    const beforeCount = await countAssistantMessages(page, selectors);

    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    await waitForNewMessage(page, selectors, beforeCount, deadline, opts.signal);

    let lastText = "";
    let stableSince = Date.now();
    const consumed = 0;

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error("aborted");
      await sleep(POLL_INTERVAL_MS);

      const text = await readLastAssistant(page, selectors);
      const stopVisible = await anyVisible(page, selectors.stopButton);

      if (text !== lastText) {
        // Emit the delta since the last emission.
        if (text.length > lastText.length && text.startsWith(lastText)) {
          yield { type: "message_delta", text: text.slice(lastText.length) };
        } else {
          // Non-prefix change — emit the whole text as a single delta and
          // let the client replace. Rare; happens on markdown re-renders.
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
    if (browser) await browser.close().catch(() => {});
    if (sessionStopUrl) {
      await stopBrowserlessSession(sessionStopUrl, debug).catch(() => {});
    }
  }
}

// ─── Internals ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

async function typeAndSend(
  page: Page,
  text: string,
  selectors: DeepSeekSelectors,
): Promise<void> {
  const input = await waitForSelector(page, selectors.input, 10_000);
  if (!input) throw new Error("chat input not found after navigation");

  await input.click();
  // Clear any prior content.
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
