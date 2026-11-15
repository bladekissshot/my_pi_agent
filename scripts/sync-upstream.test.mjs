import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root as sourceRoot } from './process.mjs';

test('subtree synchronization preserves local files and records only the chosen upstream', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'my-pi-sync-test-'));
  function command(binary, args, cwd) {
    const child = spawnSync(binary, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  }
  const git = (args, cwd) => command('git', args, cwd);
  async function init(folder) {
    await fs.mkdir(folder); git(['init', '-q', '-b', 'main'], folder);
    git(['config', 'user.name', 'Fixture'], folder); git(['config', 'user.email', 'fixture@example.invalid'], folder);
  }
  try {
    const upstream = path.join(temp, 'upstream'), repo = path.join(temp, 'repo');
    await init(upstream); await init(repo);
    await fs.writeFile(path.join(upstream, 'version.txt'), 'v1');
    git(['add', 'version.txt'], upstream); git(['commit', '-qm', 'fixture v1'], upstream); git(['tag', 'v1'], upstream);
    await fs.mkdir(path.join(repo, 'scripts'));
    for (const file of ['process.mjs', 'sync-upstream.mjs']) await fs.copyFile(path.join(sourceRoot, 'scripts', file), path.join(repo, 'scripts', file));
    await fs.writeFile(path.join(repo, 'README.md'), 'fixture');
    git(['add', 'README.md', 'scripts'], repo); git(['commit', '-qm', 'fixture root'], repo);
    git(['subtree', 'add', '--prefix=projects/pi', upstream, 'v1', '--squash'], repo);
    const url = 'https://github.com/earendil-works/pi.git';
    git(['config', `url.${upstream.replaceAll('\\', '/')}.insteadOf`, url], repo);
    const lock = { version: 1, sources: {
      pi: { remote: 'upstream-pi', url, prefix: 'projects/pi', ref: 'v1', commit: git(['rev-parse', 'v1'], upstream), snapshotCommits: [git(['rev-parse', 'HEAD^2'], repo)] },
      'pi-web': { ref: 'unchanged', commit: 'fixture' },
    } };
    await fs.writeFile(path.join(repo, 'upstreams.lock.json'), JSON.stringify(lock));
    await fs.writeFile(path.join(repo, 'local.txt'), 'custom work');
    git(['add', 'upstreams.lock.json', 'local.txt'], repo); git(['commit', '-qm', 'fixture custom work'], repo);
    await fs.writeFile(path.join(upstream, 'version.txt'), 'v2');
    git(['add', 'version.txt'], upstream); git(['commit', '-qm', 'fixture v2'], upstream); git(['tag', 'v2'], upstream);
    command(process.execPath, ['scripts/sync-upstream.mjs', 'pi', 'v2'], repo);
    assert.equal(await fs.readFile(path.join(repo, 'projects/pi/version.txt'), 'utf8'), 'v2');
    assert.equal(await fs.readFile(path.join(repo, 'local.txt'), 'utf8'), 'custom work');
    const result = JSON.parse(await fs.readFile(path.join(repo, 'upstreams.lock.json'), 'utf8'));
    assert.equal(result.sources.pi.ref, 'v2'); assert.equal(result.sources.pi.snapshotCommits.length, 2);
    assert.equal(result.sources['pi-web'].ref, 'unchanged');
    assert.ok(git(['branch', '--show-current'], repo).startsWith('codex/sync-pi-'));
    assert.equal(git(['status', '--porcelain'], repo), '');
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(temp).startsWith('my-pi-sync-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
});
