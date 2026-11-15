import test from 'node:test';
import assert from 'node:assert/strict';
import { getAdditionalAllowedRoots } from './allowed-roots.ts';

test('the configured default workspace remains accessible without a saved session', () => {
  const previous = process.env.PI_WEB_DEFAULT_CWD_ROOT;
  const roots = globalThis.__piAdditionalAllowedRoots;
  try {
    process.env.PI_WEB_DEFAULT_CWD_ROOT = '/fixture/workspaces';
    globalThis.__piAdditionalAllowedRoots = undefined;
    assert.ok(getAdditionalAllowedRoots().has('/fixture/workspaces'));
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DEFAULT_CWD_ROOT; else process.env.PI_WEB_DEFAULT_CWD_ROOT = previous;
    globalThis.__piAdditionalAllowedRoots = roots;
  }
});
