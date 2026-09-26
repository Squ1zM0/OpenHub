import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { Adapter, AdapterResponse, Message } from "../../types";
import {
  createBrowserlessSession,
  stopBrowserlessSession,
  type BrowserlessSession,
} from "./browserless";
import { mergeSelectors } from "./selectors";
import type { DeepSeekAdapterConfig, DeepSeekSelectors } from "./types";

const DEEPSEEK_URL = "https://chat.deepseek.com/";

interface InternalState {
  session: BrowserlessSession;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  sentCount: number;
}

/**
 * DeepSeek adapter driven by Browserless + Playwright.
 *
 * Credentials come from the connect flow: the caller decrypts stored
 * cookies + selectors and passes them in via config.
 */
export class DeepSeekAdapter implements Adapter {
  readonly name = "deepseek";
  private readonly cfg: Required<Omit<DeepSeekAdapterConfig, "selectors">> & {
    selectors: DeepSeekSelectors;
  };
  private state: InternalState | null = null;
  private closing = false;

  constructor(cfg: DeepSeekAdapterConfig) {
    this.cfg = {
      browserlessToken: cfg.browserlessToken,
      browserlessUrl:
        cfg.browserlessUrl ?? "https://production-sfo.browserless.io",
      cookies: cfg.cookies,
      responseTimeoutMs: cfg.responseTimeoutMs ?? 180_000,
      stabilityMs: cfg.stabilityMs ?? 2_000,
      sessionTtlMs: cfg.sessionTtlMs ?? 10 * 60 * 1000,
      debug: cfg.debug ?? false,
      selectors: mergeSelectors(cfg.selectors),
    };
  }

  async send(
    messages: Message[],
    opts?: { signal?: AbortSignal },
  ): Promise<AdapterResponse> {
    if (this.closing) throw new Error("adapter is closing");

    const state = await this.ensureOpen();
    const delta = messages.slice(state.sentCount);
    if (delta.length === 0) {
      throw new Error("send() called with no new messages since last call");
    }

    const prompt = delta.map((m) => this.formatForUI(m)).join("\n\n---\n\n");
    const beforeCount = await this.countAssistantMessages(state.page);

    await this.typeAndSend(state.page, prompt, opts?.signal);
    const text = await this.waitForReply(state.page, beforeCount, opts?.signal);

    state.sentCount = messages.length;
    return { content: text };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const s = this.state;
    this.state = null;
    if (!s) return;
    try {
      await s.browser.close();
    } catch (e) {
      this.log(`browser.close failed: ${(e as Error).message}`);
    }
    await stopBrowserlessSession(s.session.stopUrl, this.cfg.debug);
  }

  private log(msg: string): void {
    if (this.cfg.debug) console.log(`[deepseek] ${msg}`);
  }

  private async ensureOpen(): Promise<InternalState> {
    if (this.state) return this.state;

    this.log("creating browserless session");
    const session = await createBrowserlessSession({
      token: this.cfg.browserlessToken,
      baseUrl: this.cfg.browserlessUrl,
      ttlMs: this.cfg.sessionTtlMs,
      debug: this.cfg.debug,
    });

    this.log("connecting playwright via CDP");
    const browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    if (this.cfg.cookies.length > 0) {
      await context.addCookies(this.cfg.cookies);
    }
    const page = context.pages()[0] ?? (await context.newPage());

    this.log(`navigating to ${DEEPSEEK_URL}`);
    await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });
    await this.assertLoggedIn(page);
    await this.startNewChat(page);

    const state: InternalState = { session, browser, context, page, sentCount: 0 };
    this.state = state;
    return state;
  }

  private async assertLoggedIn(page: Page): Promise<void> {
    const found = await this.firstMatch(
      page,
      this.cfg.selectors.loggedInIndicator,
      15_000,
    );
    if (!found) {
      throw new Error(
        "not logged in — the stored credentials may have expired. " +
          "Reconnect DeepSeek from the dashboard.",
      );
    }
  }

  private async startNewChat(page: Page): Promise<void> {
    for (const sel of this.cfg.selectors.newChatButton) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.click({ timeout: 2000 });
          await page.waitForLoadState("domcontentloaded");
          return;
        }
      } catch {
        // try next
      }
    }
  }

  private formatForUI(m: Message): string {
    if (m.role === "system") return `### Instructions\n\n${m.content}`;
    if (m.role === "user") return m.content;
    return `[previous assistant turn]\n\n${m.content}`;
  }

  private async typeAndSend(
    page: Page,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new Error("aborted");

    const input = await this.firstMatch(page, this.cfg.selectors.input, 10_000);
    if (!input) {
      throw new Error(
        `chat input not found — tried: ${this.cfg.selectors.input.join(", ")}. ` +
          "Reconnect DeepSeek to rediscover selectors.",
      );
    }

    await input.click();
    try {
      await input.fill(text, { timeout: 5000 });
    } catch {
      await input.click();
      await page.keyboard.type(text, { delay: 1 });
    }

    const send = await this.firstMatch(
      page,
      this.cfg.selectors.sendButton,
      1_500,
    );
    if (send && (await send.isEnabled().catch(() => false))) {
      await send.click();
    } else {
      await input.press("Enter");
    }
  }

  private async waitForReply(
    page: Page,
    beforeCount: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const deadline = Date.now() + this.cfg.responseTimeoutMs;
    await this.waitForNewAssistantMessage(page, beforeCount, deadline, signal);

    let lastText = "";
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("aborted");
      await page.waitForTimeout(400);

      const text = await this.readLastAssistant(page);
      const stopVisible = await this.anyVisible(
        page,
        this.cfg.selectors.stopButton,
      );

      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
        continue;
      }

      if (!stopVisible && Date.now() - stableSince >= this.cfg.stabilityMs) {
        if (text.trim().length === 0) throw new Error("assistant message was empty");
        return text;
      }
    }

    throw new Error(
      `timed out after ${this.cfg.responseTimeoutMs}ms waiting for DeepSeek response`,
    );
  }

  private async waitForNewAssistantMessage(
    page: Page,
    beforeCount: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("aborted");
      const count = await this.countAssistantMessages(page);
      if (count > beforeCount) return;
      await page.waitForTimeout(300);
    }
    throw new Error(
      "no new assistant message appeared — the prompt may not have been sent",
    );
  }

  private async countAssistantMessages(page: Page): Promise<number> {
    for (const sel of this.cfg.selectors.assistantMessage) {
      try {
        const n = await page.locator(sel).count();
        if (n > 0) return n;
      } catch {
        // try next
      }
    }
    return 0;
  }

  private async readLastAssistant(page: Page): Promise<string> {
    for (const sel of this.cfg.selectors.assistantMessage) {
      try {
        const loc = page.locator(sel);
        const n = await loc.count();
        if (n === 0) continue;
        const text = await loc.nth(n - 1).innerText({ timeout: 2000 });
        if (text !== null) return text;
      } catch {
        // try next
      }
    }
    return "";
  }

  private async anyVisible(
    page: Page,
    candidates: readonly string[],
  ): Promise<boolean> {
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 200 })) return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  private async firstMatch(
    page: Page,
    candidates: readonly string[],
    timeoutMs: number,
  ) {
    const perCandidate = Math.max(
      200,
      Math.floor(timeoutMs / candidates.length),
    );
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        await loc.waitFor({ state: "visible", timeout: perCandidate });
        return loc;
      } catch {
        // try next
      }
    }
    return null;
  }
}
