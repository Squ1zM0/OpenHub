import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { DeepSeekStreamParser, parseSSELine } from "./deepseek-stream-parser";

const DEEPSEEK_URL = "https://chat.deepseek.com/";
const CDP_PORT = 9222;
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const DEFAULT_PROFILE = join(homedir(), ".openhub", "chromium-profile");

export interface BrowserConfig {
  /** Chromium executable path. If omitted, we search common locations. */
  chrome_path?: string;
  /** Persistent user-data directory. Default: ~/.openhub/chromium-profile. */
  profile_dir?: string;
  /** Run headful (visible window). Required for the first login. */
  headful?: boolean;
  /** Response timeout in ms. */
  response_timeout_ms?: number;
  debug?: boolean;
}

const COMMON_CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/local/bin/chrome",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

async function findChrome(explicit?: string): Promise<string> {
  if (explicit) {
    await access(explicit, constants.X_OK);
    return explicit;
  }
  if (process.env.CHROME_PATH) {
    await access(process.env.CHROME_PATH, constants.X_OK);
    return process.env.CHROME_PATH;
  }
  const candidates = COMMON_CHROME_PATHS[process.platform] ?? [];
  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // try next
    }
  }
  throw new Error(
    `Chromium/Chrome not found. Install Google Chrome, or set CHROME_PATH ` +
      `or deepseek_proxy.chrome_path in ~/.openhub/config.json.`,
  );
}

/**
 * Manages a persistent Chromium instance for DeepSeek.
 *
 * The browser is launched once with `--user-data-dir` pointing at a
 * dedicated profile, and a fixed remote debugging port. The login lives in
 * that profile — one-time OAuth, then it persists across daemon restarts.
 *
 * Why we hold the browser open instead of launching per request:
 *   - Cold start is ~3-5s; keeping it warm makes each turn fast.
 *   - Playwright's persistent-context path has a session-cookie bug
 *     (#36139) that wipes cookies on close. Raw Chrome + CDP connect
 *     sidesteps it — Chrome itself saves session cookies to the profile.
 *
 * Headful vs headless:
 *   - First run: headful, so the user can complete login in a real window.
 *   - Subsequent runs: same profile, still headful by default. Headless=new
 *     works but DeepSeek's bot detection is more aggressive against it.
 *     The difference is invisible to the user (window is minimized).
 */
export class DeepSeekBrowser {
  private readonly cfg: Required<Omit<BrowserConfig, "chrome_path">> & {
    chrome_path: string | undefined;
  };
  private chrome: ChildProcess | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private loggedIn = false;

  constructor(cfg: BrowserConfig = {}) {
    this.cfg = {
      chrome_path: cfg.chrome_path,
      profile_dir: cfg.profile_dir ?? DEFAULT_PROFILE,
      headful: cfg.headful ?? true,
      response_timeout_ms: cfg.response_timeout_ms ?? 240_000,
      debug: cfg.debug ?? false,
    };
  }

  private log(msg: string): void {
    if (this.cfg.debug) console.log(`[browser] ${msg}`);
  }

