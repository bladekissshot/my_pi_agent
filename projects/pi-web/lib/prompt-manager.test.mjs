import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { PromptStore } from 'pi-prompt-manager';
import { prepareSessionPrompt } from './prompt-manager.ts';

test('Web preparation locks the template before first prompt and shares the same snapshots as the CLI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-web-prompt-manager-test-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    await fs.writeFile(path.join(root, 'APPEND_SYSTEM.md'), 'ORIGINAL GENERAL');
    const settings = SettingsManager.inMemory({});
    const firstManager = SessionManager.inMemory(root);
    const first = await prepareSessionPrompt(firstManager, settings, root);
    assert.equal(first.id, 'general');
    const store = new PromptStore(root);
    const b = await store.create({ name: 'B', content: 'B original', mode: 'append' });
    await store.activate(b.id);
    assert.deepEqual(await prepareSessionPrompt(firstManager, settings, root, b.id), first);
    const secondManager = SessionManager.inMemory(root);
    const second = await prepareSessionPrompt(secondManager, settings, root);
    assert.equal(second.prompt.appendSystemPrompt, 'B original');
    await store.update(b.id, { name: 'B revised', content: 'B changed', mode: 'append' }, 1);
    assert.deepEqual(await prepareSessionPrompt(secondManager, settings, root), second);
    await store.delete(b.id, 2);
    assert.deepEqual(await prepareSessionPrompt(secondManager, settings, root), second);
    assert.equal((await prepareSessionPrompt(SessionManager.inMemory(root), settings, root)).prompt.appendSystemPrompt, '');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('pi-web-prompt-manager-test-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
