import type { Page } from "playwright-core";
import { DEFAULT_SELECTORS } from "./selectors";
import type { DeepSeekSelectors, SelectorCandidates } from "./types";

/**
 * Programmatic selector discovery. Runs after login inside the connect flow's
 * browser session — the same page the user just authenticated on. Returns a
 * best-effort set of selectors for the current UI.
 *
 * What we can verify at connect time (chat is empty, nothing generating):
 *   - input: yes, it's on the page
 *   - send button: yes, it's next to the input
 *   - logged-in indicator: yes, same as input
 *
 * What we cannot verify at connect time:
 *   - stop button: only renders while generating
 *   - assistant message container: no message exists yet
 *
 * For those we keep the defaults, and tag the result as "partially verified."
 * The adapter re-probes on first real use — if stop or message selectors miss,
 * it logs a warning and the user re-connects.
 */
export interface DiscoveryResult {
  selectors: DeepSeekSelectors;
  verified: ("input" | "sendButton" | "loggedInIndicator")[];
  unverified: ("stopButton" | "assistantMessage" | "newChatButton")[];
  /** Everything we saw, for logging. */
  probe: Record<string, { found: boolean; selector?: string; count?: number }>;
}

interface Probe {
  candidates: SelectorCandidates;
  mustBeVisible?: boolean;
}

async function tryCandidates(
  page: Page,
  candidates: readonly string[],
  mustBeVisible = true,
): Promise<{ selector: string; count: number } | null> {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel);
      const count = await loc.count();
      if (count === 0) continue;
      if (mustBeVisible) {
        const visible = await loc.first().isVisible({ timeout: 300 });
        if (!visible) continue;
      }
      return { selector: sel, count };
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Rank a set of candidate selectors by specificity. More specific = fewer
 * matches and more attributes. `textarea#chat-input` beats bare `textarea`.
 * Used to surface new selectors we haven't seen before.
 */
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
 * Discover input + send button by walking the DOM around any textarea or
 * contenteditable. This catches UI that uses obfuscated classes our defaults
 * don't know about.
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

  // Start with defaults, then augment with anything specific we find.
  const inputCandidates: string[] = [];
  const sendCandidates: string[] = [];

  const deep = await deepProbe(page);

  // Prefer the most specific selectors the DOM actually carries.
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

  // Logged-in indicator: same candidates as input, since the input only
  // renders when authenticated.
  probe.loggedInIndicator = inputHit
    ? { found: true, selector: inputHit.selector, count: inputHit.count }
    : { found: false };

  // Prefer specific selectors we found over the generic defaults.
  const input: SelectorCandidates = inputHit
    ? dedupe([inputHit.selector, ...rankedInputs, ...DEFAULT_SELECTORS.input])
    : DEFAULT_SELECTORS.input;

  const sendButton: SelectorCandidates = sendHit
    ? dedupe([sendHit.selector, ...rankedSends, ...DEFAULT_SELECTORS.sendButton])
    : DEFAULT_SELECTORS.sendButton;

  const selectors: DeepSeekSelectors = {
    input,
    sendButton,
    // Kept from defaults — cannot be probed on an empty chat.
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
