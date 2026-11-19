import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const { buildLocalRelease } = createRequire(import.meta.url)('./pi-web-build.cjs');

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-local-build-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5 }));
  const sourceRoot = path.join(temp, 'repo');
  const activeRoot = path.join(temp, 'active');
  const options = { sourceRoot, activeRoot, releaseStore: path.join(sourceRoot, '.local/releases'),
    log: path.join(temp, 'build.log'), jobId: 'fixture', env: { PATH: process.env.PATH, NPM_CONFIG_CACHE: 'npm-fixture',
      PI_WEB_LOCAL_REFRESH_TOKEN: 'must-not-be-inherited', OPENAI_API_KEY: 'must-not-be-inherited', NODE_OPTIONS: '--inspect' } };
  const write = async (name, contents) => {
    const dest = path.join(sourceRoot, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, contents);
  };
  await fs.mkdir(sourceRoot);
  await fs.mkdir(activeRoot);
  await fs.writeFile(path.join(activeRoot, 'do-not-modify'), 'old build');
  await write('.gitignore', '.local/\n.next/\nnode_modules/\n*.ignored\n');
  await write('scripts/task.mjs', '// test build script');
  await write('projects/pi/package-lock.json', '{}');
  await write('projects/pi-web/package-lock.json', '{}');
  await write('projects/pi-web/components/Changed.tsx', 'before');
  await write('projects/pi-web/components/Deleted.tsx', 'remove me');
  await write('projects/pi-web/auth.json', 'do not copy');
  await write('projects/pi-web/.next/tracked', 'do not copy');
  const git = (...args) => execFileSync('git', args, { cwd: sourceRoot, windowsHide: true, stdio: 'ignore' });
  git('init');
  git('add', '.');
  git('add', '-f', 'projects/pi-web/.next/tracked');
  await write('projects/pi-web/components/Changed.tsx', 'changed without a commit');
  await write('projects/pi-web/components/新 功能.tsx', 'untracked');
  await write('projects/pi-web/components/output.ignored', 'ignored');
  await write('notes.md', 'outside the build scope');
  await fs.unlink(path.join(sourceRoot, 'projects/pi-web/components/Deleted.tsx'));
  return { options, write, temp };
}

async function missing(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }

test('snapshots disk source, skips ignored and private paths, and builds separately with clean environment', async t => {
  const { options } = await fixture(t);
  await fs.symlink(options.activeRoot, path.join(options.sourceRoot, 'projects/pi-web/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const steps = [];
  const { root } = await buildLocalRelease(options, { runStep: async (args, cwd, env) => {
    steps.push({ args, cwd });
    assert.equal(env.NPM_CONFIG_CACHE, 'npm-fixture');
    for (const name of ['PI_WEB_LOCAL_REFRESH_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
  } });
  assert.deepEqual(steps.map(step => step.args), [['scripts/task.mjs', 'bootstrap'], ['scripts/task.mjs', 'build-pi'],
    ['bin/prepare-terminal.js'], ['scripts/task.mjs', 'build-web']]);
  assert.ok(steps[0].cwd.startsWith(path.join(options.releaseStore, 'build-fixture-')));
  assert.equal(steps[2].cwd, root);
  assert.equal(await fs.readFile(path.join(root, 'components/Changed.tsx'), 'utf8'), 'changed without a commit');
  assert.equal(await fs.readFile(path.join(root, 'components/新 功能.tsx'), 'utf8'), 'untracked');
  for (const name of ['components/Deleted.tsx', 'components/output.ignored', '.next', 'auth.json', 'linked', '../../notes.md']) await missing(path.join(root, name));
  assert.equal(await fs.readFile(path.join(options.activeRoot, 'do-not-modify'), 'utf8'), 'old build');
});

test('fails before compilation if the checkout changes or the release store overlaps source or active release', async t => {
  const { options, write } = await fixture(t);
  const unexpected = () => assert.fail('compilation must not start');
  await assert.rejects(buildLocalRelease(options, { runStep: unexpected, afterSnapshot: () => write('scripts/task.mjs', 'new build') }), /Source changed/);
  assert.deepEqual(await fs.readdir(options.releaseStore), []);
  for (const releaseStore of [path.join(options.sourceRoot, 'projects/pi-web/outputs'), path.join(options.activeRoot, 'outputs')]) {
    await assert.rejects(buildLocalRelease({ ...options, releaseStore }, { runStep: unexpected }), /release store must be outside/);
    await missing(releaseStore);
  }
});

test('a Web-only edit reuses independent copies of an unchanged SDK; a Pi edit compiles it again', async t => {
  const { options, write } = await fixture(t);
  await write('projects/pi/packages/coding-agent/package.json', '{}');
  await write('projects/pi/packages/coding-agent/src/index.ts', 'old Pi');
  const steps = [];
  const runStep = async (args, cwd) => {
    steps.push(args[1]);
    if (args[1] === 'build-pi') {
      const dist = path.join(cwd, 'projects/pi/packages/coding-agent/dist');
      await fs.mkdir(dist, { recursive: true });
      await fs.writeFile(path.join(dist, 'index.js'), 'compiled fixture');
    }
  };
  const first = await buildLocalRelease(options, { runStep });
  assert.ok(steps.includes('build-pi'));
  steps.length = 0;
  await write('projects/pi-web/components/Changed.tsx', 'Web-only edit');
  const second = await buildLocalRelease({ ...options, activeRoot: first.root }, { runStep });
  assert.equal(steps.includes('build-pi'), false);
  const sdkEntry = web => path.resolve(web, '../pi/packages/coding-agent/dist/index.js');
  assert.equal(await fs.readFile(sdkEntry(second.root), 'utf8'), 'compiled fixture');
  await fs.writeFile(sdkEntry(second.root), 'not the active file');
  assert.equal(await fs.readFile(sdkEntry(first.root), 'utf8'), 'compiled fixture');
  steps.length = 0;
  await write('projects/pi/packages/coding-agent/src/index.ts', 'new Pi');
  await buildLocalRelease({ ...options, activeRoot: first.root }, { runStep });
  assert.ok(steps.includes('build-pi'));
});

test('a compiler failure cannot leave an installable release or touch the active release', async t => {
  const { options } = await fixture(t);
  await assert.rejects(buildLocalRelease(options, { runStep: () => { throw new Error('build fixture failed'); } }), /build fixture failed/);
  assert.deepEqual(await fs.readdir(options.releaseStore), []);
  assert.match(await fs.readFile(options.log, 'utf8'), /build fixture failed/);
  assert.equal(await fs.readFile(path.join(options.activeRoot, 'do-not-modify'), 'utf8'), 'old build');
});
