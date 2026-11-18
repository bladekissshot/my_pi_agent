// One-shot local release checks and restart. No management server or idle daemon.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createRequire, findPackageJSON } = require('node:module');
const { pathToFileURL } = require('node:url');

const TERMINAL = new Set(['complete', 'rolled-back', 'failed']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}
function readConfig(file) {
  const config = json(file);
  for (const key of ['activeRoot', 'targetRoot', 'stateDir', 'agentDir', 'helperPath']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error(`Invalid local runtime ${key}`);
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid local runtime port');
  if (config.workspaceRoot && !path.isAbsolute(config.workspaceRoot)) throw new Error('Invalid workspace root');
  return config;
}
function inspectRelease(root) {
  const web = json(path.join(root, 'package.json'));
  if (web.name !== '@agegr/pi-web') throw new Error('The target is not a Pi Web release');
  const buildId = fs.readFileSync(path.join(root, '.next/BUILD_ID'), 'utf8').trim();
  const built = json(path.join(root, '.next/required-server-files.json'));
  const resolve = createRequire(path.join(root, 'package.json'));
  // Pi's SDK has an import-only export; require.resolve cannot resolve it.
  // Node 24's package lookup uses the import conditions without executing SDK code.
  const sdkManifest = findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(path.join(root, 'package.json')));
  if (!sdkManifest) throw new Error('Missing built Pi SDK');
  const sdk = json(sdkManifest);
  if (!sdk.main || !fs.existsSync(path.resolve(path.dirname(sdkManifest), sdk.main))) throw new Error('Missing built Pi SDK');
  if (!buildId || built.config?.env?.NEXT_PUBLIC_APP_VERSION !== web.version
      || built.config?.env?.NEXT_PUBLIC_PI_VERSION !== sdk.version
      || web.dependencies?.['@earendil-works/pi-coding-agent'] !== sdk.version) {
    throw new Error('Local build and SDK versions do not match; rebuild before refreshing');
  }
  const next = resolve.resolve('next/dist/bin/next');
  const cli = path.join(root, 'bin/pi-web.js');
  if (!fs.existsSync(cli)) throw new Error('Missing Pi Web launcher');
  if (!fs.existsSync(path.join(root, '.next/server/app/api/local-refresh/route.js'))) {
    throw new Error('The build does not include the local refresh protocol');
  }
  return { webVersion: web.version, sdkVersion: sdk.version, buildId, next, cli };
}
function readJob(config) {
  try { return json(path.join(config.stateDir, 'refresh.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function gateActive(config) {
  try {
    const gate = json(path.join(config.stateDir, 'drain.json'));
    return gate.expiresAt > Date.now() && isAlive(gate.workerPid);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function status(file) {
  const config = readConfig(file);
  let target = null, targetError = null;
  try { target = inspectRelease(config.targetRoot); } catch { targetError = 'The registered local build is unavailable or incompatible'; }
  const job = readJob(config);
  if (job && !TERMINAL.has(job.state) && Date.now() - job.startedAt > 120000 && !isAlive(job.workerPid)) {
    job.state = 'failed'; job.error = 'Refresh helper exited unexpectedly; inspect the local log before retrying';
    atomicJson(path.join(config.stateDir, 'refresh.json'), job);
    fs.rmSync(path.join(config.stateDir, 'refresh.lock'), { recursive: true, force: true });
  }
  // Only public version metadata goes to the browser, never paths or credentials.
  return { target: target && { webVersion: target.webVersion, sdkVersion: target.sdkVersion, buildId: target.buildId }, targetError, job };
}
function begin(file, oldPid, instance) {
  const config = readConfig(file);
  const target = inspectRelease(config.targetRoot);
  fs.mkdirSync(config.stateDir, { recursive: true });
  const lock = path.join(config.stateDir, 'refresh.lock');
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('A local refresh is already in progress'), { status: 409 });
    throw error;
  }
  const job = { id: crypto.randomUUID(), state: 'checking', startedAt: Date.now(), workerPid: null,
    target: { webVersion: target.webVersion, sdkVersion: target.sdkVersion, buildId: target.buildId } };
  try {
    atomicJson(path.join(config.stateDir, 'refresh.json'), job);
    const child = spawn(process.execPath, [config.helperPath, 'refresh', file, job.id, String(oldPid), instance], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    if (!child.pid) throw new Error('Could not start the one-shot refresh helper');
    job.workerPid = child.pid;
    atomicJson(path.join(config.stateDir, 'refresh.json'), job);
    child.once('error', () => {
      atomicJson(path.join(config.stateDir, 'refresh.json'), { ...job, state: 'failed', error: 'Could not start the refresh helper' });
      fs.rmSync(lock, { recursive: true, force: true });
    });
    child.unref();
    return job;
  } catch (error) {
    try { atomicJson(path.join(config.stateDir, 'refresh.json'), { ...job, state: 'failed', error: 'Could not start the refresh helper' }); }
    finally { fs.rmSync(lock, { recursive: true, force: true }); }
    throw error;
  }
}
function environment(config, file, instance) {
  return { ...process.env, PI_CODING_AGENT_DIR: config.agentDir,
    ...(config.workspaceRoot ? { PI_WEB_DEFAULT_CWD_ROOT: config.workspaceRoot } : {}),
    PI_WEB_LOCAL_REFRESH_CONFIG: file, PI_WEB_LOCAL_REFRESH_TOKEN: crypto.randomUUID(),
    PI_WEB_RUNTIME_INSTANCE: instance, PI_WEB_HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' };
}
function runStart(file) {
  const config = readConfig(file);
  const command = process.argv[2];
  const job = readJob(config);
  if ((!command || command === 'start' || command.startsWith('-')) && job && !TERMINAL.has(job.state) && isAlive(job.workerPid)) {
    throw new Error('A local refresh is in progress; wait for it to finish instead of starting another server');
  }
  inspectRelease(config.activeRoot);
  Object.assign(process.env, environment(config, file, crypto.randomUUID()));
  require(path.join(config.activeRoot, 'bin/pi-web.js'));
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function startWindowsNext(root, args, env, log, fd) {
  // A detached Windows process has no console to pass to git or other CLI
  // children. Let Next inherit the hidden launcher's console and log handles.
  // Starting it outside Node's child job lets it survive the one-shot worker.
  const pidFile = `${log}.${crypto.randomUUID()}.pid`;
  const script = `
    $ErrorActionPreference = 'Stop'
    $launch = ConvertFrom-Json -InputObject $env:PI_WEB_WINDOWS_LAUNCH
    Remove-Item Env:PI_WEB_WINDOWS_LAUNCH
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $launch.node
    $start.Arguments = $launch.commandLine
    $start.WorkingDirectory = $launch.root
    $start.UseShellExecute = $false
    $start.WindowStyle = 'Hidden'
    $server = [Diagnostics.Process]::Start($start)
    try { [IO.File]::WriteAllText($launch.pidFile, [string]$server.Id) }
    catch { $server.Kill(); throw }
  `;
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    // Next inherits the real log handles, including after PowerShell exits.
    // The arguments are a file path and fixed Next flags. None can contain a
    // double quote or end in a separator. Paths travel as data through PowerShell.
    const commandLine = args.map(arg => '"' + arg + '"').join(' ');
    const launch = JSON.stringify({ node: process.execPath, root, commandLine, pidFile });
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: root, env: { ...env, PI_WEB_WINDOWS_LAUNCH: launch }, windowsHide: true, stdio: ['ignore', fd, fd],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Could not launch the Windows server; see the local refresh log');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid Windows server PID');
    return pid;
  } finally { fs.rmSync(pidFile, { force: true }); }
}
async function startNext(root, port, env, log) {
  const release = inspectRelease(root);
  // Keep the upstream proxy-bypass protection on direct restart/probe launches.
  const rotation = require(path.join(root, 'bin/rotate-preview-secrets.js')).rotatePreviewSecrets(path.join(root, '.next'));
  if (!rotation.ok) throw new Error('Could not rotate the release preview secrets safely');
  const args = [release.next, 'start', '-H', '127.0.0.1', '-p', String(port)];
  const records = require(path.join(root, 'bin/run-records.js'));
  const dir = records.getRunDir(env);
  const fd = fs.openSync(log, 'a', 0o600);
  let child, pid;
  try {
    if (process.platform === 'win32') {
      pid = startWindowsNext(root, args, env, log, fd);
    } else {
      child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
      await once(child, 'spawn');
      pid = child.pid;
    }
  } finally { fs.closeSync(fd); }
  const server = { pid, runtimePassword: env.PI_WEB_PASSWORD, unref: () => child?.unref(),
    removeRecord: () => records.removeRunRecord(dir, pid) };
  try {
    records.writeRunRecord(dir, { pid, nextPid: pid, port, hostname: '127.0.0.1',
      url: `http://127.0.0.1:${port}`, version: release.webVersion, startedAt: new Date().toISOString() });
    return server;
  } catch (error) { await stopChild(server); throw error; }
}
async function ready(child, port, expected, instance, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) throw new Error('The target server exited during startup');
    try {
      const headers = child.runtimePassword ? { Authorization: 'Basic ' + Buffer.from(`pi:${child.runtimePassword}`).toString('base64') } : {};
      const response = await fetch(`http://127.0.0.1:${port}/api/local-refresh`, { headers, signal: AbortSignal.timeout(2000) });
      const data = response.ok && await response.json();
      if (data?.current?.webVersion === expected.webVersion && data.current.sdkVersion === expected.sdkVersion && data.current.buildId === expected.buildId && data.instance === instance) {
        const page = await fetch(`http://127.0.0.1:${port}/`, { headers, signal: AbortSignal.timeout(5000) });
        if (page.ok && (await page.text()).includes('<title>Pi Web</title>')) return;
      }
    } catch { /* Retry readiness, not the user's prompts. */ }
    await pause(100);
  }
  throw new Error('The target did not pass its startup health check');
}
async function stopChild(child) {
  if (!child) return;
  try {
    if (isAlive(child.pid)) {
      process.kill(child.pid);
      const deadline = Date.now() + 3000;
      while (isAlive(child.pid) && Date.now() < deadline) await pause(100);
      if (isAlive(child.pid)) { process.kill(child.pid, 'SIGKILL'); await waitGone(child.pid); }
    }
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
  child.removeRecord();
}
async function waitGone(pid) {
  const deadline = Date.now() + 10000;
  while (isAlive(pid) && Date.now() < deadline) await pause(100);
  if (isAlive(pid)) throw new Error('The previous server did not stop');
}
async function refresh(file, id, oldPid, instance, hooks = {}) {
  const config = readConfig(file);
  const oldJob = readJob(config);
  if (oldJob?.id !== id || oldJob.state !== 'checking' || !Number.isSafeInteger(oldPid) || oldPid <= 0 || !instance) throw new Error('Invalid refresh operation');
  // Let the initiating POST finish and record the helper PID before any action.
  await pause(hooks.delayMs ?? 300);
  const update = (state, extra = {}) => atomicJson(path.join(config.stateDir, 'refresh.json'), { ...oldJob, workerPid: process.pid, state, ...extra });
  const log = path.join(config.stateDir, 'refresh.log');
  let preview, replacement, draining = false, stopped = false;
  const ops = { freePort, startNext, ready, stopChild, waitGone, kill: pid => process.kill(pid), ...hooks };
  let target, previous;
  const call = hooks.call || (async action => {
    const headers = { 'Content-Type': 'application/json', 'X-Pi-Refresh-Token': process.env.PI_WEB_LOCAL_REFRESH_TOKEN };
    if (process.env.PI_WEB_PASSWORD) headers.Authorization = 'Basic ' + Buffer.from(`pi:${process.env.PI_WEB_PASSWORD}`).toString('base64');
    const response = await fetch(`http://127.0.0.1:${config.port}/api/local-refresh`, { method: 'POST', headers,
      body: JSON.stringify({ action, id, instance }), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || data.pid !== oldPid || data.instance !== instance) throw new Error('Runtime changed or is busy; restart was refused');
    return data;
  });
  try {
    target = inspectRelease(config.targetRoot);
    previous = inspectRelease(config.activeRoot);
    update('checking');
    const port = await ops.freePort();
    const probeInstance = crypto.randomUUID();
    const probeEnv = environment(config, file, probeInstance);
    probeEnv.PI_CODING_AGENT_DIR = path.join(config.stateDir, 'probe', id);
    delete probeEnv.PI_WEB_PASSWORD;
    delete probeEnv.PI_WEB_LOCAL_REFRESH_CONFIG;
    preview = await ops.startNext(config.targetRoot, port, probeEnv, log);
    await ops.ready(preview, port, target, probeInstance);
    await ops.stopChild(preview); preview = null;
    // The service sets an admission gate and checks all jobs again before shutdown.
    update('restarting');
    await call('drain'); draining = true;
    await call('shutdown');
    atomicJson(path.join(config.stateDir, 'config.before-refresh.json'), config);
    ops.kill(oldPid); stopped = true;
    await ops.waitGone(oldPid);
    atomicJson(file, { ...config, activeRoot: config.targetRoot });
    const nextInstance = crypto.randomUUID();
    const nextEnv = environment(config, file, nextInstance);
    // Loopback health checks authenticate when browser password login is enabled.
    replacement = await ops.startNext(config.targetRoot, config.port, nextEnv, log);
    await ops.ready(replacement, config.port, target, nextInstance);
    replacement.unref();
    update('complete', { finishedAt: Date.now() });
  } catch (error) {
    fs.appendFileSync(log, `\nRefresh ${id}: ${error.stack || error}\n`, { mode: 0o600 });
    await ops.stopChild(preview);
    await ops.stopChild(replacement);
    if (stopped) {
      try {
        atomicJson(file, config);
        const rollbackInstance = crypto.randomUUID();
        const rollback = await ops.startNext(config.activeRoot, config.port, environment(config, file, rollbackInstance), log);
        try { await ops.ready(rollback, config.port, previous, rollbackInstance); }
        catch (cause) { await ops.stopChild(rollback); throw cause; }
        rollback.unref();
        update('rolled-back', { error: 'New version failed its health check; the previous version was restored', finishedAt: Date.now() });
      } catch (cause) {
        fs.appendFileSync(log, `Rollback: ${cause.stack || cause}\n`);
        update('failed', { error: 'Restart and rollback failed; see the local refresh log', finishedAt: Date.now() });
      }
    } else {
      update('failed', { error: 'Local version check failed or the service became busy; current version was not changed', finishedAt: Date.now() });
    }
  } finally {
    if (draining && !stopped) await call('cancel').catch(() => {});
    fs.rmSync(path.join(config.stateDir, 'drain.json'), { force: true });
    fs.rmSync(path.join(config.stateDir, 'refresh.lock'), { recursive: true, force: true });
  }
}
module.exports = { atomicJson, readConfig, inspectRelease, readJob, gateActive, status, begin, runStart, refresh };
if (require.main === module) {
  const [command, file, id, pid, instance] = process.argv.slice(2);
  if (command === 'start') { process.argv = [process.argv[0], process.argv[1], '--port', String(readConfig(file).port), '--hostname', '127.0.0.1', '--no-open']; runStart(file); }
  else if (command === 'refresh') refresh(file, id, Number(pid), instance).catch(error => { console.error(error.message); process.exitCode = 1; });
  else throw new Error('Use pi-web-runtime.cjs start <config> or refresh <config> <id> <pid> <instance>');
}
