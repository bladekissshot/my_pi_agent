import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { assertLocalRefreshAdmission } from "@/lib/local-refresh";
import { getRpcSession } from "@/lib/rpc-manager";
import { readDelegationSettings, writeDelegationDefaults } from "@/lib/delegation-settings";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const status = (error as { status?: number })?.status;
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, {
    status: status && [400, 404, 409, 503].includes(status) ? status : 500,
  });
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const sessionId = new URL(req.url).searchParams.get("sessionId") || undefined;
  if (sessionId && !/^[a-zA-Z0-9-]{1,100}$/.test(sessionId)) return Response.json({ error: "Invalid session id" }, { status: 400 });
  try {
    // Opening the panel never starts a session, runs a command or reloads extensions.
    const liveId = sessionId && getRpcSession(sessionId)?.isAlive() ? sessionId : undefined;
    return Response.json(await readDelegationSettings(liveId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Expected JSON" }, { status: 415 });
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["patch", "revision"].includes(key))) {
    return Response.json({ error: "Expected patch and revision" }, { status: 400 });
  }
  try {
    assertLocalRefreshAdmission();
    return Response.json(await writeDelegationDefaults(body.patch, body.revision));
  } catch (error) { return failure(error); }
}
