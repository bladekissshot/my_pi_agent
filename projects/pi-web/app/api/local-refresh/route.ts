import { NextResponse } from "next/server";
import {
  authorizeRefreshWorker, beginLocalRefresh, clearRefreshDrain, isLocalRefreshRequest,
  localRefreshStatus, setRefreshDrain,
} from "@/lib/local-refresh";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getTerminalStats } from "@/lib/terminal-manager";
import { hasActiveSessionLivenessProvider } from "@/lib/session-liveness";
import { getSessionIdsWithUnsettledSubagentRuns } from "@/lib/subagent-runtime";
import "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// Conservative: refuse restarts during startup, tools, dialogs, detached plugin
// work, mutating commands or live terminals, not just visible model streaming.
function blockers(): number {
  let count = globalThis.__piStartLocks?.size ?? 0;
  for (const session of globalThis.__piSessions?.values() ?? []) {
    if (session.isRunning() || session.isAwaitingInput() || session.hasLocalRestartBlocker()
      || hasActiveSessionLivenessProvider({ sessionId: session.sessionId, sessionFile: session.inner.sessionFile ?? undefined })) count++;
  }
  count += getSessionIdsWithUnsettledSubagentRuns().length;
  const terminals = getTerminalStats();
  return count + terminals.count - terminals.exited;
}
function denied(request: Request): boolean {
  return !isApiRequestAllowed(request) || !isLocalRefreshRequest(request);
}
function failure(error: unknown) {
  const cause = error as { message?: string; status?: number };
  if (!cause.status || cause.status >= 500) console.error("[pi-web] local refresh:", error);
  return NextResponse.json({ error: cause.status === 409 ? cause.message : "Local refresh failed; check the local log", code: cause.status === 409 ? "busy" : "failed" }, { status: cause.status ?? 500 });
}
export async function GET(request: Request) {
  if (denied(request)) return NextResponse.json({ error: "Local requests only" }, { status: 403 });
  try { return NextResponse.json(localRefreshStatus(blockers()), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (denied(request)) return NextResponse.json({ error: "Local requests only" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "JSON required" }, { status: 415 });
  try {
    const body = await request.json() as { action?: string; id?: string; instance?: string };
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "JSON object required" }, { status: 400 });
    if (body.action === "restart") {
      if (blockers() > 0) throw Object.assign(new Error("Close running tasks and terminals before restarting"), { status: 409 });
      return NextResponse.json({ job: beginLocalRefresh() }, { status: 202 });
    }
    if (!["drain", "shutdown", "cancel"].includes(body.action ?? "")) return NextResponse.json({ error: "Unknown operation" }, { status: 400 });
    const config = authorizeRefreshWorker(request.headers.get("x-pi-refresh-token"), body.id, body.instance);
    if (body.action === "cancel") clearRefreshDrain(config);
    else {
      if (blockers() > 0) throw Object.assign(new Error("The runtime became busy; restart refused"), { status: 409 });
      setRefreshDrain(config, body.id!);
      if (body.action === "shutdown") {
        await Promise.all(Array.from(globalThis.__piSessions?.values() ?? [], session => session.shutdown()));
      }
    }
    return NextResponse.json({ pid: process.pid, instance: process.env.PI_WEB_RUNTIME_INSTANCE });
  } catch (error) { return failure(error); }
}
