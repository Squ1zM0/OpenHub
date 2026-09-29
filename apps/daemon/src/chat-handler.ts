import type { Job } from "@openhub/protocol";
import { DeepSeekBrowser, type BrowserConfig } from "./deepseek-browser";

/**
 * Chat job handler. Receives a chat job from the poll loop, drives the
 * local Chromium instance, and streams tokens back to the Vercel control
 * plane in batches.
 *
 * Batching: we POST accumulated tokens every 500ms or whenever the batch
 * reaches 32 tokens, whichever comes first. This keeps the Vercel function
 * that receives them under 100ms per call, and it keeps the daemon's
 * outbound traffic predictable.
 *
 * The daemon holds the browser. Vercel holds the buffer. The user's
 * browser polls Vercel. Nothing holds a long-lived connection.
 */

const BATCH_INTERVAL_MS = 500;
const BATCH_MAX_TOKENS = 32;

export interface ChatHandlerConfig extends BrowserConfig {
  /** Where to POST token batches. */
  server_url: string;
  /** Daemon bearer token, same one used for polling. */
  auth_token: string;
}

export interface ChatJobPayload {
  chat_id: string;
  message: string;
}

/**
 * Parse a chat job's payload. Returns null if the shape is wrong — caller
 * posts an error result and moves on.
 */
export function parseChatJob(job: Job): ChatJobPayload | null {
  if (job.kind !== "chat") return null;
  const args = job.args as Record<string, unknown> | undefined;
  if (!args) return null;
  const chat_id = args.chat_id;
  const message = args.message;
  if (typeof chat_id !== "string" || typeof message !== "string") return null;
  return { chat_id, message };
}

export class ChatHandler {
  private readonly browser: DeepSeekBrowser;
  private readonly cfg: ChatHandlerConfig;

  constructor(cfg: ChatHandlerConfig) {
    this.cfg = cfg;
    this.browser = new DeepSeekBrowser({
      chrome_path: cfg.chrome_path,
      profile_dir: cfg.profile_dir,
      headful: cfg.headful,
      response_timeout_ms: cfg.response_timeout_ms,
      debug: cfg.debug,
    });
  }

  /** Ensure the browser is up and logged in. Called on daemon startup. */
  async ensureReady(): Promise<{ ready: boolean; reason?: string }> {
    try {
      await this.browser.ensure();
      if (!this.browser.isLoggedIn()) {
        return {
          ready: false,
          reason:
            "Chrome is open at chat.deepseek.com but you're not logged in. " +
            "Log in in that window, then restart the daemon.",
        };
      }
      return { ready: true };
    } catch (e) {
      return { ready: false, reason: (e as Error).message };
    }
  }

  /**
   * Execute one chat job end to end: send the message, stream tokens,
   * batch, post. Returns when the reply is complete or an error occurs.
   */
  async run(job: ChatJobPayload): Promise<void> {
    const { chat_id, message } = job;
    const log = (m: string) => {
      if (this.cfg.debug) console.log(`[chat ${chat_id}] ${m}`);
    };

    log("start");

    let pending: string[] = [];
    let pendingSince = Date.now();
    let totalChars = 0;
    let error: string | null = null;

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      pendingSince = Date.now();
      try {
        await this.postTokens(chat_id, batch, false);
      } catch (e) {
        log(`post failed: ${(e as Error).message}`);
      }
    };

    try {
      for await (const delta of this.browser.send(message)) {
        pending.push(delta);
        totalChars += delta.length;

        if (
          pending.length >= BATCH_MAX_TOKENS ||
          Date.now() - pendingSince >= BATCH_INTERVAL_MS
        ) {
          await flush();
        }
      }
      await flush();
      log(`complete: ${totalChars} chars`);
    } catch (e) {
      error = (e as Error).message;
      await flush();
      log(`error: ${error}`);
    }

    // Final post marks the chat as done (or failed) so the poll endpoint
    // can return a terminal state.
    try {
      await this.postTokens(chat_id, [], true, error);
    } catch (e) {
      log(`finalize failed: ${(e as Error).message}`);
    }
  }

  /**
   * POST a batch of tokens to Vercel. `final` marks the chat complete;
   * `error` (when set) marks it failed.
   */
  private async postTokens(
    chatId: string,
    tokens: string[],
    final: boolean,
    error: string | null = null,
  ): Promise<void> {
    const body = {
      chat_id: chatId,
      tokens,
      final,
      error,
      at: new Date().toISOString(),
    };
    const res = await fetch(
      `${this.cfg.server_url}/api/daemon/chat-tokens`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.auth_token}`,
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} ${text}`);
    }
  }

  /** Detach from the browser. Called on daemon shutdown. */
  async detach(): Promise<void> {
    await this.browser.detach();
  }

  /** Fully stop the browser. Called only on explicit teardown. */
  async stop(): Promise<void> {
    await this.browser.stop();
  }
}
