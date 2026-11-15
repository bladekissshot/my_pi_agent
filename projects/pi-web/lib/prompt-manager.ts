import { DefaultResourceLoader, getAgentDir, type SessionManager, type SettingsManager, type InlineExtension } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { PromptStore, applyBinding, readEntryBinding, type PromptBinding } from 'pi-prompt-manager';

export const promptStore = () => new PromptStore(getAgentDir());

export async function prepareSessionPrompt(manager: SessionManager, settingsManager: SettingsManager, cwd: string, selectedId?: string | null): Promise<PromptBinding> {
  const store = promptStore();
  const loader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true,
    disabledBuiltinExtensions: ['mcp', 'codemode'], noSkills: true, noThemes: true, noPromptTemplates: true,
  });
  await loader.reload();
  let inheritedBinding: PromptBinding | null = null;
  const parent = manager.getHeader()?.parentSession;
  if (parent && !readEntryBinding(manager.getEntries())) {
    const entries = (await readFile(parent, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    inheritedBinding = readEntryBinding(entries) || await store.binding(entries[0].id);
  }
  return store.bind(manager, { customPrompt: loader.getSystemPrompt(), appendSystemPrompt: loader.getAppendSystemPrompt().join('\n\n') }, { selectedId, inheritedBinding });
}

export function sessionPromptExtension(binding: PromptBinding): InlineExtension {
  return { name: 'pi-prompt-manager-session', factory: pi => {
    pi.on('before_agent_start', event => { applyBinding(event.systemPromptOptions, binding); });
  } };
}
