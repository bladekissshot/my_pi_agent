"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, Prec, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi } from "@/lib/file-paths";

interface Feedback {
  detail?: string;
  conflict?: boolean;
}

export interface MarkdownEditSession {
  state: EditorState;
  saved: Text;
  etag: string;
  dirty: boolean;
  saving: boolean;
  feedback?: Feedback;
  scrollTop: number;
  scrollLeft: number;
  notify?: () => void;
}

interface Props {
  filePath: string;
  sessions: Map<string, MarkdownEditSession>;
  visible: boolean;
  wrapLines: boolean;
  isDark: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}

const bindings = new Compartment();
const wrap = new Compartment();
const appearance = new Compartment();
const themeStyles = {
  "&": { height: "100%", background: "var(--bg)", color: "var(--text)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-content, .cm-gutters": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 8px" },
  ".cm-gutters": { background: "var(--bg-panel)", color: "var(--text-muted)", borderColor: "var(--border)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--bg-hover)" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-panels": { color: "var(--text)", backgroundColor: "var(--bg-panel)" },
};
const lightTheme = EditorView.theme(themeStyles);
const darkTheme = EditorView.theme(themeStyles, { dark: true });

function newSession(content: string, etag: string): MarkdownEditSession {
  const state = EditorState.create({
    doc: content,
    extensions: [basicSetup, markdown(), appearance.of(lightTheme), bindings.of([]), wrap.of([])],
  });
  return { state, saved: state.doc, etag, dirty: false, saving: false, scrollTop: 0, scrollLeft: 0 };
}

async function readReply(response: Response) {
  return await response.json().catch(() => ({})) as { etag?: string; content?: string; error?: string };
}

export default function MarkdownEditor({ filePath, sessions, visible, wrapLines, isDark, onDirtyChange, onSaved }: Props) {
  const { t } = useI18n();
  const url = `/api/files/${encodeFilePathForApi(filePath)}?type=edit`;
  const [session, setSession] = useState(() => sessions.get(filePath));
  const [loading, setLoading] = useState(!session);
  const [loadFailure, setLoadFailure] = useState<Feedback>();
  const [status, setStatus] = useState<{ dirty: boolean; saving: boolean; feedback?: Feedback }>({ dirty: false, saving: false });
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  const label = t("files.markdownEditor");

  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const request = new AbortController();
    loadRequest.current = request;
    setLoading(true);
    setLoadFailure(undefined);
    try {
      const response = await fetch(url, { signal: request.signal, cache: "no-store" });
      const reply = await readReply(response);
      if (request.signal.aborted) return;
      if (!response.ok || typeof reply.etag !== "string" || typeof reply.content !== "string") {
        setLoadFailure({ detail: reply.error });
        return;
      }
      const next = newSession(reply.content, reply.etag);
      sessions.set(filePath, next);
      setSession(next);
    } catch {
      if (!request.signal.aborted) setLoadFailure({});
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [filePath, sessions, url]);

  useEffect(() => {
    if (!sessions.has(filePath)) void load();
    return () => loadRequest.current?.abort();
  }, [filePath, load, sessions]);

  const save = useCallback(async () => {
    if (!session || !session.dirty || session.saving || view.current?.composing) return;
    const doc = session.state.doc;
    session.saving = true;
    session.feedback = undefined;
    session.notify?.();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8", "If-Match": session.etag },
        body: doc.toString(),
      });
      const reply = await readReply(response);
      if (!response.ok || typeof reply.etag !== "string") {
        session.feedback = { conflict: response.status === 412 || response.status === 404, detail: reply.error };
        return;
      }
      session.etag = reply.etag;
      session.saved = doc;
      // The user can continue typing while the request is in flight.
      session.dirty = !session.state.doc.eq(doc);
      onSavedRef.current();
    } catch {
      session.feedback = {};
    } finally {
      session.saving = false;
      session.notify?.();
    }
  }, [session, url]);

  // Only CodeMirror sees keystrokes; React updates on dirty/clean transitions,
  // not on each character. Reconfigure per-mount bindings on the parked state.
  useEffect(() => {
    if (!session || !host.current) return;
    const notify = () => {
      setStatus({ dirty: session.dirty, saving: session.saving, feedback: session.feedback });
      onDirtyChange(session.dirty);
    };
    session.notify = notify;
    notify();
    const editor = new EditorView({
      parent: host.current,
      state: session.state.update({ effects: bindings.reconfigure([
        Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { void save(); return true; } }])),
        EditorView.domEventHandlers({ keydown(event) {
          // Escape belongs to the editor/search, not to the chat's stop shortcut.
          if (event.key === "Escape") event.stopPropagation();
          return false;
        } }),
        EditorView.updateListener.of((update) => {
          session.state = update.state;
          if (!update.docChanged) return;
          const dirty = !update.state.doc.eq(session.saved);
          if (dirty === session.dirty) return;
          session.dirty = dirty;
          notify();
        }),
      ]) }).state,
    });
    view.current = editor;
    editor.scrollDOM.scrollTop = session.scrollTop;
    editor.scrollDOM.scrollLeft = session.scrollLeft;
    return () => {
      session.scrollTop = editor.scrollDOM.scrollTop;
      session.scrollLeft = editor.scrollDOM.scrollLeft;
      session.state = editor.state.update({ effects: bindings.reconfigure([]) }).state;
      session.notify = undefined;
      view.current = null;
      editor.destroy();
    };
  }, [onDirtyChange, save, session]);

  useEffect(() => {
    view.current?.dispatch({ effects: [
      appearance.reconfigure(isDark ? darkTheme : lightTheme),
      wrap.reconfigure(wrapLines ? EditorView.lineWrapping : []),
    ] });
  }, [isDark, session, wrapLines]);

  useEffect(() => {
    const editor = view.current;
    if (!visible || loading || !editor) return;
    if (editor.contentDOM.getAttribute("aria-label") !== label) editor.contentDOM.setAttribute("aria-label", label);
    editor.requestMeasure();
    editor.focus();
  }, [label, loading, session, visible]);

  const error = loadFailure ?? status.feedback;
  return (
    <div className="markdown-editor" hidden={!visible}>
      <div className="markdown-editor-bar">
        <button type="button" className="file-viewer-mode-button" onClick={() => void save()}
          disabled={!session || !status.dirty || status.saving || loading} title={t("files.markdownSaveHint")}>
          {t("files.markdownSave")}
        </button>
        <button type="button" className="file-viewer-mode-button" disabled={status.saving || loading} onClick={() => {
          if (!session?.dirty || window.confirm(t("files.markdownDiscard"))) void load();
        }}>
          {t("files.markdownReload")}
        </button>
        <span role="status">
          {loading ? t("i18n.loading") : status.saving ? t("files.markdownSaving") : status.dirty ? t("files.markdownUnsaved") : null}
        </span>
      </div>
      {error && !loading && (
        <div className="markdown-editor-error" role="alert">
          {error.conflict ? t("files.markdownConflict") : loadFailure ? t("files.markdownLoadFailed") : t("files.markdownSaveFailed")}
          {!error.conflict && error.detail ? ` — ${error.detail}` : null}
        </div>
      )}
      <div className="markdown-editor-host" ref={host} inert={loading} />
    </div>
  );
}
