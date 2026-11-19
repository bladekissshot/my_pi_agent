import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareRepository, inspectRepository, validateRepositoryUrl, RepositorySetupCancelled } from '../lib/repository.mjs';
import { Coordinator, DEFAULTS, git } from '../lib/core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-repository-test-'));
const globalConfig = path.join(root, 'global-config');
fs.writeFileSync(globalConfig, '');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
test.after(() => {
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert(path.basename(root).startsWith('pi-repository-test-'));
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const cwd = path.join(dir, 'project'), remote = path.join(dir, 'remote with space.git');
  fs.mkdirSync(cwd); fs.mkdirSync(remote);
  await git(['init', '--bare', '-q', '--initial-branch=main'], remote);
  const prompts = [];
  const ui = {
    input: async title => {
      prompts.push(title);
      return title.includes('地址') ? remote : title.includes('邮箱') ? 'test@example.invalid' : 'Repository Test';
    },
    confirm: async (title, message) => { prompts.push({ title, message }); return true; },
  };
  return { dir, cwd, remote, ui, prompts };
}

async function seedRemote(f) {
  const seed = path.join(f.dir, 'seed'); fs.mkdirSync(seed);
  await git(['init', '-q', '-b', 'main'], seed);
  fs.writeFileSync(path.join(seed, 'shared.txt'), 'remote original');
  fs.writeFileSync(path.join(seed, 'remote-only.txt'), 'remote only');
  fs.writeFileSync(path.join(seed, 'local-directory'), 'remote file');
  fs.mkdirSync(path.join(seed, 'local-file'));
  fs.writeFileSync(path.join(seed, 'local-file', 'nested.txt'), 'remote nested');
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'remote baseline'], seed);
  await git(['push', f.remote, 'HEAD:refs/heads/main'], seed);
  return git(['rev-parse', 'HEAD'], seed);
}

test('plain directory asks for a URL, creates local baseline and runs a worker without publishing', async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(f.cwd, 'hello.txt'), 'local baseline');
  fs.writeFileSync(path.join(f.cwd, '.env'), 'PRIVATE=local');
  fs.mkdirSync(path.join(f.cwd, 'node_modules'));
  fs.writeFileSync(path.join(f.cwd, 'node_modules', 'generated.js'), 'generated');
  const ready = await prepareRepository(f.cwd, f.ui);
  assert(ready.ready && ready.created);
  assert(f.prompts.some(p => typeof p === 'string' && p.includes('地址')));
  assert.equal(await git(['remote', 'get-url', 'origin'], f.cwd), f.remote);
  assert.equal(await git(['show', 'HEAD:hello.txt'], f.cwd), 'local baseline');
  assert(!((await git(['ls-files'], f.cwd)).split('\n').includes('.env')));
  assert(!((await git(['ls-files'], f.cwd)).includes('node_modules')));
  assert.equal(await git(['ls-remote', f.remote], f.cwd), '', 'remote is still empty');
  const c = new Coordinator({ dir: path.join(f.dir, 'state'), cwd: f.cwd, sessionId: 'new-repo',
    config: { ...DEFAULTS, mode: 'auto', execModel: 'mock/worker' },
    runner: async j => {
      assert.equal(fs.readFileSync(path.join(j.cwd, 'hello.txt'), 'utf8'), 'local baseline');
      return { report: { status: 'submitted', summary: 'Read the local baseline', evidence: ['hello.txt'] } };
    },
  });
  try {
    const j = await c.submit({ environment: { expectedRepoRoot: f.cwd, requiredFiles: ['hello.txt'] }, title: 'Read baseline', goal: 'Explain the contents of the initial local file', context: 'This project was just initialized from a directory without Git.',
      kind: 'analysis', requirements: ['Read hello.txt'], constraints: ['Read only'], allowedPaths: ['hello.txt'], acceptance: [{ description: 'Explain file', expected: 'File content explained' }] });
    await c.wait([j.id],5000);
    assert.equal(j.status,'review',j.reason);
  } finally { c.close(); }
});

test('unborn repository reuses origin and identity, honors existing ignore rules', async () => {
  const f = await fixture();
  await git(['init', '-q', '-b', 'custom'], f.cwd);
  await git(['remote', 'add', 'origin', f.remote], f.cwd);
  await git(['config', 'user.name', 'Existing User'], f.cwd);
  await git(['config', 'user.email', 'existing@example.invalid'], f.cwd);
  fs.writeFileSync(path.join(f.cwd, '.gitignore'), 'private.txt\n');
  fs.writeFileSync(path.join(f.cwd, 'private.txt'), 'private');
  fs.writeFileSync(path.join(f.cwd, 'hello.txt'), 'tracked');
  const result = await prepareRepository(f.cwd, f.ui);
  assert(result.ready);
  assert.equal(f.prompts.filter(p => typeof p === 'string').length, 0);
  assert.equal(await git(['branch', '--show-current'], f.cwd), 'custom');
  assert.equal(await git(['log', '-1', '--format=%an <%ae>'], f.cwd), 'Existing User <existing@example.invalid>');
  assert.equal(fs.readFileSync(path.join(f.cwd, '.gitignore'), 'utf8'), 'private.txt\n');
  assert(!(await git(['ls-files'], f.cwd)).includes('private.txt'));
});

