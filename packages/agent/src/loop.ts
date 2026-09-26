import {
  formatToolResult,
  parseToolCalls,
  type AgentEvent,
  type Message,
  type RunTaskOptions,
  type RunTaskResult,
  type ToolCall,
  type ToolResult,
} from "./types.js";
import { buildSystemPrompt } from "./prompt.js";

const DEFAULT_MAX_TURNS = 12;

/**
 * The agent loop. The adapter supplies the model's text; the dispatcher
 * executes tool calls. Neither is imported from the web app — the caller
 * wires them in.
 *
 * Adapter lifecycle: `adapter.close?.()` is called in a finally block so
 * stateful adapters (browser sessions, sockets) release resources even on
 * error or abort. close() is best-effort — failures are swallowed.
 */
export async function runTask(opts: RunTaskOptions): Promise<RunTaskResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent): void => {
    events.push(e);
    opts.onEvent?.(e);
  };

  const transcript: Message[] = [
    { role: "system", content: buildSystemPrompt(opts.systemPromptSuffix) },
    { role: "user", content: opts.task },
  ];

  let lastFinal = "";

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (opts.signal?.aborted) {
        return {
          status: "aborted",
          finalMessage: lastFinal,
          transcript,
          events,
          turns: turn - 1,
        };
      }

      emit({ type: "turn_start", turn });

      let reply: string;
      try {
        const res = await opts.adapter.send(transcript, { signal: opts.signal });
        reply = res.content;
      } catch (e) {
        const message = (e as Error).message;
        emit({ type: "error", turn, message: `adapter: ${message}` });
        return {
          status: "error",
          finalMessage: lastFinal,
          transcript,
          events,
          turns: turn,
          error: `adapter: ${message}`,
        };
      }

      transcript.push({ role: "assistant", content: reply });
      emit({ type: "assistant_message", turn, content: reply });

      const { calls, malformed } = parseToolCalls(reply);

      if (calls.length === 0) {
        if (malformed) {
          const nudge =
            "Your previous message contained a <tool_call> tag that did not " +
            'parse. Emit exactly one well-formed <tool_call name="..."> block ' +
            "with valid JSON inside.";
          transcript.push({ role: "user", content: nudge });
          emit({ type: "error", turn, message: "malformed tool call" });
          continue;
        }
        lastFinal = reply.trim();
        emit({ type: "final", turn, content: lastFinal });
        return {
          status: "completed",
          finalMessage: lastFinal,
          transcript,
          events,
          turns: turn,
        };
      }

      if (calls.length > 1) {
        const message = `expected one tool call per message, got ${calls.length}`;
        emit({ type: "error", turn, message });
        return {
          status: "error",
          finalMessage: lastFinal,
          transcript,
          events,
          turns: turn,
          error: message,
        };
      }

      const call = calls[0]!;
      emit({ type: "tool_call", turn, call });

      if (call.args === null) {
        const result: ToolResult = {
          name: call.name,
          ok: false,
          result: null,
          error: "tool call body was not valid JSON",
          durationMs: 0,
        };
        emit({ type: "tool_result", turn, result });
        transcript.push({ role: "user", content: formatToolResult(result) });
        continue;
      }

      const dispatchRes = await opts.dispatch(call.name, call.args, {
        signal: opts.signal,
      });

      const result: ToolResult =
        dispatchRes.status === "ok"
          ? {
              name: call.name,
              ok: true,
              result: dispatchRes.result,
              durationMs: dispatchRes.durationMs,
            }
          : {
              name: call.name,
              ok: false,
              result: null,
              error: dispatchRes.error,
              durationMs: dispatchRes.durationMs,
            };

      emit({ type: "tool_result", turn, result });
      transcript.push({ role: "user", content: formatToolResult(result) });
    }

    emit({
      type: "error",
      turn: maxTurns,
      message: `hit max turns (${maxTurns})`,
    });
    return {
      status: "max_turns",
      finalMessage: lastFinal,
      transcript,
      events,
      turns: maxTurns,
      error: `hit max turns (${maxTurns})`,
    };
  } finally {
    if (opts.adapter.close) {
      try {
        await opts.adapter.close();
      } catch {
        // best-effort
      }
    }
  }
}

export function findToolCalls(content: string): ToolCall[] {
  return parseToolCalls(content).calls;
}
