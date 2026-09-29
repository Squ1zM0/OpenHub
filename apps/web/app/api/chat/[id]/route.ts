import { getChatBufferStore } from "@/src/lib/chat-buffer-singleton";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * Read the accumulated reply for a chat turn. Polled every 500ms by the
 * chat page. Short-lived by design — the daemon holds the browser, this
 * endpoint just reads a string.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const buf = await getChatBufferStore().get(id);

  if (!buf) {
    return Response.json(
      { error: "chat not found" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    {
      tokens: buf.tokens,
      done: buf.done,
      error: buf.error,
      updated_at: buf.updated_at,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
