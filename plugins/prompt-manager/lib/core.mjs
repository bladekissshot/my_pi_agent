import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import lockfile from 'proper-lockfile';

export const BINDING_ENTRY = 'pi-prompt-manager:binding:v1';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_CONTENT = 256 * 1024;
const now = () => new Date().toISOString();
const hash = (text) => createHash('sha256').update(text).digest('hex');
const normalize = (text) => (text ?? '').replace(/\r\n/g, '\n');
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

export class PromptError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function validateCatalog(value) {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.prompts)) throw new PromptError('Invalid prompt catalog; repair it before writing.', 500);
  const ids = new Set();
  for (const prompt of value.prompts) {
    if (!record(prompt) || !ID.test(prompt.id) || ids.has(prompt.id) || !Number.isInteger(prompt.revision) || prompt.revision < 1) throw new PromptError('Invalid prompt catalog.', 500);
    validateFields(prompt);
    ids.add(prompt.id);
  }
  if (value.activeId !== null && !ids.has(value.activeId)) throw new PromptError('Default prompt is missing from catalog.', 500);
  return value;
}
function validateFields(input) {
  if (!record(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new PromptError('Prompt name must be 1–100 characters.');
  if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT) throw new PromptError('Prompt content must be text, at most 256 KiB.');
  if (!['append', 'replace'].includes(input.mode)) throw new PromptError('Prompt mode must be append or replace.');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 1000)) throw new PromptError('Description must be at most 1,000 characters.');
  return { name: input.name.trim(), description: input.description ?? '', content: normalize(input.content), mode: input.mode };
}
export function validateBinding(binding) {
  if (!record(binding) || binding.version !== 1 || !record(binding.prompt) || !['append', 'replace', 'legacy'].includes(binding.mode)
      || typeof binding.prompt.appendSystemPrompt !== 'string' || (binding.prompt.customPrompt !== null && typeof binding.prompt.customPrompt !== 'string')
      || (binding.prompt.forceSystemPrompt !== null && typeof binding.prompt.forceSystemPrompt !== 'string')
      || binding.digest !== hash(JSON.stringify(binding.prompt))) throw new PromptError('Invalid session prompt snapshot; refusing to replace it.', 500);
  return binding;
}
export function readEntryBinding(entries) {
  const snapshots = entries.filter(entry => entry.type === 'custom' && entry.customType === BINDING_ENTRY);
  if (!snapshots.length) return null;
  const binding = validateBinding(snapshots[0].data);
  if (snapshots.some(entry => validateBinding(entry.data).digest !== binding.digest)) throw new PromptError('Conflicting session prompt snapshots.', 409);
  return binding;
}
export function legacyPromptFromEntries(entries, base) {
  const sections = {};
  let hasSystem = false;
  let opaque = null;
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== 'message' || message?.role !== 'system') continue;
    hasSystem = true;
    if (message.sections) {
      for (const [key, value] of Object.entries(message.sections)) { if (value === null) delete sections[key]; else sections[key] = value; }
    } else if (typeof message.content === 'string' && message.content) opaque = message.content;
  }
  if (!hasSystem) return { customPrompt: base.customPrompt ?? null, appendSystemPrompt: normalize(base.appendSystemPrompt), forceSystemPrompt: null };
  if (!sections.preamble && opaque) return { customPrompt: null, appendSystemPrompt: '', forceSystemPrompt: opaque };
  const unwrap = (name, value) => value?.replace(new RegExp(`^<${name}>\\n`), '').replace(new RegExp(`\\n</${name}>$`), '') ?? '';
  const preamble = sections.preamble;
  return { customPrompt: preamble?.startsWith('You are a coding assistant running inside pi,') ? null : preamble ?? null,
    appendSystemPrompt: unwrap('addendum', sections.addendum), forceSystemPrompt: null };
}
export function applyBinding(options, binding) {
  const prompt = validateBinding(binding).prompt;
  options.customPrompt = prompt.customPrompt ?? undefined;
  options.appendSystemPrompt = prompt.appendSystemPrompt;
  if (prompt.forceSystemPrompt !== null) options.forceSystemPrompt = prompt.forceSystemPrompt;
}

