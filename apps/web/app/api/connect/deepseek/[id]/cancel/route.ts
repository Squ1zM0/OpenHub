import { cancelConnect } from "@openhub/agent";
import { getConnectStore } from "@/src/lib/credential-store";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const result = await cancelConnect(id, getConnectStore(), true);
  return Response.json(result);
}
