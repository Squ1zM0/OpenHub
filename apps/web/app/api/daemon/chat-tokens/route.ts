import { z } from "zod";
import { checkBearer } from "@/src/lib/auth";
import { getChatBufferStore } from "@/src/lib/chat-buffer-singleton";

export const runtime = "nodejs";
export const maxDuration = 15;

const Body = z.object({
  chat_id: z.string().min(1),
  tokens: z.array(z.string()),
  final: z.boolean(),
  error: z.string().nullable().optional(),
  at: z.string().optional(),
});

/**
 * Receive token batches from the daemon. The daemon posts here every
 * ~500ms or 32 tokens while a chat turn is running, then posts once more
 * with `final: true` when the reply is complete.
 *
 * Auth: bearer token, same one used for /api/poll and /api/result.
 */
export async function POST(req: Request): Promise<Response> {
  if (!checkBearer(req)) {
    return new Response("unauthorized", { status: 401 });
  }

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

  const { chat_id, tokens, final, error } = parsed.data;
  const store = getChatBufferStore();

  const buf = await store.get(chat_id);
  if (!buf) {
    return Response.json({ error: "unknown chat_id" }, { status: 404 });
  }

  if (tokens.length > 0) {
    await store.append(chat_id, tokens);
  }

  if (final) {
    await store.finalize(chat_id, error ?? null);
  }

  return Response.json({ ok: true });
}
