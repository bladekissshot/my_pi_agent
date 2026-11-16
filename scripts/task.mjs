import fs from 'node:fs/promises';
import path from 'node:path';
import { root, npm, run } from './process.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or newer.');
for (const key of Object.keys(process.env)) {
  if (/API_KEY|(?:^|_)TOKEN(?:_|$)|PASSWORD|SECRET/.test(key) || ['PI_CODING_AGENT_DIR', 'PI_LIVE_TEST', 'PI_SDK_PATH'].includes(key)) delete process.env[key];
}
const consumers = ['plugins/prompt-manager', 'plugins/delegation', 'projects/pi-web'];

async function seedModelData() {
  const destination = path.join(root, 'projects/pi/packages/ai/src/providers/data');
  if (await fs.stat(path.join(destination, '.manifest.json')).catch(() => null)) return;
  const version = JSON.parse(await fs.readFile(path.join(root, 'projects/pi/packages/ai/package.json'), 'utf8')).version;
  for (const consumer of consumers) {
    const installed = path.join(root, consumer, 'node_modules/@earendil-works/pi-ai');
    const metadata = await fs.readFile(path.join(installed, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    const data = path.join(installed, 'dist/providers/data');
    if (metadata?.version !== version || !await fs.stat(path.join(data, '.manifest.json')).catch(() => null)) continue;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(data, destination, { recursive: true, force: false, errorOnExist: true });
    console.log('Seeded model data from the matching public Pi package.');
    return;
  }
  throw new Error('No matching published Pi model data found. Run bootstrap with SDK versions matching the selected Pi revision, or hydrate the upstream catalog explicitly.');
}

async function linkPiPackages() {
  const packages = [];
  for (const name of await fs.readdir(path.join(root, 'projects/pi/packages'))) {
    const folder = path.join(root, 'projects/pi/packages', name);
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (metadata.name?.startsWith('@earendil-works/')) packages.push({ folder, name: metadata.name });
  }
  const stamp = Date.now().toString();
  for (const consumer of consumers) {
    const modules = path.join(root, consumer, 'node_modules');
    await fs.mkdir(modules, { recursive: true });
    if (!(await fs.realpath(modules)).startsWith(root + path.sep)) throw new Error('Refusing to change node_modules outside this checkout.');
    for (const pkg of packages) {
      const target = path.join(modules, ...pkg.name.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (!(await fs.realpath(path.dirname(target))).startsWith(root + path.sep)) throw new Error('Refusing to change a package namespace outside this checkout.');
      try {
        if ((await fs.realpath(target)) === pkg.folder) continue;
        const backup = path.join(root, '.local/module-backups', stamp, consumer, pkg.name);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        if (!(await fs.realpath(path.dirname(backup))).startsWith(root + path.sep)) throw new Error('Refusing to move package backups outside this checkout.');
        await fs.rename(target, backup);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.symlink(pkg.folder, target, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  console.log('Pi Web and plugins now resolve the local Pi SDK packages.');
}

const task = process.argv[2];
switch (task) {
  case 'bootstrap':
    // An agent launched by `next start` inherits NODE_ENV=production. Builds
    // still need the pinned compilers and test tools, never a global fallback.
    for (const folder of ['projects/pi', ...consumers]) npm(['ci', '--ignore-scripts', '--include=dev'], path.join(root, folder));
    break;
  case 'build-pi':
    await seedModelData();
    npm(['run', 'build:offline'], path.join(root, 'projects/pi'));
    await linkPiPackages();
    break;
  case 'link-pi': await linkPiPackages(); break;
  case 'build-web':
    if (!await fs.stat(path.join(root, 'projects/pi/packages/coding-agent/dist/index.js')).catch(() => null)) throw new Error('Run build:pi first.');
    await linkPiPackages();
    run(process.execPath, ['--max-old-space-size=16384', 'node_modules/next/dist/bin/next', 'build', '--webpack'], path.join(root, 'projects/pi-web'));
    break;
  case 'test':
    for (const folder of ['plugins/prompt-manager', 'plugins/delegation']) npm(['test'], path.join(root, folder));
    npm(['run', 'test:integration'], path.join(root, 'plugins/delegation'));
    run(process.execPath, ['--experimental-strip-types', '--test', 'lib/prompt-manager.test.mjs', 'lib/prompt-manager-runtime.integration.test.mjs', 'lib/exact-system-prompt.test.mjs', 'lib/session-fork.test.mjs', 'lib/rpc-manager-tool-exposure.test.mjs', 'lib/streaming-message.test.mjs', 'lib/local-runtime-build.test.mjs', 'lib/default-cwd.test.mjs', 'lib/i18n/registry.test.mjs', 'lib/i18n/format.test.mjs'], path.join(root, 'projects/pi-web'));
    break;
  case 'check-web':
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], path.join(root, 'projects/pi-web'));
    run(process.execPath, ['node_modules/eslint/bin/eslint.js', 'components/SystemPromptPanel.tsx', 'components/AppShell.tsx', 'components/ChatWindow.tsx', 'hooks/useAgentSession.ts', 'next.config.ts', 'lib/prompt-manager.ts', 'lib/rpc-manager.ts', 'lib/default-cwd.ts', 'lib/allowed-roots.ts', 'app/api/prompts/route.ts', 'app/api/agent/new/route.ts'], path.join(root, 'projects/pi-web'));
    break;
  default: throw new Error('Use bootstrap, build-pi, build-web, test, check-web or link-pi.');
}
