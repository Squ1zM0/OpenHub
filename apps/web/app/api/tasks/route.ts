import { z } from "zod";
import { ScriptedAdapter, defaultDemoScript, runTask, type JobDispatcher, type Message } from "@openhub/agent";
import { sendJob } from "@/src/lib/tasks.js";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
  session_id: z.string().min(1),
  task: z.string().min(1),
  /** Optional scripted sequence for the mock adapter. */
  script: z.array(z.string()).optional(),
  /** Optional file path override for the default demo script. */
  file: z.string().optional(),
  max_turns: z.number().int().positive().max(30).default(12),
  job_timeout_ms: z.number().int().positive().max(55_000).default(30_000),
});

/**
 * Run one agent task against a session. Uses the scripted (mock) adapter
 * until the DeepSeek adapter lands. The full transcript and event log are
 * returned so the dashboard can render what happened.
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

  const { session_id, task, script, file, max_turns, job_timeout_ms } = parsed.data;

  const adapter = new ScriptedAdapter(
    script && script.length > 0 ? script : defaultDemoScript(file),
  );

  const dispatch: JobDispatcher = async (tool, args) => {
    const started = Date.now();
    const res = await sendJob(session_id, tool, args, job_timeout_ms);
    const durationMs = Date.now() - started;
    if (res.status === "ok") {
      return { status: "ok", result: res.result.result, durationMs };
    }
    return { status: "error", error: res.error, durationMs };
  };

  const result = await runTask({
    task,
    adapter,
    dispatch,
    maxTurns: max_turns,
  });

  return Response.json({
    status: result.status,
    final_message: result.finalMessage,
    turns: result.turns,
    error: result.error ?? null,
    events: result.events,
    transcript: result.transcript as Message[],
  });
}
