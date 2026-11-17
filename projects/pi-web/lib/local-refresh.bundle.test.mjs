import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const compiled = require('next/dist/compiled/webpack/webpack');
const webpack = compiled.webpack ?? compiled.default;

test('the production bundler keeps the configured helper a native Node import', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-refresh-bundle-'));
  const previous = process.env.PI_WEB_LOCAL_REFRESH_CONFIG;
  try {
    const source = await fs.readFile(new URL('./local-refresh.ts', import.meta.url), 'utf8');
    await fs.writeFile(path.join(root, 'entry.mjs'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
    const helperPath = path.join(root, 'helper.cjs');
    const config = path.join(root, 'runtime.json');
    await fs.writeFile(helperPath, `exports.readConfig=()=>({stateDir:${JSON.stringify(root)}}); exports.status=()=>({target:null,targetError:null,job:null});`);
    await fs.writeFile(config, JSON.stringify({ helperPath }));
    await new Promise((resolve, reject) => webpack({ mode: 'production', target: 'node', entry: path.join(root, 'entry.mjs'),
      optimization: { minimize: false }, // Exercise the parser, without Next's app-only minifier wiring.
      output: { path: root, filename: 'bundle.cjs', library: { type: 'commonjs2' } } }, (error, stats) => {
      if (error || stats.hasErrors()) reject(error ?? new Error(stats.toString())); else resolve();
    }));
    process.env.PI_WEB_LOCAL_REFRESH_CONFIG = config;
    assert.equal(require(path.join(root, 'bundle.cjs')).localRefreshStatus(0).available, true);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_LOCAL_REFRESH_CONFIG; else process.env.PI_WEB_LOCAL_REFRESH_CONFIG = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
