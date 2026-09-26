import { readDeepSeekEnv, pollConnect } from "@openhub/agent";
import {
  getConnectStore,
  getCredentialStore,
} from "@/src/lib/credential-store.js";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Poll a connect flow. Returns one of:
 *   pending   — still waiting for login
 *   connected — captured and stored
 *   failed / expired / not_found
 *
 * Calling this when the flow is already complete returns not_found, because
 * the pending record is deleted on success.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const env = readDeepSeekEnv();

  const status = await pollConnect(
    id,
    {
      browserlessToken: env.BROWSERLESS_TOKEN,
      browserlessUrl: env.BROWSERLESS_URL,
      credentialKeyHex: env.DEEPSEEK_CREDENTIAL_KEY,
      debug: true,
    },
    getConnectStore(),
    getCredentialStore(),
  );

  const httpStatus =
    status.status === "not_found"
      ? 404
      : status.status === "failed"
        ? 500
        : 200;

  return Response.json(status, { status: httpStatus });
}
