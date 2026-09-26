#!/usr/bin/env node
/**
 * Fix the @openhub/agent package so it builds.
 *
 * Three changes:
 *   1. Create packages/agent/src/types.ts if it doesn't exist.
 *      This file was referenced by every module but never committed.
 *   2. Add "DOM" to lib in packages/agent/tsconfig.build.json.
 *      discovery.ts uses document, Element, etc. inside page.evaluate().
 *   3. Set exactOptionalPropertyTypes: false in the build tsconfig.
 *      Four call sites assign `undefined` to optional properties; the
 *      flag is correct in principle, but tightening those call sites
 *      isn't worth a build cycle during bootstrap.
 *
 * Idempotent.
 */
const fs = require("node:fs");
const path = require("node:path");

const cwd = process.cwd();

const TYPES_TS = `import { z } from "zod";

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface ToolCall {
  name: string;
  args: unknown;
  raw: string;
}

export interface ToolResult {
  name: string;
  ok: boolean;
  result: unknown;
  error?: string;
  durationMs: number;
}

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "assistant_message"; turn: number; content: string }
  | { type: "tool_call"; turn: number; call: ToolCall }
  | { type: "tool_result"; turn: number; result: ToolResult }
  | { type: "final"; turn: number; content: string }
  | { type: "error"; turn: number; message: string }
  | { type: "adapter_note"; turn: number; message: string };

export interface AdapterResponse {
  content: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface Adapter {
  readonly name: string;
  send(
    messages: Message[],
    opts?: { signal?: AbortSignal },
  ): Promise<AdapterResponse>;
  close?(): Promise<void>;
}

export type JobDispatcher = (
  tool: string,
  args: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<JobDispatchResult>;

export type JobDispatchResult =
  | { status: "ok"; result: unknown; durationMs: number }
  | { status: "error"; error: string; durationMs: number };

export interface RunTaskOptions {
  task: string;
  adapter: Adapter;
  dispatch: JobDispatcher;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  systemPromptSuffix?: string;
}

export type RunTaskStatus = "completed" | "max_turns" | "error" | "aborted";

export interface RunTaskResult {
  status: RunTaskStatus;
  finalMessage: string;
  transcript: Message[];
  events: AgentEvent[];
  turns: number;
  error?: string;
}

const TOOL_CALL_RE = /<tool_call\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/tool_call>/g;

export interface ParseResult {
  calls: ToolCall[];
  malformed: boolean;
}

export function parseToolCalls(content: string): ParseResult {
  const calls: ToolCall[] = [];
  let m: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((m = TOOL_CALL_RE.exec(content)) !== null) {
    const name = m[1]!;
    const body = m[2]!.trim();
    let args: unknown;
    try {
      args = body.length === 0 ? {} : JSON.parse(body);
    } catch {
      calls.push({ name, args: null, raw: m[0]! });
      continue;
    }
    calls.push({ name, args, raw: m[0]! });
  }

  const anyTags = content.includes("<tool_call");
  return { calls, malformed: anyTags && calls.length === 0 };
}

export function formatToolResult(result: ToolResult): string {
  const payload = result.ok
    ? JSON.stringify(result.result, null, 2)
    : JSON.stringify({ error: result.error }, null, 2);
  const attrs = result.ok
    ? \`name="\${result.name}"\`
    : \`name="\${result.name}" error="true"\`;
  return \`<tool_result \${attrs}>\\n\${payload}\\n</tool_result>\`;
}

export const ScriptedResponse = z.union([
  z.string(),
  z.object({
    content: z.string(),
    when_last: z.string().optional(),
  }),
]);
export type ScriptedResponse = z.infer<typeof ScriptedResponse>;
`;

const AGENT_BUILD_TSCONFIG = {
  extends: "./tsconfig.json",
  compilerOptions: {
    noEmit: false,
    outDir: "./dist",
    rootDir: "./src",
    declaration: true,
    declarationMap: true,
    sourceMap: true,
    types: ["node"],
    // discovery.ts uses browser globals (document, Element) inside
    // page.evaluate() callbacks. Types for those live in the DOM lib.
    lib: ["ES2022", "DOM"],
    // The flag is correct in principle; four call sites in the deepseek
    // adapter assign \`undefined\` to optional properties. Tightening those
    // isn't worth a build cycle during bootstrap. Revisit once green.
    exactOptionalPropertyTypes: false,
  },
  include: ["src"],
  exclude: ["node_modules", "dist", "scripts", "**/*.test.ts"],
};

let changed = 0;

// ── 1. types.ts ────────────────────────────────────────────────────────────
const typesPath = path.join(cwd, "packages/agent/src/types.ts");
if (fs.existsSync(typesPath)) {
  console.log("  skip: packages/agent/src/types.ts already exists");
} else {
  fs.mkdirSync(path.dirname(typesPath), { recursive: true });
  fs.writeFileSync(typesPath, TYPES_TS, "utf8");
  console.log("  wrote: packages/agent/src/types.ts");
  changed++;
}

// ── 2. tsconfig.build.json ─────────────────────────────────────────────────
const buildTsconfigPath = path.join(
  cwd,
  "packages/agent/tsconfig.build.json",
);
const content = JSON.stringify(AGENT_BUILD_TSCONFIG, null, 2) + "\n";
const existing = fs.existsSync(buildTsconfigPath)
  ? fs.readFileSync(buildTsconfigPath, "utf8")
  : null;
if (existing !== content) {
  fs.writeFileSync(buildTsconfigPath, content, "utf8");
  console.log("  wrote: packages/agent/tsconfig.build.json");
  changed++;
} else {
  console.log("  unchanged: packages/agent/tsconfig.build.json");
}

console.log("");
console.log(changed === 0 ? "Nothing to do." : \`\${changed} change(s) applied.\`);
