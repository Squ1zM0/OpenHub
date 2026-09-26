#!/usr/bin/env tsx
/**
 * Discovery script for chat.deepseek.com selectors.
 *
 * Run with BROWSERLESS_TOKEN and DEEPSEEK_COOKIES set. Opens a Browserless
 * session, navigates to DeepSeek, and dumps every plausible input / send /
 * stop / message container it can find — ranked by how likely each is to
 * be the real thing.
 *
 * Usage:
 *   pnpm --filter @openhub/agent discover-selectors
 *
 * Then paste the winners into DEEPSEEK_SELECTORS_OVERRIDE (JSON) or into
 * selectors.ts.
 */
import { chromium } from "playwright-core";
import { createBrowserlessSession, stopBrowserlessSession } from "../src/adapter/deepseek/browserless";
import { readDeepSeekEnv, parseCookies } from "../src/adapter/deepseek/types";

interface Candidate {
  selector: string;
  count: number;
  note: string;
}

const env = readDeepSeekEnv();
const cookies = parseCookies(env.DEEPSEEK_COOKIES);

const session = await createBrowserlessSession({
  token: env.BROWSERLESS_TOKEN,
  baseUrl: env.BROWSERLESS_URL,
  ttlMs: 120_000,
  debug: true,
});

const browser = await chromium.connectOverCDP(session.connectUrl);
const context = browser.contexts()[0] ?? (await browser.newContext());
await context.addCookies(cookies);
const page = context.pages()[0] ?? (await context.newPage());

console.log(`\nnavigating to chat.deepseek.com...`);
await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

console.log(`\nURL: ${page.url()}`);
console.log(`TITLE: ${await page.title()}\n`);

async function probe(selector: string, note: string): Promise<Candidate | null> {
  try {
    const n = await page.locator(selector).count();
    if (n === 0) return null;
    return { selector, count: n, note };
  } catch {
    return null;
  }
}

const INPUT_CANDIDATES = [
  "textarea",
  "textarea#chat-input",
  "textarea[placeholder]",
  "div[contenteditable='true']",
  "div[contenteditable='true'][role='textbox']",
  "[role='textbox']",
];

const BUTTON_CANDIDATES = [
  "button",
  "button[type='submit']",
  "button[aria-label]",
  "button[data-testid]",
];

console.log("─── INPUT CANDIDATES ─────────────────────────────────────");
for (const s of INPUT_CANDIDATES) {
  const r = await probe(s, "input");
  if (r) {
    const ph = await page
      .locator(s)
      .first()
      .getAttribute("placeholder")
      .catch(() => null);
    console.log(`  ✓ ${s}  (count=${r.count}${ph ? `, placeholder="${ph}"` : ""})`);
  }
}

console.log("\n─── BUTTON CANDIDATES ────────────────────────────────────");
for (const s of BUTTON_CANDIDATES) {
  const r = await probe(s, "button");
  if (r) {
    const buttons = await page.locator(s).all();
    for (const b of buttons.slice(0, 30)) {
      const label = await b.getAttribute("aria-label").catch(() => null);
      const testid = await b.getAttribute("data-testid").catch(() => null);
      const text = ((await b.innerText().catch(() => "")) || "").trim().slice(0, 40);
      if (label || testid || text) {
        console.log(
          `  ✓ ${s}  aria-label="${label ?? ""}" data-testid="${testid ?? ""}" text="${text}"`,
        );
      }
    }
  }
}

console.log("\n─── MESSAGE CONTAINER CANDIDATES ─────────────────────────");
const MSG_CANDIDATES = [
  "[data-role='assistant']",
  "[data-message-author-role='assistant']",
  ".ds-markdown",
  "[class*='markdown']",
  "[class*='message']",
];
for (const s of MSG_CANDIDATES) {
  const r = await probe(s, "message");
  if (r) console.log(`  ✓ ${s}  (count=${r.count})`);
}

console.log("\n─── STRUCTURE SNAPSHOT ───────────────────────────────────");
console.log("Here are the top-level elements containing a textarea or contenteditable:");
const tree = await page.evaluate(() => {
  function describe(el: Element, depth: number): string {
    const indent = "  ".repeat(depth);
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.split(/\s+/).slice(0, 3).join(".")
      : "";
    const role = el.getAttribute("role") ? `[role='${el.getAttribute("role")}']` : "";
    const testid = el.getAttribute("data-testid") ? `[data-testid='${el.getAttribute("data-testid")}']` : "";
    return `${indent}${tag}${id}${cls}${role}${testid}`;
  }

  const roots = Array.from(document.querySelectorAll("textarea, [contenteditable='true']"));
  const out: string[] = [];
  for (const root of roots) {
    let cur: Element | null = root;
    const chain: string[] = [];
    while (cur && chain.length < 6) {
      chain.unshift(describe(cur, 0));
      cur = cur.parentElement;
    }
    out.push(chain.join("\n  ↳ "));
    out.push("");
  }
  return out.join("\n");
});
console.log(tree);

console.log("\n─── DONE ─────────────────────────────────────────────────");
console.log("Paste the winning selectors into DEEPSEEK_SELECTORS_OVERRIDE or selectors.ts\n");

await browser.close();
await stopBrowserlessSession(session.stopUrl, true);
