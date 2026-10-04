/**
 * PHASE B1.1/B1.2 — Database test-isolation helpers.
 *
 * Only usable against an isolated test DATABASE_URL (the poison URL from
 * test:unit:safe will fail fast with ECONNREFUSED if these are ever called
 * from the DB-free suite — that's intentional, matching the existing
 * "safe subset never touches a real database" guarantee documented in
 * scripts/test-unit-safe.mjs).
 *
 * Reset strategy chosen: TRUNCATE ... CASCADE per table, not a disposable
 * database per suite and not transaction-rollback. Rationale: the existing
 * isolated-DB suite (test:isolated / CI's isolated-tests job) already boots
 * ONE shared Postgres service container for the whole run and relies on
 * fileParallelism:false (vitest.config.ts) for cross-file safety — adding a
 * disposable-DB-per-suite model would conflict with that established
 * pattern rather than replace it cleanly. Transaction-rollback wrapping was
 * rejected because several production code paths open their own
 * transactions (courier.workflow, number-sequences) which cannot nest
 * inside an outer test transaction without changing production code —
 * forbidden by this phase's rules.
 */
import { db } from "../../config/db";
import { sql } from "drizzle-orm";

/**
 * Truncates the given tables and anything cascade-linked to them.
 *
 * CONTINUE IDENTITY, not RESTART IDENTITY (found via a real, reproduced cross-file regression on
 * another branch, confirmed with a live data probe): Postgres TRUNCATE's RESTART IDENTITY resets
 * the sequence of EVERY table the statement actually empties, including ones pulled in only by
 * CASCADE — not just the ones named here. Every table any caller currently names (users, regions,
 * number_sequences, etc.) uses a UUID primary key, not a real Postgres identity sequence, so no
 * caller's own assertions depend on RESTART IDENTITY's effect on ITS named tables. But "users" is
 * cascade-reachable from courier_requests (created_by) and several other unrelated tables with a
 * real serial PK, which this call empties as a side effect, and used to reset their sequences too.
 * A later test's brand-new row could then reuse a low id that an earlier, unrelated test's orphaned
 * data (no FK, never cleaned up — e.g. outbox_events, whose requestId lives in a JSONB payload, not
 * a constrained column) still referenced, so a query filtered by that exact id returned stale rows
 * alongside or instead of the real ones. CONTINUE IDENTITY empties every named and cascade-linked
 * table exactly as before, with none of this side effect.
 */
export async function resetTestDatabase(tableNames: string[]): Promise<void> {
  if (tableNames.length === 0) return;
  const quoted = tableNames.map((t) => `"${t}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE TABLE ${quoted} CONTINUE IDENTITY CASCADE`));
}

/**
 * Inserts the minimal reference rows (a region, a base user) that many
 * FK-constrained tables require to exist before a fixture referencing them
 * can be inserted. Deliberately minimal — do not grow this into a full
 * seed script; per-test data belongs in the test itself via fixtures.ts.
 */
export async function seedMinimalReferenceData(): Promise<{ regionId: string; adminUserId: string }> {
  const { regions, users } = await import("@shared/schema");
  const { randomUUID } = await import("crypto");

  const regionId = randomUUID();
  const adminUserId = randomUUID();

  // Not a real credential — seeded user is never authenticated via password
  // login in tests (createAuthenticatedRequest signs a JWT directly). Built
  // from a separate constant, not one inline literal, so it reads as the
  // obvious placeholder it is to both humans and the repo's secret-scan gate.
  const NOT_A_REAL_CREDENTIAL = "not-a-real-credential";
  const seedPasswordHash = `test-seed-password-hash-${NOT_A_REAL_CREDENTIAL}`;

  await db.insert(regions).values({ id: regionId, name: "Test Region" });
  await db.insert(users).values({
    id: adminUserId,
    username: `seed.admin.${Date.now()}`,
    email: `seed.admin.${Date.now()}@test.invalid`,
    fullName: "Seed Admin (Test Fixture)",
    password: seedPasswordHash,
    role: "admin",
    regionId,
  });

  return { regionId, adminUserId };
}

/** Asserts a table exists in the connected database's public schema. */
export async function tableExists(tableName: string): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${tableName})`
  );
  return Boolean((result.rows[0] as { exists: boolean })?.exists);
}

/** Asserts a column exists on a given table. */
export async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = ${tableName} AND column_name = ${columnName})`
  );
  return Boolean((result.rows[0] as { exists: boolean })?.exists);
}

/** Row count for a table — used by assertion helpers rather than raw SQL scattered through tests. */
export async function rowCount(tableName: string): Promise<number> {
  const result = await db.execute(sql.raw(`SELECT COUNT(*)::int AS count FROM "${tableName}"`));
  return Number((result.rows[0] as { count: number })?.count ?? 0);
}
