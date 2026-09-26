import { readDeepSeekEnv } from "@openhub/agent";
import { startConnect } from "@openhub/agent";
import { DEFAULT_USER_ID } from "@openhub/agent";
import { getConnectStore } from "@/src/lib/credential-store.js";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Start a DeepSeek connect flow. Returns a live view URL the dashboard
 * embeds. No credentials touched here — the user logs in to the remote
 * browser, and the poll route captures the session.
 */
export async function POST(): Promise<Response> {
  const env = readDeepSeekEnv();
  const connectStore = getConnectStore();

  try {
    const result = await startConnect(
      {
        browserlessToken: env.BROWSERLESS_TOKEN,
        browserlessUrl: env.BROWSERLESS_URL,
        credentialKeyHex: env.DEEPSEEK_CREDENTIAL_KEY,
        debug: true,
      },
      connectStore,
      DEFAULT_USER_ID,
    );
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
