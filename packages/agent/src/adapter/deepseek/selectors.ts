import type { DeepSeekSelectors } from "./types";

/**
 * Default selector candidates for chat.deepseek.com.
 *
 * ⚠️  THESE ARE EDUCATED GUESSES, NOT VERIFIED. DeepSeek's UI ships obfuscated
 *     class names that change on every deploy. Before using the adapter for
 *     real, run:
 *
 *         pnpm --filter @openhub/agent discover-selectors
 *
 *     with BROWSERLESS_TOKEN and DEEPSEEK_COOKIES set. It will dump every
 *     candidate it finds, ranked by likelihood. Paste the winners into your
 *     env or a config file. The adapter fails loudly with a useful message
 *     if a selector doesn't match — you'll know immediately.
 *
 * Candidates are tried in order; first match wins. Add your own at the front
 * of each array to override the defaults.
 */
export const DEFAULT_SELECTORS: DeepSeekSelectors = {
  input: [
    "textarea#chat-input",
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="Send" i]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea',
  ],
  sendButton: [
    'button[type="submit"]',
    'button[aria-label*="Send" i]',
    'button[data-testid*="send" i]',
    // No reliable send button → Enter key is the fallback
  ],
  stopButton: [
    'button[aria-label*="Stop" i]',
    'button[data-testid*="stop" i]',
    // Generic heuristic: any button whose text contains "stop"
    'button:has-text("Stop")',
  ],
  assistantMessage: [
    '[data-role="assistant"]',
    '[data-message-author-role="assistant"]',
    ".ds-markdown",
    '[class*="markdown" i]',
  ],
  newChatButton: [
    'a[href="/"]',
    'button[aria-label*="New chat" i]',
    'button:has-text("New chat")',
  ],
  loggedInIndicator: [
    "textarea#chat-input",
    'div[contenteditable="true"][role="textbox"]',
    "textarea",
  ],
};

export function mergeSelectors(
  overrides: Partial<DeepSeekSelectors> | undefined,
): DeepSeekSelectors {
  if (!overrides) return DEFAULT_SELECTORS;
  return {
    input: overrides.input ?? DEFAULT_SELECTORS.input,
    sendButton: overrides.sendButton ?? DEFAULT_SELECTORS.sendButton,
    stopButton: overrides.stopButton ?? DEFAULT_SELECTORS.stopButton,
    assistantMessage:
      overrides.assistantMessage ?? DEFAULT_SELECTORS.assistantMessage,
    newChatButton:
      overrides.newChatButton ?? DEFAULT_SELECTORS.newChatButton,
    loggedInIndicator:
      overrides.loggedInIndicator ?? DEFAULT_SELECTORS.loggedInIndicator,
  };
}
