import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const jiti = createJiti(import.meta.url);
const { isLocalRefreshRequest, assertLocalRefreshAdmission } = await jiti.import('./local-refresh.ts');
const { sanitizeProjectCommandEnvironment } = await jiti.import('./project-command-env.ts');

const req = (url, headers = {}) => new Request(url, { headers: { host: new URL(url).host, ...headers } });
test('local refresh refuses cross-site and remote/custom-host requests', () => {
  assert.equal(isLocalRefreshRequest(req('http://127.0.0.1:30141/api/local-refresh')), true);
  assert.equal(isLocalRefreshRequest(req('http://localhost:30141/api/local-refresh', { origin: 'http://localhost:30141' })), true);
  assert.equal(isLocalRefreshRequest(req('http://localhost:30141/api/local-refresh', { host: '127.0.0.1:30141', origin: 'http://127.0.0.1:30141' })), true, 'Next reconstructs loopback URLs using localhost');
  for (const request of [
    req('http://192.168.1.10:30141/api/local-refresh'),
    req('http://attacker.invalid:30141/api/local-refresh'),
    req('http://127.0.0.1:30141/api/local-refresh', { origin: 'http://attacker.invalid' }),
    req('http://127.0.0.1:30141/api/local-refresh', { 'sec-fetch-site': 'cross-site' }),
    req('http://127.0.0.1:30141/api/local-refresh', { host: 'attacker.invalid' }),
  ]) assert.equal(isLocalRefreshRequest(request), false);
});

test('a live drain rejects new work and expires if the helper dies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-refresh-gate-'));
  const previous = process.env.PI_WEB_LOCAL_REFRESH_CONFIG;
  try {
    const helperPath = createRequire(import.meta.url).resolve('../../../scripts/pi-web-runtime.cjs');
    const file = path.join(root, 'config.json');
    await fs.writeFile(file, JSON.stringify({ activeRoot: root, targetRoot: root, stateDir: root, agentDir: root, helperPath, port: 30141 }));
    process.env.PI_WEB_LOCAL_REFRESH_CONFIG = file;
    assert.doesNotThrow(assertLocalRefreshAdmission);
    await fs.writeFile(path.join(root, 'drain.json'), JSON.stringify({ workerPid: process.pid, expiresAt: Date.now() + 5000 }));
    assert.throws(assertLocalRefreshAdmission, error => error.status === 503);
    await fs.writeFile(path.join(root, 'drain.json'), JSON.stringify({ workerPid: process.pid, expiresAt: Date.now() - 1 }));
    assert.doesNotThrow(assertLocalRefreshAdmission);
    await fs.writeFile(path.join(root, 'drain.json'), JSON.stringify({ workerPid: 2147483647, expiresAt: Date.now() + 5000 }));
    assert.doesNotThrow(assertLocalRefreshAdmission, 'a dead helper must not leave admissions disabled');
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_LOCAL_REFRESH_CONFIG; else process.env.PI_WEB_LOCAL_REFRESH_CONFIG = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project commands cannot inherit the local restart token or configuration', () => {
  const env = { PATH: 'fixture', PI_WEB_LOCAL_REFRESH_TOKEN: 'fixture-only', PI_WEB_LOCAL_REFRESH_CONFIG: '/fixture/config.json', USER_VALUE: 'kept' };
  assert.deepEqual(sanitizeProjectCommandEnvironment(env), { PATH: 'fixture', USER_VALUE: 'kept' });
});
