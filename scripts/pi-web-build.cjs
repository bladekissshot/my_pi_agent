// Build source snapshots out of tree; never use the checkout's node_modules or .next.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const scopes = ['package.json', 'scripts', 'plugins', 'projects/pi', 'projects/pi-web'];
const excludedDirectories = new Set(['.git', '.local', '.next', '.pi', 'node_modules', 'dist', 'build', 'coverage', 'test-results', '.cache']);
const privateName = /^(?:\.env(?:\..*)?|auth\.json|credentials\.json|models\.json|settings\.json\.local|pi-web-local\.json|runtime\.json)$/i;
const stepTimeoutMs = 20 * 60_000;

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function buildEnvironment(env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^(?:PATH|PATHEXT|SystemRoot|ComSpec|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|TEMP|TMP|TMPDIR|LANG|LC_\w+|CI|NUMBER_OF_PROCESSORS|(?:HTTPS?|ALL|NO)_PROXY|NPM_CONFIG_(?:CACHE|USERCONFIG|REGISTRY|OFFLINE|PREFER_OFFLINE|STRICT_SSL|CAFILE)|NODE_EXTRA_CA_CERTS|SSL_CERT_(?:FILE|DIR)|GIT_(?:SSL_CAINFO|SSL_CAPATH))$/i.test(key)) continue;
    if (value !== undefined) result[key] = value;
  }
  return { ...result, NEXT_TELEMETRY_DISABLED: '1', npm_config_audit: 'false', npm_config_fund: 'false' };
}

function listFiles(root) {
  const gitEnv = { ...buildEnvironment(process.env), GIT_OPTIONAL_LOCKS: '0' };
  const git = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, env: gitEnv, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
  });
  const top = fs.realpathSync(git('rev-parse', '--show-toplevel').trim());
  if (path.relative(root, top)) throw new Error('The configured source must be the Git worktree root');
  const names = git('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...scopes).split('\0').filter(Boolean);
  return [...new Set(names)].sort().filter((name) => {
    const segments = name.split('/');
    if (name.includes('\\') || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
      throw new Error('The source contains a path that cannot be snapshotted safely');
    }
    if (!scopes.some(scope => name === scope || name.startsWith(scope + '/'))) return false;
    if (segments.some(segment => excludedDirectories.has(segment.toLowerCase()))) return false;
    const file = segments.at(-1);
    // Pi's versioned npm project configuration is required by the build.
    if (file.toLowerCase() === '.npmrc' && name !== 'projects/pi/.npmrc') return false;
    return !privateName.test(file) && !/\.(?:pem|key|p12|pfx)$/i.test(file);
  });
}

function sourceFiles(root, snapshot) {
  const hash = createHash('sha256');
  const sdk = createHash('sha256').update(`${process.version}/${process.platform}/${process.arch}\0`);
  for (const name of listFiles(root)) {
    const source = path.join(root, name);
    let stat, real;
    try {
      stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      real = fs.realpathSync(source);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; // unstaged deletions
      throw error;
    }
    // Refuse to traverse symlinks/junctions, even if the target is in this repo.
    if (path.relative(source, real)) continue;
    const bytes = fs.readFileSync(real);
    const entry = JSON.stringify([name, stat.mode & 0o777, bytes.length]);
    hash.update(entry).update('\0').update(bytes);
    if (name.startsWith('projects/pi/') || name === 'scripts/task.mjs' || name === 'scripts/process.mjs') {
      sdk.update(entry).update('\0').update(bytes);
    }
    if (snapshot) {
      const destination = path.join(snapshot, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: stat.mode & 0o777 });
      if (process.platform !== 'win32') fs.chmodSync(destination, stat.mode & 0o777);
    }
  }
  return { snapshotHash: hash.digest('hex'), sdkHash: sdk.digest('hex') };
}

const sdkMarker = '.pi-web-sdk-build.json';
function sdkPackages(root) { return path.join(root, 'projects', 'pi', 'packages'); }

function rememberSdk(root, sdkHash) {
  const packages = sdkPackages(root);
  const outputs = fs.readdirSync(packages, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.statSync(path.join(packages, entry.name, 'dist'), { throwIfNoEntry: false })?.isDirectory())
    .map(entry => entry.name).sort();
  fs.writeFileSync(path.join(root, sdkMarker), JSON.stringify({ sdkHash, outputs }), { flag: 'wx' });
}

