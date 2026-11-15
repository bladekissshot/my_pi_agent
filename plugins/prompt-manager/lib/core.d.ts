export interface PromptTemplate { id: string; name: string; description: string; content: string; mode: 'append' | 'replace'; revision: number; createdAt: string; updatedAt: string }
export interface PromptCatalog { version: 1; activeId: string | null; prompts: PromptTemplate[] }
export interface PromptBinding { version: 1; id: string | null; name: string; revision: number; mode: 'append' | 'replace' | 'legacy'; digest: string; boundAt: string; prompt: { customPrompt: string | null; appendSystemPrompt: string; forceSystemPrompt: string | null } }
export interface PromptManager { getSessionId(): string; getEntries(): any[]; getBranch(): any[]; appendCustomEntry(type: string, data: unknown): string }
export interface PromptBase { customPrompt?: string; appendSystemPrompt?: string; forceSystemPrompt?: string }
export const BINDING_ENTRY: string;
export class PromptError extends Error { status: number; constructor(message: string, status?: number) }
export class PromptStore {
  agentDir: string; dir: string; file: string;
  constructor(agentDir: string);
  list(): Promise<PromptCatalog>;
  create(input: Pick<PromptTemplate, 'name' | 'content' | 'mode'> & { description?: string }): Promise<PromptTemplate>;
  update(id: string, input: Pick<PromptTemplate, 'name' | 'content' | 'mode'> & { description?: string }, expectedRevision: number): Promise<PromptTemplate>;
  delete(id: string, expectedRevision: number): Promise<{ deleted: string; activeId: string | null }>;
  activate(id: string | null): Promise<{ activeId: string | null }>;
  binding(sessionId: string): Promise<PromptBinding | null>;
  bind(manager: PromptManager, base: PromptBase, options?: { selectedId?: string | null; inheritedBinding?: PromptBinding | null }): Promise<PromptBinding>;
}
export function validateBinding(binding: unknown): PromptBinding;
export function readEntryBinding(entries: any[]): PromptBinding | null;
export function legacyPromptFromEntries(entries: any[], base: PromptBase): PromptBinding['prompt'];
export function applyBinding(options: PromptBase, binding: PromptBinding): void;
