export type DelegationThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface DelegationConfig {
  mode: 'off' | 'auto';
  execModel: string;
  execThinking: DelegationThinkingLevel;
  maxConcurrent: number;
  taskTimeoutMs: number;
  panel: boolean;
}
export interface DelegationSettings {
  config: DelegationConfig;
  revision: string;
}
export interface DelegationModel {
  id: string;
  name: string;
  thinkingLevels: string[];
}
export interface DelegationSnapshot extends DelegationSettings {
  sessionId: string;
  models: DelegationModel[];
  repositoryReady: boolean;
  tasks: Array<{ id: string; title: string; status: string }>;
}
export type DelegationAction =
  | { action: 'apply'; patch: Partial<DelegationConfig>; revision: string }
  | { action: 'repo' }
  | { action: 'stop'; taskId: string };
export interface DelegationSettingsController {
  snapshot(): Promise<DelegationSnapshot>;
  execute(request: DelegationAction): Promise<DelegationSnapshot>;
}
export const THINKING_LEVELS: DelegationThinkingLevel[];
export function settingsError(message: string, status?: number): Error & { status: number };
export function publicConfig(config: Partial<DelegationConfig>): DelegationConfig;
export function configRevision(config: Partial<DelegationConfig>): string;
export function assertConfigRevision(config: Partial<DelegationConfig>, expected?: string): void;
export function validateConfigPatch(raw: unknown, options?: { allowMode?: boolean }): Partial<DelegationConfig>;
export function readDefaultSettings(dir: string): DelegationSettings;
export function saveDefaultSettings(dir: string, raw: unknown, expectedRevision?: string): DelegationSettings;
export function registerSettingsController(dir: string, sessionId: string, controller: DelegationSettingsController): () => void;
export function getSettingsController(dir: string, sessionId: string): DelegationSettingsController | undefined;
