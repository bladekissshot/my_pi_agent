import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS, atomicJson, Coordinator } from '../lib/core.mjs';
import { configRevision, readDefaultSettings, saveDefaultSettings, validateConfigPatch, registerSettingsController, getSettingsController } from '../lib/settings.mjs';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegation-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('settings reject invalid or hidden fields before writing any preference', t => {
  const dir = temporary(t);
  for (const patch of [null, [], { maxConcurrent: 1.5 }, { maxConcurrent: 9 }, { maxTurns: 16 }, { taskTimeoutMs: 9999 }, { taskTimeoutMs: Infinity }, { panel: 'false' }, { execThinking: 'turbo' }, { execModel: 'worker' }, { execModel: 'p/a\n' }, { unknown: 1 }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => saveDefaultSettings(dir, patch));
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
  }
  assert.deepEqual(validateConfigPatch({ mode: 'auto', execModel: 'provider/nested/model:tag', maxConcurrent: 8, taskTimeoutMs: 3600000 }), { mode: 'auto', execModel: 'provider/nested/model:tag', maxConcurrent: 8, taskTimeoutMs: 3600000 });
});

test('defaults cannot opt another session into AUTO and preserve unknown stored fields', t => {
  const dir = temporary(t);
  atomicJson(path.join(dir, 'config.json'), { ...DEFAULTS, mode: 'auto', futureSetting: 'keep' });
  const before = readDefaultSettings(dir);
  assert.equal(before.config.mode, 'off');
  assert.equal('futureSetting' in before.config, false);
  assert.throws(() => saveDefaultSettings(dir, { mode: 'auto' }));
  const after = saveDefaultSettings(dir, { execModel: 'local/worker', execThinking: 'high', taskTimeoutMs: 20000 }, before.revision);
  assert.equal(after.config.mode, 'off');
  assert.notEqual(after.revision, before.revision);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).futureSetting, 'keep');
  assert.throws(() => saveDefaultSettings(dir, { panel: false }, before.revision), { status: 409 });
  assert.deepEqual(readDefaultSettings(dir), after);
});

test('a legacy AUTO default never enables a new coordinator, restored session opt-in survives', t => {
  const dir = temporary(t);
  atomicJson(path.join(dir, 'config.json'), { ...DEFAULTS, mode: 'auto' });
  const fresh = new Coordinator({ dir, cwd: dir, sessionId: 'fresh', runner: async () => ({}) });
  assert.equal(fresh.config.mode, 'off');
  fresh.configure({ mode: 'auto' });
  fresh.close();
  const restored = new Coordinator({ dir, cwd: dir, sessionId: 'fresh', runner: async () => ({}) });
  assert.equal(restored.config.mode, 'auto');
  restored.close();
});

test('registry is scoped to agent directory and old cleanup cannot remove a replacement', t => {
  const dir = temporary(t);
  const first = {}, second = {};
  const release = registerSettingsController(dir, 'one', first);
  assert.equal(getSettingsController(dir, 'one'), first);
  assert.equal(getSettingsController(path.join(dir, 'other'), 'one'), undefined);
  const releaseSecond = registerSettingsController(dir, 'one', second);
  release();
  assert.equal(getSettingsController(dir, 'one'), second);
  releaseSecond();
  assert.equal(getSettingsController(dir, 'one'), undefined);
  assert.equal(configRevision({ ...DEFAULTS }), configRevision({ ...DEFAULTS, ignored: true }));
});
