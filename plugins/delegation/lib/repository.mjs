import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const locks = globalThis[Symbol.for('pi-delegation/repository-setup/v1')] ??= new Map();
const initialIgnore = 'node_modules/\n.pi/\n.env\n.env.*\n!.env.example\n*.pem\n*.key\n.DS_Store\n';

export class RepositorySetupCancelled extends Error {
  constructor() { super('已取消仓库准备，任务尚未启动。'); }
}

async function command(cwd, args, input) {
  try {
    const execution = execFileAsync('git', args, {
      cwd, windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    });
    // A NUL-delimited stream avoids Windows command-line limits and filename quoting.
    execution.child.stdin.on('error', () => {}); // Git's exit status reports early pipe closure.
    execution.child.stdin.end(input);
    const { stdout } = await execution;
    return stdout.trimEnd();
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('未找到 Git，请安装 Git 后重新运行 /delegation auto。');
    // Do not include the full command/URL: credentials may be supplied by Git configuration.
    const failure = new Error(error.stderr?.trim() || 'Git 操作未完成，请检查仓库权限后重试。');
    failure.code = error.code;
    throw failure;
  }
}

async function optionalConfig(cwd, key) {
  try { return await command(cwd, ['config', '--get', key]); }
  catch (error) { if (error.code === 1) return ''; throw error; }
}

export async function inspectRepository(cwd) {
  let root;
  try { root = await command(cwd, ['rev-parse', '--show-toplevel']); }
  catch (error) {
    if (!/not a git repository/.test(error.message)) throw error;
    return { root: fs.realpathSync(cwd), initialized: false, ready: false, origin: '' };
  }
  const origin = await optionalConfig(root, 'remote.origin.url');
  try {
    const head = await command(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    return { root, initialized: true, ready: true, origin, head };
  } catch (error) {
    // Only an unborn branch may be initialized. Corrupt/detached refs need repair.
    const branch = await command(root, ['symbolic-ref', '-q', 'HEAD']);
    try { await command(root, ['show-ref', '--verify', '--quiet', branch]); }
    catch (missing) {
      if (missing.code === 1) return { root, initialized: true, ready: false, origin };
      throw missing;
    }
    throw error;
  }
}

export function validateRepositoryUrl(value) {
  const url = value?.trim();
  if (!url || (/[\x00-\x20\x7f]/.test(url) && !path.isAbsolute(url)) || url.startsWith('-') || /[\r\n\0]/.test(url)) {
    throw new Error('请输入有效的 Git 仓库地址。');
  }
  if (path.isAbsolute(url)) return url;
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(url)) return url;
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('仓库地址需为 HTTPS、SSH 或本地 Git 仓库的绝对路径。'); }
  if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(parsed.protocol) || parsed.password ||
      (parsed.username && parsed.protocol !== 'ssh:') || parsed.search || parsed.hash) {
    throw new Error('请使用不含密码或 token 的 Git 仓库地址；认证交给本机 Git 凭据管理器。');
  }
  return url;
}

async function remoteBranch(root, url) {
  let refs;
  try { refs = await command(root, ['ls-remote', '--symref', '--', url, 'HEAD', 'refs/heads/*']); }
  catch { throw new Error('无法读取这个仓库。请确认地址存在、Git 认证已配置，再重新运行 /delegation auto。'); }
  const branches = refs.split('\n').map(line => line.match(/^[0-9a-f]+\t(refs\/heads\/[^\s]+)$/)?.[1]).filter(Boolean);
  const symbolic = refs.match(/^ref: (refs\/heads\/[^\s]+)\tHEAD$/m)?.[1];
  return symbolic && branches.includes(symbolic) ? symbolic :
    branches.find(ref => ref === 'refs/heads/main') || branches.find(ref => ref === 'refs/heads/master') || branches[0];
}

