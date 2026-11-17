export function jsonResponse(
  _request: Request,
  data: unknown,
  init: ResponseInit = {},
): Response {
  const body = JSON.stringify(data);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  // Next 16.4.5+ strips Content-Encoding from route responses. Its HTTP server
  // negotiates compression; encoding here leaves clients with an extra gzip layer.
  return new Response(body, { ...init, headers });
}
