import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { root } from './process.mjs';

const windowsOnly = { skip: process.platform !== 'win32', timeout: 20000 };
const launcher = path.join(root, 'scripts/Start-PiWeb.ps1');

async function fixture(t) {
  // Include spaces to exercise Windows argument quoting.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'my-pi desktop-test-'));
  await fs.mkdir(path.join(directory, 'bin'));
  await fs.writeFile(path.join(directory, 'bin/PiWeb-Environment.ps1'), '# Isolated test; no agent configuration.\n');
  await fs.writeFile(path.join(directory, 'bin/pi-web-launch.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const http = require('node:http');
    const root = path.resolve(__dirname, '..');
    fs.appendFileSync(path.join(root, 'pids.txt'), process.pid + '\\n');
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    setTimeout(() => {
      http.createServer((request, response) => {
        fs.appendFileSync(path.join(root, 'requests.txt'), 'GET\\n');
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<html><title>Pi Web</title></html>');
      }).listen(port, '127.0.0.1');
    }, 250);
  `);
  t.after(async () => {
    const pids = await fs.readFile(path.join(directory, 'pids.txt'), 'utf8').catch(() => '');
    for (const pid of pids.trim().split('\n').filter(Boolean).map(Number)) {
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    // Windows may need a moment to release the redirected log handles.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return directory;
}

function launch(directory, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher,
      '-InstallRoot', directory, '-NodePath', process.execPath, '-Port', String(port), '-NoBrowser',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Desktop launcher timed out.'));
    }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    // A detached backend can inherit pipe handles; do not wait for its exit.
    child.once('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

for (const { name, status, title, expected } of [
  { name: 'reuses a healthy service', status: 200, title: 'Pi Web', expected: 0 },
  { name: 'preserves an unrelated service on the port', status: 200, title: 'Other app', expected: 1 },
  { name: 'rejects an unhealthy service', status: 503, title: 'Pi Web', expected: 1 },
]) {
  test(`desktop launcher ${name}`, windowsOnly, async t => {
    const directory = await fixture(t);
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests++;
      response.writeHead(status, { 'Content-Type': 'text/html', Connection: 'close' });
      response.end(`<html><title>${title}</title></html>`);
    });
    const port = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve)));
    const result = await launch(directory, port);
    assert.equal(result.code, expected, JSON.stringify(result));
    if (expected === 0) assert.ok(result.stdout.includes(`http://127.0.0.1:${port}`));
    else assert.match(result.stderr, /already in use/);
    assert.equal(requests, 1, 'probe the page only once');
    assert.equal(server.listening, true);
    assert.equal(await fs.stat(path.join(directory, 'pids.txt')).catch(() => null), null, 'do not start another backend');
  });
}

for (const count of [1, 2]) {
  test(`desktop launcher starts one backend for ${count} simultaneous invocation(s)`, windowsOnly, async t => {
    const directory = await fixture(t);
    const reservation = http.createServer();
    const port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const results = await Promise.all(Array.from({ length: count }, () => launch(directory, port)));
    for (const result of results) {
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.ok(result.stdout.includes(`http://127.0.0.1:${port}`));
    }
    const pids = (await fs.readFile(path.join(directory, 'pids.txt'), 'utf8')).trim().split('\n');
    assert.equal(pids.length, 1, 'serialize startup instead of racing to spawn');
    const requests = (await fs.readFile(path.join(directory, 'requests.txt'), 'utf8')).trim().split('\n');
    assert.equal(requests.length, count, 'do not repeat a successful readiness request');
    const response = await fetch(`http://127.0.0.1:${port}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>Pi Web<\/title>/);
  });
}
