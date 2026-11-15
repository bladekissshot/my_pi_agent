"use client";

import { useEffect, useRef, useState } from "react";
import type { PromptBinding, PromptTemplate } from "pi-prompt-manager";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
  sessionId?: string | null;
}

export function SystemPromptPanel({ loading, prompt, translate, sessionId }: Props) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [binding, setBinding] = useState<PromptBinding | null>(null);
  const [draft, setDraft] = useState<{ id?: string; revision?: number; name: string; description: string; content: string; mode: "append" | "replace" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const selected = templates.find(item => item.id === selectedId);
  useEffect(() => {
    const controller = new AbortController();
    setBinding(null);
    void fetch(`/api/prompts${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { signal: controller.signal })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error); return value; })
      .then(value => { setTemplates(value.prompts); setActiveId(value.activeId); setSelectedId(value.activeId ?? ""); setBinding(value.binding); })
      .catch(value => { if (!controller.signal.aborted) setError(String(value.message ?? value)); });
    return () => controller.abort();
  }, [sessionId]);

  async function mutate(body: Record<string, unknown>) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/prompts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      const listing = await fetch(`/api/prompts${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`);
      const catalog = await listing.json();
      if (!listing.ok) throw new Error(catalog.error);
      setTemplates(catalog.prompts); setActiveId(catalog.activeId);
      if (sessionIdRef.current === sessionId) setBinding(catalog.binding);
      if (body.action === "create" || body.action === "update") { setSelectedId(value.id); setDraft(null); }
      if (body.action === "delete") setSelectedId(catalog.activeId ?? "");
      setNotice(translate("prompts.saved"));
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  }

  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      <div className="system-prompt-scroll">
        <div className="prompt-manager">
          <strong>{translate("prompts.title")}</strong>
          <p>{translate("prompts.sticky")}</p>
          {sessionId && <div className="prompt-binding" data-testid="prompt-binding">{binding
            ? translate("prompts.bound", { name: binding.name, version: binding.revision })
            : translate("prompts.legacy")}</div>}
          <label htmlFor="prompt-template-select">{translate("prompts.next")}</label>
          <div className="prompt-manager-row">
            <select id="prompt-template-select" value={selectedId} onChange={event => { setSelectedId(event.target.value); setDraft(null); }} disabled={busy}>
              <option value="">{translate("prompts.native")}</option>
              {templates.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.revision}{item.id === activeId ? " ●" : ""}</option>)}
            </select>
            <button disabled={busy || selectedId === (activeId ?? "")} onClick={() => void mutate({ action: "activate", id: selectedId || null })}>{translate("prompts.activate")}</button>
          </div>
          <div className="prompt-manager-row">
            <button disabled={busy} onClick={() => setDraft({ name: "", description: "", content: "", mode: "append" })}>{translate("prompts.create")}</button>
            <button disabled={busy || !selected} onClick={() => selected && setDraft({ ...selected })}>{translate("prompts.edit")}</button>
            <button disabled={busy || !selected} onClick={() => selected && window.confirm(translate("prompts.deleteConfirm", { name: selected.name })) && void mutate({ action: "delete", id: selected.id, revision: selected.revision })}>{translate("prompts.delete")}</button>
          </div>
          {draft && <form className="prompt-editor" onSubmit={event => {
            event.preventDefault();
            void mutate({ action: draft.id ? "update" : "create", id: draft.id, revision: draft.revision, prompt: { name: draft.name, description: draft.description, content: draft.content, mode: draft.mode } });
          }}>
            <label>{translate("prompts.name")}<input aria-label={translate("prompts.name")} value={draft.name} maxLength={100} required disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>{translate("prompts.description")}<input aria-label={translate("prompts.description")} value={draft.description} maxLength={1000} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
            <label>{translate("prompts.mode")}<select aria-label={translate("prompts.mode")} value={draft.mode} disabled={busy} onChange={event => setDraft({ ...draft, mode: event.target.value as "append" | "replace" })}>
              <option value="append">{translate("prompts.append")}</option><option value="replace">{translate("prompts.replace")}</option>
            </select></label>
            <label>{translate("prompts.content")}<textarea aria-label={translate("prompts.content")} rows={8} value={draft.content} disabled={busy} onChange={event => setDraft({ ...draft, content: event.target.value })} /></label>
            <div className="prompt-manager-row"><button type="submit" disabled={busy || !draft.name.trim()}>{translate("prompts.save")}</button><button type="button" disabled={busy} onClick={() => setDraft(null)}>{translate("prompts.cancel")}</button></div>
          </form>}
          {error && <div role="alert">{error}</div>}
          {notice && <div role="status">{notice}</div>}
          {!draft && <details><summary>{translate("prompts.preview")}</summary><pre className="system-prompt-text">{selected?.content || translate("prompts.native")}</pre></details>}
          {binding && <details><summary>{translate("prompts.snapshot")}</summary><pre className="system-prompt-text">{binding.prompt.forceSystemPrompt ?? [binding.prompt.customPrompt, binding.prompt.appendSystemPrompt].filter(Boolean).join("\n\n")}</pre></details>}
        </div>
        <details><summary>{translate("system.prompt")}</summary>{prompt ? (
          <div className="system-prompt-text">{prompt}</div>
        ) : (
          <div className="system-prompt-empty">
            {prompt === ""
              ? translate("system.empty")
              : loading
                ? translate("system.loading")
                : translate("system.load")}
          </div>
        )}</details>
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          height: min(600px, 75dvh);
          min-height: 220px;
          flex-direction: column;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .prompt-manager { display: grid; gap: 10px; font-size: 12px; color: var(--text); margin-bottom: 16px; }
        .prompt-manager p { margin: 0; color: var(--text-muted); line-height: 1.5; }
        .prompt-binding { background: var(--bg-selected); padding: 8px; border: 1px solid var(--border); border-radius: 5px; }
        .prompt-manager-row { display: flex; gap: 8px; flex-wrap: wrap; }
        .prompt-manager-row select { flex: 1; min-width: 140px; }
        .prompt-manager button, .prompt-manager select, .prompt-manager input, .prompt-manager textarea { color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 5px; padding: 7px 9px; font: inherit; }
        .prompt-manager button:disabled { opacity: .45; cursor: default; }
        .prompt-editor { display: grid; gap: 10px; }
        .prompt-editor label { display: grid; gap: 5px; }
        .prompt-editor textarea { resize: vertical; font-family: var(--font-mono); }
        .prompt-manager [role="alert"] { color: #d54b4b; }
        .system-prompt-scroll summary { cursor: pointer; color: var(--text-muted); font-size: 12px; }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px 16px;
        }
        .system-prompt-text {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
      `}</style>
    </section>
  );
}
