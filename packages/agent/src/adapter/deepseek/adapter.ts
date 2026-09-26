import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { Adapter, AdapterResponse, Message } from "../../types.js";
import { createBrowserlessSession, stopBrowserlessSession, type BrowserlessSession } from "./browserless.js";
import { mergeSelectors } from "./selectors.js";
import type { DeepSeekAdapterConfig, DeepSeekSelectors } from "./types.js";

const DEEPSEEK_URL = "https://chat.deepseek.com/";

interface InternalState {
  session: BrowserlessSession;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** How many transcript messages we've already sent to the UI. */
  sentCount: number;
}

/**
 * DeepSeek adapter driven by Browserless + Playwright.
 *
 * Lifecycle: lazy-open on first send(), close() releases the browser session.
 * The loop calls close() in a finally, so leaks are bounded by the loop's
 * lifetime.
 *
 * Message mapping: the DeepSeek web UI has no system-prompt slot, so on the
 * first send() the system message and the first user message are concatenated
 * into one prompt. Subsequent sends only push the *delta* of new messages —
 * the loop only appends, so we can track a cursor.
 */
export class DeepSeekAdapter implements Adapter {
  readonly name = "deepseek";
  private readonly cfg: Required<
    Omit<DeepSeekAdapterConfig, "selectors">
  > & { selectors: DeepSeekSelectors };
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
    if (this.closing) {
      throw new Error("adapter is closing");
    }

    const state = await this.ensureOpen();
    const delta = this.computeDelta(messages, state.sentCount);

    if (delta.length === 0) {
      throw new Error(
        "send() called with no new messages since the last call — this is a loop bug",
      );
    }

    // Concatenate the delta into a single prompt. On turn 1 this is
    // system + task; on later turns it's just the injected tool result.
    const prompt = delta
      .map((m) => this.formatForUI(m))
      .join("\n\n---\n\n");

    const beforeCount = await this.countAssistantMessages(state.page);

    await this.typeAndSend(state.page, prompt, opts?.signal);

    const text = await this.waitForReply(
      state.page,
      beforeCount,
      opts?.signal,
    );

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

  // ─── Internals ────────────────────────────────────────────────────────────

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

    this.log(`connecting playwright via CDP`);
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

    const state: InternalState = {
      session,
      browser,
      context,
      page,
      sentCount: 0,
    };
    this.state = state;
    return state;
  }

  private async assertLoggedIn(page: Page): Promise<void> {
    const candidates = this.cfg.selectors.loggedInIndicator;
    const found = await this.firstMatch(page, candidates, 15_000);
    if (!found) {
      throw new Error(
        `not logged in to chat.deepseek.com — none of these selectors matched: ` +
          candidates.join(", ") +
          `. Update DEEPSEEK_COOKIES with a fresh session, or run the ` +
          `discover-selectors script.`,
      );
    }
  }

  private async startNewChat(page: Page): Promise<void> {
    // Best-effort. If we're already on a fresh chat, this is a no-op.
    for (const sel of this.cfg.selectors.newChatButton) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.click({ timeout: 2000 });
          await page.waitForLoadState("domcontentloaded");
          return;
        }
      } catch {
        // try next candidate
      }
    }
  }

  private computeDelta(messages: Message[], sentCount: number): Message[] {
    if (messages.length <= sentCount) return [];
    return messages.slice(sentCount);
  }

  /**
   * Merge the system prompt into the first user message. DeepSeek's UI has
   * no system slot, and starting with a bare system message would just look
   * like a user message anyway.
   */
  private formatForUI(m: Message): string {
    if (m.role === "system") return `### Instructions\n\n${m.content}`;
    if (m.role === "user") return m.content;
    // Assistant messages in the delta are rare — the loop only ever appends
    // assistant text after the model produced it, so re-sending it would be
    // duplication. But if it happens, prefix it clearly.
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
        `chat input not found — tried: ${this.cfg.selectors.input.join(", ")}`,
      );
    }

    await input.click();
    // fill() is atomic; type() is per-keystroke and can trigger re-renders
    // mid-message on some React textareas. Prefer fill() when the element
    // supports it, fall back to keyboard for contenteditable.
    try {
      await input.fill(text, { timeout: 5000 });
    } catch {
      await input.click();
      await page.keyboard.type(text, { delay: 1 });
    }

    // Prefer clicking a send button if we can find one; otherwise Enter.
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

    // Phase 1: wait for a new assistant message to appear.
    await this.waitForNewAssistantMessage(page, beforeCount, deadline, signal);

    // Phase 2: wait for generation to finish. Two signals, and we require
    // both: stop button gone, and text stable.
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
        if (text.trim().length === 0) {
          throw new Error("assistant message was empty");
        }
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

  /**
   * Return the first locator from a candidate list that is visible. Returns
   * null if none match within the timeout.
   */
  private async firstMatch(
    page: Page,
    candidates: readonly string[],
    timeoutMs: number,
  ) {
    const perCandidate = Math.max(200, Math.floor(timeoutMs / candidates.length));
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
