import { z } from "zod";

/**
 * Candidate CSS selectors, tried in order. The first one that matches is used.
 * Multiple candidates means a UI change that renames one class doesn't break
 * the adapter.
 */
export type SelectorCandidates = readonly string[];

export interface DeepSeekSelectors {
  /** The chat input. Textarea or contenteditable. */
  input: SelectorCandidates;
  /**
   * The send button. Often optional — pressing Enter in the input usually
   * works. If provided, the adapter prefers clicking this over Enter.
   */
  sendButton: SelectorCandidates;
  /**
   * Visible ONLY while the model is generating. This is the completion
   * signal: when this disappears and the last message text has been stable
   * for `stabilityMs`, generation is done.
   */
  stopButton: SelectorCandidates;
  /**
   * The container for each assistant message, in document order. The adapter
   * takes the last one. Usually a markdown-rendered block.
   */
  assistantMessage: SelectorCandidates;
  /** "New chat" affordance, used to start a fresh conversation. */
  newChatButton: SelectorCandidates;
  /**
   * A marker that the user is logged in — e.g. the input exists. Used to
   * fail loudly instead of silently typing into a login page.
   */
  loggedInIndicator: SelectorCandidates;
}

export interface DeepSeekAdapterConfig {
  /** Browserless API token. */
  browserlessToken: string;
  /** Browserless base URL. Region-specific. */
  browserlessUrl?: string;
  /**
   * Cookies from a logged-in chat.deepseek.com session, as JSON.
   * Format: [{ name, value, domain, path, ... }] — Playwright cookie shape.
   */
  cookies: PlaywrightCookie[];
  /** Overrides for auto-detected selectors. */
  selectors?: Partial<DeepSeekSelectors>;
  /** How long to wait for a single response to complete. Default 180s. */
  responseTimeoutMs?: number;
  /** Text stability window before declaring generation done. Default 2000ms. */
  stabilityMs?: number;
  /** Browserless session TTL. Default 10 minutes. */
  sessionTtlMs?: number;
  /** Verbose logging to stdout. */
  debug?: boolean;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export const DeepSeekEnv = z.object({
  BROWSERLESS_TOKEN: z.string().min(1),
  BROWSERLESS_URL: z
    .string()
    .url()
    .default("https://production-sfo.browserless.io"),
  DEEPSEEK_COOKIES: z.string().min(1),
});

export type DeepSeekEnv = z.infer<typeof DeepSeekEnv>;

export function readDeepSeekEnv(
  env: NodeJS.ProcessEnv = process.env,
): DeepSeekEnv {
  const parsed = DeepSeekEnv.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `missing DeepSeek adapter env: ${missing}. See .env.local.example.`,
    );
  }
  return parsed.data;
}

export function parseCookies(json: string): PlaywrightCookie[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`DEEPSEEK_COOKIES is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("DEEPSEEK_COOKIES must be a JSON array of cookie objects");
  }
  return parsed as PlaywrightCookie[];
}
