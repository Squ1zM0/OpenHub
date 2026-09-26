import { readDeepSeekEnv, pollConnect } from "@openhub/agent";
import {
  getConnectStore,
  getCredentialStore,
} from "@/src/lib/credential-store";

export const runtime = "nodejs";
export const maxDuration = 60;

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
