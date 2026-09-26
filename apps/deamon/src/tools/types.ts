import { z } from "zod";

export interface ToolContext {
  sessionId: string;
  workspace: string;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  execute(args: I, ctx: ToolContext): Promise<O>;
}
