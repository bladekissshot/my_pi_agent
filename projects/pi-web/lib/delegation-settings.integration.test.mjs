import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { registerSettingsController } from 'pi-delegation/settings';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');

function setup(t) {
  const inner = {
    sessionId: 'delegation-command-test', isStreaming: false, isCompacting: false, isBashRunning: false,
    sessionManager: { getCwd: () => process.cwd() }, agent: { state: {} }, extensionRunner: {},
    abort: async () => {}, clearQueue: () => ({ steering: [], followUp: [] }), dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  return wrapper;
}

test('configuration commands participate in wrapper mutation/replacement and native dialog cancellation', async t => {
  const wrapper = setup(t);
  const ui = wrapper.createExtensionUiContext();
  let applied = false;
  const release = registerSettingsController(join(getAgentDir(), 'pi-delegation'), wrapper.sessionId, {
    execute: async () => { await ui.confirm('Prepare repository', 'Confirm baseline'); applied = true; return {}; },
  });
  t.after(release);
  const events = [];
  wrapper.onEvent(event => events.push(event));
  const pending = wrapper.send({ type: 'delegation_settings', request: { action: 'repo' } });
  const rejected = assert.rejects(pending, /cancelled by Stop/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrapper.hasLocalRestartBlocker(), true);
  assert.equal(wrapper.isRunning(), true, 'a configuration dialog keeps its session alive');
  await assert.rejects(wrapper.send({ type: 'reload' }), /before reloading/);
  assert.equal(events.some(event => event.method === 'confirm'), true);
  await assert.rejects(wrapper.send({ type: 'clone' }), /another session command/);
  await wrapper.send({ type: 'abort' });
  await rejected;
  assert.equal(applied, false);
  assert.equal(wrapper.pendingUiRequests.size, 0);
  assert.equal(wrapper.hasLocalRestartBlocker(), false);

  const next = wrapper.send({ type: 'delegation_settings', request: { action: 'repo' } });
  await new Promise(resolve => setImmediate(resolve));
  const dialog = events.findLast(event => event.method === 'confirm');
  await wrapper.send({ type: 'extension_ui_response', id: dialog.id, confirmed: true });
  await next;
  assert.equal(applied, true, 'a new explicit configuration operation can ask after Stop');
});

test('missing plugin cannot turn configuration into a model prompt', async t => {
  const wrapper = setup(t);
  await assert.rejects(wrapper.send({ type: 'delegation_settings', request: { action: 'apply', patch: {}, revision: 'x' } }), /not loaded/);
  assert.equal(wrapper.hasLocalRestartBlocker(), false);
});
