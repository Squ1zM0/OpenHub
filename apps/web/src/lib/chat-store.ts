import type { ToolCall } from "@openhub/agent";

export type ChatRole = "user" | "assistant" | "tool";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  created_at: string;
  tool_name?: string;
  tool_args?: unknown;
  tool_result?: unknown;
  tool_error?: string;
  tool_calls?: ToolCall[];
}

/**
 * Message history per (user, session). In-memory is dev-only — on Vercel
 * a POST and its follow-up may land on different function instances and
 * share no memory. Production needs KV or Postgres.
 */
export interface ChatStore {
  getMessages(userId: string, sessionId: string): Promise<ChatMessage[]>;
  appendMessage(
    userId: string,
    sessionId: string,
    msg: ChatMessage,
  ): Promise<void>;
  clear(userId: string, sessionId: string): Promise<void>;
}

export class InMemoryChatStore implements ChatStore {
  private data = new Map<string, ChatMessage[]>();

  private key(userId: string, sessionId: string): string {
    return `${userId}::${sessionId}`;
  }

  async getMessages(userId: string, sessionId: string): Promise<ChatMessage[]> {
    return [...(this.data.get(this.key(userId, sessionId)) ?? [])];
  }

  async appendMessage(
    userId: string,
    sessionId: string,
    msg: ChatMessage,
  ): Promise<void> {
    const k = this.key(userId, sessionId);
    const list = this.data.get(k) ?? [];
    list.push(msg);
    this.data.set(k, list);
  }

  async clear(userId: string, sessionId: string): Promise<void> {
    this.data.delete(this.key(userId, sessionId));
  }
}
