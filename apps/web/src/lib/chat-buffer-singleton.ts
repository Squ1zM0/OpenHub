import {
  InMemoryChatBufferStore,
  type ChatBufferStore,
} from "./chat-buffer";

const g = globalThis as unknown as { __openhub_chat_buffers?: ChatBufferStore };

export function getChatBufferStore(): ChatBufferStore {
  if (!g.__openhub_chat_buffers) {
    g.__openhub_chat_buffers = new InMemoryChatBufferStore();
  }
  return g.__openhub_chat_buffers;
}
