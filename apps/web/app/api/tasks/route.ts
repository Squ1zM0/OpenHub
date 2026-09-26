import { z } from "zod";
import {
  DeepSeekAdapter,
  ScriptedAdapter,
  defaultDemoScript,
  decryptCredentials,
  readDeepSeekEnv,
  DEFAULT_USER_ID,
  runTask,
  type Adapter,
  type JobDispatcher,
  type Message,
} from "@openhub/agent";
import { sendJob } from "@/src/lib/tasks";
import { getCredentialStore } from "@/src/lib/credential-store";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  session_id: z.string().min(1),
  task: z.string().min(1),
  adapter: z.enum(["scripted", "deepseek"]).default("scripted"),
  script: z.array(z.string()).optional(),
  file: z.string().optional(),
  max_turns: z.number().int().positive().max(30).default(12),
  job_timeout_ms: z.number().int().positive().max(55_000).default(30_000),
});

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

  const {
    session_id,
    task,
    adapter: adapterKind,
    script,
    file,
    max_turns,
    job_timeout_ms,
  } = parsed.data;

  let adapter: Adapter;
  try {
    adapter = await buildAdapter(adapterKind, { script, file });
  } catch (e) {
    return Response.json(
      { error: `adapter init: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const dispatch: JobDispatcher = async (tool, args) => {
    const started = Date.now();
    const res = await sendJob(session_id, tool, args, job_timeout_ms);
    const durationMs = Date.now() - started;
    if (res.status === "ok") {
      return { status: "ok", result: res.result.result, durationMs };
    }
    return { status: "error", error: res.error, durationMs };
  };

  const result = await runTask({ task, adapter, dispatch, maxTurns: max_turns });

  return Response.json({
    adapter: adapterKind,
    status: result.status,
    final_message: result.finalMessage,
    turns: result.turns,
    error: result.error ?? null,
    events: result.events,
    transcript: result.transcript as Message[],
  });
}

async function buildAdapter(
  kind: "scripted" | "deepseek",
  opts: { script?: string[]; file?: string },
): Promise<Adapter> {
  if (kind === "scripted") {
    return new ScriptedAdapter(
      opts.script && opts.script.length > 0
        ? opts.script
        : defaultDemoScript(opts.file),
    );
  }

  const env = readDeepSeekEnv();
  const stored = await getCredentialStore().get(DEFAULT_USER_ID);
  if (!stored) {
    throw new Error(
      "DeepSeek is not connected. Go to /connect/deepseek first.",
    );
  }

  const payload = decryptCredentials(stored, env.DEEPSEEK_CREDENTIAL_KEY);

  return new DeepSeekAdapter({
    browserlessToken: env.BROWSERLESS_TOKEN,
    browserlessUrl: env.BROWSERLESS_URL,
    cookies: payload.cookies,
    selectors: payload.selectors,
    debug: true,
  });
}
