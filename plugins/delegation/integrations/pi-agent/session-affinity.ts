import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function sessionAffinityHeaders(pi: ExtensionAPI) {
  pi.on("before_provider_headers", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    for (const headerName of Object.keys(event.headers)) {
      const normalizedName = headerName.toLowerCase();
      // Normalize casing so an existing header cannot produce duplicate values.
      if (normalizedName === "x-session-affinity") {
        delete event.headers[headerName];
      } else if (ctx.model?.provider === "company" && normalizedName === "x-session-id") {
        delete event.headers[headerName];
      } else if (ctx.model?.provider === "company" && normalizedName === "session_id") {
        event.headers[headerName] = null;
      }
    }
    // Preserve the legacy company's x-session-id convention as well.
    if (ctx.model?.provider === "company") event.headers["x-session-id"] = sessionId;
    event.headers["x-session-affinity"] = sessionId;
  });
}
