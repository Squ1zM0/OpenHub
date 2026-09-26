import { z } from "zod";
import { checkBearer } from "@/src/lib/auth.js";
import { getStore } from "@/src/lib/store-singleton.js";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  daemon_id: z.string().min(1),
  session_id: z.string().min(1),
});

/**
 * The daemon long-polls here. We hold the request open for up to HOLD_MS,
 * checking the queue every TICK_MS. If a job appears, return it immediately.
 * If the hold expires, return 204 and the daemon re-polls instantly.
 *
 * Sessions are created on demand — the daemon may start polling before the
 * dashboard has heard about the session.
 */
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