export class PromptStore {
  constructor(agentDir) {
    this.agentDir = agentDir;
    this.dir = path.join(agentDir, 'prompt-manager');
    this.file = path.join(this.dir, 'catalog.json');
  }
  async transact(update) {
    await fs.mkdir(this.dir, { recursive: true });
    try { await fs.writeFile(this.file, JSON.stringify({ version: 1, activeId: null, prompts: [], initialized: false }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const release = await lockfile.lock(this.file, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } });
    try {
      const catalog = validateCatalog(await readJson(this.file));
      if (!catalog.initialized) {
        let legacy = '';
        try { legacy = normalize(await fs.readFile(path.join(this.agentDir, 'APPEND_SYSTEM.md'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (legacy.trim()) {
          catalog.prompts.push({ id: 'general', name: '通用工程', description: '导入当前已应用的通用提示词', content: legacy, mode: 'append', revision: 1, createdAt: now(), updatedAt: now() });
          catalog.activeId = 'general';
        }
        catalog.initialized = true;
      }
      const result = await update(catalog);
      await atomicJson(this.file, catalog);
      return result;
    } finally { await release(); }
  }
  async list() { return this.transact(catalog => structuredClone(catalog)); }
  async create(input) {
    const fields = validateFields(input);
    return this.transact(catalog => {
      if (catalog.prompts.length >= 100) throw new PromptError('At most 100 prompt templates are supported.');
      const prompt = { id: randomUUID(), ...fields, revision: 1, createdAt: now(), updatedAt: now() };
      catalog.prompts.push(prompt);
      return prompt;
    });
  }
  async update(id, input, expectedRevision) {
    const fields = validateFields(input);
    return this.transact(catalog => {
      const index = catalog.prompts.findIndex(prompt => prompt.id === id);
      if (index < 0) throw new PromptError('Prompt not found.', 404);
      if (catalog.prompts[index].revision !== expectedRevision) throw new PromptError('Prompt changed elsewhere. Reload before saving.', 409);
      const prompt = { ...catalog.prompts[index], ...fields, revision: expectedRevision + 1, updatedAt: now() };
      catalog.prompts[index] = prompt;
      return prompt;
    });
  }
  async delete(id, expectedRevision) {
    return this.transact(catalog => {
      const prompt = catalog.prompts.find(prompt => prompt.id === id);
      if (!prompt) throw new PromptError('Prompt not found.', 404);
      if (prompt.revision !== expectedRevision) throw new PromptError('Prompt changed elsewhere. Reload before deleting.', 409);
      catalog.prompts = catalog.prompts.filter(prompt => prompt.id !== id);
      if (catalog.activeId === id) catalog.activeId = null;
      return { deleted: id, activeId: catalog.activeId };
    });
  }
  async activate(id) {
    return this.transact(catalog => {
      if (id !== null && !catalog.prompts.some(prompt => prompt.id === id)) throw new PromptError('Prompt not found.', 404);
      catalog.activeId = id;
      return { activeId: id };
    });
  }
  async binding(sessionId) {
    if (!ID.test(sessionId)) throw new PromptError('Invalid session id.');
    const value = await readJson(path.join(this.dir, 'sessions', sessionId + '.json'));
    return value ? validateBinding(value) : null;
  }
  async bind(manager, base, { selectedId, inheritedBinding } = {}) {
    const sessionId = manager.getSessionId();
    if (!ID.test(sessionId)) throw new PromptError('Invalid session id.');
    const entries = manager.getEntries();
    const entryBinding = readEntryBinding(entries);
    const saved = await this.binding(sessionId);
    if (entryBinding && saved && entryBinding.digest !== saved.digest) throw new PromptError('Session snapshot mismatch; refusing to change prompt.', 409);
    let binding = saved ?? entryBinding ?? inheritedBinding;
    if (!binding) {
      const hasConversation = entries.some(entry => entry.type === 'message' && entry.message?.role !== 'system');
      if (hasConversation || entries.some(entry => entry.type === 'message' && entry.message?.role === 'system')) {
        binding = { version: 1, id: null, name: '旧会话提示词', revision: 0, mode: 'legacy', boundAt: now(), prompt: legacyPromptFromEntries(manager.getBranch(), base) };
      } else {
        const catalog = await this.list();
        const id = selectedId === undefined ? catalog.activeId : selectedId;
        const profile = id === null ? null : catalog.prompts.find(prompt => prompt.id === id);
        if (id !== null && !profile) throw new PromptError('Prompt not found.', 404);
        let globalAppend = '';
        try { globalAppend = normalize(await fs.readFile(path.join(this.agentDir, 'APPEND_SYSTEM.md'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const configuredAppend = normalize(base.appendSystemPrompt);
        const supplemental = configuredAppend.trim() !== globalAppend.trim() ? configuredAppend : '';
        const prompt = profile?.mode === 'replace'
          ? { customPrompt: null, appendSystemPrompt: '', forceSystemPrompt: profile.content }
          : { customPrompt: base.customPrompt ?? null, appendSystemPrompt: [profile?.content, supplemental].filter(Boolean).join('\n\n'), forceSystemPrompt: null };
        binding = { version: 1, id: profile?.id ?? null, name: profile?.name ?? 'Pi 默认', revision: profile?.revision ?? 0, mode: profile?.mode ?? 'append', boundAt: now(), prompt };
      }
      binding.digest = hash(JSON.stringify(binding.prompt));
    }
    binding = validateBinding(binding);
    const dir = path.join(this.dir, 'sessions');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, sessionId + '.json');
    // Atomic first-writer-wins publication prevents two runtime starters from rebinding a session.
    const temp = path.join(dir, '.' + randomUUID() + '.tmp');
    try {
      await fs.writeFile(temp, JSON.stringify(binding, null, 2), { flag: 'wx', mode: 0o600 });
      try { await fs.link(temp, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const canonical = validateBinding(await readJson(file));
      if (entryBinding && canonical.digest !== entryBinding.digest) throw new PromptError('Session snapshot mismatch.', 409);
      binding = canonical;
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    if (!entryBinding) manager.appendCustomEntry(BINDING_ENTRY, binding);
    return binding;
  }
}
