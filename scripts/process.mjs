import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function run(command, args, cwd = root, options = {}) {
  const env = { ...process.env, ...options.env };
  const child = spawnSync(command, args, { cwd, env, stdio: options.capture ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`${command} failed (exit ${child.status}).`);
  return options.capture ? child.stdout.trim() : undefined;
}
export function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (npmCli?.endsWith('npm-cli.js')) return run(process.execPath, [npmCli, ...args], cwd);
  const binary = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (process.platform === 'win32') return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', binary, ...args], cwd,
    { env: { PATH: dirname(process.execPath) + ';' + process.env.PATH } });
  return run(binary, args, cwd);
}
