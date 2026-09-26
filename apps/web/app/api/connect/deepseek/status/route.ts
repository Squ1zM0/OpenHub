import { DEFAULT_USER_ID } from "@openhub/agent";
import { getCredentialStore } from "@/src/lib/credential-store";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const creds = await getCredentialStore().get(DEFAULT_USER_ID);
  if (!creds) return Response.json({ connected: false });
  return Response.json({
    connected: true,
    connected_at: creds.connected_at,
    account_hint: creds.account_hint ?? null,
  });
}

export async function DELETE(): Promise<Response> {
  await getCredentialStore().delete(DEFAULT_USER_ID);
  return Response.json({ ok: true });
}
