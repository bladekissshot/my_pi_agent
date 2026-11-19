"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { LocalRefreshStatus, RefreshAction, RefreshJob } from "@/lib/local-refresh";
import { ConfigButton } from "./SettingsUi";

const active = (job: RefreshJob | null | undefined) => job?.state === "building" || job?.state === "checking"
  || job?.state === "waiting-for-idle" || job?.state === "restarting";
const elapsed = (job: RefreshJob) => Math.max(0, Math.floor(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000));

export function ApplicationSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<LocalRefreshStatus | null>(null);
  const [error, setError] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [check, setCheck] = useState(0);
  const [waiting, setWaiting] = useState<{ id: string; instance: string | null } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let offlineUntil = 0;
    const load = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 3000);
      try {
        const response = await fetch("/api/local-refresh", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const value = await response.json() as LocalRefreshStatus;
        if (disposed) return;
        setStatus(value); setError(false);
        offlineUntil = 0;
        if (!waiting && value.job && active(value.job)) {
          setWaiting({ id: value.job.id, instance: value.instance });
          return;
        }
        if (waiting && value.job?.id === waiting.id) {
          if ((value.job.state === "complete" || value.job.state === "rolled-back") && value.instance !== waiting.instance) {
            // Reload only after the helper verified a new instance, even when the
            // Web/SKD version number stayed the same for a local source change.
            window.location.reload();
            return;
          }
          if (!active(value.job)) { setWaiting(null); return; }
        } else if (waiting) { setWaiting(null); return; }
        if (waiting || value.blockers > 0) timer = setTimeout(load, 1000);
      } catch {
        if (!disposed) {
          if (waiting && !offlineUntil) offlineUntil = Date.now() + 150_000;
          if (waiting && Date.now() < offlineUntil) timer = setTimeout(load, 700);
          else { setError(true); setWaiting(null); }
        }
      } finally { clearTimeout(timeout); }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, [waiting, check]);

  const restart = async (action: RefreshAction) => {
    if (!status || requesting || !window.confirm(t(action === "restart" ? "application.confirm" : "application.buildConfirm"))) return;
    setRequesting(true); setError(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/api/local-refresh", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }), signal: controller.signal });
      const value = await response.json() as { job?: RefreshJob; code?: string };
      if (!response.ok || !value.job) throw new Error("Refused");
      if (mounted.current) {
        setStatus({ ...status, job: value.job });
        setWaiting({ id: value.job.id, instance: status.instance });
      }
    } catch { if (mounted.current) setError(true); }
    finally { clearTimeout(timeout); if (mounted.current) setRequesting(false); }
  };
  const busy = requesting || Boolean(waiting) || active(status?.job);
  return (
    <div className="settings-general">
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("application.title")}</h3>
        <p className="settings-general-description">{t("application.description")}</p>
        <dl>
          <dt>{t("application.current")}</dt>
          <dd>{status ? <>Pi Web {status.current.webVersion} / Pi SDK {status.current.sdkVersion} · <code>{status.current.buildId}</code></> : "…"}</dd>
          <dt>{t("application.target")}</dt>
          <dd>{status?.target ? <>Pi Web {status.target.webVersion} / Pi SDK {status.target.sdkVersion} · <code>{status.target.buildId}</code></> : "—"}</dd>
        </dl>
        {status && !status.available && <p>{t("application.unconfigured")}</p>}
        {status?.targetError && <p role="alert">{t("application.invalidBuild")}</p>}
        {Boolean(status?.blockers) && <p role="status">{t("application.blocked", { count: status!.blockers })}</p>}
        <ConfigButton variant="secondary" disabled={busy} onClick={() => setCheck(value => value + 1)}>{t("application.check")}</ConfigButton>
        <ConfigButton variant="secondary" disabled={!status?.available || !status.target || Boolean(status.blockers) || busy} onClick={() => void restart("restart")}>
          {t("application.restart")}
        </ConfigButton>
        <ConfigButton disabled={!status?.buildAvailable || busy} onClick={() => void restart("build-and-restart")}>
          {t("application.buildRestart")}
        </ConfigButton>
        {status?.available && !status.buildAvailable && <p>{t("application.buildUnconfigured")}</p>}
        {status?.job && <p role="status">
          {t(`application.${status.job.failure ?? status.job.state}`)}
          {status.job.action === "build-and-restart" ? ` · ${t("application.elapsed", { seconds: elapsed(status.job) })}` : ""}
        </p>}
        {error && <p role="alert">{t("application.error")}</p>}
      </section>
    </div>
  );
}
