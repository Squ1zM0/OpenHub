import { Result } from "@openhub/protocol";
import { checkBearer, verifySignature } from "@/src/lib/auth.js";
import { getStore } from "@/src/lib/store-singleton.js";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * The daemon posts results here after executing a job. Signature is verified
 * against the shared token before the result is accepted — a hostile or
 * buggy client that guesses the bearer can't forge a result without also
 * computing the HMAC.
 */
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
