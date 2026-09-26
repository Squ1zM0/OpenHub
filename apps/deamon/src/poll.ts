import { PollResponse, sign } from "@openhub/protocol";
import type { Job, Result } from "@openhub/protocol";
import type { Config } from "./config.js";

const POLL_TIMEOUT_MS = 25_000;
const RESULT_TIMEOUT_MS = 10_000;

/**
 * Long-poll the server for the next job. Returns null on server-side timeout
 * (nothing available). Throws on transport errors — caller handles backoff.
 */
export async function poll(
  cfg: Config,
  daemonId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<Job | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), POLL_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(`${cfg.server_url}/api/poll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ daemon_id: daemonId, session_id: sessionId }),
      signal: ctl.signal,
    });

    if (res.status === 204) return null;
    if (!res.ok) {
      throw new Error(`poll failed: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    const parsed = PollResponse.parse(json);
    return parsed.job;
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      // Outer signal (SIGINT) → propagate so the loop stops.
      if (signal.aborted) throw e;
      // Timeout → normal, no job available this round.
      return null;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function postResult(cfg: Config, result: Result): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RESULT_TIMEOUT_MS);
  try {
    const body = { result };
    const signature = sign(body, cfg.token);
    const res = await fetch(`${cfg.server_url}/api/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.token}`,
        "x-openhub-signature": signature,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      throw new Error(`result post failed: ${res.status} ${res.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
