import type { Page } from "puppeteer-core";
import { DEFAULT_SELECTORS } from "./selectors";
import type { DeepSeekSelectors, SelectorCandidates } from "./types";

/**
 * Programmatic selector discovery. Runs after login inside the connect
 * flow's browser session. Returns a best-effort set of selectors for the
 * current UI.
 *
 * Uses Puppeteer's Page API, not Playwright's. The two are not
 * interchangeable — Puppeteer has `page.$$()`, `element.boundingBox()`,
 * and `element.evaluate()` where Playwright has `page.locator()`,
 * `.isVisible()`, and `.evaluate()` on the locator itself.
 *
 * What we can verify at connect time (chat is empty, nothing generating):
 *   - input: yes
 *   - send button: yes
 *   - logged-in indicator: yes
 *
 * What we cannot:
 *   - stop button (only renders while generating)
 *   - assistant message container (no message exists yet)
 *   - new chat button (may or may not be present)
 */
export interface DiscoveryResult {
  selectors: DeepSeekSelectors;
  verified: ("input" | "sendButton" | "loggedInIndicator")[];
  unverified: ("stopButton" | "assistantMessage" | "newChatButton")[];
  probe: Record<string, { found: boolean; selector?: string; count?: number }>;
}

async function tryCandidates(
  page: Page,
  candidates: readonly string[],
  mustBeVisible = true,
): Promise<{ selector: string; count: number } | null> {
  for (const sel of candidates) {
    try {
      const elements = await page.$$(sel);
      if (elements.length === 0) continue;
      if (mustBeVisible) {
        const box = await elements[0]!.boundingBox();
        if (!box || box.width === 0 || box.height === 0) continue;
      }
      return { selector: sel, count: elements.length };
    } catch {
      // try next
    }
  }
  return null;
}

function specificity(sel: string): number {
  let score = 0;
  if (sel.includes("#")) score += 4;
  if (sel.includes("[")) score += 2;
  if (sel.includes(".")) score += 1;
  if (sel.startsWith("[data-")) score += 3;
  if (sel === "textarea" || sel === "button") score -= 3;
  return score;
}

/**
 * Walk the DOM for textareas, contenteditables, and send-like buttons.
 * Runs inside the browser, so it uses DOM APIs only — identical in
 * Puppeteer and Playwright at this layer.
 */
async function deepProbe(page: Page): Promise<{
  inputs: string[];
  sends: string[];
}> {
  return page.evaluate(() => {
    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const role = el.getAttribute("role");
      const testid = el.getAttribute("data-testid");
      const aria = el.getAttribute("aria-label");
      const ph = el.getAttribute("placeholder");
      let sel = tag + id;
      if (testid) sel += `[data-testid="${testid}"]`;
      else if (aria) sel += `[aria-label="${aria}"]`;
      else if (role) sel += `[role="${role}"]`;
      else if (ph) sel += `[placeholder="${ph}"]`;
      return sel;
    }

    const inputs: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll("textarea, [contenteditable='true']"),
    )) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        inputs.push(describe(el));
      }
    }

    const sends: string[] = [];
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const b of buttons) {
      const aria = (b.getAttribute("aria-label") ?? "").toLowerCase();
      const testid = (b.getAttribute("data-testid") ?? "").toLowerCase();
      const text = (b.textContent ?? "").trim().toLowerCase();
      const type = b.getAttribute("type");
      const matches =
        type === "submit" ||
        aria.includes("send") ||
        testid.includes("send") ||
        text === "send";
      if (matches) {
        const rect = b.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          sends.push(describe(b));
        }
      }
    }

    return { inputs, sends };
  });
}

export async function discoverSelectors(page: Page): Promise<DiscoveryResult> {
  const probe: DiscoveryResult["probe"] = {};

  const inputCandidates: string[] = [];
  const sendCandidates: string[] = [];

  const deep = await deepProbe(page);

  const rankedInputs = [...deep.inputs].sort(
    (a, b) => specificity(b) - specificity(a),
  );
  const rankedSends = [...deep.sends].sort(
    (a, b) => specificity(b) - specificity(a),
  );

  inputCandidates.push(...rankedInputs, ...DEFAULT_SELECTORS.input);
  sendCandidates.push(...rankedSends, ...DEFAULT_SELECTORS.sendButton);

  const inputHit = await tryCandidates(page, inputCandidates, true);
  probe.input = inputHit
    ? { found: true, selector: inputHit.selector, count: inputHit.count }
    : { found: false };

  const sendHit = await tryCandidates(page, sendCandidates, true);
  probe.sendButton = sendHit
    ? { found: true, selector: sendHit.selector, count: sendHit.count }
    : { found: false };

  probe.loggedInIndicator = inputHit
    ? { found: true, selector: inputHit.selector, count: inputHit.count }
    : { found: false };

  const input: SelectorCandidates = inputHit
    ? dedupe([inputHit.selector, ...rankedInputs, ...DEFAULT_SELECTORS.input])
    : DEFAULT_SELECTORS.input;

  const sendButton: SelectorCandidates = sendHit
    ? dedupe([sendHit.selector, ...rankedSends, ...DEFAULT_SELECTORS.sendButton])
    : DEFAULT_SELECTORS.sendButton;

  const selectors: DeepSeekSelectors = {
    input,
    sendButton,
    stopButton: DEFAULT_SELECTORS.stopButton,
    assistantMessage: DEFAULT_SELECTORS.assistantMessage,
    newChatButton: DEFAULT_SELECTORS.newChatButton,
    loggedInIndicator: input,
  };

  const verified: DiscoveryResult["verified"] = [];
  if (inputHit) verified.push("input", "loggedInIndicator");
  if (sendHit) verified.push("sendButton");

  return {
    selectors,
    verified,
    unverified: ["stopButton", "assistantMessage", "newChatButton"],
    probe,
  };
}

function dedupe(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}
