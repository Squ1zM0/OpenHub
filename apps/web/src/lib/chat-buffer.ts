export interface ChatBuffer {
  chat_id: string;
  session_id: string;
  /** Accumulated reply text, in the order the daemon emitted it. */
  tokens: string;
  /** True once the daemon has posted its final batch. */
  done: boolean;
  /** Non-null when the turn failed. Set alongside done=true. */
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Chat reply buffer. The daemon appends tokens as they're produced; the
 * user's browser polls for the accumulated text. In-memory is dev-only —
 * on Vercel the daemon's POST and the browser's GET may land on different
 * function instances. Production needs KV.
 */
export interface ChatBufferStore {
  create(chatId: string, sessionId: string): Promise<void>;
  get(chatId: string): Promise<ChatBuffer | null>;
  append(chatId: string, tokens: string[]): Promise<void>;
  finalize(chatId: string, error: string | null): Promise<void>;
}

export class InMemoryChatBufferStore implements ChatBufferStore {
  private map = new Map<string, ChatBuffer>();

  async create(chatId: string, sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    this.map.set(chatId, {
      chat_id: chatId,
      session_id: sessionId,
      tokens: "",
      done: false,
      error: null,
      created_at: now,
      updated_at: now,
    });
  }

  async get(chatId: string): Promise<ChatBuffer | null> {
    return this.map.get(chatId) ?? null;
  }

  async append(chatId: string, tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    const buf = this.map.get(chatId);
    if (!buf) return;
    buf.tokens += tokens.join("");
    buf.updated_at = new Date().toISOString();
  }

  async finalize(chatId: string, error: string | null): Promise<void> {
    const buf = this.map.get(chatId);
    if (!buf) return;
    buf.done = true;
    buf.error = error;
    buf.updated_at = new Date().toISOString();
  }
}