function restoreSdk(activeWeb, root, sdkHash) {
  const active = path.resolve(activeWeb, '../..');
  if (path.relative(path.join(active, 'projects/pi-web'), activeWeb)) return false;
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(active, sdkMarker), 'utf8')); }
  catch { return false; }
  if (marker?.sdkHash !== sdkHash || !Array.isArray(marker.outputs) || !marker.outputs.includes('coding-agent')
    || !marker.outputs.every(name => typeof name === 'string' && /^[a-z0-9-]+$/.test(name))) return false;
  const from = sdkPackages(active);
  const to = sdkPackages(root);
  if (!marker.outputs.every(name => fs.statSync(path.join(from, name, 'dist'), { throwIfNoEntry: false })?.isDirectory()
    && fs.statSync(path.join(to, name, 'package.json'), { throwIfNoEntry: false })?.isFile())) return false;
  try {
    for (const name of marker.outputs) {
      fs.cpSync(path.join(from, name, 'dist'), path.join(to, name, 'dist'), { recursive: true, errorOnExist: true, force: false,
        filter: source => {
          const stat = fs.lstatSync(source);
          if (!stat.isFile() && !stat.isDirectory()) throw new Error('Previous SDK contains linked or special files');
          return true;
        },
      });
    }
    if (!fs.statSync(path.join(to, 'coding-agent/dist/index.js'), { throwIfNoEntry: false })?.isFile()) throw new Error('Previous SDK is incomplete');
    return true;
  } catch {
    for (const name of marker.outputs) fs.rmSync(path.join(to, name, 'dist'), { recursive: true, force: true });
    return false;
  }
}

function runStep(args, cwd, env, fd) {
  fs.writeSync(fd, `\n[${new Date().toISOString()}] ${args.join(' ')}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        try { execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); }
        catch { child.kill(); }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
      }
    }, stepTimeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (!timedOut && code === 0) resolve();
      else reject(new Error(`${args.join(' ')} ${timedOut ? 'timed out' : `failed (exit ${code})`}; see build.log`));
    });
  });
}

async function buildLocalRelease({ sourceRoot, releaseStore, jobId, env, log, activeRoot }, hooks = {}) {
  if (!sourceRoot || !releaseStore || !/^[a-zA-Z0-9-]{1,64}$/.test(jobId)) throw new Error('Invalid local source build configuration');
  const source = fs.realpathSync(sourceRoot);
  const active = fs.realpathSync(activeRoot);
  // Validate before mkdir as well as after resolving any junction in the store.
  function validateStore(store) {
    const local = path.join(source, '.local');
    if (inside(active, store) || (inside(source, store) && (!inside(local, store) || !path.relative(local, store)))) {
      throw new Error('The release store must be outside source directories and the running release');
    }
  }
  validateStore(path.resolve(releaseStore));
  fs.mkdirSync(releaseStore, { recursive: true });
  const store = fs.realpathSync(releaseStore);
  validateStore(store);
  const stage = fs.mkdtempSync(path.join(store, `build-${jobId}-`));
  // The directory stays at the same path after build: npm's Windows junctions
  // and Next tracing refer to it by absolute path.
  let releaseReady = false;
  try {
    const fd = fs.openSync(log, 'a', 0o600);
    try {
      fs.writeSync(fd, `\n[${new Date().toISOString()}] Building ${jobId}\n`);
      const { snapshotHash, sdkHash } = sourceFiles(source, stage);
      await hooks.afterSnapshot?.();
      if (snapshotHash !== sourceFiles(source).snapshotHash) throw new Error('Source changed while taking the snapshot; retry after saving');
      for (const file of ['scripts/task.mjs', 'projects/pi/package-lock.json', 'projects/pi-web/package-lock.json']) {
        if (!fs.existsSync(path.join(stage, file))) throw new Error(`Source snapshot missing ${file}`);
      }
      const web = path.join(stage, 'projects/pi-web');
      const clean = buildEnvironment(env);
      const run = hooks.runStep ?? runStep;
      await run(['scripts/task.mjs', 'bootstrap'], stage, clean, fd);
      if (restoreSdk(active, stage, sdkHash)) fs.writeSync(fd, 'Reused the verified active SDK build; Pi sources and build inputs are unchanged.\n');
      else await run(['scripts/task.mjs', 'build-pi'], stage, clean, fd);
      if (fs.existsSync(sdkPackages(stage))) rememberSdk(stage, sdkHash);
      await run(['bin/prepare-terminal.js'], web, clean, fd);
      await run(['scripts/task.mjs', 'build-web'], stage, clean, fd);
      releaseReady = true;
      return { root: web };
    } catch (error) {
      fs.writeSync(fd, `${error.stack || error}\n`);
      throw error;
    } finally { fs.closeSync(fd); }
  } finally {
    if (!releaseReady) fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = { buildLocalRelease };
