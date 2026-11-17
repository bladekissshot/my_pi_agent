// Monorepo-only production check: real page click and real one-shot process exit.
// All runtime data uses a private fixture directory; no model is prompted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const artifacts = new URL('../test-results/local-refresh/', import.meta.url);
await fs.mkdir(artifacts, { recursive: true });
const web = process.env.E2E_RELEASE_ROOT || path.join(root, 'projects/pi-web');
const helperPath = path.join(root, 'scripts/pi-web-runtime.cjs');
const helper = createRequire(import.meta.url)(helperPath);
const testDir = await fs.mkdtemp(path.join(tmpdir(), 'pi-web-local-refresh-e2e-'));
await fs.mkdir(path.join(testDir, 'project'), { recursive: true });
const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const file = path.join(testDir, 'runtime.json');
const config = { activeRoot: web, targetRoot: web, stateDir: path.join(testDir, 'state'), agentDir: path.join(testDir, 'agent'), workspaceRoot: path.join(testDir, 'project'), helperPath, port };
helper.atomicJson(file, config);
const logs = await fs.open(path.join(testDir, 'server.log'), 'a');
const env = { ...process.env, PI_WEB_PASSWORD: '', PI_WEB_SKIP_VERSION_CHECK: '1' };
for (const key of Object.keys(env)) {
  if (/API_KEY|(?:^|_)TOKEN(?:_|$)|SECRET/.test(key)) delete env[key];
}
const server = spawn(process.execPath, [helperPath, 'start', file], { cwd: root, env, stdio: ['ignore',logs.fd,logs.fd] });
await logs.close();
let browser;
try {
  const deadline = Date.now() + 60000;
  let status;
  let lastResponse;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-refresh`).catch(() => null);
    if (response?.ok) { status = await response.json(); break; }
    if (response) lastResponse = { status: response.status, body: await response.text() };
    if (server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(status?.available, 'managed runtime should be ready: ' + JSON.stringify({ lastResponse, log: await fs.readFile(path.join(testDir, 'server.log'), 'utf8') }));
  assert.equal(status.job, null, 'GET starts no operation');
  const originalInstance = status.instance;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true });
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?cwd=${encodeURIComponent(config.workspaceRoot)}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Application', exact: true }).click();
  const button = page.getByRole('button', { name: 'Check local build and restart', exact: true });
  await button.waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Check local build and restart');
    return button && !button.disabled;
  });
  assert.equal(await button.isEnabled(), true);
  assert.equal(helper.readJob(config), null, 'opening the tab starts no helper');
  page.once('dialog', dialog => dialog.accept());
  await Promise.all([page.waitForEvent('load', { timeout: 90000 }), button.click()]);
  const response = await fetch(`http://127.0.0.1:${port}/api/local-refresh`);
  const next = await response.json();
  assert.equal(next.job.state, 'complete', JSON.stringify(next));
  assert.notEqual(next.instance, originalInstance, 'even a same-version restart must prove the instance changed');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.throws(() => process.kill(next.job.workerPid, 0), 'no management helper may stay alive');
  assert.equal(helper.gateActive(config), false);
  assert.deepEqual(errors, []);
  const result = { result: 'PASS', scenario: 'settings click, isolated probe, runtime restart, automatic page reload, helper exit', current: next.current, workerExited: true };
  await fs.writeFile(new URL('result.json', artifacts), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  const job = helper.readJob(config);
  if (job?.workerPid) { try { process.kill(job.workerPid); } catch { /* Already exited. */ } }
  const dirs = [path.join(config.agentDir, 'pi-web-run')];
  const probe = path.join(config.stateDir, 'probe');
  for (const id of await fs.readdir(probe).catch(() => [])) dirs.push(path.join(probe,id,'pi-web-run'));
  for (const dir of dirs) for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const bytes = await fs.readFile(path.join(dir,name),'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!bytes) continue;
    const record = JSON.parse(bytes);
    for (const pid of new Set([record.pid, record.nextPid])) if (pid) { try { process.kill(pid); } catch {} }
  }
  if (server.exitCode === null) server.kill();
  await new Promise(resolve => setTimeout(resolve, 200));
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
