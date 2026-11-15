import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { root } from './process.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or newer.');
const [target, ...args] = process.argv.slice(2);
if (!['cli', 'web'].includes(target)) throw new Error('Use launch.mjs cli|web.');
let config = {};
try { config = JSON.parse(await fs.readFile(path.join(root, '.local/runtime.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = { ...process.env };
if (config.agentDir) env.PI_CODING_AGENT_DIR = path.resolve(root, config.agentDir);
if (env.PI_CODING_AGENT_DIR) {
  const directory = path.resolve(env.PI_CODING_AGENT_DIR);
  if (directory.startsWith(root + path.sep) && !directory.startsWith(path.join(root, '.local') + path.sep)) throw new Error('Keep agent data outside tracked source, or under the ignored .local directory.');
}
if (config.workspaceRoot) env.PI_WEB_DEFAULT_CWD_ROOT = config.workspaceRoot;
const port = config.webPort ?? 30141;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local Web port.');
const cwd = target === 'web' ? path.join(root, 'projects/pi-web') : process.cwd();
const entry = target === 'web'
  ? path.join(cwd, 'node_modules/next/dist/bin/next')
  : path.join(root, 'projects/pi/packages/coding-agent/dist/bundle/cli.js');
if (!await fs.stat(entry).catch(() => null)) throw new Error('Build the selected project before launching it.');
if (target === 'web') {
  const occupied = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  if (occupied) throw new Error('A service is already using the configured port. Stop it before launching another Pi Web.');
}
const command = target === 'web' ? [entry, 'start', '-H', '127.0.0.1', '-p', String(port), ...args] : [entry, ...args];
const child = spawn(process.execPath, command, { cwd, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
