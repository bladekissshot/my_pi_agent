import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, POST } = await jiti.import('./route.ts');

const request = (method, body, extra = {}) => new Request('http://127.0.0.1:30141/api/local-refresh', {
  method, headers: { host: '127.0.0.1:30141', ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test('GET does not launch a helper; tasks, terminals and startup locks prevent restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-refresh-route-'));
  const original = { config: process.env.PI_WEB_LOCAL_REFRESH_CONFIG, instance: process.env.PI_WEB_RUNTIME_INSTANCE,
    sessions: globalThis.__piSessions, locks: globalThis.__piStartLocks, terminals: globalThis.__piWebTerminals };
  try {
    const configFile = path.join(root, 'config.json');
    const helperPath = path.join(root, 'helper.cjs');
    await fs.writeFile(configFile, JSON.stringify({ helperPath, stateDir: root, port: 30141 }));
    await fs.writeFile(helperPath, `exports.readConfig=()=>({stateDir:${JSON.stringify(root)}});
      exports.status=()=>({target:{webVersion:'0.17.0',sdkVersion:'1.5.2',buildId:'test'},targetError:null,job:null,buildAvailable:true});
      exports.begin=(_file,_pid,_instance,action)=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'started'))},action);return{id:'test',state:action==='restart'?'checking':'building'};};`);
    process.env.PI_WEB_LOCAL_REFRESH_CONFIG = configFile;
    process.env.PI_WEB_RUNTIME_INSTANCE = 'test-instance';
    globalThis.__piSessions = new Map();
    globalThis.__piStartLocks = new Map();
    globalThis.__piWebTerminals = new Map();
    assert.equal((await GET(request('GET'))).status, 200);
    assert.equal(await fs.stat(path.join(root, 'started')).catch(() => null), null);
    for (const busy of ['running', 'mutation', 'dialog', 'terminal', 'startup']) {
      globalThis.__piSessions = new Map(busy === 'running' || busy === 'mutation' || busy === 'dialog' ? [['a', {
        sessionId: 'a', inner: {}, isRunning: () => busy === 'running', isAwaitingInput: () => false, hasLocalRestartBlocker: () => busy === 'mutation' || busy === 'dialog',
      }]] : []);
      globalThis.__piWebTerminals = new Map(busy === 'terminal' ? [['t', { exited: false, listeners: new Set() }]] : []);
      globalThis.__piStartLocks = new Map(busy === 'startup' ? [['s', Promise.resolve()]] : []);
      assert.equal((await POST(request('POST', { action: 'restart' }))).status, 409, busy);
    }
    assert.equal(await fs.stat(path.join(root, 'started')).catch(() => null), null);
    assert.equal((await POST(request('POST', { action: 'build-and-restart', sourceRoot: 'other' }))).status, 400);
    assert.equal((await POST(request('POST', { action: 'build-and-restart' }, { origin: 'https://untrusted.invalid' }))).status, 403);
    assert.equal(await fs.stat(path.join(root, 'started')).catch(() => null), null);
    assert.equal((await POST(request('POST', { action: 'build-and-restart' }))).status, 202, 'building is permitted while a startup is busy');
    assert.equal(await fs.readFile(path.join(root, 'started'), 'utf8'), 'build-and-restart');
    globalThis.__piSessions = new Map(); globalThis.__piWebTerminals = new Map(); globalThis.__piStartLocks = new Map();
    assert.equal((await POST(request('POST', { action: 'restart' }))).status, 202);
    assert.equal(await fs.readFile(path.join(root, 'started'), 'utf8'), 'restart');
    assert.equal((await POST(request('POST', { action: 'shutdown', id: 'test', instance: 'test-instance' }))).status, 403);
    assert.equal((await POST(request('POST', { action: 'restart' }, { origin: 'https://attacker.invalid' }))).status, 403);
  } finally {
    if (original.config === undefined) delete process.env.PI_WEB_LOCAL_REFRESH_CONFIG; else process.env.PI_WEB_LOCAL_REFRESH_CONFIG = original.config;
    if (original.instance === undefined) delete process.env.PI_WEB_RUNTIME_INSTANCE; else process.env.PI_WEB_RUNTIME_INSTANCE = original.instance;
    globalThis.__piSessions = original.sessions; globalThis.__piStartLocks = original.locks; globalThis.__piWebTerminals = original.terminals;
    await fs.rm(root, { recursive: true, force: true });
  }
});
