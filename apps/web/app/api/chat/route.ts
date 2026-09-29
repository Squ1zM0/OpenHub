import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Job } from "@openhub/protocol";
import { getStore } from "@/src/lib/store-singleton";
import { getChatBufferStore } from "@/src/lib/chat-buffer-singleton";

export const runtime = "nodejs";
export const maxDuration = 15;

const Body = z.object({
  session_id: z.string().min(1),
  message: z.string().min(1).max(20_000),
});

/**
 * Accept a user message, enqueue a chat job for the daemon, and return a
 * chat_id. The daemon picks up the job via its normal poll loop, drives
 * the local Chromium, and streams tokens back to /api/daemon/chat-tokens.
 *
 * The caller polls /api/chat/[id] to read the accumulated reply.
 *
 * Why not SSE: on Vercel Hobby, functions are capped at 60s. A DeepSeek
 * turn can run 60–240s. An SSE connection would hold a function open the
 * entire time and get killed mid-reply. Polling uses short-lived calls.
 */
export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const { session_id, message } = parsed.data;
  const store = getStore();

  // Same on-demand behavior as /api/poll: if the session isn't registered
  // yet, register it. The daemon may be polling this id already.
  if (!(await store.sessionExists(session_id))) {
    await store.createSession(session_id);
  }

  const chatId = randomUUID();
  await getChatBufferStore().create(chatId, session_id);

  const job: Job = {
    job_id: randomUUID(),
    session_id,
    kind: "chat",
    args: { chat_id: chatId, message },
  };

  await store.enqueueJob(session_id, job);

  return Response.json({ chat_id: chatId });
}

/**
 * Debug endpoint. Returns messages stored in the old chat store — left in
 * place so the previous tool-calling flow's history is still inspectable.
 * The new polling flow doesn't write here; it uses ChatBufferStore instead.
 */
export async function GET(): Promise<Response> {
  const { getChatStore } = await import("@/src/lib/chat-store-singleton");
  const { DEFAULT_USER_ID } = await import("@openhub/agent");
  const messages = await getChatStore().getMessages(DEFAULT_USER_ID, "default");
  return Response.json({ messages });
}
