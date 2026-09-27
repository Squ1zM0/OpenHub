import { readDeepSeekEnv, startConnect, DEFAULT_USER_ID } from "@openhub/agent";
import { getConnectStore } from "@/src/lib/credential-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Start a DeepSeek connect flow.
 *
 * Proxy and browser engine are controlled by env vars so they can be
 * tuned without a redeploy:
 *
 *   BROWSERLESS_PROXY_TYPE=residential | datacenter  (default: residential)
 *   BROWSERLESS_PROXY_COUNTRY=us                     (default: us)
 *   BROWSERLESS_BROWSER=stealth | chromium | chrome  (default: unset)
 *
 * DeepSeek's CloudFront WAF blocks datacenter IPs. The residential proxy
 * is the reliable fix. If your Browserless plan doesn't include it, the
 * session-creation call will fail with a clear error naming the reason.
 *
 * The proxy body sent to Browserless accepts only: type, sticky, country,
 * city, state, preset. Sending extra keys (e.g. localeMatch) returns 400.
 */
export async function POST(): Promise<Response> {
  const env = readDeepSeekEnv();
  const connectStore = getConnectStore();

  const proxyType =
    (process.env.BROWSERLESS_PROXY_TYPE as
      | "residential"
      | "datacenter"
      | undefined) ?? "residential";
  const proxyCountry = process.env.BROWSERLESS_PROXY_COUNTRY ?? "us";
  const browser = process.env.BROWSERLESS_BROWSER as
    | "chrome"
    | "chromium"
    | "stealth"
    | undefined;

  try {
    const result = await startConnect(
      {
        browserlessToken: env.BROWSERLESS_TOKEN,
        browserlessUrl: env.BROWSERLESS_URL,
        credentialKeyHex: env.DEEPSEEK_CREDENTIAL_KEY,
        proxy: {
          type: proxyType,
          sticky: true,
          country: proxyCountry,
        },
        browser,
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
