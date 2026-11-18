import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { boardName, postBoard, readBoard } from '../lib/team-board.mjs';

const lib = new URL('../lib/team-board.mjs', import.meta.url).href;
const exec = promisify(execFile);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-board-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
}

test('independent processes append to one existing board without truncation or interleaving', async t => {
  const root = fixture(t), file = path.join(root, boardName);
  assert.match(await readBoard(root, 's'), /no entries/);
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, 'User note without a final newline');
  await postBoard(root, 's', 'main', 'goal', 'Original goal');
  const writers = Array.from({length:5}, (_,i) => `t-worker${i}`);
  await Promise.all(writers.map(author => exec(process.execPath, ['--input-type=module','-e',
    `import {postBoard} from ${JSON.stringify(lib)}; for(let i=0;i<12;i++) await postBoard(process.argv[1],'s',process.argv[2],'update','note '+i+'\\nsecond line');`, root, author])));
  const data = fs.readFileSync(file, 'utf8'), entries = data.split('\n').filter(l=>l.startsWith('- '));
  assert(data.startsWith('User note without a final newline\n'));
  assert.equal(entries.length, 61);
  for (const author of writers) for (let i=0;i<12;i++) assert.equal(entries.filter(l=>l.endsWith(` | s/${author} | update | note ${i} second line`)).length, 1);
  const page = await readBoard(root, 's');
  assert.match(page, /Current session goal: .*Original goal/);
  assert.match(await readBoard(root, 's', Number(page.match(/before=(\d+)/)[1])), /Older entries/);
  assert.deepEqual(fs.readdirSync(root), [boardName]);
});

test('post never grants goal authority to workers or follows hard links', async t => {
  const root = fixture(t), other = path.join(root,'other');
  await assert.rejects(async()=>postBoard(root,'s','t-worker','goal','replacement'), /Only the main/);
  fs.writeFileSync(other, 'untouched'); fs.linkSync(other, path.join(root,boardName));
  await assert.rejects(postBoard(root,'s','main','goal','replacement'), /regular/);
  assert.equal(fs.readFileSync(other,'utf8'), 'untouched');
});
