#!/usr/bin/env node
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readConfig, writeConfig } from "./config.js";
import { Session } from "./session.js";
import { poll, postResult } from "./poll.js";
import { execute } from "./executor.js";

const POLL_BACKOFF_MS = [250, 500, 1000, 2000, 5000];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "start";

  if (cmd === "login") {
    const server_url = args[1];
    const token = args[2];
    if (!server_url || !token) {
      console.error("usage: openhub login <server_url> <token>");
      process.exit(2);
    }
    await writeConfig({ server_url, token });
    console.log("config written to ~/.openhub/config.json");
    return;
  }

  if (cmd === "start") {
    const cfg = await readConfig();
    if (!cfg) {
      console.error("not logged in. run: openhub login <server_url> <token>");
      process.exit(2);
    }

    const daemonId = cfg.daemon_id ?? hostname();
    const sessionId = process.env.OPENHUB_SESSION_ID ?? randomUUID();

    console.log("openhub daemon");
    console.log(`  server:   ${cfg.server_url}`);
    console.log(`  daemon:   ${daemonId}`);
    console.log(`  session:  ${sessionId}`);
    console.log("  ctrl-c to exit\n");

    const session = await Session.open(sessionId);
    const shutdown = new AbortController();
    process.on("SIGINT", () => {
      console.log("\nshutting down...");
      shutdown.abort();
    });

    let backoffIdx = 0;
    while (!shutdown.signal.aborted) {
      let job;
      try {
        job = await poll(cfg, daemonId, sessionId, shutdown.signal);
        backoffIdx = 0;
      } catch (e) {
        if (shutdown.signal.aborted) break;
        const err = e as Error;
        const delay =
          POLL_BACKOFF_MS[Math.min(backoffIdx++, POLL_BACKOFF_MS.length - 1)]!;
        console.error(`poll error: ${err.message} — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!job) continue;

      console.log(`job ${job.job_id}  kind=${job.kind}  tool=${job.tool ?? "-"}`);
      const result = await execute(session, job);
      console.log(`  → ${result.status}  (${result.duration_ms}ms)`);

      try {
        await postResult(cfg, result);
      } catch (e) {
        console.error(`  ! failed to post result: ${(e as Error).message}`);
      }

      if (job.kind === "shutdown") break;
    }

    await session.close();
    console.log("done.");
    return;
  }

  console.error(`unknown command: ${cmd}`);
  console.error("usage: openhub [login <server_url> <token> | start]");
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
