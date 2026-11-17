import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { jsonResponse } = await jiti.import("./json-response.ts");

test("leaves large JSON unencoded for Next's HTTP compression", async () => {
  const response = jsonResponse(
    new Request("http://localhost/test", { headers: { "Accept-Encoding": "gzip" } }),
    { value: "large payload ".repeat(200) },
  );

  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.equal((await response.json()).value, "large payload ".repeat(200));
});

test("preserves response status and application headers", async () => {
  const response = jsonResponse(
    new Request("http://localhost/test", { headers: { "Accept-Encoding": "gzip;q=invalid, *;q=1" } }),
    { value: "large payload ".repeat(200) },
    { status: 202, headers: { Vary: "Origin", "Cache-Control": "private, no-cache" } },
  );

  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("Vary"), "Origin");
  assert.equal(response.headers.get("Cache-Control"), "private, no-cache");
  assert.equal((await response.json()).value, "large payload ".repeat(200));
});

test("leaves small JSON responses uncompressed", async () => {
  const response = jsonResponse(
    new Request("http://localhost/test", { headers: { "Accept-Encoding": "gzip" } }),
    { ok: true },
  );

  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.deepEqual(await response.json(), { ok: true });
});
