"use client";

import { useEffect, useRef, useState } from "react";
import type { DelegationAction, DelegationConfig, DelegationSnapshot } from "pi-delegation/settings";
import type { DelegationSettingsResponse } from "@/lib/delegation-settings";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigField, ConfigSwitch } from "./SettingsUi";

interface Props {
  sessionId: string | null;
  onAction: (request: DelegationAction) => Promise<DelegationSnapshot>;
  getSessionId: () => string | null;
  onManagePlugins: () => void;
  onClose: (restoreFocus: boolean) => void;
}

type Draft = Omit<DelegationConfig, "maxConcurrent" | "taskTimeoutMs"> & {
  maxConcurrent: string;
  timeoutSeconds: string;
};

function toDraft(config: DelegationConfig): Draft {
  const { taskTimeoutMs, ...rest } = config;
  return { ...rest, maxConcurrent: String(config.maxConcurrent), timeoutSeconds: String(taskTimeoutMs / 1000) };
}

export function DelegationPanel({ sessionId, onAction, getSessionId, onManagePlugins, onClose }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<DelegationSettingsResponse | null>(null);
  const [scope, setScope] = useState<"session" | "defaults">("session");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const readRequest = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  async function refresh(target: "session" | "defaults", id?: string | null) {
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/delegation${id ? `?sessionId=${encodeURIComponent(id)}` : ""}`, { signal: controller.signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      if (controller.signal.aborted || !mounted.current) return;
      const next = value as DelegationSettingsResponse;
      setData(next);
      setDraft(toDraft(target === "session" ? next.current?.config ?? next.defaults.config : next.defaults.config));
      setDirty(false);
    } catch (err) {
      if (!controller.signal.aborted && mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh("session", sessionId ?? getSessionId());
    return () => { mounted.current = false; readRequest.current?.abort(); };
    // AppShell keys the panel by the displayed chat; switching chats discards only an unsaved draft.
  }, [sessionId, getSessionId]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"]')) return;
      event.preventDefault(); event.stopPropagation();
      onClose(Boolean(panelRef.current?.contains(document.activeElement)));
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  function change(patch: Partial<Draft>) {
    setDraft(current => current && { ...current, ...patch });
    setDirty(true); setNotice(""); setError("");
  }

  function selectScope(next: "session" | "defaults") {
    if (!data || next === scope || (dirty && !window.confirm(t("delegation.discard")))) return;
    setScope(next);
    setDraft(toDraft(next === "session" ? data.current?.config ?? data.defaults.config : data.defaults.config));
    setDirty(false); setError(""); setNotice("");
  }

  async function act(request: DelegationAction) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const current = await onAction(request);
      if (!mounted.current) return;
      setData(previous => previous && { ...previous, current });
      if (request.action === "apply") { setDraft(toDraft(current.config)); setDirty(false); }
      setNotice(t(request.action === "apply" ? "delegation.applied" : request.action === "repo" ? "delegation.repoReady" : "delegation.stopped"));
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function save() {
    if (!draft || !data || pending.current) return;
    const patch: DelegationConfig = {
      mode: draft.mode, execModel: draft.execModel, execThinking: draft.execThinking, panel: draft.panel,
      maxConcurrent: Number(draft.maxConcurrent), taskTimeoutMs: Math.round(Number(draft.timeoutSeconds) * 1000),
    };
    if (scope === "session") {
      await act({ action: "apply", patch, revision: data.current?.revision ?? data.defaults.revision });
      return;
    }
    pending.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const preferences: Partial<DelegationConfig> = { ...patch };
      delete preferences.mode;
      const response = await fetch("/api/delegation", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: preferences, revision: data.defaults.revision }),
      });
      const defaults = await response.json();
      if (!response.ok) throw new Error(defaults.error || `HTTP ${response.status}`);
      if (!mounted.current) return;
      setData(previous => previous && { ...previous, defaults });
      setDraft(toDraft(defaults.config)); setDirty(false); setNotice(t("delegation.defaultsSaved"));
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const models = scope === "session" && data?.current ? data.current.models : data?.models ?? [];
  const selectedModel = models.find(model => model.id === draft?.execModel);
  const levels = selectedModel?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const thinkingOptions = draft && !levels.includes(draft.execThinking) ? [draft.execThinking, ...levels] : levels;
  const unavailable = Boolean(sessionId && !data?.current);

  return (
    <section ref={panelRef} className="delegation-panel" aria-label={t("delegation.title")}>
      <header className="delegation-header">
        <strong>Delegation</strong>
        <span>{t(data?.current ? "delegation.loaded" : "delegation.preferences")}</span>
        <ConfigButton size="small" disabled={busy} onClick={() => {
          if (!dirty || window.confirm(t("delegation.discard"))) void refresh(scope, sessionId ?? data?.current?.sessionId);
        }}>{t("delegation.refresh")}</ConfigButton>
        <ConfigButton size="small" onClick={onManagePlugins}>{t("delegation.manage")}</ConfigButton>
      </header>
      <div className="delegation-scope" role="group" aria-label={t("delegation.scope")}>
        <ConfigButton size="small" variant={scope === "session" ? "primary" : "secondary"} aria-pressed={scope === "session"} disabled={busy} onClick={() => selectScope("session")}>{t("delegation.session")}</ConfigButton>
        <ConfigButton size="small" variant={scope === "defaults" ? "primary" : "secondary"} aria-pressed={scope === "defaults"} disabled={busy} onClick={() => selectScope("defaults")}>{t("delegation.defaults")}</ConfigButton>
      </div>
      {!data && !error && <p role="status">{t("delegation.loading")}</p>}
      {data && draft && <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <p id="delegation-scope-note">{t(scope === "defaults" ? "delegation.defaultsHint" : "delegation.sessionHint")}</p>
        {scope === "session" && !data.current && <p>{t(sessionId ? "delegation.unavailable" : "delegation.newSession")}</p>}
        <fieldset disabled={busy}>
          <div className="delegation-grid">
            {scope === "session" && <ConfigField label={t("delegation.mode")}>
              <select aria-label={t("delegation.mode")} value={draft.mode} onChange={event => change({ mode: event.target.value as DelegationConfig["mode"] })}>
                <option value="off">OFF</option><option value="auto">AUTO</option>
              </select>
            </ConfigField>}
            <ConfigField label={t("delegation.model")}>
              <select aria-label={t("delegation.model")} value={draft.execModel} onChange={event => {
                const model = models.find(item => item.id === event.target.value);
                const level = model?.thinkingLevels.includes(draft.execThinking) ? draft.execThinking : model?.thinkingLevels[0] ?? "off";
                change({ execModel: event.target.value, execThinking: level as DelegationConfig["execThinking"] });
              }}>
                <option value="">{t("delegation.noModel")}</option>
                {draft.execModel && !selectedModel && <option value={draft.execModel} disabled>{t("delegation.missingModel", { model: draft.execModel })}</option>}
                {models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
              </select>
            </ConfigField>
            <ConfigField label={t("delegation.concurrent")}>
              <input aria-label={t("delegation.concurrent")} type="number" min={1} max={8} step={1} required value={draft.maxConcurrent} onChange={event => change({ maxConcurrent: event.target.value })} />
            </ConfigField>
            <ConfigField label={t("delegation.panel")}>
              <ConfigSwitch label={t("delegation.panel")} checked={draft.panel} onChange={panel => change({ panel })} />
            </ConfigField>
          </div>
          <details className="delegation-advanced">
            <summary>{t("delegation.advanced")}</summary>
            <div className="delegation-grid">
              <ConfigField label={t("delegation.thinking")}>
                <select aria-label={t("delegation.thinking")} value={draft.execThinking} onChange={event => change({ execThinking: event.target.value as DelegationConfig["execThinking"] })}>
                  {thinkingOptions.map(level => <option key={level} value={level}>{level}</option>)}
                </select>
              </ConfigField>
              <ConfigField label={t("delegation.timeout")}>
                <input aria-label={t("delegation.timeout")} type="number" min={10} max={3600} step={0.001} required value={draft.timeoutSeconds} onChange={event => change({ timeoutSeconds: event.target.value })} />
              </ConfigField>
            </div>
            {selectedModel && !levels.includes(draft.execThinking) && <p>{t("delegation.thinkingHint")}</p>}
          </details>
          <div className="delegation-actions">
            <ConfigButton type="submit" variant="primary" disabled={scope === "session" && unavailable}>{t(scope === "session" ? "delegation.apply" : "delegation.saveDefaults")}</ConfigButton>
            {dirty && <span>{t("delegation.unsaved")}</span>}
          </div>
        </fieldset>
      </form>}
      {scope === "session" && data && <div className="delegation-runtime">
        <div className="delegation-actions">
          <span>{t("delegation.repository")} · {t(data.current?.repositoryReady ? "delegation.repoReady" : data.current ? "delegation.repoMissing" : "delegation.notChecked")}</span>
          <ConfigButton size="small" disabled={busy || unavailable} onClick={() => void act({ action: "repo" })}>{t("delegation.prepareRepo")}</ConfigButton>
        </div>
        <p>{t("delegation.offHint")}</p>
        {data.current?.tasks.map(task => <div className="delegation-task" key={task.id}>
          <span>{task.title} <small>{t(`delegation.task.${task.status}`)}</small></span>
          <ConfigButton size="small" variant="danger" disabled={busy} onClick={() => {
            if (window.confirm(t("delegation.stopConfirm", { title: task.title }))) void act({ action: "stop", taskId: task.id });
          }}>{t("delegation.stop")}</ConfigButton>
        </div>)}
      </div>}
      {busy && data && <p role="status">{t("delegation.working")}</p>}
      {error && <p role="alert" className="delegation-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <style>{`
        .delegation-panel { background: var(--bg-panel); color: var(--text); border-bottom: 1px solid var(--border); padding: 14px 16px; font-size: 12px; max-height: 75dvh; overflow-y: auto; }
        .delegation-panel p { color: var(--text-muted); line-height: 1.5; margin: 10px 0; overflow-wrap: anywhere; }
        .delegation-header, .delegation-scope, .delegation-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .delegation-header > span { color: var(--text-dim); margin-right: auto; }
        .delegation-scope { margin-top: 14px; }
        .delegation-panel fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
        .delegation-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 12px 18px; max-width: 1000px; }
        .delegation-grid > * { min-width: 0; }
        .delegation-panel input, .delegation-panel select { display: block; width: 100%; min-width: 0; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 7px 9px; font: inherit; }
        .delegation-panel button:disabled { opacity: .45; }
        .delegation-advanced { margin: 16px 0; }
        .delegation-advanced summary { cursor: pointer; color: var(--text-muted); margin-bottom: 12px; }
        .delegation-actions > span, .delegation-task small { color: var(--text-dim); }
        .delegation-runtime { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 12px; }
        .delegation-task { display: flex; align-items: center; gap: 10px; padding-top: 8px; }
        .delegation-task > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
        .delegation-panel .delegation-error { color: var(--ansi-red); }
      `}</style>
    </section>
  );
}
