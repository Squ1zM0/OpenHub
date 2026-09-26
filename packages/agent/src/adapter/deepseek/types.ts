import { z } from "zod";

export type SelectorCandidates = readonly string[];

export interface DeepSeekSelectors {
  input: SelectorCandidates;
  sendButton: SelectorCandidates;
  stopButton: SelectorCandidates;
  assistantMessage: SelectorCandidates;
  newChatButton: SelectorCandidates;
  loggedInIndicator: SelectorCandidates;
}

export interface DeepSeekAdapterConfig {
  browserlessToken: string;
  browserlessUrl?: string;
  cookies: PlaywrightCookie[];
  selectors?: Partial<DeepSeekSelectors>;
  responseTimeoutMs?: number;
  stabilityMs?: number;
  sessionTtlMs?: number;
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

/**
 * Server-side env. Note there is no DEEPSEEK_COOKIES — credentials come from
 * the connect flow, encrypted at rest, not from environment variables.
 */
export const DeepSeekEnv = z.object({
  BROWSERLESS_TOKEN: z.string().min(1),
  BROWSERLESS_URL: z
    .string()
    .url()
    .default("https://production-sfo.browserless.io"),
  DEEPSEEK_CREDENTIAL_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, {
      message:
        "must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32",
    }),
});

export type DeepSeekEnv = z.infer<typeof DeepSeekEnv>;

export function readDeepSeekEnv(
  env: NodeJS.ProcessEnv = process.env,
): DeepSeekEnv {
  const parsed = DeepSeekEnv.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`missing/invalid DeepSeek env:\n${issues}`);
  }
  return parsed.data;
}
