import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PromptStore } from "pi-prompt-manager";

// Covers both conflict resolutions in the 0.17.0 merge: trusted settings plus
// immutable prompt binding, and the upstream non-blocking session_start dialog.
test("a pinned prompt survives startup dialogs and resume without trusting project settings", { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-prompt-runtime-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE"].map(key => [key, process.env[key]]));
  const sessions = [];
  let providerRequests = 0;
  const server = createServer((_request, response) => { providerRequests++; response.writeHead(500); response.end(); });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "model", cacheWarming: "off" }));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "untrusted-project", defaultModel: "must-not-load" }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "dummy", api: "openai-completions",
      models: [{ id: "model", name: "Fixture", reasoning: false, contextWindow: 1000, maxTokens: 100 }],
    } } }));
    await writeFile(join(agentDir, "extensions", "startup.ts"), `export default function (pi) {
      pi.on("session_start", async (_event, ctx) => { await ctx.ui.confirm("Fixture startup", "Continue?"); });
    }`);
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const { startRpcSession } = await jiti.import("./rpc-manager.ts");
    const store = new PromptStore(agentDir);
    const pinned = await store.create({ name: "Pinned", content: "PINNED ORIGINAL PROMPT", mode: "replace" });

    async function ready(started) {
      const { session } = started;
      sessions.push(session);
      const dialogs = [];
      const unsubscribe = session.onEvent(event => {
        if (event.type === "extension_ui_request" && event.method === "confirm") dialogs.push(event);
      });
      unsubscribe();
      assert.equal(dialogs.length, 1, "the wrapper must be available while its startup dialog waits");
      assert.equal((await session.send({ type: "get_state" })).systemPrompt, "PINNED ORIGINAL PROMPT");
      await session.send({ type: "extension_ui_response", id: dialogs[0].id, confirmed: true });
      await session.waitUntilReady();
      assert.equal(session.inner.settingsManager.isProjectTrusted(), false);
      assert.equal(session.inner.settingsManager.getDefaultProvider(), "fixture");
      assert.equal((await session.send({ type: "get_state" })).systemPrompt, "PINNED ORIGINAL PROMPT");
      assert.ok(session.inner.modelRuntime.getProvider("llama.cpp"), "keep the upstream built-in provider alongside the prompt extension");
      return session;
    }

    const started = await startRpcSession(`__new__${randomUUID()}`, "", cwd, { promptProfileId: pinned.id });
    const first = await ready(started);
    first.inner.sessionManager.appendMessage({ role: "user", content: "Fixture history, never sent to a model", timestamp: Date.now() });
    const file = first.inner.sessionFile;
    assert.ok(file);
    await first.shutdown();
    await store.update(pinned.id, { name: "Changed", content: "MUST NOT REBIND", mode: "replace" }, 1);
    const other = await store.create({ name: "Other", content: "OTHER DEFAULT", mode: "replace" });
    await store.activate(other.id);
    await ready(await startRpcSession(started.realSessionId, file, undefined));
    assert.equal(providerRequests, 0, "startup and resume must not prompt the model");
  } finally {
    for (const session of sessions) await session.shutdown();
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
