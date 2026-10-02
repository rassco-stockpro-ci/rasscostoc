import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { regions } from "./catalog.schema";
import { users } from "./organization.schema";

export const systemLogs = pgTable("system_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  userName: text("user_name").notNull(),
  userRole: text("user_role").notNull(),
  regionId: varchar("region_id").references(() => regions.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: varchar("entity_id"),
  entityName: text("entity_name"),
  details: text("details"),
  description: text("description").notNull(),
  severity: text("severity").notNull().default("info"),
  success: boolean("success").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: varchar("key").primaryKey(),
  responseStatus: integer("response_status").notNull(),
  responseBody: text("response_body").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const rateLimitCounters = pgTable("rate_limit_counters", {
  key: varchar("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at").notNull(),
});

export const insertSystemLogSchema = createInsertSchema(systemLogs).omit({
  id: true,
  createdAt: true,
});

export const insertIdempotencyKeySchema = createInsertSchema(idempotencyKeys);

export const coreJobs = pgTable("core_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: varchar("type", { length: 50 }).notNull(), // 'EXPORT_EXCEL', 'BULK_IMPORT', 'AI_PROCESS'
  status: varchar("status", { length: 20 }).notNull().default("PENDING"), // 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'
  ownerId: varchar("owner_id").references(() => users.id).notNull(),
  progress: integer("progress").notNull().default(0),
  progressDetails: text("progress_details"), // JSON: { processedRows, totalRows, etaSeconds, currentStep }
  payload: text("payload"), // JSON payload as text
  resultUrl: varchar("result_url", { length: 512 }),
  resultMetadata: text("result_metadata"), // JSON: { url, size, mime, checksum, expires }
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  nextRetryAt: timestamp("next_retry_at"),
  lastErrorAt: timestamp("last_error_at"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const insertCoreJobSchema = createInsertSchema(coreJobs);

export type InsertSystemLog = z.infer<typeof insertSystemLogSchema>;
export type SystemLog = typeof systemLogs.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type InsertIdempotencyKey = z.infer<typeof insertIdempotencyKeySchema>;
export type RateLimitCounter = typeof rateLimitCounters.$inferSelect;
export type CoreJob = typeof coreJobs.$inferSelect;
export type InsertCoreJob = z.infer<typeof insertCoreJobSchema>;

// Owner Operations Center (owner.nuzum.fun) platform-wide lock state.
//
// RECOVERED, not authored fresh: this table already existed live in the
// database (created 2026-07-27) from a complete original implementation
// that was deployed once, then vanished from the git-tracked source with
// zero trace in git history — while its DB table and old compiled dist/
// bundles (in server backups under /root/quarantine, /root/*-backup-*)
// survived. The full original TypeScript source (types, service, ops
// service, auth, middleware, routes — apps/api/src/core/platform-lock/*)
// was recovered verbatim from esbuild source maps embedded in those old
// dist bundles and restored here rather than reinvented, since it is a
// far more complete design (real session revocation, subscription grace
// period, full audit trail) than a first-principles rewrite would be.
// This schema definition matches the live table's real columns exactly
// (confirmed via `\d platform_lock_state` against production) — it does
// NOT create or alter anything; the table's DDL predates this file.
export const platformLockState = pgTable("platform_lock_state", {
  id: varchar("id").primaryKey().default("default"),
  mode: text("mode").notNull().default("ACTIVE"),
  publicMessage: text("public_message"),
  internalReason: text("internal_reason"),
  lockedAt: timestamp("locked_at"),
  lockedBy: text("locked_by"),
  subscriptionExpiresAt: timestamp("subscription_expires_at"),
  gracePeriodEndsAt: timestamp("grace_period_ends_at"),
  stopWorkers: boolean("stop_workers").notNull().default(true),
  revokeSessions: boolean("revoke_sessions").notNull().default(true),
  systemLockVersion: integer("system_lock_version").notNull().default(0),
  suspendedAt: timestamp("suspended_at"),
  reactivatedAt: timestamp("reactivated_at"),
  suspensionReason: text("suspension_reason"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type PlatformLockStateRow = typeof platformLockState.$inferSelect;
