// The optional one-shot desktop helper. No helper starts from a GET or timer.
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

export interface LocalRelease { webVersion: string; sdkVersion: string; buildId: string }
export type RefreshAction = "restart" | "build-and-restart";
export interface RefreshJob {
  id: string;
  action?: RefreshAction;
  state: "building" | "checking" | "waiting-for-idle" | "restarting" | "complete" | "rolled-back" | "failed";
  startedAt: number;
  workerPid: number | null;
  finishedAt?: number;
  error?: string;
  failure?: "build-failed" | "idle-timeout" | "check-failed";
  target: LocalRelease | null;
}
export interface LocalRefreshStatus {
  available: boolean;
  buildAvailable?: boolean;
  current: LocalRelease;
  instance: string | null;
  target: LocalRelease | null;
  targetError: string | null;
  job: RefreshJob | null;
  blockers: number;
}
interface RuntimeConfig { stateDir: string; helperPath: string; port: number }
interface RuntimeHelper {
  atomicJson(file: string, value: unknown): void;
  gateActive(config: RuntimeConfig): boolean;
  readConfig(file: string): RuntimeConfig;
  readJob(config: RuntimeConfig): RefreshJob | null;
  status(file: string): Pick<LocalRefreshStatus, "target" | "targetError" | "job" | "buildAvailable">;
  begin(file: string, pid: number, instance: string, action: RefreshAction): RefreshJob;
}
function runtime(): { helper: RuntimeHelper; file: string; config: RuntimeConfig } | null {
  const file = process.env.PI_WEB_LOCAL_REFRESH_CONFIG;
  if (!file) return null;
  // Only operator-owned configuration supplies executable paths; never HTTP input.
  const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as RuntimeConfig;
  if (!path.isAbsolute(parsed.helperPath)) throw new Error("Invalid local refresh helper path");
  // Next/SWC gives imported createRequire special bundler semantics. Ask Node
  // for its actual builtin instead; this operator-owned path is not a bundle dependency.
  const requireRuntime = process.getBuiltinModule("module").createRequire(file);
  const helper = requireRuntime(parsed.helperPath) as RuntimeHelper;
  return { helper, file, config: helper.readConfig(file) };
}
export function assertLocalRefreshAdmission(): void {
  const configured = runtime();
  if (configured?.helper.gateActive(configured.config)) {
    throw Object.assign(new Error("Pi Web is restarting; please wait before sending another command"), { status: 503 });
  }
}
export function localRefreshStatus(blockers: number): LocalRefreshStatus {
  const configured = runtime();
  const current = { webVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown", sdkVersion: process.env.NEXT_PUBLIC_PI_VERSION ?? "unknown",
    buildId: readBuildId() };
  return { available: Boolean(configured), current, instance: process.env.PI_WEB_RUNTIME_INSTANCE ?? null,
    ...(configured ? configured.helper.status(configured.file) : { target: null, targetError: null, job: null }), blockers };
}
function readBuildId(): string {
  try { return readFileSync(path.join(process.cwd(), ".next/BUILD_ID"), "utf8").trim(); }
  catch { return "development"; }
}
export function beginLocalRefresh(action: RefreshAction = "restart"): RefreshJob {
  const configured = runtime();
  if (!configured || !process.env.PI_WEB_RUNTIME_INSTANCE) throw Object.assign(new Error("Local refresh is not configured"), { status: 409 });
  if (action === "build-and-restart" && !configured.helper.status(configured.file).buildAvailable) {
    throw Object.assign(new Error("Local source build is not configured"), { status: 409 });
  }
  return configured.helper.begin(configured.file, process.pid, process.env.PI_WEB_RUNTIME_INSTANCE, action);
}
export function authorizeRefreshWorker(token: string | null, id: unknown, instance: unknown): RuntimeConfig {
  const configured = runtime();
  if (!configured || !token || token !== process.env.PI_WEB_LOCAL_REFRESH_TOKEN
    || instance !== process.env.PI_WEB_RUNTIME_INSTANCE || typeof id !== "string"
    || configured.helper.readJob(configured.config)?.id !== id) {
    throw Object.assign(new Error("Untrusted refresh operation"), { status: 403 });
  }
  return configured.config;
}
export function setRefreshDrain(config: RuntimeConfig, id: string): void {
  const configured = runtime()!;
  const job = configured.helper.readJob(config);
  if (!job?.workerPid) throw new Error("Refresh worker not ready");
  configured.helper.atomicJson(path.join(config.stateDir, "drain.json"), { id, workerPid: job.workerPid, expiresAt: Date.now() + 90000 });
}
export function clearRefreshDrain(config: RuntimeConfig): void {
  rmSync(path.join(config.stateDir, "drain.json"), { force: true });
}
export function isLocalRefreshRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  const host = request.headers.get("host");
  if (!host || /[\s/@\\]/.test(host) || request.headers.get("sec-fetch-site") === "cross-site") return false;
  try {
    // Next may reconstruct request.url with localhost even when the browser
    // used 127.0.0.1. Trust only literal loopback Host names and its actual origin.
    const authority = new URL(`${url.protocol}//${host}`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(authority.hostname) || authority.port !== url.port) return false;
    const origin = request.headers.get("origin");
    return !origin || origin === authority.origin;
  } catch { return false; }
}
