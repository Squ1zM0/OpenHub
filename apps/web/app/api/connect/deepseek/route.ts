import { readDeepSeekEnv } from "@openhub/agent";
import { startConnect } from "@openhub/agent";
import { DEFAULT_USER_ID } from "@openhub/agent";
import { getConnectStore } from "@/src/lib/credential-store";

export const runtime = "nodejs";
export const maxDuration = 60;

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
