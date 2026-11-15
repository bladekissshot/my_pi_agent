import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import extension from '../extensions/prompts.ts';
import { PromptStore } from '../lib/core.mjs';

test('real Pi extension preserves old prompts through reload and model changes, while new sessions use the new template', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-prompt-manager-sdk-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const sessions = [];
  const observed = [];
  try {
    await fs.writeFile(path.join(root, 'APPEND_SYSTEM.md'), 'INITIAL PROFILE');
    const runtime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: path.join(root, 'models.json'), allowModelNetwork: false });
    await runtime.setRuntimeApiKey('openai', 'test-only-no-network');
    const model = { id: 'test-model', provider: 'openai', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 100 };
    async function start() {
      const settings = SettingsManager.inMemory({});
      const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, disabledBuiltinExtensions: ['mcp', 'codemode'], noThemes: true, noSkills: true, noPromptTemplates: true, extensionFactories: [extension, pi => {
        pi.on('before_agent_start', (event, ctx) => { observed.push(structuredClone(event.systemPromptOptions)); void ctx.abort(); });
      }] });
      await resourceLoader.reload();
      const result = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model, settingsManager: settings, resourceLoader, sessionManager: SessionManager.inMemory(root), tools: ['read'] });
      assert.deepEqual(result.extensionsResult.errors, []);
      sessions.push(result.session);
      const errors = [];
      await result.session.bindExtensions({ onError: error => errors.push(error) });
      assert.deepEqual(errors, []);
      return result.session;
    }
    const first = await start();
    await first.prompt('Verify binding without a model request');
    assert.ok(observed.at(-1).appendSystemPrompt.includes('INITIAL PROFILE'));
    const store = new PromptStore(root);
    const b = await store.create({ name: 'B', content: 'SECOND PROFILE', mode: 'append' });
    await store.activate(b.id);
    await fs.writeFile(path.join(root, 'APPEND_SYSTEM.md'), 'GLOBAL CHANGED');
    await first.reload();
    await first.prompt('Verify binding after reload');
    assert.ok(observed.at(-1).appendSystemPrompt.includes('INITIAL PROFILE'));
    assert.ok(!observed.at(-1).appendSystemPrompt.includes('GLOBAL CHANGED'));
    await first.setModel({ ...model, id: 'another-test-model' });
    first.setActiveToolsByName(['read', 'write']);
    await first.prompt('Verify binding after model and tool changes');
    assert.ok(observed.at(-1).appendSystemPrompt.includes('INITIAL PROFILE'));
    const second = await start();
    await second.prompt('Verify second binding');
    assert.ok(observed.at(-1).appendSystemPrompt.includes('SECOND PROFILE'));
    await store.delete(b.id, 1);
    await second.reload();
    await second.prompt('Verify deleted-template binding');
    assert.ok(observed.at(-1).appendSystemPrompt.includes('SECOND PROFILE'));
    await first.prompt('/prompts current');
    assert.equal((await store.binding(first.sessionId)).name, '通用工程');
  } finally {
    for (const session of sessions) session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('pi-prompt-manager-sdk-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
