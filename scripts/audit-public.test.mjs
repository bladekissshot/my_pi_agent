import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContent } from './audit-public.mjs';

test('exact private keys and endpoints are checked even inside upstream blobs', () => {
  const secret = 'fixture-value-never-a-real-key';
  assert.deepEqual(inspectContent(Buffer.from(secret), { secrets: [secret], publicBlob: true }), ['exact-private-value']);
  assert.deepEqual(inspectContent(Buffer.from('https://private.example.invalid/v1'), { hosts: ['private.example.invalid'], publicBlob: true }), ['private-endpoint']);
});
test('findings contain rule names rather than the secret value', () => {
  const credential = 'ghp_' + 'a'.repeat(36);
  const result = inspectContent(Buffer.from(credential));
  assert.deepEqual(result, ['credential-shaped-literal']);
  assert.ok(!JSON.stringify(result).includes(credential));
});
test('symbolic env keys are allowed, while credentials embedded in a URL are refused', () => {
  assert.deepEqual(inspectContent(Buffer.from('${PI_PROVIDER_API_KEY}')), []);
  assert.deepEqual(inspectContent(Buffer.from(['https://', 'name', ':', 'password', '@example.invalid'].join(''))), ['credential-in-url']);
});
