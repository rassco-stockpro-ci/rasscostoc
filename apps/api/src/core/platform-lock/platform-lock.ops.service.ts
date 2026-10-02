/**
 * Owner Portal — Operations Center snapshot + history sampler.
 * Lightweight host/process metrics (no external APM dependency).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { X509Certificate } from "crypto";
import { pool } from "@core/config/db";
import { readinessManager } from "@core/telemetry/readiness";
import { metrics } from "@core/telemetry/metrics";
import { outboxRepository } from "@core/outbox/outbox.repository";
import { platformLockService } from "./platform-lock.service";

const execFileAsync = promisify(execFile);

export type OpsStatus = "ok" | "warn" | "danger" | "unknown";

export type OpsSample = {
  t: number;
  cpu: number;
  ram: number;
  disk: number;
  rps: number;
  errors: number;
  dbConnections: number;
  queue: number;
  latency: number;
  dbLatency: number;
  networkIn: number;
  networkOut: number;
};

type ComponentCard = {
  key: string;
  label: string;
  status: OpsStatus;
  detail: string;
};

type AlertItem = {
  level: OpsStatus;
  code: string;
  message: string;
};

const HISTORY_MAX = 10_080; // ~7 days @ 1/min
const SAMPLE_MS = 60_000;

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function pct(used: number, total: number): number {
  if (!total || total <= 0) return 0;
  return clamp(Math.round((used / total) * 1000) / 10);
}

async function runCmd(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout || "");
  } catch {
    return "";
  }
}

function historyFilePath(): string {
  return (
    process.env.PLATFORM_OPS_HISTORY_FILE?.trim() ||
    path.join(process.cwd(), "data", "platform-ops-history.json")
  );
}

class PlatformOpsService {
  private history: OpsSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastNet: { rx: number; tx: number; at: number } | null = null;
  private lastHttpTotal = 0;
  private lastHttpAt = Date.now();
  private started = false;
  private liveBuffer: Array<{ t: number; message: string }> = [];

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadHistory();
    void this.sampleOnce();
    this.timer = setInterval(() => void this.sampleOnce(), SAMPLE_MS);
    this.timer.unref?.();
  }

  pushLive(message: string): void {
    this.liveBuffer.unshift({ t: Date.now(), message });
    if (this.liveBuffer.length > 80) this.liveBuffer.length = 80;
  }

  private loadHistory(): void {
    try {
      const raw = fs.readFileSync(historyFilePath(), "utf8");
      const parsed = JSON.parse(raw) as OpsSample[];
      if (Array.isArray(parsed)) {
        this.history = parsed
          .filter((s) => s && typeof s.t === "number")
          .slice(-HISTORY_MAX);
      }
    } catch {
      // first run
    }
  }

  private persistHistory(): void {
    try {
      const file = historyFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.history.slice(-HISTORY_MAX)));
    } catch {
      // non-fatal
    }
  }

  private async cpuPercent(): Promise<number> {
    const cpus1 = os.cpus();
    const idle1 = cpus1.reduce((a, c) => a + c.times.idle, 0);
    const total1 = cpus1.reduce(
      (a, c) => a + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle,
      0,
    );
    await new Promise((r) => setTimeout(r, 120));
    const cpus2 = os.cpus();
    const idle2 = cpus2.reduce((a, c) => a + c.times.idle, 0);
    const total2 = cpus2.reduce(
      (a, c) => a + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle,
      0,
    );
    const idle = idle2 - idle1;
    const total = total2 - total1;
    if (total <= 0) return 0;
    return clamp(Math.round((1 - idle / total) * 1000) / 10);
  }

  private ramPercent(): number {
    const total = os.totalmem();
    const free = os.freemem();
    return pct(total - free, total);
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    const digits = i === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2;
    return `${n.toFixed(digits)} ${units[i]}`;
  }

  private async diskPercent(): Promise<{
    percent: number;
    detail: string;
    usedBytes: number;
    totalBytes: number;
    freeBytes: number;
    usedLabel: string;
    totalLabel: string;
    freeLabel: string;
    mount: string;
  }> {
    const empty = {
      percent: 0,
      detail: "n/a",
      usedBytes: 0,
      totalBytes: 0,
      freeBytes: 0,
      usedLabel: "0 B",
      totalLabel: "0 B",
      freeLabel: "0 B",
      mount: "/",
    };
    if (process.platform === "win32") {
      return { ...empty, detail: "n/a on windows host probe" };
    }
    const out = await runCmd("df", ["-P", "-k", process.cwd()]);
    const lines = out.trim().split("\n");
    const data = lines[1]?.split(/\s+/) || [];
    const usedKb = Number(data[2] || 0);
    const availKb = Number(data[3] || 0);
    const usedBytes = usedKb * 1024;
    const freeBytes = availKb * 1024;
    const totalBytes = usedBytes + freeBytes;
    const percent = pct(usedBytes, totalBytes);
    const mount = data[5] || "/";
    const usedLabel = this.formatBytes(usedBytes);
    const totalLabel = this.formatBytes(totalBytes);
    const freeLabel = this.formatBytes(freeBytes);
    return {
      percent,
      detail: `${usedLabel} / ${totalLabel} (${percent}%) · free ${freeLabel} · ${mount}`,
      usedBytes,
      totalBytes,
      freeBytes,
      usedLabel,
      totalLabel,
      freeLabel,
      mount,
    };
  }

  private async networkRates(): Promise<{ inMbps: number; outMbps: number }> {
    if (process.platform === "win32" || !fs.existsSync("/proc/net/dev")) {
      return { inMbps: 0, outMbps: 0 };
    }
    try {
      const raw = fs.readFileSync("/proc/net/dev", "utf8");
      let rx = 0;
      let tx = 0;
      for (const line of raw.split("\n").slice(2)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const iface = parts[0]?.replace(":", "");
        if (!iface || iface === "lo") continue;
        rx += Number(parts[1] || 0);
        tx += Number(parts[9] || 0);
      }
      const now = Date.now();
      if (!this.lastNet) {
        this.lastNet = { rx, tx, at: now };
        return { inMbps: 0, outMbps: 0 };
      }
      const dt = Math.max(0.001, (now - this.lastNet.at) / 1000);
      const inMbps = Math.round(((rx - this.lastNet.rx) * 8) / dt / 1_000_000 * 100) / 100;
      const outMbps = Math.round(((tx - this.lastNet.tx) * 8) / dt / 1_000_000 * 100) / 100;
      this.lastNet = { rx, tx, at: now };
      return { inMbps: Math.max(0, inMbps), outMbps: Math.max(0, outMbps) };
    } catch {
      return { inMbps: 0, outMbps: 0 };
    }
  }

  private async pm2Status(): Promise<{ status: OpsStatus; detail: string; online: number; total: number }> {
    const out = await runCmd("pm2", ["jlist"]);
    if (!out.trim()) {
      return { status: "unknown", detail: "pm2 unavailable", online: 0, total: 0 };
    }
    try {
      const list = JSON.parse(out) as Array<{ name?: string; pm2_env?: { status?: string } }>;
      const total = list.length;
      const online = list.filter((p) => p.pm2_env?.status === "online").length;
      const target = list.find((p) => p.name === "nulip-inventory") || list[0];
      const st = target?.pm2_env?.status || "unknown";
      const status: OpsStatus = st === "online" ? "ok" : st === "stopped" ? "danger" : "warn";
      return {
        status,
        detail: target ? `${target.name}: ${st}` : `online ${online}/${total}`,
        online,
        total,
      };
    } catch {
      return { status: "unknown", detail: "pm2 parse error", online: 0, total: 0 };
    }
  }

  private async sslInfo(): Promise<{ status: OpsStatus; detail: string; daysLeft: number | null }> {
    const candidates = [
      "/etc/letsencrypt/live/nuzum.fun/fullchain.pem",
      "/etc/letsencrypt/live/owner.nuzum.fun/fullchain.pem",
      "/etc/nginx/ssl-certificates/nuzum.fun.crt",
    ];
    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const pem = fs.readFileSync(file, "utf8");
        const cert = new X509Certificate(pem);
        const expires = Date.parse(cert.validTo);
        if (!Number.isFinite(expires)) continue;
        const daysLeft = Math.floor((expires - Date.now()) / 86_400_000);
        const status: OpsStatus = daysLeft < 7 ? "danger" : daysLeft < 21 ? "warn" : "ok";
        return {
          status,
          detail: `${path.basename(path.dirname(file))} · ${daysLeft}d left`,
          daysLeft,
        };
      } catch {
        // try next
      }
    }
    return { status: "unknown", detail: "certificate not found", daysLeft: null };
  }

  private async internetOk(): Promise<{ status: OpsStatus; detail: string }> {
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch("https://1.1.1.1", { method: "HEAD", signal: ctrl.signal });
      clearTimeout(t);
      const ms = Date.now() - started;
      return {
        status: res.ok || res.status === 301 || res.status === 302 || res.status === 405 ? "ok" : "warn",
        detail: `${ms}ms`,
      };
    } catch {
      return { status: "danger", detail: "unreachable" };
    }
  }

  private async dbProbe(): Promise<{
    status: OpsStatus;
    detail: string;
    connections: number;
    latencyMs: number;
  }> {
    const started = Date.now();
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        let connections = 0;
        try {
          const r = await client.query(
            `SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database()`,
          );
          connections = Number(r.rows[0]?.c || 0);
        } catch {
          connections = pool.totalCount ?? 0;
        }
        const latencyMs = Date.now() - started;
        const status: OpsStatus = latencyMs > 800 ? "danger" : latencyMs > 250 ? "warn" : "ok";
        return { status, detail: `${latencyMs}ms · ${connections} conn`, connections, latencyMs };
      } finally {
        client.release();
      }
    } catch (e) {
      return {
        status: "danger",
        detail: e instanceof Error ? e.message.slice(0, 80) : "db down",
        connections: 0,
        latencyMs: Date.now() - started,
      };
    }
  }

  private async jobCounts(): Promise<{
    running: number;
    failed: number;
    pending: number;
    sessions: number;
    activeUsers: number;
    opsToday: number;
    errors24h: number;
    dbSizeBytes: number;
    dbSizeLabel: string;
  }> {
    const client = await pool.connect();
    try {
      const jobs = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'RUNNING')::int AS running,
          COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE status IN ('PENDING','RUNNING'))::int AS pending
        FROM core_jobs
        WHERE expires_at > NOW()
      `).catch(() => ({ rows: [{ running: 0, failed: 0, pending: 0 }] }));

      const sessions = await client.query(`
        SELECT COUNT(*)::int AS c FROM bearer_sessions WHERE expiry > NOW()
      `).catch(() => ({ rows: [{ c: 0 }] }));

      const users = await client.query(`
        SELECT COUNT(*)::int AS c FROM users WHERE is_active = true
      `).catch(() => ({ rows: [{ c: 0 }] }));

      const opsToday = await client.query(`
        SELECT COUNT(*)::int AS c FROM system_logs
        WHERE created_at >= date_trunc('day', NOW())
      `).catch(() => ({ rows: [{ c: 0 }] }));

      const errors24h = await client.query(`
        SELECT COUNT(*)::int AS c FROM system_logs
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND (success = false OR severity IN ('error','critical','danger'))
      `).catch(() => ({ rows: [{ c: 0 }] }));

      const dbSize = await client.query(`
        SELECT pg_database_size(current_database())::bigint AS bytes
      `).catch(() => ({ rows: [{ bytes: 0 }] }));

      const dbSizeBytes = Number(dbSize.rows[0]?.bytes || 0);
      return {
        running: Number(jobs.rows[0]?.running || 0),
        failed: Number(jobs.rows[0]?.failed || 0),
        pending: Number(jobs.rows[0]?.pending || 0),
        sessions: Number(sessions.rows[0]?.c || 0),
        activeUsers: Number(users.rows[0]?.c || 0),
        opsToday: Number(opsToday.rows[0]?.c || 0),
        errors24h: Number(errors24h.rows[0]?.c || 0),
        dbSizeBytes,
        dbSizeLabel: this.formatBytes(dbSizeBytes),
      };
    } finally {
      client.release();
    }
  }

  private async recentLive(limit = 40): Promise<Array<{ t: string; message: string; level: string }>> {
    const client = await pool.connect();
    try {
      const r = await client.query(
        `
        SELECT description, action, severity, success, created_at
        FROM system_logs
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit],
      );
      const fromDb = r.rows.map((row) => ({
        t: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        message: String(row.description || row.action || "event"),
        level: row.success === false ? "danger" : String(row.severity || "info"),
      }));
      const fromMem = this.liveBuffer.map((x) => ({
        t: new Date(x.t).toISOString(),
        message: x.message,
        level: "info",
      }));
      return [...fromMem, ...fromDb]
        .sort((a, b) => Date.parse(b.t) - Date.parse(a.t))
        .slice(0, limit);
    } catch {
      return this.liveBuffer.slice(0, limit).map((x) => ({
        t: new Date(x.t).toISOString(),
        message: x.message,
        level: "info",
      }));
    } finally {
      client.release();
    }
  }

  private httpRates(): { rps: number; errorRate: number; latencyMs: number; requests: number; errors: number } {
    const all = metrics.getAllMetrics();
    const latency = metrics.getHistogram("api_latency_ms");
    const requests =
      Number(all.counters.http_requests_total || 0) ||
      Number(latency.count || 0);
    const errors = Number(all.counters.http_errors_total || 0);
    const now = Date.now();
    const dt = Math.max(1, (now - this.lastHttpAt) / 1000);
    const rps = Math.max(0, Math.round(((requests - this.lastHttpTotal) / dt) * 100) / 100);
    this.lastHttpTotal = requests;
    this.lastHttpAt = now;
    const errorRate = requests > 0 ? Math.round((errors / requests) * 1000) / 10 : 0;
    return { rps, errorRate, latencyMs: latency.avg || 0, requests, errors };
  }

  private scoreHealth(input: {
    platformActive: boolean;
    apiOk: boolean;
    dbStatus: OpsStatus;
    workersOk: boolean;
    cpu: number;
    ram: number;
    disk: number;
    errorRate: number;
    latencyMs: number;
    sslStatus: OpsStatus;
  }): {
    score: number;
    label: string;
    factors: Array<{ key: string; label: string; status: OpsStatus; ok: boolean; message: string; impact: number }>;
  } {
    const factors: Array<{ key: string; label: string; status: OpsStatus; ok: boolean; message: string; impact: number }> = [];
    let score = 100;

    const hit = (key: string, label: string, impact: number, status: OpsStatus, message: string, ok: boolean) => {
      if (impact > 0) score -= impact;
      factors.push({ key, label, status, ok, message, impact });
    };

    if (!input.platformActive) hit("platform", "Platform", 35, "danger", "Platform not ACTIVE", false);
    else hit("platform", "Platform", 0, "ok", "ACTIVE", true);

    if (!input.apiOk) hit("api", "API", 25, "danger", "API not ready", false);
    else hit("api", "API", 0, "ok", "Healthy", true);

    if (input.dbStatus === "danger") hit("database", "Database", 25, "danger", "Database unreachable", false);
    else if (input.dbStatus === "warn") hit("database", "Database", 10, "warn", "Database slow", false);
    else hit("database", "Database", 0, "ok", "Healthy", true);

    if (!input.workersOk) hit("workers", "Workers", 10, "danger", "Workers stopped", false);
    else hit("workers", "Workers", 0, "ok", "Running", true);

    if (input.sslStatus === "danger") hit("ssl", "SSL", 10, "danger", "SSL expiring soon", false);
    else if (input.sslStatus === "warn") hit("ssl", "SSL", 4, "warn", "SSL renew soon", false);
    else hit("ssl", "SSL", 0, "ok", "Valid", true);

    if (input.cpu > 90) hit("cpu", "CPU", 12, "danger", `CPU critical (${input.cpu}%)`, false);
    else if (input.cpu > 75) hit("cpu", "CPU", 6, "warn", `CPU slightly high (${input.cpu}%)`, false);
    else hit("cpu", "CPU", 0, "ok", `CPU normal (${input.cpu}%)`, true);

    if (input.ram > 90) hit("ram", "RAM", 12, "danger", `RAM critical (${input.ram}%)`, false);
    else if (input.ram > 85) hit("ram", "RAM", 6, "warn", `RAM elevated (${input.ram}%)`, false);
    else hit("ram", "RAM", 0, "ok", `RAM normal (${input.ram}%)`, true);

    if (input.disk > 90) hit("storage", "Storage", 15, "danger", `Disk critical (${input.disk}%)`, false);
    else if (input.disk > 80) hit("storage", "Storage", 7, "warn", `Disk high (${input.disk}%)`, false);
    else hit("storage", "Storage", 0, "ok", `Disk normal (${input.disk}%)`, true);

    if (input.errorRate > 5) hit("errors", "Errors", 15, "danger", `Error rate ${input.errorRate}%`, false);
    else if (input.errorRate > 1) hit("errors", "Errors", 6, "warn", `Error rate ${input.errorRate}%`, false);
    else hit("errors", "Errors", 0, "ok", "Error rate normal", true);

    if (input.latencyMs > 800) hit("latency", "Latency", 10, "danger", `Latency ${input.latencyMs}ms`, false);
    else if (input.latencyMs > 300) hit("latency", "Latency", 4, "warn", `Latency ${input.latencyMs}ms`, false);
    else hit("latency", "Latency", 0, "ok", `Latency ${input.latencyMs}ms`, true);

    score = clamp(score);
    const label = score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 50 ? "Degraded" : "Critical";
    return { score, label, factors };
  }

  private async dbExtras(): Promise<{
    locks: number;
    activeQueries: number;
    slowQueries: number;
    idleInTransaction: number;
  }> {
    const client = await pool.connect();
    try {
      const locks = await client.query(`SELECT count(*)::int AS c FROM pg_locks WHERE NOT granted`).catch(() => ({ rows: [{ c: 0 }] }));
      const active = await client.query(`SELECT count(*)::int AS c FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid()`).catch(() => ({ rows: [{ c: 0 }] }));
      const slow = await client.query(`
        SELECT count(*)::int AS c FROM pg_stat_activity
        WHERE state = 'active' AND now() - query_start > interval '2 seconds' AND pid <> pg_backend_pid()
      `).catch(() => ({ rows: [{ c: 0 }] }));
      const idle = await client.query(`
        SELECT count(*)::int AS c FROM pg_stat_activity WHERE state = 'idle in transaction'
      `).catch(() => ({ rows: [{ c: 0 }] }));
      return {
        locks: Number(locks.rows[0]?.c || 0),
        activeQueries: Number(active.rows[0]?.c || 0),
        slowQueries: Number(slow.rows[0]?.c || 0),
        idleInTransaction: Number(idle.rows[0]?.c || 0),
      };
    } finally {
      client.release();
    }
  }

  private async lastBackup(): Promise<{ at: string | null; ageMin: number | null; name: string | null; sizeBytes: number }> {
    const client = await pool.connect();
    try {
      const r = await client.query(`
        SELECT details, created_at, entity_name
        FROM system_logs
        WHERE entity_type = 'backup' AND action = 'export' AND success = true
        ORDER BY created_at DESC
        LIMIT 1
      `);
      if (!r.rows[0]) return { at: null, ageMin: null, name: null, sizeBytes: 0 };
      const created = r.rows[0].created_at ? new Date(r.rows[0].created_at) : null;
      let sizeBytes = 0;
      let name = r.rows[0].entity_name || null;
      try {
        const d = typeof r.rows[0].details === "string" ? JSON.parse(r.rows[0].details) : {};
        sizeBytes = Number(d.backupSizeBytes || 0);
        if (d.filename) name = String(d.filename);
      } catch {
        // ignore
      }
      const ageMin = created ? Math.max(0, Math.round((Date.now() - created.getTime()) / 60000)) : null;
      return { at: created ? created.toISOString() : null, ageMin, name, sizeBytes };
    } catch {
      return { at: null, ageMin: null, name: null, sizeBytes: 0 };
    } finally {
      client.release();
    }
  }

  private redisStatus(): { status: OpsStatus; detail: string; configured: boolean } {
    const url = process.env.REDIS_URL?.trim() || process.env.REDIS_HOST?.trim();
    if (!url) return { status: "unknown", detail: "not configured", configured: false };
    return { status: "ok", detail: "configured", configured: true };
  }

  private topEndpoints(): Array<{ name: string; avgMs: number; count: number }> {
    const all = metrics.getAllMetrics();
    const hist = all.histograms || {};
    return Object.entries(hist)
      .filter(([k]) => k.startsWith("api_") || k.startsWith("API") || k.includes("latency") || k.includes("courier"))
      .map(([name, v]) => ({
        name,
        avgMs: Number((v as { avg?: number }).avg || 0),
        count: Number((v as { count?: number }).count || 0),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }

  private buildAlerts(ctx: {
    disk: number;
    ram: number;
    apiOk: boolean;
    dbStatus: OpsStatus;
    dbLatency: number;
    workersOk: boolean;
    sslDays: number | null;
    sslStatus: OpsStatus;
    platformMode: string;
  }): AlertItem[] {
    const alerts: AlertItem[] = [];
    if (ctx.disk > 90) alerts.push({ level: "danger", code: "DISK_HIGH", message: `Disk > 90% (${ctx.disk}%)` });
    else if (ctx.disk > 80) alerts.push({ level: "warn", code: "DISK_WARN", message: `Disk high (${ctx.disk}%)` });
    if (ctx.ram > 85) alerts.push({ level: "danger", code: "RAM_HIGH", message: `RAM > 85% (${ctx.ram}%)` });
    else if (ctx.ram > 75) alerts.push({ level: "warn", code: "RAM_WARN", message: `RAM elevated (${ctx.ram}%)` });
    if (!ctx.apiOk) alerts.push({ level: "danger", code: "API_DOWN", message: "API not ready" });
    if (ctx.dbStatus === "danger") alerts.push({ level: "danger", code: "DB_DOWN", message: "Database unreachable" });
    else if (ctx.dbLatency > 250) alerts.push({ level: "warn", code: "DB_SLOW", message: `Database slow (${ctx.dbLatency}ms)` });
    if (!ctx.workersOk) alerts.push({ level: "danger", code: "WORKER_CRASH", message: "Workers stopped" });
    if (ctx.sslStatus === "danger") {
      alerts.push({ level: "danger", code: "SSL_EXPIRING", message: `SSL expiring (${ctx.sslDays ?? "?"}d)` });
    } else if (ctx.sslStatus === "warn") {
      alerts.push({ level: "warn", code: "SSL_WARN", message: `SSL renew soon (${ctx.sslDays ?? "?"}d)` });
    }
    if (ctx.platformMode === "MAINTENANCE") {
      alerts.push({ level: "warn", code: "MAINTENANCE", message: "Platform in maintenance mode" });
    }
    if (ctx.platformMode === "SUBSCRIPTION_SUSPENDED" || ctx.platformMode === "SECURITY_LOCKDOWN") {
      alerts.push({ level: "danger", code: "SUSPENDED", message: `Platform ${ctx.platformMode}` });
    }
    if (!alerts.length) alerts.push({ level: "ok", code: "HEALTHY", message: "All systems normal" });
    return alerts;
  }

  async sampleOnce(): Promise<void> {
    try {
      const [cpu, disk, queueStats, db, net] = await Promise.all([
        this.cpuPercent(),
        this.diskPercent(),
        outboxRepository.getStats().catch(() => ({ pending: 0, dead: 0 })),
        this.dbProbe(),
        this.networkRates(),
      ]);
      const http = this.httpRates();
      const sample: OpsSample = {
        t: Date.now(),
        cpu,
        ram: this.ramPercent(),
        disk: disk.percent,
        rps: http.rps,
        errors: http.errors,
        dbConnections: db.connections,
        queue: queueStats.pending,
        latency: http.latencyMs || db.latencyMs,
        dbLatency: db.latencyMs,
        networkIn: net.inMbps,
        networkOut: net.outMbps,
      };
      this.history.push(sample);
      if (this.history.length > HISTORY_MAX) {
        this.history = this.history.slice(-HISTORY_MAX);
      }
      if (this.history.length % 5 === 0) this.persistHistory();
    } catch {
      // ignore sample failures
    }
  }

  getHistory(range: "1h" | "24h" | "7d"): OpsSample[] {
    const ms = range === "1h" ? 3_600_000 : range === "24h" ? 86_400_000 : 7 * 86_400_000;
    const from = Date.now() - ms;
    const rows = this.history.filter((s) => s.t >= from);
    if (rows.length <= 180) return rows;
    // downsample for chart payload
    const step = Math.ceil(rows.length / 180);
    return rows.filter((_, i) => i % step === 0);
  }

  async getSnapshot(): Promise<Record<string, unknown>> {
    this.start();
    const state = await platformLockService.refresh();
    const ready = readinessManager.getDetails();
    const apiOk = readinessManager.isReady() || ready.database;

    const [cpu, disk, net, pm2, ssl, internet, db, jobs, queueStats, live, dbExtra, backup] = await Promise.all([
      this.cpuPercent(),
      this.diskPercent(),
      this.networkRates(),
      this.pm2Status(),
      this.sslInfo(),
      this.internetOk(),
      this.dbProbe(),
      this.jobCounts(),
      outboxRepository.getStats().catch(() => ({ pending: 0, dead: 0 })),
      this.recentLive(80),
      this.dbExtras(),
      this.lastBackup(),
    ]);
    const redis = this.redisStatus();
    const topEndpoints = this.topEndpoints();

    const ram = this.ramPercent();
    const http = this.httpRates();
    const workersRunning =
      Boolean(ready.outboxWorker) && (state.mode === "ACTIVE" || !state.stopWorkers);

    const overview: ComponentCard[] = [
      {
        key: "platform",
        label: "Platform Status",
        status: state.mode === "ACTIVE" ? "ok" : state.mode === "MAINTENANCE" ? "warn" : "danger",
        detail: state.mode,
      },
      {
        key: "api",
        label: "API",
        status: apiOk ? "ok" : "danger",
        detail: apiOk ? "UP" : "DOWN",
      },
      {
        key: "database",
        label: "Database",
        status: db.status,
        detail: db.detail,
      },
      {
        key: "workers",
        label: "Workers",
        status: workersRunning ? "ok" : "danger",
        detail: workersRunning ? "running" : "stopped",
      },
      {
        key: "queue",
        label: "Queue",
        status: queueStats.dead > 0 ? "warn" : queueStats.pending > 200 ? "warn" : "ok",
        detail: `${queueStats.pending} pending · ${queueStats.dead} dead`,
      },
      {
        key: "storage",
        label: "Storage",
        status: disk.percent > 90 ? "danger" : disk.percent > 80 ? "warn" : "ok",
        detail: `${disk.usedLabel} used / ${disk.totalLabel} · free ${disk.freeLabel}`,
      },
      {
        key: "ssl",
        label: "SSL",
        status: ssl.status,
        detail: ssl.detail,
      },
      {
        key: "internet",
        label: "Internet Connectivity",
        status: internet.status,
        detail: internet.detail,
      },
    ];

    const health = this.scoreHealth({
      platformActive: state.mode === "ACTIVE",
      apiOk,
      dbStatus: db.status,
      workersOk: workersRunning,
      cpu,
      ram,
      disk: disk.percent,
      errorRate: http.errorRate,
      latencyMs: http.latencyMs,
      sslStatus: ssl.status,
    });

    const alerts = this.buildAlerts({
      disk: disk.percent,
      ram,
      apiOk,
      dbStatus: db.status,
      dbLatency: db.latencyMs,
      workersOk: workersRunning,
      sslDays: ssl.daysLeft,
      sslStatus: ssl.status,
      platformMode: state.mode,
    });

    const load = os.loadavg();
    const headlineStatus: OpsStatus =
      health.score >= 90 && state.mode === "ACTIVE"
        ? "ok"
        : health.score >= 75 || state.mode === "MAINTENANCE"
          ? "warn"
          : "danger";
    const headlineLabel =
      headlineStatus === "ok"
        ? "Platform Healthy"
        : headlineStatus === "warn"
          ? "Platform Degraded"
          : "Platform Critical";

    const architecture = [
      { key: "clients", label: "Clients / Flutter", status: internet.status === "ok" ? "ok" : "warn", detail: "mobile + portal" },
      { key: "gateway", label: "API Gateway", status: apiOk ? "ok" : "danger", detail: apiOk ? "UP" : "DOWN" },
      { key: "database", label: "PostgreSQL", status: db.status, detail: db.detail },
      { key: "redis", label: "Redis", status: redis.status, detail: redis.detail },
      { key: "workers", label: "Workers", status: workersRunning ? "ok" : "danger", detail: workersRunning ? "running" : "stopped" },
      { key: "queue", label: "Queue / Outbox", status: queueStats.dead > 0 ? "warn" : "ok", detail: `${queueStats.pending} pending` },
      { key: "storage", label: "Storage", status: disk.percent > 90 ? "danger" : disk.percent > 80 ? "warn" : "ok", detail: disk.usedLabel },
      { key: "ssl", label: "SSL", status: ssl.status, detail: ssl.detail },
      { key: "pm2", label: "PM2 Runtime", status: pm2.status, detail: pm2.detail },
    ];

    const statusBar = {
      mode: state.mode,
      users: jobs.sessions,
      rps: http.rps,
      latencyMs: http.latencyMs || db.latencyMs,
      cpu,
      ram,
      storage: disk.percent,
      lastBackupAgeMin: backup.ageMin,
      lastBackupAt: backup.at,
    };

    const details = {
      api: {
        status: apiOk ? "ok" : "danger",
        latencyMs: http.latencyMs,
        requests: http.requests,
        errors: http.errors,
        errorRate: http.errorRate,
        rps: http.rps,
        readiness: ready,
      },
      database: {
        status: db.status,
        latencyMs: db.latencyMs,
        connections: db.connections,
        sizeLabel: jobs.dbSizeLabel,
        sizeBytes: jobs.dbSizeBytes,
        locks: dbExtra.locks,
        activeQueries: dbExtra.activeQueries,
        slowQueries: dbExtra.slowQueries,
        idleInTransaction: dbExtra.idleInTransaction,
        lastBackupAt: backup.at,
        lastBackupAgeMin: backup.ageMin,
        lastBackupName: backup.name,
        restoreStatus: "idle",
        replication: "primary / single-node",
      },
      workers: {
        running: workersRunning,
        jobsRunning: jobs.running,
        jobsFailed: jobs.failed,
        jobsPending: jobs.pending,
        pm2: pm2.detail,
        pm2Status: pm2.status,
      },
      queue: {
        pending: queueStats.pending,
        dead: queueStats.dead,
        status: queueStats.dead > 0 ? "warn" : "ok",
      },
      storage: {
        percent: disk.percent,
        usedLabel: disk.usedLabel,
        totalLabel: disk.totalLabel,
        freeLabel: disk.freeLabel,
        mount: disk.mount,
      },
      ssl: {
        status: ssl.status,
        detail: ssl.detail,
        daysLeft: ssl.daysLeft,
      },
      redis: redis,
      pm2: { status: pm2.status, detail: pm2.detail, online: pm2.online, total: pm2.total },
    };

    return {
      generatedAt: new Date().toISOString(),
      mode: state.mode,
      headline: {
        status: headlineStatus,
        label: headlineLabel,
        score: health.score,
        healthLabel: health.label,
      },
      statusBar,
      overview,
      architecture,
      infrastructure: architecture,
      server: {
        cpu,
        ram,
        disk: disk.percent,
        diskUsedBytes: disk.usedBytes,
        diskTotalBytes: disk.totalBytes,
        diskFreeBytes: disk.freeBytes,
        diskUsedLabel: disk.usedLabel,
        diskTotalLabel: disk.totalLabel,
        diskFreeLabel: disk.freeLabel,
        diskMount: disk.mount,
        diskDetail: disk.detail,
        networkIn: net.inMbps,
        networkOut: net.outMbps,
        loadAverage: load.map((n) => Math.round(n * 100) / 100),
        uptimeSec: Math.floor(os.uptime()),
        processUptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version,
        pm2: pm2.detail,
        pm2Status: pm2.status,
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
      },
      database: details.database,
      workers: details.workers,
      health: {
        score: health.score,
        label: health.label,
        factors: health.factors,
        responseTimeMs: http.latencyMs || db.latencyMs,
        errorRate: http.errorRate,
        activeUsers: jobs.activeUsers,
        activeSessions: jobs.sessions,
        runningJobs: jobs.running,
        failedJobs: jobs.failed,
        queueSize: queueStats.pending,
        avgApiLatencyMs: http.latencyMs,
        requestsPerSec: http.rps,
        requestsPerMin: Math.round(http.rps * 60 * 10) / 10,
        opsToday: jobs.opsToday,
        errors24h: jobs.errors24h,
        dbSizeLabel: jobs.dbSizeLabel,
        cpu,
      },
      analytics: {
        usersToday: jobs.activeUsers,
        onlineUsers: jobs.sessions,
        opsToday: jobs.opsToday,
        avgLatencyMs: http.latencyMs || db.latencyMs,
        errorRate: http.errorRate,
        errors24h: jobs.errors24h,
        requestsPerMin: Math.round(http.rps * 60 * 10) / 10,
        topEndpoints,
        usageGrowth: http.rps > 0 ? "active" : "idle",
      },
      kpis: {
        onlineUsers: jobs.sessions,
        activeUsers: jobs.activeUsers,
        requestsPerMin: Math.round(http.rps * 60 * 10) / 10,
        avgLatencyMs: http.latencyMs || db.latencyMs,
        opsToday: jobs.opsToday,
        errors24h: jobs.errors24h,
        dbSizeLabel: jobs.dbSizeLabel,
        activeSessions: jobs.sessions,
        cpu,
      },
      details,
      backup,
      alerts,
      live,
      readiness: ready,
    };
  }

  async restartWorkers(actor = "owner-portal", ip?: string): Promise<{ ok: boolean; detail: string }> {
    const result = await platformLockService.restartWorkers(actor, { ip });
    if (result.ok) {
      readinessManager.setOutboxWorkerStarted(true);
      this.pushLive(`Workers restarted by ${actor}`);
    }
    return result;
  }

  async runBackupNow(actor = "owner-portal", ip?: string): Promise<{ ok: boolean; detail: string; sizeBytes?: number }> {
    try {
      const { systemContainer } = await import("@server/composition/system.container");
      const { getDatabase } = await import("@core/database/connection");
      const { systemLogs } = await import("@shared/schema");
      const backup = await systemContainer.exportSystemBackupUseCase.execute();
      const payload = JSON.stringify(backup);
      const sizeBytes = Buffer.byteLength(payload, "utf8");
      const filename = `backup_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      const db = getDatabase();
      await db.insert(systemLogs).values({
        userId: null,
        userName: actor,
        userRole: "PLATFORM_OWNER",
        regionId: null,
        action: "export",
        entityType: "backup",
        entityId: null,
        entityName: filename,
        details: JSON.stringify({ filename, backupSizeBytes: sizeBytes, ip: ip || null, source: "owner-portal" }),
        description: `backup export by ${actor}`,
        severity: "info",
        success: true,
      });
      this.pushLive(`Backup finished (${this.formatBytes(sizeBytes)})`);
      return { ok: true, detail: filename, sizeBytes };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "backup failed";
      this.pushLive(`Backup failed: ${msg}`);
      return { ok: false, detail: msg };
    }
  }
}

export const platformOpsService = new PlatformOpsService();