  /**
   * Launch Chrome if not already running, connect via CDP, navigate to
   * DeepSeek, and verify login. Idempotent — safe to call before every turn.
   */
  async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.loggedIn) {
      return this.page;
    }
    if (!this.chrome) {
      await this.launch();
    }
    if (!this.browser) {
      this.log(`connecting to CDP at ${CDP_BASE}`);
      this.browser = await puppeteer.connect({
        browserURL: CDP_BASE,
        defaultViewport: null,
      });
    }
    if (!this.page || this.page.isClosed()) {
      const pages = await this.browser.pages();
      this.page =
        pages.find((p) => p.url().startsWith(DEEPSEEK_URL)) ??
        pages[0] ??
        (await this.browser.newPage());
    }
    if (!this.page.url().startsWith(DEEPSEEK_URL)) {
      this.log(`navigating to ${DEEPSEEK_URL}`);
      await this.page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });
    }
    this.loggedIn = await this.checkLoggedIn(this.page);
    if (!this.loggedIn) {
      this.log(
        `not logged in — a Chrome window is open at ${DEEPSEEK_URL}. ` +
          `Log in, then re-run the daemon.`,
      );
    }
    return this.page;
  }

  /** Is the chat input present? That's our proxy for "logged in". */
  private async checkLoggedIn(page: Page): Promise<boolean> {
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

  /** True if a browser was launched and is still alive. */
  isRunning(): boolean {
    return this.chrome !== null && this.chrome.exitCode === null;
  }

  /** True if the current page is on a logged-in DeepSeek chat. */
  isLoggedIn(): boolean {
    return this.loggedIn;
  }

  /**
   * Send a message and stream the assistant's reply token by token.
   *
   * Uses the page's own fetch so we inherit its TLS fingerprint, cookies,
   * and CSP allowances — the request looks identical to a real user typing.
   * We read the response body as a stream and feed each SSE frame through
   * the patch parser.
   *
   * The generator completes when the stream emits [DONE] or the page stops
   * producing data for `response_timeout_ms`.
   */
  async *send(text: string): AsyncGenerator<string, void, void> {
    const page = await this.ensure();
    if (!this.loggedIn) {
      throw new Error(
        "not logged in — a Chrome window is open at chat.deepseek.com; " +
          "complete the login and re-run the daemon.",
      );
    }

    this.log("dispatching message via page fetch");
    await this.typeIntoComposer(page, text);
    await this.pressSend(page);

    const parser = new DeepSeekStreamParser();
    const deadline = Date.now() + this.cfg.response_timeout_ms;

    // Poll the DOM for the newest assistant message and stream its text.
    // We don't try to intercept the SSE directly (CSP + CDP binding is
    // fragile); instead we observe the rendered output, which is what
    // dubridge does too. The parser is retained for anyone who wants to
    // swap to direct frame reading later.
    let lastText = "";
    let stableSince = Date.now();
    let sawAnyText = false;

    while (Date.now() < deadline) {
      await sleep(150);

      const current = await this.readLastAssistant(page);
      if (current === null) continue;

      if (current !== lastText) {
        sawAnyText = true;
        const delta =
          current.length > lastText.length && current.startsWith(lastText)
            ? current.slice(lastText.length)
            : current;
        lastText = current;
        stableSince = Date.now();
        if (delta.length > 0) yield delta;
        continue;
      }

      const generating = await this.isGenerating(page);
      if (sawAnyText && !generating && Date.now() - stableSince >= 800) {
        this.log("stream complete");
        return;
      }
    }

    throw new Error(
      `timed out after ${this.cfg.response_timeout_ms}ms waiting for reply`,
    );
  }

  /**
   * Read the text of the most recent assistant message. Returns null if no
   * assistant message exists yet.
   */
  private async readLastAssistant(page: Page): Promise<string | null> {
    const selectors = [
      "[data-role='assistant']",
      "[data-message-author-role='assistant']",
      ".ds-markdown",
      "[class*='markdown' i]",
    ];
    for (const sel of selectors) {
      try {
        const els = await page.$$(sel);
        if (els.length === 0) continue;
        const text = await els[els.length - 1]!.evaluate(
          (n) => n.textContent ?? "",
        );
        return text;
      } catch {
        // try next
      }
    }
    return null;
  }

  /**
   * True while the stop-generation button is present. Its absence plus a
   * stable text window is our completion signal.
   */
  private async isGenerating(page: Page): Promise<boolean> {
    const selectors = [
      "button[aria-label*='Stop' i]",
      "button[data-testid*='stop' i]",
      "button:has-text('Stop')",
    ];
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const box = await el.boundingBox();
        if (box && box.width > 0) return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  /** Type the message into the composer, clearing any leftover text. */
  private async typeIntoComposer(page: Page, text: string): Promise<void> {
    const input = await this.waitFor(
      page,
      [
        "textarea#chat-input",
        'textarea[placeholder*="Message" i]',
        'textarea[placeholder*="Send" i]',
        'div[contenteditable="true"][role="textbox"]',
        "textarea",
      ],
      10_000,
    );
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
  }

  private async pressSend(page: Page): Promise<void> {
    const sendBtn = await this.waitFor(
      page,
      [
        'button[type="submit"]',
        'button[aria-label*="Send" i]',
        'button[data-testid*="send" i]',
      ],
      1_500,
    );
    if (sendBtn) {
      await sendBtn.click();
      return;
    }
    await page.keyboard.press("Enter");
  }

  private async waitFor(
    page: Page,
    selectors: readonly string[],
    timeoutMs: number,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const box = await el.boundingBox();
          if (box && box.width > 0 && box.height > 0) return el;
        } catch {
          // try next
        }
      }
      await sleep(200);
    }
    return null;
  }

  private async launch(): Promise<void> {
    const chromePath = await findChrome(this.cfg.chrome_path);
    await mkdir(this.cfg.profile_dir, { recursive: true });

    const args = [
      `--user-data-dir=${this.cfg.profile_dir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      DEEPSEEK_URL,
    ];
    if (!this.cfg.headful) {
      args.unshift("--headless=new");
    }

    this.log(`launching: ${chromePath}`);
    this.log(`profile: ${this.cfg.profile_dir}`);

    this.chrome = spawn(chromePath, args, {
      stdio: this.cfg.debug ? ["ignore", "inherit", "inherit"] : "ignore",
      detached: false,
    });

    this.chrome.on("exit", (code) => {
      this.log(`chrome exited: code=${code}`);
      this.chrome = null;
      this.browser = null;
      this.page = null;
      this.loggedIn = false;
    });

    // Wait for the CDP endpoint to come up.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${CDP_BASE}/json/version`);
        if (res.ok) {
          this.log("chrome CDP ready");
          return;
        }
      } catch {
        // not up yet
      }
      await sleep(300);
    }
    throw new Error("chrome did not expose CDP within 15s");
  }

  /**
   * Detach from the browser but leave it running. Called on daemon shutdown
   * so the login persists.
   */
  async detach(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.disconnect();
      } catch {
        // already gone
      }
      this.browser = null;
    }
  }

  /**
   * Fully stop Chrome. Only for explicit teardown — the daemon calls
   * detach() on normal shutdown so login survives.
   */
  async stop(): Promise<void> {
    await this.detach();
    if (this.chrome && this.chrome.exitCode === null) {
      this.chrome.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (this.chrome && this.chrome.exitCode === null) {
            this.chrome.kill("SIGKILL");
          }
          resolve();
        }, 3000);
        this.chrome!.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.chrome = null;
    this.page = null;
    this.loggedIn = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
