import { z } from "zod";
import { sendJob } from "@/src/lib/tasks.js";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  tool: z.string().min(1),
  args: z.unknown().optional(),
  timeout_ms: z.number().int().positive().max(55_000).default(30_000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

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

  const result = await sendJob(
    id,
    parsed.data.tool,
    parsed.data.args ?? {},
    parsed.data.timeout_ms,
  );

  const status = result.status === "ok" ? 200 : 504;
  return Response.json(result, { status });
}
