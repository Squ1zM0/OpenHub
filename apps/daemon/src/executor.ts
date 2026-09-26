import type { Job, Result } from "@openhub/protocol";
import type { Session } from "./session.js";
import { getTool } from "./tools/registry.js";

export async function execute(session: Session, job: Job): Promise<Result> {
  const started = Date.now();
  const base = { job_id: job.job_id, session_id: job.session_id };
  const done = (rest: Omit<Result, "job_id" | "session_id" | "duration_ms" | "completed_at">): Result => ({
    ...base,
    ...rest,
    duration_ms: Date.now() - started,
    completed_at: new Date().toISOString(),
  });

  if (job.kind === "ping") {
    return done({ status: "ok", result: { pong: true } });
  }

  if (job.kind === "shutdown") {
    return done({ status: "ok", result: { acknowledged: true } });
  }

  // kind === "tool_call"
  if (!job.tool) {
    return done({
      status: "error",
      error: { message: "tool_call job missing `tool` field", code: "BAD_JOB" },
    });
  }

  const tool = getTool(job.tool);
  if (!tool) {
    return done({
      status: "error",
      error: { message: `unknown tool: ${job.tool}`, code: "UNKNOWN_TOOL" },
    });
  }

  const parsed = tool.input.safeParse(job.args ?? {});
  if (!parsed.success) {
    return done({
      status: "error",
      error: {
        message: `invalid args for ${job.tool}: ${parsed.error.message}`,
        code: "BAD_ARGS",
      },
    });
  }

  try {
    const result = await tool.execute(parsed.data, {
      sessionId: session.id,
      workspace: session.workspace,
    });
    return done({ status: "ok", result });
  } catch (e) {
    const err = e as Error;
    return done({
      status: "error",
      error: { message: err.message, stack: err.stack },
    });
  }
}
