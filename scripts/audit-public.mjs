import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { root, run } from './process.mjs';

export function inspectContent(bytes, { secrets = [], hosts = [], publicBlob = false } = {}) {
  const findings = [];
  for (const value of secrets) if (bytes.includes(Buffer.from(value))) findings.push('exact-private-value');
  const text = bytes.toString('utf8');
  for (const host of hosts) if (text.toLowerCase().includes(host.toLowerCase())) findings.push('private-endpoint');
  if (!publicBlob && !bytes.includes(0)) {
    if (/(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,})/.test(text)) findings.push('credential-shaped-literal');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push('private-key');
    if (/https?:\/\/[^\s/"']+:[^\s/"']+@/i.test(text)) findings.push('credential-in-url');
  }
  return [...new Set(findings)];
}
const blobId = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');

export async function privateFingerprints(directory) {
  const secrets = new Set(), hosts = new Set();
  let inputs = 0;
  for (const name of ['auth.json', 'models.json']) {
    let data;
    try { data = JSON.parse((await fs.readFile(path.join(directory, name), 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error('A private input could not be parsed; its contents were not printed.'); }
    inputs++;
    function walk(value, key = '') {
      if (typeof value === 'string') {
        if (name === 'auth.json' && value.length >= 16 && !value.startsWith('${')) secrets.add(value);
        if (/url/i.test(key) && /^https?:/i.test(value)) {
          const url = new URL(value);
          if (!['localhost', '127.0.0.1', '[::1]', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'].includes(url.hostname)
              && !url.hostname.endsWith('.invalid') && !url.hostname.endsWith('.example')) hosts.add(url.hostname);
        }
      } else if (Array.isArray(value)) value.forEach(item => walk(item, key));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => walk(item, name));
    }
    walk(data);
  }
  if (!inputs) throw new Error('No private inputs found; refusing to report an exact-value audit.');
  return { secrets: [...secrets], hosts: [...hosts], inputs };
}

export async function audit({ history = false, privateDir } = {}) {
  const fingerprints = privateDir ? await privateFingerprints(privateDir) : { secrets: [], hosts: [], inputs: 0 };
  const lock = JSON.parse(await fs.readFile(path.join(root, 'upstreams.lock.json'), 'utf8'));
  const publicBlobs = new Set();
  for (const source of Object.values(lock.sources)) {
    for (const commit of source.snapshotCommits ?? []) {
      const lines = run('git', ['ls-tree', '-r', commit], root, { capture: true }).split('\n');
      for (const line of lines) { const match = line.match(/^\d+ blob ([a-f0-9]+)\t/); if (match) publicBlobs.add(match[1]); }
    }
  }
  const findings = [];
  const files = run('git', ['ls-files', '-c', '-o', '--exclude-standard'], root, { capture: true }).split('\n').filter(Boolean);
  for (const file of new Set(files)) {
    const absolute = path.join(root, file);
    let bytes;
    try { bytes = await fs.readFile(absolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const publicBlob = publicBlobs.has(blobId(bytes)) || publicBlobs.has(blobId(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'))));
    const rules = inspectContent(bytes, { ...fingerprints, publicBlob });
    if (!publicBlob && (/(^|\/)(?:\.local|node_modules|\.next)(\/|$)/.test(file)
        || /^(?:sessions|runs)\//.test(file) || file.endsWith('.jsonl') || /prompt-manager\/(?:catalog\.json|sessions\/)/.test(file))) rules.push('runtime-data');
    if (!publicBlob && /(^|\/)(?:auth\.json|models\.json|settings\.json|\.npmrc|\.env(?:\.[^/]+)?)$/.test(file) && !file.endsWith('.env.example')) rules.push('runtime-configuration');
    for (const rule of rules) findings.push({ scope: 'working-tree', file, rule });
  }
  let historyObjects = 0;
  if (history) {
    const entries = run('git', ['rev-list', '--objects', 'HEAD'], root, { capture: true }).split('\n').filter(Boolean);
    const names = new Map(entries.map(line => { const space = line.indexOf(' '); return [space < 0 ? line : line.slice(0, space), space < 0 ? '(commit)' : line.slice(space + 1)]; }));
    const ids = [...names.keys()];
    const result = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: ids.join('\n') + '\n', maxBuffer: 512 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('Git history audit failed.');
    let cursor = 0;
    for (const id of ids) {
      const end = result.stdout.indexOf(10, cursor);
      const header = result.stdout.subarray(cursor, end).toString('ascii').split(' ');
      const size = Number(header[2]);
      const bytes = result.stdout.subarray(end + 1, end + 1 + size);
      cursor = end + 1 + size + 1;
      if (!['blob', 'commit'].includes(header[1])) continue;
      historyObjects++;
      for (const rule of inspectContent(bytes, { ...fingerprints, publicBlob: publicBlobs.has(id) })) findings.push({ scope: 'history', object: id, file: names.get(id), rule });
    }
  }
  const report = { files: new Set(files).size, historyObjects, exactPrivateInputsChecked: fingerprints.inputs, findings };
  console.log(JSON.stringify(report, null, 2));
  if (findings.length) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, 'scripts/audit-public.mjs')) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--private-dir');
  await audit({ history: args.includes('--history'), privateDir: index >= 0 ? args[index + 1] : undefined });
}
