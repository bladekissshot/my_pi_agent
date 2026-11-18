import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const boardName = 'TeamBoard.MD';
const header = '# TeamBoard\n\n项目协作记录（仅追加）。格式：UTC 时间 | 主会话/作者 | 类型 | 简述。确认不等于验收。\n';
const kinds = new Set(['goal', 'update', 'ask', 'confirm', 'block']);

// Pi's mutation queue is per process; separate host processes can share a checkout.
// Never steal a lock based on age: a paused but live writer may still own it.
async function withBoard(root, signal, action) {
  const file = path.join(root, boardName), lock = path.join(root, `.${boardName}.lock`);
  const deadline = Date.now() + 3000;
  for (;;) {
    signal?.throwIfAborted();
    try { fs.mkdirSync(lock); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error(`TeamBoard busy. Retry later; if all writers have stopped, check for a stale lock: ${lock}`);
      await sleep(25, undefined, { signal });
    }
  }
  try {
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && (!st.isFile() || st.nlink !== 1)) throw new Error('TeamBoard.MD must be a regular, unlinked project file (no symlink or hard link).');
    return action(file, st);
  } finally { fs.rmdirSync(lock); }
}

export function postBoard(root, session, author, kind, text, signal) {
  if (!kinds.has(kind) || (kind === 'goal' && author !== 'main')) throw new Error('Only the main agent can record project goals; use a supported entry kind.');
  const note = text?.replace(/[\s\u0000-\u001f\u007f]+/gu, ' ').trim();
  if (!note || note.length > 600) throw new Error('Provide one concise TeamBoard note (1–600 characters).');
  return withBoard(root, signal, (file, st) => {
    const line = `- ${new Date().toISOString()} | ${session}/${author} | ${kind} | ${note}`;
    // A leading newline also separates an existing user-authored last line without an EOL.
    fs.appendFileSync(file, `${st?.size ? '' : header}\n${line}\n`, { mode: 0o600 });
    return line;
  });
}

export function readBoard(root, session, before, signal) {
  return withBoard(root, signal, (file, st) => {
    if (!st?.size) return 'TeamBoard.MD has no entries yet.';
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim());
    const end = before === undefined ? lines.length : Math.min(lines.length, before - 1);
    const start = Math.max(0, end - 16), page = lines.slice(start, end);
    const goal = lines.findLast(line => line.startsWith('- ') && line.split(' | ', 3).slice(1).join(' | ') === `${session}/main | goal`);
    const result = page.map((line, i) => `${start + i + 1}: ${line.slice(0, 900)}`);
    if (goal && !page.includes(goal)) result.unshift(`Current session goal: ${goal.slice(0, 900)}`);
    if (start) result.push(`Older entries: read with before=${start + 1}.`);
    return result.join('\n') || 'No earlier entries.';
  });
}