test('populated remote retains its ancestry, imports missing files and preserves local path collisions', async () => {
  const f = await fixture(), parent = await seedRemote(f);
  fs.writeFileSync(path.join(f.cwd, 'shared.txt'), 'local preferred');
  fs.writeFileSync(path.join(f.cwd, 'local-only.txt'), 'local only');
  fs.writeFileSync(path.join(f.cwd, 'local-file'), 'local file over remote directory');
  fs.mkdirSync(path.join(f.cwd, 'local-directory'));
  fs.writeFileSync(path.join(f.cwd, 'local-directory', 'child.txt'), 'local directory over remote file');
  const result = await prepareRepository(f.cwd, f.ui);
  assert(result.ready);
  assert.equal(await git(['rev-parse', 'HEAD^'], f.cwd), parent);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'shared.txt'), 'utf8'), 'local preferred');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'remote-only.txt'), 'utf8'), 'remote only');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'local-file'), 'utf8'), 'local file over remote directory');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'local-directory', 'child.txt'), 'utf8'), 'local directory over remote file');
  assert.equal(await git(['status', '--porcelain'], f.cwd), '');
  assert.equal(await git(['rev-parse', 'main'], f.remote), parent, 'remote history unchanged');
});

test('cancelling the URL or baseline dialog leaves files and Git metadata untouched', async () => {
  for (const cancel of ['url', 'confirm']) {
    const f = await fixture(); fs.writeFileSync(path.join(f.cwd, 'hello.txt'), 'preserve');
    const ui = { ...f.ui, ...(cancel === 'url' ? { input: async () => undefined } : { confirm: async () => false }) };
    await assert.rejects(prepareRepository(f.cwd, ui), RepositorySetupCancelled);
    assert.deepEqual(fs.readdirSync(f.cwd), ['hello.txt']);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'hello.txt'), 'utf8'), 'preserve');
  }
});

test('existing committed repositories do not prompt, add remotes or commit dirty files', async () => {
  const f = await fixture(); await prepareRepository(f.cwd, f.ui);
  await git(['remote', 'remove', 'origin'], f.cwd);
  fs.writeFileSync(path.join(f.cwd, 'dirty.txt'), 'keep uncommitted');
  const before = await git(['rev-parse', 'HEAD'], f.cwd);
  const ready = await prepareRepository(f.cwd, { input: () => assert.fail('unexpected prompt'), confirm: () => assert.fail('unexpected confirmation') });
  assert(ready.ready && !ready.created);
  assert.equal(await git(['rev-parse', 'HEAD'], f.cwd), before);
  assert.equal(await git(['remote'], f.cwd), '');
  assert.match(await git(['status', '--porcelain'], f.cwd), /dirty.txt/);
});

test('unavailable remotes and conflicting origins fail before modifying project files', async () => {
  const f = await fixture();
  await assert.rejects(prepareRepository(f.cwd, f.ui, path.join(f.dir, 'missing.git')), /无法读取/);
  assert.deepEqual(fs.readdirSync(f.cwd), []);
  await git(['init', '-q'], f.cwd);
  await git(['remote', 'add', 'origin', f.remote], f.cwd);
  await assert.rejects(prepareRepository(f.cwd, f.ui, path.join(f.dir, 'different.git')), /已有不同的 origin/);
  assert.equal(await git(['remote', 'get-url', 'origin'], f.cwd), f.remote);
  assert.equal((await inspectRepository(f.cwd)).ready, false);
});

test('simultaneous setup requests share a single initialization and dialog sequence', async () => {
  const f = await fixture();
  const results = await Promise.all([prepareRepository(f.cwd, f.ui), prepareRepository(f.cwd, f.ui)]);
  assert(results.every(r => r.ready));
  assert.equal(results[0].head, results[1].head, 'both callers receive the same baseline');
  assert.equal(f.prompts.filter(p => typeof p === 'object').length, 1);
  assert.equal(await git(['rev-list', '--count', 'HEAD'], f.cwd), '1');
});

test('parallel setup attempts share cancellation instead of prompting repeatedly', async () => {
  const f = await fixture(); let prompts = 0;
  const ui = { ...f.ui, input: async () => { prompts++; await new Promise(resolve => setTimeout(resolve, 100)); return undefined; } };
  const results = await Promise.allSettled([prepareRepository(f.cwd, ui), prepareRepository(f.cwd, ui)]);
  assert(results.every(r => r.status === 'rejected' && r.reason instanceof RepositorySetupCancelled));
  assert.equal(prompts, 1);
  assert.deepEqual(fs.readdirSync(f.cwd), []);
});

test('no-UI startup requests setup instead of creating a repository without user input', async () => {
  const f = await fixture();
  await assert.rejects(prepareRepository(f.cwd), /delegation repo/);
  assert.deepEqual(fs.readdirSync(f.cwd), []);
});

test('repository URLs reject helper commands and embedded credentials', () => {
  for (const url of ['-u', 'ext::sh exploit', 'https://token@example.com/repo.git', ['https://','user',':','pass','@example.com/r'].join(''), 'ssh://host/repo\ncommand', 'relative/path']) {
    assert.throws(() => validateRepositoryUrl(url));
  }
  assert.equal(validateRepositoryUrl('git@github.com:user/repo.git'), 'git@github.com:user/repo.git');
  assert.equal(validateRepositoryUrl('https://github.com/user/repo.git'), 'https://github.com/user/repo.git');
});
