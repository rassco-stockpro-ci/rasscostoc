import { desc, eq } from "drizzle-orm";
import { getDatabase } from "@core/database/connection";
import { platformLockState, systemLogs } from "@shared/schema";
import { pool } from "@core/config/db";
import {
  DEFAULT_PUBLIC_MESSAGES,
  isPlatformLockMode,
  type PlatformLockMode,
  type PlatformLockState,
} from "./platform-lock.types";
import { readFailsafeLockState, writeFailsafeLockState } from "./platform-lock.failsafe";

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function failClosedDefault(reason: string): PlatformLockState {
  return {
    id: "default",
    mode: "MAINTENANCE",
    publicMessage: DEFAULT_PUBLIC_MESSAGES.MAINTENANCE,
    internalReason: reason,
    lockedAt: new Date().toISOString(),
    lockedBy: "fail-closed",
    subscriptionExpiresAt: null,
    gracePeriodEndsAt: null,
    stopWorkers: true,
    revokeSessions: true,
    systemLockVersion: Number.MAX_SAFE_INTEGER,
    suspendedAt: null,
    reactivatedAt: null,
    suspensionReason: reason,
    updatedAt: new Date().toISOString(),
    source: "fail-closed-default",
  };
}

function mapRow(row: typeof platformLockState.$inferSelect, source: PlatformLockState["source"]): PlatformLockState {
  const mode = isPlatformLockMode(row.mode) ? row.mode : "MAINTENANCE";
  return {
    id: row.id,
    mode,
    publicMessage: row.publicMessage ?? DEFAULT_PUBLIC_MESSAGES[mode] ?? null,
    internalReason: row.internalReason ?? null,
    lockedAt: toIso(row.lockedAt),
    lockedBy: row.lockedBy ?? null,
    subscriptionExpiresAt: toIso(row.subscriptionExpiresAt),
    gracePeriodEndsAt: toIso(row.gracePeriodEndsAt),
    stopWorkers: row.stopWorkers !== false,
    revokeSessions: row.revokeSessions !== false,
    systemLockVersion: row.systemLockVersion ?? 0,
    suspendedAt: toIso(row.suspendedAt),
    reactivatedAt: toIso(row.reactivatedAt),
    suspensionReason: row.suspensionReason ?? null,
    updatedAt: toIso(row.updatedAt),
    source,
  };
}

export type EnableLockInput = {
  mode: Exclude<PlatformLockMode, "ACTIVE">;
  publicMessage?: string;
  internalReason?: string;
  lockedBy: string;
  stopWorkers?: boolean;
  revokeSessions?: boolean;
  suspensionReason?: string;
  ip?: string;
};

export type SubscriptionDatesInput = {
  subscriptionExpiresAt?: string | null;
  gracePeriodEndsAt?: string | null;
  actor: string;
};

class PlatformLockService {
  private cached: PlatformLockState | null = null;
  private subscriptionTimer: NodeJS.Timeout | null = null;
  private workerController: {
    start: () => void;
    stop: () => void;
  } | null = null;

  setWorkerController(controller: { start: () => void; stop: () => void }): void {
    this.workerController = controller;
  }

  getCachedState(): PlatformLockState {
    return this.cached || failClosedDefault("cache-empty");
  }

  async initialize(): Promise<PlatformLockState> {
    const state = await this.refresh();
    this.applyWorkerPolicy(state);
    this.startSubscriptionWatcher();
    return state;
  }

