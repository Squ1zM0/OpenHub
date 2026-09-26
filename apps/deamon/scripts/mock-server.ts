#!/usr/bin/env node
/**
 * Minimal mock of the cloud side of the poll protocol, for local testing.
 *
 * It hands out one read_file job the first time it's polled, seeds the
 * workspace with a hello.txt so the job succeeds, prints the result, then
 * exits after a short grace period.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 4123);
const EXPECTED_TOKEN = "dev-token";

let jobDelivered = false;
let exitTimer: NodeJS.Timeout | null = null;

function scheduleExit(reason: string): void {
  if (exitTimer) return;
  exitTimer = setTimeout(() => {
    console.log(`\nmock server exiting (${reason}).`);
    process.exit(0);
  }, 3000);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
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

    if (jobDelivered) {
      // Mimic a long-poll timeout.
      await new Promise((r) => setTimeout(r, 1500));
      res.writeHead(204).end();
      return;
    }

    // Seed the session workspace so read_file has something to succeed on.
    const ws = join(
      homedir(),
      ".openhub",
      "sessions",
      body.session_id,
      "workspace",
    );
    await mkdir(ws, { recursive: true });
    await writeFile(
      join(ws, "hello.txt"),
      "hello from the mock server\n",
      "utf8",
    );

    jobDelivered = true;
    const job = {
      job_id: randomUUID(),
      session_id: body.session_id,
      kind: "tool_call",
      tool: "read_file",
      args: { path: "hello.txt" },
    };
    console.log(`→ dispatching job ${job.job_id}: ${job.tool}(${JSON.stringify(job.args)})`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ job, server_time_ms: Date.now() }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/result") {
    const body = JSON.parse(await readBody(req)) as { result: unknown };
    console.log("← received result:");
    console.log(JSON.stringify(body.result, null, 2));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    scheduleExit("job completed");
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`mock server listening on http://localhost:${PORT}`);
  console.log(`  token: ${EXPECTED_TOKEN}`);
  console.log("\nto run the daemon against it:");
  console.log("  cd openhub/apps/daemon");
  console.log(`  pnpm tsx src/index.ts login http://localhost:${PORT} ${EXPECTED_TOKEN}`);
  console.log("  pnpm tsx src/index.ts start");
});
