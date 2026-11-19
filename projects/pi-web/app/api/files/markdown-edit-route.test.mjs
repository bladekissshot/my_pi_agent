import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET, POST } = await jiti.import("./[...path]/route.ts");
const { encodeFilePathForApi } = await jiti.import("../../../lib/file-paths.ts");
const { NextRequest } = await jiti.import("next/server");

function fixture(t, contents = "# original\n") {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-markdown-edit-")));
  const root = path.join(base, "workspace");
  fs.mkdirSync(root);
  const file = path.join(root, "笔记.MD");
  fs.writeFileSync(file, contents);
  const previous = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60_000 };
  t.after(() => {
    globalThis.__piAllowedRootsCache = previous;
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root, file };
}

function request(file, { etag, body, headers, sessionId } = {}) {
  const encoded = encodeFilePathForApi(file);
  const url = new URL(`http://localhost/api/files/${encoded}?type=edit`);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  const init = { headers: { host: "localhost", ...headers } };
  if (body !== undefined) {
    init.method = "POST";
    init.body = body;
    init.duplex = "half";
    init.headers["Content-Type"] = "text/plain; charset=utf-8";
    if (etag) init.headers["If-Match"] = etag;
  }
  return (init.method === "POST" ? POST : GET)(new NextRequest(url, init), {
    params: Promise.resolve({ path: encoded.split("/").map(decodeURIComponent) }),
  });
}

test("loads the whole Markdown file and saves Unicode with the original BOM and CRLF", async (t) => {
  const { file, root } = fixture(t, "\uFEFF# original\r\n\r\ntext");
  const opened = await request(file);
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("cache-control"), "no-store");
  const { content, etag } = await opened.json();
  assert.equal(content, "# original\n\ntext");
  const saved = await request(file, { etag, body: "# 新笔记\n\n🙂\n" });
  assert.equal(saved.status, 200);
  const next = await saved.json();
  assert.notEqual(next.etag, etag);
  assert.equal(fs.readFileSync(file, "utf8"), "\uFEFF# 新笔记\r\n\r\n🙂\r\n");
  assert.deepEqual(fs.readdirSync(root), ["笔记.MD"]);
  assert.equal((await request(file, { etag: next.etag, body: "" })).status, 200);
  assert.equal(fs.readFileSync(file, "utf8"), "\uFEFF");
});

test("requires a base version and refuses to overwrite same-size, same-mtime or deleted files", async (t) => {
  const { file } = fixture(t, "old\n");
  const timestamp = new Date("2025-01-01T00:00:00Z");
  fs.utimesSync(file, timestamp, timestamp);
  const { etag } = await (await request(file)).json();
  assert.equal((await request(file, { body: "missing version" })).status, 428);
  fs.writeFileSync(file, "new\n");
  fs.utimesSync(file, timestamp, timestamp);
  assert.equal((await request(file, { etag, body: "stale draft" })).status, 412);
  assert.equal(fs.readFileSync(file, "utf8"), "new\n");
  fs.unlinkSync(file);
  assert.equal((await request(file, { etag, body: "stale draft" })).status, 404);
  assert.equal(fs.existsSync(file), false);
});

test("rechecks the version after staging and leaves no temporary file on a conflict", async (t) => {
  const { file, root } = fixture(t);
  const { etag } = await (await request(file)).json();
  const sync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd) => {
    fs.writeFileSync(file, "external write\n");
    return sync(fd);
  });
  assert.equal((await request(file, { etag, body: "draft" })).status, 412);
  assert.equal(fs.readFileSync(file, "utf8"), "external write\n");
  assert.deepEqual(fs.readdirSync(root), ["笔记.MD"]);
});

test("simultaneous editor saves cannot both replace the same version", async (t) => {
  const { file } = fixture(t);
  const { etag } = await (await request(file)).json();
  const responses = await Promise.all([
    request(file, { etag, body: "first" }),
    request(file, { etag, body: "second" }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 412]);
  assert.equal(fs.readFileSync(file, "utf8"), responses[0].ok ? "first" : "second");
});

test("denies cross-site requests and paths outside the workspace, even with a session ID", async (t) => {
  const { base, file, root } = fixture(t);
  const { etag } = await (await request(file)).json();
  assert.equal((await request(file, { etag, body: "cross-site", headers: { origin: "https://example.com", "sec-fetch-site": "cross-site" } })).status, 403);
  const other = path.join(base, "outside.md");
  fs.writeFileSync(other, "outside");
  assert.equal((await request(other, { sessionId: "some-session" })).status, 403);
  assert.equal((await request(other, { sessionId: "some-session", etag, body: "overwrite" })).status, 403);
  const linked = path.join(root, "linked");
  fs.symlinkSync(base, linked, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await request(path.join(linked, "outside.md"))).status, 403);
  assert.equal((await request(path.join(linked, "outside.md"), { etag, body: "overwrite" })).status, 403);
  assert.equal(fs.readFileSync(other, "utf8"), "outside");
});

test("refuses non-Markdown, non-UTF-8, mixed line endings and oversized reads or chunked writes", async (t) => {
  const { root, file } = fixture(t);
  const { etag } = await (await request(file)).json();
  const chunked = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(256 * 1024));
    controller.enqueue(Uint8Array.of(65));
    controller.close();
  } });
  assert.equal((await request(file, { etag, body: chunked })).status, 413);
  assert.equal(fs.readFileSync(file, "utf8"), "# original\n");
  for (const [name, contents, status] of [
    ["not-markdown.txt", "# text", 415],
    ["bad-encoding.md", Buffer.from([0xff, 0xfe, 0x31, 0x00]), 415],
    ["mixed.md", "a\r\nb\n", 415],
    ["large.md", Buffer.alloc(256 * 1024 + 1, 65), 413],
  ]) {
    const target = path.join(root, name);
    fs.writeFileSync(target, contents);
    assert.equal((await request(target)).status, status, name);
  }
});
