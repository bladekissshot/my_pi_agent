import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PromptStore, BINDING_ENTRY, applyBinding } from '../lib/core.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-prompt-manager-test-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('pi-prompt-manager-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store: new PromptStore(root) };
}
function manager(id = randomUUID(), entries = []) {
  return { entries, getSessionId: () => id, getEntries: () => entries, getBranch: () => entries,
    appendCustomEntry: (customType, data) => { entries.push({ type: 'custom', customType, data: structuredClone(data) }); return 'entry'; } };
}
const input = content => ({ name: content, content, mode: 'append' });

test('CRUD uses revision checks, and deleting the active template resets only the default', async t => {
  const { store } = await fixture(t);
  const a = await store.create(input('A'));
  await store.activate(a.id);
  const edited = await store.update(a.id, input('A2'), a.revision);
  assert.equal(edited.revision, 2);
  await assert.rejects(store.update(a.id, input('stale'), 1), { status: 409 });
  await assert.rejects(store.delete(a.id, 1), { status: 409 });
  await store.delete(a.id, 2);
  assert.equal((await store.list()).activeId, null);
});
test('changing defaults, editing and deleting a template never rebind an existing session', async t => {
  const { store } = await fixture(t);
  const a = await store.create(input('A'));
  await store.activate(a.id);
  const old = manager();
  const bound = await store.bind(old, {});
  await store.update(a.id, input('A edited'), 1);
  const b = await store.create(input('B'));
  await store.activate(b.id);
  await store.delete(a.id, 2);
  const resumed = manager(old.getSessionId(), structuredClone(old.entries));
  const restored = await store.bind(resumed, { appendSystemPrompt: 'unexpected new global text' }, { selectedId: b.id });
  assert.deepEqual(restored, bound);
  assert.equal(restored.prompt.appendSystemPrompt, 'A');
  assert.equal((await store.bind(manager(), {})).prompt.appendSystemPrompt, 'B');
});
test('a fork carries the parent snapshot even when the default has changed', async t => {
  const { store } = await fixture(t);
  const a = await store.create(input('A')); await store.activate(a.id);
  const parent = manager(); const snapshot = await store.bind(parent, {});
  const b = await store.create(input('B')); await store.activate(b.id);
  const child = manager(randomUUID(), structuredClone(parent.entries));
  assert.deepEqual(await store.bind(child, {}), snapshot);
});
test('legacy sessions capture their recorded addendum, not the newly selected template', async t => {
  const { store } = await fixture(t);
  const b = await store.create(input('B')); await store.activate(b.id);
  const old = manager(randomUUID(), [
    { type: 'message', message: { role: 'system', sections: { preamble: 'You are a coding assistant running inside pi, a coding agent harness.', addendum: '<addendum>\nOLD\n</addendum>' } } },
    { type: 'message', message: { role: 'user', content: 'previous work' } },
  ]);
  const binding = await store.bind(old, { appendSystemPrompt: 'NEW GLOBAL' });
  assert.equal(binding.mode, 'legacy'); assert.equal(binding.prompt.appendSystemPrompt, 'OLD');
});
test('import the existing universal prompt, without duplicating it; native default removes managed text', async t => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'APPEND_SYSTEM.md'), 'GENERAL\r\n');
  assert.equal((await store.list()).activeId, 'general');
  assert.equal((await store.bind(manager(), { appendSystemPrompt: 'GENERAL\r\n' })).prompt.appendSystemPrompt, 'GENERAL\n');
  await store.activate(null);
  assert.equal((await store.bind(manager(), { appendSystemPrompt: 'GENERAL\r\n' })).prompt.appendSystemPrompt, '');
});
test('project-specific appended instructions are retained in the session snapshot', async t => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'APPEND_SYSTEM.md'), 'GENERAL');
  await store.list();
  const a = await store.create(input('A')); await store.activate(a.id);
  assert.equal((await store.bind(manager(), { appendSystemPrompt: 'PROJECT' })).prompt.appendSystemPrompt, 'A\n\nPROJECT');
});
test('simultaneous starters converge on one immutable snapshot', async t => {
  const { store } = await fixture(t);
  const a = await store.create(input('A')); const b = await store.create(input('B'));
  const id = randomUUID();
  const [first, second] = await Promise.all([
    store.bind(manager(id), {}, { selectedId: a.id }),
    store.bind(manager(id), {}, { selectedId: b.id }),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(await store.binding(id), first);
});
test('replace mode, empty replacement and malformed catalog are handled without overwriting old data', async t => {
  const { store } = await fixture(t);
  const a = await store.create({ ...input('X'), mode: 'replace', content: '' });
  const binding = await store.bind(manager(), {}, { selectedId: a.id });
  const options = {}; applyBinding(options, binding);
  assert.equal(options.forceSystemPrompt, '');
  await fs.writeFile(store.file, '{broken');
  await assert.rejects(store.create(input('B')));
  assert.equal(await fs.readFile(store.file, 'utf8'), '{broken');
});
test('missing or conflicting snapshots fail closed, and cannot silently adopt a new default', async t => {
  const { store } = await fixture(t);
  const old = manager(); const bound = await store.bind(old, {});
  old.entries.push({ type: 'custom', customType: BINDING_ENTRY, data: { ...bound, prompt: { ...bound.prompt, appendSystemPrompt: 'tampered' } } });
  await assert.rejects(store.bind(old, {}));
});