function canRestore(root, relative) {
  const parts = relative.split('/');
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') ||
      parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new Error('远程仓库包含不安全的文件路径。');
  for (let i = 1; i <= parts.length; i++) {
    try {
      const stat = fs.lstatSync(path.join(root, ...parts.slice(0, i)));
      // Preserve local files, directories and symlinks on every collision.
      if (i === parts.length || !stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return true;
}

async function initialize(cwd, ui, suppliedUrl) {
  const repo = await inspectRepository(cwd);
  if (repo.ready) return repo;
  if (!ui?.input || !ui?.confirm) throw new Error('请在 Pi CLI 或 Pi Web 中运行 /delegation repo，提供仓库地址并完成本地基线准备后重试。');
  let url = suppliedUrl || repo.origin;
  if (!url) url = await ui.input('当前项目尚未准备 Git 仓库，请提供仓库地址', 'https://github.com/用户名/仓库名.git');
  if (!url?.trim()) throw new RepositorySetupCancelled();
  url = validateRepositoryUrl(url);
  if (repo.origin && repo.origin !== url) throw new Error('当前仓库已有不同的 origin；请先确认项目地址，不会自动覆盖现有远程配置。');
  const branch = await remoteBranch(repo.root, url);
  const name = await optionalConfig(repo.root, 'user.name') || await ui.input('创建首次本地提交需要 Git 用户名', '你的 Git 用户名');
  if (!name?.trim()) throw new RepositorySetupCancelled();
  const email = await optionalConfig(repo.root, 'user.email') || await ui.input('创建首次本地提交需要 Git 邮箱', 'you@example.com');
  if (!email?.trim()) throw new RepositorySetupCancelled();
  if (/[\r\n\0<>]/.test(name + email)) throw new Error('Git 用户名或邮箱格式无效。');
  const entries = fs.readdirSync(repo.root).filter(p => p !== '.git');
  const confirmed = await ui.confirm('准备 Git 仓库并创建本地基线', [
    `项目：${repo.root}`, `仓库：${url}`,
    branch ? '将读取远程分支，补充本地缺少的文件；同名路径保留本地内容。' : '远程仓库尚无分支，将创建首次本地提交。',
    `当前目录：${entries.slice(0, 30).join('、') || '空目录'}${entries.length > 30 ? '……' : ''}`,
    '将按 .gitignore 提交当前文件作为子任务基线；没有 .gitignore 时创建常见依赖、环境文件和私钥的忽略规则。请先确认忽略范围。',
    '只修改本地仓库，不推送到远程。准备完成后即可继续委派。',
  ].join('\n'));
  if (!confirmed) throw new RepositorySetupCancelled();
  // Recheck after the dialog: another session or the user may have initialized it.
  const latest = await inspectRepository(cwd);
  if (latest.ready) return latest;
  if (fs.realpathSync(latest.root) !== fs.realpathSync(repo.root)) throw new Error('项目所属仓库已发生变化，请重新确认仓库准备。');
  if (latest.origin && latest.origin !== url) throw new Error('仓库地址已被其他会话修改，请重试。');
  if (!latest.initialized) await command(repo.root, ['init', '-b', 'main']);
  if (!latest.origin) await command(repo.root, ['remote', 'add', 'origin', url]);
  if (!await optionalConfig(repo.root, 'user.name')) await command(repo.root, ['config', '--local', 'user.name', name.trim()]);
  if (!await optionalConfig(repo.root, 'user.email')) await command(repo.root, ['config', '--local', 'user.email', email.trim()]);
  let parent;
  if (branch) {
    await command(repo.root, ['fetch', '--no-tags', 'origin', branch]);
    parent = await command(repo.root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    const tree = await command(repo.root, ['ls-tree', '-rz', '--full-tree', parent]);
    const files = tree.split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t');
      if (entry.startsWith('160000 ')) throw new Error('远程仓库含子模块，请先用 Git 克隆并初始化子模块后再开启委派。');
      return entry.slice(tab + 1);
    });
    const missing = files.filter(file => canRestore(repo.root, file));
    await command(repo.root, ['read-tree', parent]);
    // checkout-index without --force refuses to overwrite even if a file appears after inspection.
    if (missing.length) await command(repo.root, ['checkout-index', '-z', '--stdin'], missing.join('\0') + '\0');
  }
  const ignorePath = path.join(repo.root, '.gitignore');
  try { fs.writeFileSync(ignorePath, initialIgnore, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await command(repo.root, ['add', '--all', '--', '.']);
  const tree = await command(repo.root, ['write-tree']);
  const head = await command(repo.root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Prepare project baseline for Pi delegation']);
  // Publish the initial ref only once the complete baseline is ready; never reset an existing commit.
  await command(repo.root, ['update-ref', 'HEAD', head, '']);
  return { ...await inspectRepository(cwd), created: true };
}

export async function prepareRepository(cwd, ui, suppliedUrl) {
  const repo = await inspectRepository(cwd);
  if (repo.ready) return repo;
  const realRoot = fs.realpathSync(repo.root);
  const key = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  // Share the same result, including cancellation, so parallel tools do not repeat the dialog.
  if (locks.has(key)) return locks.get(key);
  const task = initialize(repo.root, ui, suppliedUrl);
  locks.set(key, task);
  try { return await task; }
  finally { if (locks.get(key) === task) locks.delete(key); }
}
