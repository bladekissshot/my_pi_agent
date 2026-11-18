import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  getSettingsController,
  readDefaultSettings,
  saveDefaultSettings,
  settingsError,
  validateConfigPatch,
  type DelegationAction,
  type DelegationModel,
  type DelegationSettings,
  type DelegationSnapshot,
} from "pi-delegation/settings";
import { getModelRuntimeWithExtensions } from "./model-runtime";
import { resolveVisibleModels } from "./model-scope";
import { withDeferredProviderModels } from "./deferred-provider-models";

export interface DelegationSettingsResponse {
  defaults: DelegationSettings;
  models: DelegationModel[];
  current: DelegationSnapshot | null;
}

export function delegationDirectory(): string {
  return join(getAgentDir(), "pi-delegation");
}

export async function defaultDelegationModels(): Promise<DelegationModel[]> {
  const runtime = await getModelRuntimeWithExtensions();
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(agentDir, agentDir);
  const scope = await resolveVisibleModels(withDeferredProviderModels(runtime), settings.getEnabledModels());
  return scope.visible.map(model => ({
    id: `${model.provider}/${model.id}`,
    name: model.name || model.id,
    thinkingLevels: getSupportedThinkingLevels(model),
  }));
}

export async function readDelegationSettings(sessionId?: string): Promise<DelegationSettingsResponse> {
  const dir = delegationDirectory();
  const controller = sessionId ? getSettingsController(dir, sessionId) : undefined;
  const [models, current] = await Promise.all([
    defaultDelegationModels(),
    controller?.snapshot() ?? null,
  ]);
  return { defaults: readDefaultSettings(dir), models, current };
}

export async function writeDelegationDefaults(patch: unknown, revision: unknown): Promise<DelegationSettings> {
  if (typeof revision !== "string") throw settingsError("Missing configuration revision");
  const validated = validateConfigPatch(patch, { allowMode: false });
  if (validated.execModel) {
    const models = await defaultDelegationModels();
    if (!models.some(model => model.id === validated.execModel)) {
      throw settingsError("Execution model is not available in the global enabled model list");
    }
  }
  // Compare again after asynchronous model validation: never overwrite another window's save.
  return saveDefaultSettings(delegationDirectory(), validated, revision);
}

/** Only called inside the wrapper's tracked command lifetime, never as a detached HTTP mutation. */
export async function executeDelegationAction(sessionId: string, request: unknown): Promise<DelegationSnapshot> {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw settingsError("Invalid delegation action");
  const controller = getSettingsController(delegationDirectory(), sessionId);
  if (!controller) throw settingsError("Delegation configuration is not loaded in this session. Enable/update the plugin and reload the idle session first.", 409);
  return controller.execute(request as DelegationAction);
}
