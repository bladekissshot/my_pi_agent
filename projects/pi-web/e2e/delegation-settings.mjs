// Real production browser + SDK/plugin, isolated agent directory, zero model calls.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const web = process.env.E2E_RELEASE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const plugin = process.env.E2E_PLUGIN_ROOT || fileURLToPath(new URL('../../../plugins/delegation/', import.meta.url));
const artifacts = fileURLToPath(new URL('../test-results/delegation-settings/', import.meta.url));
await fs.mkdir(artifacts, { recursive: true });
const root = await fs.mkdtemp(path.join(tmpdir(), 'pi-web-delegation-e2e-'));
const agentDir = path.join(root, 'agent'), project = path.join(root, 'project');
await fs.mkdir(agentDir); await fs.mkdir(project);
await fs.writeFile(path.join(project, 'hello.txt'), 'fixture\n');
let modelCalls = 0;
const provider = http.createServer((_req, res) => { modelCalls++; res.writeHead(500); res.end('No model call should occur'); });
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${provider.address().port}`, api: 'anthropic-messages', apiKey: 'test-only',
  models: [{ id: 'worker', name: 'Fixture worker', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 2000 }],
} } }));
await fs.writeFile(path.join(agentDir, 'auth.json'), '{}');
await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
  defaultProvider: 'fixture', defaultModel: 'worker', packages: [plugin], defaultTools: ['read', 'edit', 'write'],
  extensions: ['-builtin:mcp', '-builtin:codemode', '-builtin:llama.cpp'],
}));
const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env };
for (const key of Object.keys(env)) if (/API_KEY|(?:^|_)TOKEN(?:_|$)|PASSWORD|SECRET/.test(key) || key.startsWith('PI_WEB_')) delete env[key];
Object.assign(env, { NODE_ENV: 'production', PI_CODING_AGENT_DIR: agentDir, PI_WEB_HOSTNAME: '127.0.0.1', PI_WEB_SKIP_VERSION_CHECK: '1', PI_WEB_DEFAULT_CWD_ROOT: project });
const log = await fs.open(path.join(root, 'server.log'), 'a');
const server = spawn(process.execPath, [path.join(web, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: web, env, stdio: ['ignore', log.fd, log.fd] });
await log.close();
let browser, page;
const readDefaults = async () => JSON.parse(await fs.readFile(path.join(agentDir, 'pi-delegation/config.json'), 'utf8'));
const runFiles = async () => (await fs.readdir(path.join(agentDir, 'pi-delegation/runs')).catch(() => [])).filter(name => name.endsWith('.json'));
const readRun = async name => JSON.parse(await fs.readFile(path.join(agentDir, 'pi-delegation/runs', name), 'utf8'));
try {
  const deadline = Date.now() + 60000;
  while (true) {
    const response = await fetch(origin + '/api/home').catch(() => null);
    if (response?.ok) break;
    if (server.exitCode !== null || Date.now() > deadline) throw new Error('Server not ready: ' + await fs.readFile(path.join(root, 'server.log'), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true });
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/?cwd=${encodeURIComponent(project)}`);
  const open = () => page.getByRole('button', { name: '插件配置', exact: true }).click();
  await open();
  const panel = page.getByRole('region', { name: '插件配置' });
  await panel.getByRole('button', { name: '新会话默认值', exact: true }).click();
  await panel.getByLabel('执行模型', { exact: true }).selectOption('fixture/worker');
  await panel.getByLabel('并发上限（1–8）').fill('3');
  await panel.locator('summary').click();
  const timeoutField = panel.getByLabel('验收超时（秒，10–3600）');
  await timeoutField.fill('90');
  await panel.getByRole('button', { name: '保存新会话默认值' }).click();
  await panel.getByText('默认值已保存，其他会话保持不变。').waitFor();
  const defaults = await readDefaults();
  assert.equal(defaults.maxConcurrent, 3); assert(!('maxTurns' in defaults)); assert.equal(defaults.taskTimeoutMs, 90000); assert.equal(defaults.mode, 'off');
  assert.deepEqual(await runFiles(), [], 'opening/saving defaults never starts a session');

  await panel.getByRole('button', { name: '当前会话', exact: true }).click();
  await panel.getByLabel('委派模式').selectOption('auto');
  await timeoutField.fill('120');
  await panel.getByRole('button', { name: '应用到当前会话' }).click();
  const dialog = page.getByRole('dialog', { name: '当前项目尚未准备 Git 仓库，请提供仓库地址' });
  await dialog.waitFor();
  assert.equal(await panel.isVisible(), false, 'configuration panel cannot cover native confirmation');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  let files = await runFiles(); assert.equal(files.length, 1);
  const firstFile = files[0], firstId = firstFile.replace(/\.json$/, '');
  assert.equal((await readRun(firstFile)).config.mode, 'off');
  assert.equal((await readRun(firstFile)).config.taskTimeoutMs, 90000, 'cancelled form applies no partial budget');
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.delegation-panel select[aria-label="委派模式"]')?.value === 'off');

  // Establish a local test baseline without a remote or any model, then exercise real AUTO activation.
  const git = args => execFileSync('git', args, { cwd: project, stdio: 'pipe', windowsHide: true });
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['add', 'hello.txt']); git(['commit', '-qm', 'fixture baseline']);
  await panel.getByLabel('委派模式').selectOption('auto');
  await panel.getByLabel('并发上限（1–8）').fill('2');
  await timeoutField.fill('120');
  await panel.getByRole('button', { name: '应用到当前会话' }).click();
  await panel.getByText('已应用。现有任务保留创建时的模型和预算。').waitFor();
  const live = await readRun(firstFile);
  assert.equal(live.config.mode, 'auto'); assert.equal(live.config.taskTimeoutMs, 120000); assert.equal(live.config.maxConcurrent, 2);
  assert.deepEqual(await readDefaults(), defaults);
  const toolsResponse = await fetch(`${origin}/api/agent/${firstId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'get_tools' }) });
  const tools = (await toolsResponse.json()).data;
  assert(tools.some(tool => tool.name === 'delegate_task' && tool.active));
  await open(); await open();
  await page.waitForFunction(() => document.querySelector('.delegation-panel select[aria-label="委派模式"]')?.value === 'auto');
  assert.equal(await panel.getByLabel('并发上限（1–8）').inputValue(), '2', 'reopening a pre-message session reads its own runtime');
  await panel.locator('summary').click();
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });

  // Browser refresh creates a fresh composer, not an implicit AUTO opt-in copied from its predecessor.
  await page.reload();
  await open();
  await panel.getByLabel('委派模式').waitFor();
  assert.equal(await panel.getByLabel('委派模式').inputValue(), 'off');
  assert.equal(await panel.getByLabel('并发上限（1–8）').inputValue(), '3');
  assert.equal((await readRun(firstFile)).config.mode, 'auto', 'another composer never changes the old session');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await page.locator('[data-mobile-toolbar-more]').click();
  await page.locator('[data-mobile-toolbar-action="plugins"]').click();
  await panel.waitFor();
  await panel.getByLabel('委派模式').waitFor();
  await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
  const layout = await panel.evaluate(element => ({ width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, page: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert(layout.width <= 390 && layout.scrollWidth <= layout.clientWidth + 1 && layout.page <= layout.viewport + 1, JSON.stringify(layout));
  assert.equal(modelCalls, 0, 'configuration must not consume model calls');
  assert.deepEqual(errors, []);
  const result = { result: 'PASS', modelCalls, scenarios: ['defaults without session', 'native Git cancellation without partial save', 'AUTO tool activation', 'session/default isolation', 'reopen unsent session', 'fresh composer OFF', 'desktop/mobile layout'], layout };
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill();
  await new Promise(resolve => setTimeout(resolve, 500));
  await fs.copyFile(path.join(root, 'server.log'), path.join(artifacts, 'server.log'));
  await new Promise(resolve => provider.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
