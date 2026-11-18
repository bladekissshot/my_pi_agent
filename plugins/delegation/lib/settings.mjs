import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULTS, loadConfig, saveConfig } from './core.mjs';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const keys = Object.keys(DEFAULTS);
const registryKey = Symbol.for('pi-delegation/settings/v1');

export function settingsError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Only public preferences cross the host boundary, never arbitrary file contents. */
export function publicConfig(config) {
  return Object.fromEntries(keys.map(key => [key, config[key] ?? DEFAULTS[key]]));
}

export function configRevision(config) {
  return createHash('sha256').update(JSON.stringify(publicConfig(config))).digest('hex');
}

export function assertConfigRevision(config, expected) {
  if (expected !== undefined && expected !== configRevision(config)) {
    throw settingsError('配置已在其他窗口或命令中修改，请刷新后重试。', 409);
  }
}

/** Strict writes: reject the entire patch rather than silently clamping a field. */
export function validateConfigPatch(raw, { allowMode = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw settingsError('配置必须是对象。');
  const patch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key) || (key === 'mode' && !allowMode)) throw settingsError(`不支持的配置项：${key}`);
    if (key === 'mode' && !['off', 'auto'].includes(value)) throw settingsError('模式必须为 OFF 或 AUTO。');
    if (key === 'execModel' && (typeof value !== 'string' || value.length > 512 || /[\x00-\x20]/.test(value))) throw settingsError('执行模型必须是 provider/model 格式。');
    if (key === 'execModel' && value && !/^[^/]+\/.+/.test(value)) throw settingsError('执行模型必须是 provider/model 格式。');
    if (key === 'execThinking' && !THINKING_LEVELS.includes(value)) throw settingsError('无效的执行思考级别。');
    if (key === 'panel' && typeof value !== 'boolean') throw settingsError('面板开关必须为布尔值。');
    const range = { maxConcurrent: [1, 8], taskTimeoutMs: [10000, 3600000] }[key];
    if (range && (!Number.isInteger(value) || value < range[0] || value > range[1])) {
      throw settingsError(`${key} 必须为 ${range[0]}–${range[1]} 之间的整数。`);
    }
    patch[key] = value;
  }
  return patch;
}

export function readDefaultSettings(dir) {
  // AUTO is always a session opt-in, including for legacy files containing mode:auto.
  const config = publicConfig({ ...loadConfig(dir), mode: 'off' });
  return { config, revision: configRevision(config) };
}

export function saveDefaultSettings(dir, raw, expectedRevision) {
  const patch = validateConfigPatch(raw, { allowMode: false });
  assertConfigRevision(readDefaultSettings(dir).config, expectedRevision);
  saveConfig(dir, { ...patch, mode: 'off' });
  return readDefaultSettings(dir);
}

/** Registered only by a started extension; a settings read never loads or enables one. */
export function registerSettingsController(dir, sessionId, controller) {
  const registry = globalThis[registryKey] ??= new Map();
  const key = `${path.resolve(dir)}\0${sessionId}`;
  registry.set(key, controller);
  return () => { if (registry.get(key) === controller) registry.delete(key); };
}

export function getSettingsController(dir, sessionId) {
  return globalThis[registryKey]?.get(`${path.resolve(dir)}\0${sessionId}`);
}
