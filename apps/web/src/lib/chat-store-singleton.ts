import { InMemoryChatStore, type ChatStore } from "./chat-store";

const g = globalThis as unknown as { __openhub_chats?: ChatStore };

export function getChatStore(): ChatStore {
  if (!g.__openhub_chats) {
    g.__openhub_chats = new InMemoryChatStore();
  }
  return g.__openhub_chats;
}
