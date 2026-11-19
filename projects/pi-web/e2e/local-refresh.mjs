// Monorepo-only production check: real page click and real one-shot process exit.
// All runtime data uses a private fixture directory; no model is prompted.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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
const testBuild = process.env.E2E_LOCAL_BUILD === '1';
if (testBuild) {
  // Use a tiny trusted checkout so this test exercises a real snapshot, worker,
  // registration and cutover without installing dependencies in every E2E run.
  config.sourceRoot = path.join(testDir, 'source');
  config.releaseStore = path.join(testDir, 'releases');
  for (const [name, body] of Object.entries({
    'projects/pi/package-lock.json': '{}',
    'projects/pi-web/package-lock.json': '{}',
    'projects/pi-web/bin/prepare-terminal.js': '// fixture',
    'scripts/task.mjs': `import fs from 'node:fs'; import path from 'node:path';
      if (process.argv[2] === 'build-web') {
        const old = ${JSON.stringify(web)};
        for (const name of ['.next', 'bin', 'public', 'package.json', 'next.config.ts']) {
          fs.cpSync(path.join(old, name), path.join('projects/pi-web', name), { recursive: true, filter: file => !['cache','dev'].includes(path.basename(file)) });
        }
        fs.symlinkSync(path.join(old, 'node_modules'), path.resolve('projects/pi-web/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      }`,
  })) {
    const target = path.join(config.sourceRoot, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
  execFileSync('git', ['init', '-q'], { cwd: config.sourceRoot, windowsHide: true });
}
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
  const label = testBuild ? 'Build and restart local version' : 'Check local build and restart';
  const button = page.getByRole('button', { name: label, exact: true });
  await button.waitFor();
  await page.waitForFunction((name) => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === name);
    return button && !button.disabled;
  }, label);
  assert.equal(await button.isEnabled(), true);
  assert.equal(helper.readJob(config), null, 'opening the tab starts no helper');
  page.once('dialog', dialog => dialog.accept());
  await Promise.all([page.waitForEvent('load', { timeout: 90000 }), button.click()]);
  const response = await fetch(`http://127.0.0.1:${port}/api/local-refresh`);
  const next = await response.json();
  assert.equal(next.job.state, 'complete', JSON.stringify(next));
  if (testBuild) {
    assert.equal(next.job.action, 'build-and-restart');
    const registered = helper.readConfig(file);
    assert.ok(registered.activeRoot.startsWith(config.releaseStore + path.sep));
    assert.equal(registered.activeRoot, registered.targetRoot);
    assert.notEqual(registered.activeRoot, web);
  }
  assert.notEqual(next.instance, originalInstance, 'even a same-version restart must prove the instance changed');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.throws(() => process.kill(next.job.workerPid, 0), 'no management helper may stay alive');
  assert.equal(helper.gateActive(config), false);
  assert.deepEqual(errors, []);
  const result = { result: 'PASS', scenario: `settings click, ${testBuild ? 'source snapshot, build, ' : ''}isolated probe, runtime restart, automatic page reload, helper exit`, current: next.current, workerExited: true };
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
