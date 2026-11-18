import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';
import { registerSettingsController } from 'pi-delegation/settings';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-web-delegation-route-'));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ packages: [], extensions: [] }));
await fs.writeFile(path.join(root, 'models.json'), '{"providers":{}}');
await fs.writeFile(path.join(root, 'auth.json'), '{}');
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PUT } = await jiti.import('./route.ts');
const request = (method, body, headers = {}, query = '') => new Request(`http://127.0.0.1:30141/api/delegation${query}`, {
  method, headers: { host: '127.0.0.1:30141', 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('configuration route: read-only opening, scoped defaults, atomic validation and conflicts', async () => {
  const originalSessions = globalThis.__piSessions;
  let mutations = 0;
  const current = { sessionId: 'live', revision: 'live-config', config: { mode: 'auto' }, models: [], tasks: [], repositoryReady: true };
  const release = registerSettingsController(path.join(root, 'pi-delegation'), 'live', { snapshot: async () => current, execute: async () => { mutations++; } });
  try {
    globalThis.__piSessions = new Map([['live', { isAlive: () => true }]]);
    const before = await (await GET(request('GET', undefined, {}, '?sessionId=live'))).json();
    assert.equal(before.current.sessionId, 'live');
    assert.equal(before.defaults.config.mode, 'off');
    assert.equal(await fs.stat(path.join(root, 'pi-delegation')).catch(() => null), null, 'opening writes no config or run');
    const absent = await (await GET(request('GET', undefined, {}, '?sessionId=absent'))).json();
    assert.equal(absent.current, null);
    assert.equal(globalThis.__piSessions.size, 1, 'GET never starts a wrapper');
    const saved = await PUT(request('PUT', { patch: { maxConcurrent: 8, taskTimeoutMs: 10000, panel: false }, revision: before.defaults.revision }));
    assert.equal(saved.status, 200);
    const after = await saved.json();
    assert.equal(after.config.maxConcurrent, 8);
    assert.equal(after.config.mode, 'off');
    assert.equal(mutations, 0, 'saving defaults does not mutate an open session');
    const file = path.join(root, 'pi-delegation', 'config.json');
    const bytes = await fs.readFile(file, 'utf8');
    for (const patch of [{ mode: 'auto' }, { maxTurns: 16 }, { maxConcurrent: 3, panel: 'no' }, { execModel: 'nonexistent/worker' }]) {
      assert.equal((await PUT(request('PUT', { patch, revision: after.revision }))).status, 400);
      assert.equal(await fs.readFile(file, 'utf8'), bytes);
    }
    assert.equal((await PUT(request('PUT', { patch: { panel: true }, revision: before.defaults.revision }))).status, 409);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    assert.equal((await GET(request('GET', undefined, { origin: 'https://attacker.invalid' }))).status, 403);
    assert.equal((await PUT(request('PUT', {}, { origin: 'https://attacker.invalid' }))).status, 403);
    assert.equal((await PUT(request('PUT', {}, { 'content-type': 'text/plain' }))).status, 415);
    assert.equal((await GET(request('GET', undefined, {}, '?sessionId=../auth'))).status, 400);
    await fs.writeFile(file, '{broken');
    assert.equal((await PUT(request('PUT', { patch: { panel: true }, revision: after.revision }))).status, 500);
    assert.equal(await fs.readFile(file, 'utf8'), '{broken', 'corrupt config is never overwritten');
  } finally {
    release();
    globalThis.__piSessions = originalSessions;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    delete globalThis.__piWebSharedModelRuntime;
    await fs.rm(root, { recursive: true, force: true });
  }
});