  async refresh(): Promise<PlatformLockState> {
    try {
      const db = getDatabase();
      const [row] = await db.select().from(platformLockState).where(eq(platformLockState.id, "default")).limit(1);
      if (!row) {
        await db.insert(platformLockState).values({ id: "default", mode: "ACTIVE" });
        const [created] = await db.select().from(platformLockState).where(eq(platformLockState.id, "default")).limit(1);
        const mapped = mapRow(created!, "database");
        this.cached = mapped;
        writeFailsafeLockState(mapped);
        return mapped;
      }
      const mapped = mapRow(row, "database");
      this.cached = mapped;
      writeFailsafeLockState(mapped);
      return mapped;
    } catch (error) {
      const fromFile = readFailsafeLockState();
      if (fromFile) {
        this.cached = fromFile;
        return fromFile;
      }
      const closed = failClosedDefault(
        `unable-to-read-lock-state: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.cached = closed;
      return closed;
    }
  }

  isActive(state: PlatformLockState = this.getCachedState()): boolean {
    return state.mode === "ACTIVE";
  }

  getPublicMessage(state: PlatformLockState = this.getCachedState()): string {
    if (state.mode === "ACTIVE") return state.publicMessage?.trim() || "";
    return state.publicMessage || DEFAULT_PUBLIC_MESSAGES[state.mode] || DEFAULT_PUBLIC_MESSAGES.MAINTENANCE;
  }

  async listAuditLogs(limit = 50): Promise<
    Array<{
      id: string;
      action: string;
      description: string;
      details: string | null;
      severity: string;
      success: boolean;
      createdAt: string | null;
      userName: string;
      ip: string | null;
      result: string;
    }>
  > {
    const db = getDatabase();
    const rows = await db
      .select({
        id: systemLogs.id,
        action: systemLogs.action,
        description: systemLogs.description,
        details: systemLogs.details,
        severity: systemLogs.severity,
        success: systemLogs.success,
        createdAt: systemLogs.createdAt,
        userName: systemLogs.userName,
      })
      .from(systemLogs)
      .where(eq(systemLogs.entityType, "platform_lock_state"))
      .orderBy(desc(systemLogs.createdAt))
      .limit(Math.min(100, Math.max(1, limit)));

    return rows.map((r) => {
      let ip: string | null = null;
      if (r.details) {
        try {
          const parsed = JSON.parse(r.details) as { ip?: string };
          if (typeof parsed.ip === "string") ip = parsed.ip;
        } catch {
          // ignore
        }
      }
      return {
        id: r.id,
        action: r.action,
        description: r.description,
        details: r.details ?? null,
        severity: r.severity,
        success: r.success,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        userName: r.userName,
        ip,
        result: r.success ? "success" : "failed",
      };
    });
  }

  async restartWorkers(actor: string, meta?: { ip?: string }): Promise<{ ok: boolean; detail: string }> {
    const state = this.getCachedState();
    if (state.mode !== "ACTIVE" && state.stopWorkers) {
      return { ok: false, detail: "Workers locked by platform mode — resume first" };
    }
    if (!this.workerController) {
      return { ok: false, detail: "Worker controller not registered" };
    }
    this.workerController.stop();
    this.workerController.start();
    await this.audit("workers_restart", actor, { ok: true, ip: meta?.ip || null });
    return { ok: true, detail: "Workers restarted" };
  }

  async enable(input: EnableLockInput): Promise<PlatformLockState> {
    const now = new Date();
    const current = await this.refresh();
    const nextVersion =
      input.revokeSessions !== false ? current.systemLockVersion + 1 : current.systemLockVersion;

    const db = getDatabase();
    const [row] = await db
      .update(platformLockState)
      .set({
        mode: input.mode,
        publicMessage: input.publicMessage || DEFAULT_PUBLIC_MESSAGES[input.mode],
        internalReason: input.internalReason || null,
        lockedAt: now,
        lockedBy: input.lockedBy,
        stopWorkers: input.stopWorkers !== false,
        revokeSessions: input.revokeSessions !== false,
        systemLockVersion: nextVersion,
        suspendedAt: input.mode === "SUBSCRIPTION_SUSPENDED" ? now : current.suspendedAt ? new Date(current.suspendedAt) : null,
        suspensionReason: input.suspensionReason || input.internalReason || null,
        reactivatedAt: null,
        updatedAt: now,
      })
      .where(eq(platformLockState.id, "default"))
      .returning();

    const mapped = mapRow(row, "database");
    this.cached = mapped;
    writeFailsafeLockState(mapped);

    if (input.revokeSessions !== false) {
      await this.revokeAllSessions();
    }
    this.applyWorkerPolicy(mapped);
    await this.audit("PLATFORM_LOCK_ENABLE", input.lockedBy, {
      mode: mapped.mode,
      systemLockVersion: mapped.systemLockVersion,
      stopWorkers: mapped.stopWorkers,
      revokeSessions: mapped.revokeSessions,
      internalReason: mapped.internalReason,
      ip: input.ip || null,
    });
    return mapped;
  }

  async disable(actor: string, reason?: string, meta?: { ip?: string }): Promise<PlatformLockState> {
    const now = new Date();
    const db = getDatabase();
    const [row] = await db
      .update(platformLockState)
      .set({
        mode: "ACTIVE",
        publicMessage: null,
        internalReason: reason || "reactivated",
        lockedAt: null,
        lockedBy: null,
        stopWorkers: true,
        revokeSessions: true,
        reactivatedAt: now,
        suspensionReason: null,
        updatedAt: now,
      })
      .where(eq(platformLockState.id, "default"))
      .returning();

    const mapped = mapRow(row, "database");
    this.cached = mapped;
    writeFailsafeLockState(mapped);
    this.applyWorkerPolicy(mapped);
    await this.audit("PLATFORM_LOCK_DISABLE", actor, {
      mode: mapped.mode,
      reason: reason || null,
      systemLockVersion: mapped.systemLockVersion,
      ip: meta?.ip || null,
    });
    return mapped;
  }

  async updateSubscriptionDates(input: SubscriptionDatesInput): Promise<PlatformLockState> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.subscriptionExpiresAt !== undefined) {
      patch.subscriptionExpiresAt = input.subscriptionExpiresAt
        ? new Date(input.subscriptionExpiresAt)
        : null;
    }
    if (input.gracePeriodEndsAt !== undefined) {
      patch.gracePeriodEndsAt = input.gracePeriodEndsAt
        ? new Date(input.gracePeriodEndsAt)
        : null;
    }

    const db = getDatabase();
    const [row] = await db
      .update(platformLockState)
      .set(patch as any)
      .where(eq(platformLockState.id, "default"))
      .returning();

    const mapped = mapRow(row, "database");
    this.cached = mapped;
    writeFailsafeLockState(mapped);
    await this.audit("PLATFORM_LOCK_SUBSCRIPTION_DATES", input.actor, {
      subscriptionExpiresAt: mapped.subscriptionExpiresAt,
      gracePeriodEndsAt: mapped.gracePeriodEndsAt,
    });
    return mapped;
  }

  /**
   * Emergency recover: write ACTIVE to failsafe (+ DB when available) without requiring web.
   */
  async recoverLocal(actor: string, reason?: string): Promise<PlatformLockState> {
    try {
      return await this.disable(actor, reason || "cli-recover");
    } catch {
      const recovered: PlatformLockState = {
        id: "default",
        mode: "ACTIVE",
        publicMessage: null,
        internalReason: reason || "cli-recover-failsafe-only",
        lockedAt: null,
        lockedBy: null,
        subscriptionExpiresAt: null,
        gracePeriodEndsAt: null,
        stopWorkers: true,
        revokeSessions: true,
        systemLockVersion: this.getCachedState().systemLockVersion,
        suspendedAt: null,
        reactivatedAt: new Date().toISOString(),
        suspensionReason: null,
        updatedAt: new Date().toISOString(),
        source: "failsafe-file",
      };
      writeFailsafeLockState(recovered);
      this.cached = recovered;
      this.applyWorkerPolicy(recovered);
      return recovered;
    }
  }

  async revokeAllSessions(): Promise<{ refresh: number; bearer: number; cookie: number }> {
    const client = await pool.connect();
    try {
      const refresh = await client.query(
        `UPDATE refresh_tokens SET is_revoked = true WHERE is_revoked = false`,
      );
      const bearer = await client.query(`DELETE FROM bearer_sessions`);
      let cookie: { rowCount: number | null } = { rowCount: 0 };
      try {
        cookie = await client.query(`DELETE FROM session`);
      } catch {
        // connect-pg-simple table may be named differently in some envs
        try {
          cookie = await client.query(`DELETE FROM "session"`);
        } catch {
          cookie = { rowCount: 0 };
        }
      }
      return {
        refresh: refresh.rowCount || 0,
        bearer: bearer.rowCount || 0,
        cookie: cookie.rowCount || 0,
      };
    } finally {
      client.release();
    }
  }

  applyWorkerPolicy(state: PlatformLockState = this.getCachedState()): void {
    if (!this.workerController) return;
    if (state.mode === "ACTIVE" || !state.stopWorkers) {
      this.workerController.start();
    } else {
      this.workerController.stop();
    }
  }

  async enforceSubscriptionExpiry(): Promise<PlatformLockState | null> {
    const state = await this.refresh();
    if (state.mode !== "ACTIVE") return null;
    if (!state.gracePeriodEndsAt) return null;
    const ends = new Date(state.gracePeriodEndsAt).getTime();
    if (Number.isNaN(ends) || Date.now() <= ends) return null;

    return this.enable({
      mode: "SUBSCRIPTION_SUSPENDED",
      lockedBy: "subscription-watcher",
      internalReason: "grace_period_ended",
      suspensionReason: "Subscription grace period ended",
      publicMessage: DEFAULT_PUBLIC_MESSAGES.SUBSCRIPTION_SUSPENDED,
      stopWorkers: true,
      revokeSessions: true,
    });
  }

  startSubscriptionWatcher(): void {
    if (this.subscriptionTimer) return;
    this.subscriptionTimer = setInterval(() => {
      void this.enforceSubscriptionExpiry().catch(() => undefined);
    }, 60_000);
    // Avoid keeping process alive solely for the watcher in tests
    this.subscriptionTimer.unref?.();
  }

  private async audit(action: string, actor: string, details: Record<string, unknown>): Promise<void> {
    try {
      const db = getDatabase();
      await db.insert(systemLogs).values({
        userId: null,
        userName: actor,
        userRole: "PLATFORM_OWNER",
        regionId: null,
        action,
        entityType: "platform_lock_state",
        entityId: "default",
        entityName: "platform_lock",
        details: JSON.stringify(details),
        description: `${action} by ${actor}`,
        severity: action.includes("restart") ? "info" : "warning",
        success: details.ok === false ? false : true,
      });
    } catch {
      // Audit must not block lock operations
    }
  }
}

export const platformLockService = new PlatformLockService();

/** Used by auth JWT issuance — never throws. */
export async function getCurrentSystemLockVersion(): Promise<number> {
  try {
    const cached = platformLockService.getCachedState();
    if (cached.source === "database" || cached.source === "failsafe-file") {
      return cached.systemLockVersion;
    }
    const state = await platformLockService.refresh();
    return state.systemLockVersion;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function getCachedSystemLockVersion(): number {
  try {
    return platformLockService.getCachedState().systemLockVersion;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
