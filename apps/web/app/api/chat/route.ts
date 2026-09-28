import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  runChatTurn,
  decryptCredentials,
  readDeepSeekEnv,
  DEFAULT_USER_ID,
  type ToolCall,
} from "@openhub/agent";
import { getCredentialStore } from "@/src/lib/credential-store";
import { getChatStore } from "@/src/lib/chat-store-singleton";
import { getSessionRegistry } from "@/src/lib/session-registry";
import { sendJob } from "@/src/lib/tasks";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  session_id: z.string().min(1),
  message: z.string().min(1).max(20_000),
  max_turns: z.number().int().positive().max(20).default(12),
  job_timeout_ms: z.number().int().positive().max(55_000).default(30_000),
});

interface ToolExecResult {
  call: ToolCall;
  result: unknown;
  error?: string;
  durationMs: number;
}

function formatToolResults(results: ToolExecResult[]): string {
  return results
    .map(({ call, result, error }) => {
      const attrs = error
        ? `name="${call.name}" error="true"`
        : `name="${call.name}"`;
      const body = error ? { error } : result;
      return `<tool_result ${attrs}>\n${JSON.stringify(body, null, 2)}\n</tool_result>`;
    })
    .join("\n\n");
}

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

  const env = readDeepSeekEnv();
  const userId = DEFAULT_USER_ID;
  const { session_id, message, max_turns, job_timeout_ms } = parsed.data;

  const storedCreds = await getCredentialStore().get(userId);
  if (!storedCreds) {
    return Response.json(
      { error: "DeepSeek is not connected. Go to /connect/deepseek first." },
      { status: 400 },
    );
  }

  const creds = decryptCredentials(storedCreds, env.DEEPSEEK_CREDENTIAL_KEY);
  const chatStore = getChatStore();
  const sessionRegistry = getSessionRegistry();

  await chatStore.appendMessage(userId, session_id, {
    id: randomUUID(),
    role: "user",
    content: message,
    created_at: new Date().toISOString(),
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      try {
        let currentPrompt = message;

        for (let turn = 1; turn <= max_turns; turn++) {
          send({ type: "turn_start", turn });

          // Reuse the live Browserless session if we have one. First turn
          // pays the cold-start cost; every subsequent turn is warm.
          const existing = sessionRegistry.get(userId);

          let assistantText = "";
          let toolCalls: ToolCall[] = [];
          let turnError: string | null = null;

          for await (const evt of runChatTurn({
            cookies: creds.cookies,
            selectors: creds.selectors,
            browserlessToken: env.BROWSERLESS_TOKEN,
            browserlessUrl: env.BROWSERLESS_URL,
            userMessage: currentPrompt,
            existingSessionUrl: existing?.connectUrl ?? null,
            extendOnUse: true,
            debug: true,
          })) {
            switch (evt.type) {
              case "session_ready":
                sessionRegistry.set(userId, {
                  connectUrl: evt.session_url,
                  stopUrl: evt.stop_url,
                  expiresAt: evt.expires_at,
                });
                send({ type: "session_ready", reused: evt.reused });
                break;
              case "message_delta":
                send({ type: "message_delta", text: evt.text });
                break;
              case "message_done":
                assistantText = evt.text;
                toolCalls = evt.toolCalls;
                break;
              case "error":
                turnError = evt.message;
                break;
            }
          }

          if (turnError) {
            send({ type: "error", message: turnError });
            close();
            return;
          }

          await chatStore.appendMessage(userId, session_id, {
            id: randomUUID(),
            role: "assistant",
            content: assistantText,
            created_at: new Date().toISOString(),
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          });

          send({ type: "assistant_done", text: assistantText, toolCalls });

          if (toolCalls.length === 0) {
            send({ type: "done", turns: turn });
            close();
            return;
          }

          const results: ToolExecResult[] = [];
          for (const call of toolCalls) {
            send({ type: "tool_call_start", call });

            const started = Date.now();
            const res = await sendJob(
              session_id,
              call.name,
              call.args,
              job_timeout_ms,
            );
            const durationMs = Date.now() - started;

            let result: unknown = null;
            let error: string | undefined;
            if (res.status === "ok") {
              result = res.result.result;
            } else {
              error = res.error;
            }

            results.push({ call, result, error, durationMs });

            await chatStore.appendMessage(userId, session_id, {
              id: randomUUID(),
              role: "tool",
              content: error
                ? `Error: ${error}`
                : JSON.stringify(result, null, 2),
              created_at: new Date().toISOString(),
              tool_name: call.name,
              tool_args: call.args,
              tool_result: result,
              tool_error: error,
            });

            send({
              type: "tool_call_done",
              call,
              result,
              error: error ?? null,
              durationMs,
            });
          }

          currentPrompt = formatToolResults(results);
        }

        send({ type: "error", message: `hit max turns (${max_turns})` });
        close();
      } catch (e) {
        send({ type: "error", message: (e as Error).message });
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export async function GET(): Promise<Response> {
  const messages = await getChatStore().getMessages(DEFAULT_USER_ID, "default");
  return Response.json({ messages });
}
