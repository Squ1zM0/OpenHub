#!/usr/bin/env node
/**
 * Minimal mock of the cloud side of the poll protocol, for local testing.
 *
 * Delivers a fixed sequence of jobs that exercises the full tool registry:
 *   1. write_file   — create hello.txt
 *   2. read_file    — confirm it exists
 *   3. apply_patch  — change "hello" to "goodbye"
 *   4. read_file    — confirm the patch landed
 *   5. shutdown     — ask the daemon to exit cleanly
 *
 * Prints every result as it comes back, then exits a few seconds after the
 * shutdown job completes.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 4123);
const EXPECTED_TOKEN = "dev-token";

interface PlannedJob {
  kind: "tool_call" | "shutdown";
  tool?: string;
  args?: unknown;
  label: string;
}

function plan(sessionId: string): PlannedJob[] {
  return [
    {
      label: "create hello.txt",
      kind: "tool_call",
      tool: "write_file",
      args: { path: "hello.txt", content: "hello\n", create_only: true },
    },
    {
      label: "read it back",
      kind: "tool_call",
      tool: "read_file",
      args: { path: "hello.txt" },
    },
    {
      label: "patch hello → goodbye",
      kind: "tool_call",
      tool: "apply_patch",
      args: {
        path: "hello.txt",
        patch: "@@ -1 +1 @@\n-hello\n+goodbye\n",
      },
    },
    {
      label: "confirm the patch",
      kind: "tool_call",
      tool: "read_file",
      args: { path: "hello.txt" },
    },
    {
      label: "shutdown",
      kind: "shutdown",
    },
  ];
}

const queues = new Map<string, PlannedJob[]>();
let exitTimer: NodeJS.Timeout | null = null;

function scheduleExit(reason: string): void {
  if (exitTimer) return;
  exitTimer = setTimeout(() => {
    console.log(`\nmock server exiting (${reason}).`);
    process.exit(0);
  }, 3000);
}

async function readBody(
  req: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${EXPECTED_TOKEN}`) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  if (req.method === "POST" && req.url === "/api/poll") {
    const body = JSON.parse(await readBody(req)) as {
      session_id: string;
      daemon_id: string;
    };

    let queue = queues.get(body.session_id);
    if (!queue) {
      queue = plan(body.session_id);
      queues.set(body.session_id, queue);
      console.log(`session ${body.session_id} opened — ${queue.length} jobs queued\n`);
    }

    const next = queue.shift();
    if (!next) {
      // Mimic a long-poll timeout.
      await new Promise((r) => setTimeout(r, 1500));
      res.writeHead(204).end();
      return;
    }

    const job = {
      job_id: randomUUID(),
      session_id: body.session_id,
      kind: next.kind,
      tool: next.tool,
      args: next.args,
    };

    console.log(`→ ${next.label}  [${next.kind}${next.tool ? `:${next.tool}` : ""}]`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ job, server_time_ms: Date.now() }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/result") {
    const body = JSON.parse(await readBody(req)) as {
      result: { status: string; result?: unknown; error?: { message: string } };
    };
    const r = body.result;
    if (r.status === "ok") {
      console.log(`← ok`);
      if (r.result !== undefined) {
        console.log(indent(JSON.stringify(r.result, null, 2)));
      }
    } else {
      console.log(`← ${r.status}: ${r.error?.message ?? "unknown"}`);
    }
    console.log("");

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    // If all queues are drained, schedule exit.
    const anyPending = [...queues.values()].some((q) => q.length > 0);
    if (!anyPending) scheduleExit("all jobs completed");
    return;
  }

  res.writeHead(404).end("not found");
});

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

server.listen(PORT, () => {
  console.log(`mock server listening on http://localhost:${PORT}`);
  console.log(`  token: ${EXPECTED_TOKEN}`);
  console.log("\nto run the daemon against it:");
  console.log("  cd openhub/apps/daemon");
  console.log(`  pnpm tsx src/index.ts login http://localhost:${PORT} ${EXPECTED_TOKEN}`);
  console.log("  pnpm tsx src/index.ts start");
  console.log("");
});
