import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { PromptStore, applyBinding, readEntryBinding, type PromptBinding, type PromptTemplate } from '../lib/core.mjs';

export default function promptManager(pi: ExtensionAPI) {
  const store = new PromptStore(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
  let binding: PromptBinding | null = null;
  let sessionId = '';
  pi.registerFlag('prompt-profile', { description: 'Prompt template id for this new session (default: configured template)', type: 'string' });

  async function initialize(ctx: ExtensionContext, reason = 'startup') {
    const id = ctx.sessionManager.getSessionId();
    if (binding && sessionId === id) return;
    const entries = ctx.sessionManager.getEntries();
    let existing = readEntryBinding(entries) || await store.binding(id);
    const parentFile = ctx.sessionManager.getHeader()?.parentSession;
    if (!existing && parentFile) {
      const lines = (await readFile(parentFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      existing = readEntryBinding(lines) || (lines[0]?.id ? await store.binding(lines[0].id) : null);
    }
    let selectedId: string | null | undefined;
    const flag = pi.getFlag('prompt-profile');
    const isNew = !existing && !entries.some(entry => entry.type === 'message');
    if (isNew && typeof flag === 'string') selectedId = flag === 'default' ? null : flag;
    else if (isNew && ctx.hasUI && !['reload', 'resume', 'fork'].includes(reason)) {
      const catalog = await store.list();
      const choices = [
        ...catalog.prompts.map(prompt => `${prompt.id === catalog.activeId ? '● ' : ''}${prompt.name} [${prompt.id}]`),
        'Pi 默认 [default]',
      ];
      const selected = await ctx.ui.select('为新会话选择提示词（会话创建后固定）', choices);
      if (selected) selectedId = selected.endsWith('[default]') ? null : selected.match(/\[([^\]]+)\]$/)?.[1];
    }
    const rendered = ctx.getSystemPrompt().replace(/\r\n/g, '\n');
    const sectionStart = rendered.search(/\n\n<(?:tools|rules|docs|addendum|project_context|skills|cwd)>/);
    const preamble = sectionStart < 0 ? rendered : rendered.slice(0, sectionStart);
    const options = {
      customPrompt: preamble.startsWith('You are a coding assistant running inside pi,') ? undefined : preamble,
      appendSystemPrompt: rendered.match(/<addendum>\n([\s\S]*?)\n<\/addendum>/)?.[1] ?? '',
    };
    // The extension API exposes a read-only SessionManager. Persist transcript metadata through pi.appendEntry.
    const manager = {
      getSessionId: () => id,
      getEntries: () => ctx.sessionManager.getEntries(),
      getBranch: () => ctx.sessionManager.getBranch(),
      appendCustomEntry: (type: string, data: unknown) => { pi.appendEntry(type, data); return ''; },
    };
    binding = await store.bind(manager, options, { selectedId, inheritedBinding: existing });
    sessionId = id;
    ctx.ui.setStatus('prompt-manager', `Prompt: ${binding.name} · v${binding.revision} · 固定`);
  }

  pi.on('session_start', async (event, ctx) => {
    binding = null;
    await initialize(ctx, event.reason);
  });
  pi.on('before_agent_start', async (event, ctx) => {
    await initialize(ctx);
    applyBinding(event.systemPromptOptions, binding!);
  });

  async function pick(ctx: ExtensionContext): Promise<PromptTemplate | null> {
    const catalog = await store.list();
    const choice = await ctx.ui.select('选择提示词', catalog.prompts.map(prompt => `${prompt.name} [${prompt.id}]`));
    return catalog.prompts.find(prompt => prompt.id === choice?.match(/\[([^\]]+)\]$/)?.[1]) ?? null;
  }
  pi.registerCommand('prompts', {
    description: '管理提示词；默认启用仅影响新会话，当前会话快照固定',
    getArgumentCompletions: prefix => ['list', 'current', 'use ', 'create', 'edit', 'delete'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        const [action, ...rest] = args.trim().split(/\s+/);
        if (action === 'use') {
          const id = rest.join(' ');
          if (!id) throw new Error('用法：/prompts use <id|default>');
          await store.activate(id === 'default' ? null : id);
          ctx.ui.notify('已设置新会话默认提示词。当前会话保持原快照。', 'info');
          return;
        }
        if (action === 'current') {
          ctx.ui.notify(binding ? `${binding.name} · v${binding.revision} · ${binding.digest.slice(0, 12)}（固定）` : '尚未绑定', 'info');
          return;
        }
        if (action === 'list') {
          const catalog = await store.list();
          ctx.ui.notify(catalog.prompts.map(prompt => `${prompt.id === catalog.activeId ? '● ' : ''}${prompt.name} v${prompt.revision} — ${prompt.id}`).join('\n') || '没有模板；新会话使用 Pi 默认。', 'info');
          return;
        }
        if (!ctx.hasUI) throw new Error('交互式管理需要 UI；也可以使用 /prompts list、current、use。');
        const operation = action || await ctx.ui.select('提示词管理（不改变当前会话）', ['创建', '编辑', '删除', '设置新会话默认', '当前会话']);
        if (operation === '当前会话') { ctx.ui.notify(`${binding?.name ?? '未绑定'}（当前会话固定）`, 'info'); return; }
        if (operation === '设置新会话默认') {
          const catalog = await store.list();
          const choice = await ctx.ui.select('新会话默认', ['Pi 默认 [default]', ...catalog.prompts.map(prompt => `${prompt.name} [${prompt.id}]`)]);
          if (choice) await store.activate(choice.endsWith('[default]') ? null : choice.match(/\[([^\]]+)\]$/)![1]);
          return;
        }
        const creating = operation === 'create' || operation === '创建';
        const prompt = creating ? null : await pick(ctx);
        if (!creating && !prompt) return;
        if (operation === 'delete' || operation === '删除') {
          if (await ctx.ui.confirm('删除提示词', `删除“${prompt!.name}”？旧会话的快照保留。`)) await store.delete(prompt!.id, prompt!.revision);
          return;
        }
        if (!creating && !['edit', '编辑'].includes(operation ?? '')) throw new Error('未知操作。');
        const name = await ctx.ui.input('名称', prompt?.name ?? '');
        if (!name) return;
        const description = await ctx.ui.input('用途说明', prompt?.description ?? '');
        if (description === undefined) return;
        const mode = await ctx.ui.select('模式', ['追加工作规则（保留 Pi 原生说明）', '替换完整 system prompt']);
        if (!mode) return;
        const content = await ctx.ui.editor('提示词正文', prompt?.content ?? '');
        if (content === undefined) return;
        const input = { name, description, content, mode: (mode.startsWith('追加') ? 'append' : 'replace') as 'append' | 'replace' };
        if (creating) await store.create(input); else await store.update(prompt!.id, input, prompt!.revision);
        ctx.ui.notify('已保存。只有之后的新会话会读取新版本。', 'info');
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
    },
  });
}
