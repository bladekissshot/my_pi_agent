import fs from 'node:fs/promises';
import path from 'node:path';
import { root, run } from './process.mjs';

const [name, ref] = process.argv.slice(2);
if (!['pi', 'pi-web'].includes(name) || !ref || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) throw new Error('Usage: sync-upstream.mjs pi|pi-web <reviewed-tag-or-ref>');
if (run('git', ['status', '--porcelain'], root, { capture: true })) throw new Error('Commit or resolve current changes before syncing.');
const file = path.join(root, 'upstreams.lock.json');
const lock = JSON.parse(await fs.readFile(file, 'utf8'));
const upstream = lock.sources[name];
if (upstream.prefix !== `projects/${name}`) throw new Error('Unexpected subtree prefix.');
if (upstream.remote !== `upstream-${name}`) throw new Error('Unexpected upstream remote.');
const url = new URL(upstream.url);
if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) throw new Error('Upstream URLs must be public GitHub URLs without credentials.');
const remotes = run('git', ['remote'], root, { capture: true }).split('\n');
if (!remotes.includes(upstream.remote)) run('git', ['remote', 'add', upstream.remote, upstream.url]);
else if (run('git', ['config', '--get', `remote.${upstream.remote}.url`], root, { capture: true }) !== upstream.url) throw new Error('Upstream remote URL does not match the lock file.');
run('git', ['fetch', '--no-tags', '--depth=1', upstream.remote, ref]);
const commit = run('git', ['rev-parse', 'FETCH_HEAD'], root, { capture: true });
if (commit === upstream.commit && ref === upstream.ref) {
  console.log(`${name} already matches the reviewed upstream revision.`);
  process.exit(0);
}
const branch = `codex/sync-${name}-${Date.now()}`;
run('git', ['switch', '-c', branch]);
const before = run('git', ['rev-parse', 'HEAD'], root, { capture: true });
run('git', ['subtree', 'merge', `--prefix=${upstream.prefix}`, commit, '--squash']);
if (run('git', ['rev-parse', 'HEAD'], root, { capture: true }) !== before) {
  const snapshot = run('git', ['rev-parse', 'HEAD^2'], root, { capture: true });
  upstream.snapshotCommits = [...new Set([...(upstream.snapshotCommits ?? []), snapshot])];
}
upstream.ref = ref; upstream.commit = commit;
await fs.writeFile(file, JSON.stringify(lock, null, 2) + '\n');
run('git', ['add', 'upstreams.lock.json']);
run('git', ['commit', '-m', `chore: pin ${name} upstream ${ref}`]);
console.log(`Updated ${name} on ${branch}. Run relevant checks before merging and pushing.`);
