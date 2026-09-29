import { z } from "zod";

/**
 * Envelope for a job dispatched from the cloud workflow to the local daemon.
 * The daemon long-polls for these; when it receives one, it executes the
 * named tool against the session's workspace and posts a Result back.
 */
export const JobKind = z.enum(["tool_call", "chat", "shutdown", "ping"]);
export type JobKind = z.infer<typeof JobKind>;

export const Job = z.object({
  job_id: z.string().min(1),
  session_id: z.string().min(1),
  kind: JobKind,
  /** Tool name — required when kind === "tool_call". */
  tool: z.string().optional(),
  /** Tool input — shape is validated by the tool's own input schema. */
  args: z.unknown().optional(),
  /** Unix ms; daemon should abandon execution past this. */
  deadline_ms: z.number().int().positive().optional(),
});
export type Job = z.infer<typeof Job>;

export const JobError = z.object({
  message: z.string(),
  stack: z.string().optional(),
  code: z.string().optional(),
});
export type JobError = z.infer<typeof JobError>;

export const ResultStatus = z.enum(["ok", "error", "rejected"]);
export type ResultStatus = z.infer<typeof ResultStatus>;

export const Result = z.object({
  job_id: z.string().min(1),
  session_id: z.string().min(1),
  status: ResultStatus,
  result: z.unknown().optional(),
  error: JobError.optional(),
  duration_ms: z.number().int().nonnegative(),
  /** ISO timestamp of when execution completed, daemon-local. */
  completed_at: z.string(),
});
export type Result = z.infer<typeof Result>;

/** Response shape from POST /api/poll. */
export const PollResponse = z.object({
  job: Job.nullable(),
  /** Server time in unix ms — daemon uses this to re-sync if drift is large. */
  server_time_ms: z.number().int().optional(),
});
export type PollResponse = z.infer<typeof PollResponse>;
