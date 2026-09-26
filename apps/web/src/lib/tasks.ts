import { randomUUID } from "node:crypto";
import type { Job, Result } from "@openhub/protocol";
import { getStore } from "./store-singleton.js";

const TICK_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type SendJobResult =
  | { status: "ok"; result: Result }
  | { status: "error"; error: string };

/**
 * Enqueue a tool call for a session and wait for the daemon to post the
 * result. This is the server-side shape of one turn: the workflow will call
 * this, block on the result, then decide what to enqueue next.
 */
export async function sendJob(
  sessionId: string,
  tool: string,
  args: unknown,
  timeoutMs: number,
): Promise<SendJobResult> {
  const store = getStore();

  if (!(await store.sessionExists(sessionId))) {
    return { status: "error", error: `unknown session: ${sessionId}` };
  }

  const job: Job = {
    job_id: randomUUID(),
    session_id: sessionId,
    kind: "tool_call",
    tool,
    args,
  };

  await store.enqueueJob(sessionId, job);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await store.getResult(job.job_id);
    if (result) return { status: "ok", result };
    await sleep(TICK_MS);
  }

  return {
    status: "error",
    error: `timed out after ${timeoutMs}ms waiting for daemon`,
  };
}
