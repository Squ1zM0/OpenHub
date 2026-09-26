import { z } from "zod";
import { checkBearer } from "@/src/lib/auth";
import { getStore } from "@/src/lib/store-singleton";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  daemon_id: z.string().min(1),
  session_id: z.string().min(1),
});

const HOLD_MS = 25_000;
const TICK_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

  const store = getStore();
  const { session_id } = parsed.data;

  if (!(await store.sessionExists(session_id))) {
    await store.createSession(session_id);
  }

  const deadline = Date.now() + HOLD_MS;
  while (Date.now() < deadline) {
    const job = await store.dequeueJob(session_id);
    if (job) {
      return Response.json({ job, server_time_ms: Date.now() });
    }
    await sleep(TICK_MS);
  }

  return new Response(null, { status: 204 });
}
