import { Result } from "@openhub/protocol";
import { checkBearer, verifySignature } from "@/src/lib/auth";
import { getStore } from "@/src/lib/store-singleton";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(req: Request): Promise<Response> {
  if (!checkBearer(req)) {
    return new Response("unauthorized", { status: 401 });
  }

  const raw = await req.text();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const signature = req.headers.get("x-openhub-signature") ?? "";
  if (!verifySignature(json, signature)) {
    return new Response("bad signature", { status: 401 });
  }

  const body = json as { result?: unknown };
  const parsed = Result.safeParse(body.result);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  await getStore().saveResult(parsed.data);
  return Response.json({ ok: true });
}
