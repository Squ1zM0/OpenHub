import { randomUUID } from "node:crypto";
import { getStore } from "@/src/lib/store-singleton.js";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const sessionId = randomUUID();
  await getStore().createSession(sessionId);
  return Response.json({ session_id: sessionId });
}

export async function GET(): Promise<Response> {
  const sessions = await getStore().listSessions();
  return Response.json({ sessions });
}
