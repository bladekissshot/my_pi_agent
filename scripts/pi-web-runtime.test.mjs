import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { root } from './process.mjs';
const helper = createRequire(import.meta.url)('./pi-web-runtime.cjs');

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pi local-refresh-'));
  t.after(async () => {
    for (const entry of await fs.readdir(folder, { recursive: true })) {
      if (!entry.endsWith('pids.txt')) continue;
      for (const pid of (await fs.readFile(path.join(folder, entry), 'utf8')).trim().split('\n').filter(Boolean).map(Number)) {
        try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const config = { activeRoot: path.join(folder, 'old'), targetRoot: path.join(folder, 'new'), stateDir: path.join(folder, 'state'), agentDir: path.join(folder, 'agent'), helperPath: path.join(root, 'scripts/pi-web-runtime.cjs'), port: 30149 };
  for (const [name, version] of [['old', '0.16.0'], ['new', '0.17.0']]) {
    const release = config[name === 'old' ? 'activeRoot' : 'targetRoot'];
    const files = {
      'package.json': { name: '@agegr/pi-web', version, dependencies: { '@earendil-works/pi-coding-agent': '1.5.2' } },
      '.next/required-server-files.json': { config: { env: { NEXT_PUBLIC_APP_VERSION: version, NEXT_PUBLIC_PI_VERSION: '1.5.2' } } },
      'node_modules/@earendil-works/pi-coding-agent/package.json': { name: '@earendil-works/pi-coding-agent', version: '1.5.2', main: 'index.js', exports: { '.': { import: './index.js' } } },
      'node_modules/next/package.json': { name: 'next', version: '16.4.4' },
    };
    for (const [file, data] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(release, file)), { recursive: true });
      await fs.writeFile(path.join(release, file), JSON.stringify(data));
    }
    await fs.writeFile(path.join(release, '.next/BUILD_ID'), name);
    await fs.mkdir(path.join(release, '.next/server/app/api/local-refresh'), { recursive: true });
    await fs.writeFile(path.join(release, '.next/server/app/api/local-refresh/route.js'), '// fixture capability');
    await fs.writeFile(path.join(release, 'node_modules/@earendil-works/pi-coding-agent/index.js'), 'module.exports = {};');
    await fs.mkdir(path.join(release, 'node_modules/next/dist/bin'), { recursive: true });
    await fs.writeFile(path.join(release, 'node_modules/next/dist/bin/next'), `
      const fs = require('node:fs'); const http = require('node:http'); const path = require('node:path');
      const version = JSON.parse(fs.readFileSync('package.json')).version;
      const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
      const marker = process.env.PI_CODING_AGENT_DIR;
      fs.mkdirSync(marker, {recursive:true});
      fs.appendFileSync(path.join(marker, 'pids.txt'), process.pid + '\\n');
      http.createServer((req,res) => {
        if (req.url === '/api/local-refresh' && req.method === 'POST') {
          let body=''; req.on('data',b=>body+=b); req.on('end',()=> {
            const request=JSON.parse(body);
            res.setHeader('Content-Type','application/json');
            res.end(JSON.stringify({pid:process.pid,instance:request.instance}));
          });
        } else if(req.url === '/api/local-refresh') {
          res.setHeader('Content-Type','application/json');
          res.end(JSON.stringify({current:{webVersion:version,sdkVersion:'1.5.2',buildId:fs.readFileSync('.next/BUILD_ID','utf8')},instance:process.env.PI_WEB_RUNTIME_INSTANCE}));
        } else res.end('<title>Pi Web</title>');
      }).listen(port,'127.0.0.1');
      process.on('SIGTERM',()=>process.exit(0));
    `);
    await fs.mkdir(path.join(release, 'bin'), { recursive: true });
    await fs.writeFile(path.join(release, 'bin/pi-web.js'), '// fixture launcher');
    await fs.writeFile(path.join(release, 'bin/rotate-preview-secrets.js'), 'exports.rotatePreviewSecrets = () => ({ ok: true });');
    await fs.writeFile(path.join(release, 'bin/run-records.js'), `
      const fs=require('node:fs'),path=require('node:path');
      exports.getRunDir=env=>path.join(env.PI_CODING_AGENT_DIR,'run');
      exports.writeRunRecord=(dir,r)=>{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,r.pid+'.json'),JSON.stringify(r));};
      exports.removeRunRecord=(dir,pid)=>fs.rmSync(path.join(dir,pid+'.json'),{force:true});
    `);
  }
  const file = path.join(folder, 'runtime.json');
  helper.atomicJson(file, config);
  const job = { id: 'test-operation', state: 'checking', startedAt: Date.now(), workerPid: process.pid, target: { webVersion: '0.17.0', sdkVersion: '1.5.2', buildId: 'new' } };
  helper.atomicJson(path.join(config.stateDir, 'refresh.json'), job);
  await fs.mkdir(path.join(config.stateDir, 'refresh.lock'));
  return { folder, file, config, job };
}

test('local inspection rejects stale builds and never starts a process', async t => {
  const { config, file } = await fixture(t);
  assert.equal(helper.status(file).target.webVersion, '0.17.0');
  await fs.writeFile(path.join(config.targetRoot, '.next/required-server-files.json'), JSON.stringify({ config: { env: { NEXT_PUBLIC_APP_VERSION: '0.15.0', NEXT_PUBLIC_PI_VERSION: '1.5.2' } } }));
  assert.throws(() => helper.inspectRelease(config.targetRoot), /versions do not match/);
  assert.equal(helper.status(file).target, null);
  assert.equal(await fs.stat(config.agentDir).catch(() => null), null);
});

for (const failure of [null, 'probe', 'drain', 'replacement']) {
  test(`one-shot operation ${failure ? 'handles ' + failure + ' failure' : 'checks, restarts and finishes'} without keeping a manager`, async t => {
    const { config, file, job } = await fixture(t);
    const events = [];
    let starts = 0;
    const hooks = {
      delayMs: 0,
      freePort: async () => 30249,
      startNext: (release, port, env) => { events.push(['start', release, port]); return { role: ++starts, env, unref() { events.push(['unref']); } }; },
      ready: async child => {
        events.push(['ready', child.role]);
        if ((failure === 'probe' && child.role === 1) || (failure === 'replacement' && child.role === 2)) throw new Error('Fixture health failure');
      },
      stopChild: async child => { if (child) events.push(['stop', child.role]); },
      call: async action => { events.push([action]); if (failure === 'drain' && action === 'drain') throw new Error('busy'); },
      kill: pid => events.push(['kill', pid]),
      waitGone: async () => {},
    };
    await helper.refresh(file, job.id, 12345, 'old-instance', hooks);
    const result = helper.readJob(config);
    assert.equal(result.state, failure === 'replacement' ? 'rolled-back' : failure ? 'failed' : 'complete');
    assert.equal(helper.readConfig(file).activeRoot, failure ? config.activeRoot : config.targetRoot);
    assert.equal(await fs.stat(path.join(config.stateDir, 'refresh.lock')).catch(() => null), null);
    assert.equal(helper.gateActive(config), false);
    assert.equal(events.filter(([kind]) => kind === 'kill').length, failure === 'probe' || failure === 'drain' ? 0 : 1);
    if (!failure) assert.deepEqual(events.map(([kind]) => kind), ['start','ready','stop','drain','shutdown','kill','start','ready','unref']);
    if (failure === 'replacement') assert.equal(starts, 3, 'start the original release for rollback');
  });
}

test('concurrent clicks are refused by the filesystem lock', async t => {
  const { file } = await fixture(t);
  assert.throws(() => helper.begin(file, 12345, 'instance'), error => error.status === 409);
});

test('a real one-shot helper exits after checking and starting the replacement', { timeout: 20000 }, async t => {
  const { config, file, job } = await fixture(t);
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  config.port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  helper.atomicJson(file, config);
  const old = spawn(process.execPath, [path.join(config.activeRoot, 'node_modules/next/dist/bin/next'), 'start', '-p', String(config.port)],
    { cwd: config.activeRoot, env: { ...process.env, PI_CODING_AGENT_DIR: config.agentDir, PI_WEB_RUNTIME_INSTANCE: 'old-instance' }, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 300));
  const worker = spawn(process.execPath, [config.helperPath, 'refresh', file, job.id, String(old.pid), 'old-instance'],
    { env: { ...process.env, PI_WEB_PASSWORD: '' }, stdio: ['ignore','pipe','pipe'] });
  let errors = ''; worker.stderr.on('data', data => errors += data);
  const [code] = await once(worker, 'exit');
  assert.equal(code, 0, errors);
  assert.equal(helper.readJob(config).state, 'complete');
  assert.equal(helper.readConfig(file).activeRoot, config.targetRoot);
  assert.throws(() => process.kill(worker.pid, 0), 'the helper must no longer exist');
  const response = await fetch(`http://127.0.0.1:${config.port}/api/local-refresh`);
  const state = await response.json();
  assert.equal(state.current.webVersion, '0.17.0');
  assert.notEqual(state.instance, 'old-instance');
});
