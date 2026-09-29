#!/usr/bin/env node
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readConfig, writeConfig } from "./config";
import { Session } from "./session";
import { poll, postResult } from "./poll";
import { execute } from "./executor";
import { ChatHandler, parseChatJob } from "./chat-handler";

const POLL_BACKOFF_MS = [250, 500, 1000, 2000, 5000];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "start";

  // ─── login ────────────────────────────────────────────────────────────
  if (cmd === "login") {
    const server_url = args[1];
    const token = args[2];
    if (!server_url || !token) {
      console.error("usage: openhub login <server_url> <token>");
      process.exit(2);
    }
    const existing = await readConfig();
    await writeConfig({
      ...(existing ?? {}),
      server_url,
      token,
    } as Parameters<typeof writeConfig>[0]);
    console.log("config written to ~/.openhub/config.json");
    return;
  }

  // ─── enable-chat ──────────────────────────────────────────────────────
  // Turn on the DeepSeek browser integration. Optional args:
  //   openhub enable-chat [chrome_path] [profile_dir]
  // Everything defaults sensibly.
  if (cmd === "enable-chat") {
    const chrome_path = args[1];
    const profile_dir = args[2];
    const existing = await readConfig();
    if (!existing) {
      console.error("not logged in yet. run: openhub login <server_url> <token>");
      process.exit(2);
    }
    await writeConfig({
      ...existing,
      deepseek_browser: {
        ...(chrome_path ? { chrome_path } : {}),
        ...(profile_dir ? { profile_dir } : {}),
        headful: true,
      },
    });
    console.log("deepseek browser enabled in config.");
    console.log("restart the daemon; a Chrome window will open at chat.deepseek.com.");
    console.log("log in once. it persists.");
    return;
  }

  // ─── disable-chat ─────────────────────────────────────────────────────
  if (cmd === "disable-chat") {
    const existing = await readConfig();
    if (!existing) {
      console.error("no config found.");
      process.exit(2);
    }
    const { deepseek_browser: _drop, ...rest } = existing;
    await writeConfig(rest as Parameters<typeof writeConfig>[0]);
    console.log("deepseek browser disabled.");
    return;
  }

  // ─── start ────────────────────────────────────────────────────────────
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

    // Start the chat handler if configured. Failing to become ready is
    // non-fatal: tool execution still works, chat jobs will error out.
    let chatHandler: ChatHandler | null = null;
    if (cfg.deepseek_browser) {
      console.log("  browser:  ensuring Chromium…");
      chatHandler = new ChatHandler({
        chrome_path: cfg.deepseek_browser.chrome_path,
        profile_dir: cfg.deepseek_browser.profile_dir,
        headful: cfg.deepseek_browser.headful ?? true,
        response_timeout_ms: cfg.deepseek_browser.response_timeout_ms,
        server_url: cfg.server_url,
        auth_token: cfg.token,
        debug: true,
      });
      const ready = await chatHandler.ensureReady();
      if (ready.ready) {
        console.log("  browser:  ready");
      } else {
        console.log(`  browser:  not ready — ${ready.reason}`);
        console.log("            chat jobs will fail until resolved.");
      }
    } else {
      console.log("  browser:  not configured (run: openhub enable-chat)");
    }

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

      // Chat jobs are handled by the browser, not by the tool registry.
      // The daemon streams tokens back to Vercel out-of-band; the result
      // we post here just acknowledges the job.
      if (job.kind === "chat") {
        const payload = parseChatJob(job);
        if (!payload) {
          console.error("  malformed chat job — missing chat_id or message");
          try {
            await postResult(cfg, {
              job_id: job.job_id,
              session_id: job.session_id,
              status: "error",
              error: { message: "malformed chat job", code: "BAD_JOB" },
              duration_ms: 0,
              completed_at: new Date().toISOString(),
            });
          } catch (e) {
            console.error(`  ! failed to post result: ${(e as Error).message}`);
          }
          continue;
        }

        if (!chatHandler) {
          console.error("  chat job received but browser not configured");
          try {
            await postResult(cfg, {
              job_id: job.job_id,
              session_id: job.session_id,
              status: "error",
              error: {
                message:
                  "chat not enabled — run `openhub enable-chat` and restart",
                code: "CHAT_DISABLED",
              },
              duration_ms: 0,
              completed_at: new Date().toISOString(),
            });
          } catch (e) {
            console.error(`  ! failed to post result: ${(e as Error).message}`);
          }
          continue;
        }

        const started = Date.now();
        await chatHandler.run(payload);
        const durationMs = Date.now() - started;
        console.log(`  → chat dispatched  (${durationMs}ms)`);

        try {
          await postResult(cfg, {
            job_id: job.job_id,
            session_id: job.session_id,
            status: "ok",
            result: { chat_id: payload.chat_id },
            duration_ms: durationMs,
            completed_at: new Date().toISOString(),
          });
        } catch (e) {
          console.error(`  ! failed to post result: ${(e as Error).message}`);
        }

        continue;
      }

      // Tool call, shutdown, ping — handled by the executor.
      const result = await execute(session, job);
      console.log(`  → ${result.status}  (${result.duration_ms}ms)`);

      try {
        await postResult(cfg, result);
      } catch (e) {
        console.error(`  ! failed to post result: ${(e as Error).message}`);
      }

      if (job.kind === "shutdown") break;
    }

    // On shutdown, detach from the browser — do NOT close it. The login
    // lives in the persistent profile and only survives if Chrome exits
    // cleanly on its own (or stays running). Detaching leaves Chrome alive
    // in the background.
    if (chatHandler) await chatHandler.detach();

    await session.close();
    console.log("done.");
    return;
  }

  console.error(`unknown command: ${cmd}`);
  console.error(
    "usage: openhub [login <url> <token> | enable-chat [chrome] [dir] | disable-chat | start]",
  );
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
