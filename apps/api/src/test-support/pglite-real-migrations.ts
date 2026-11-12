/**
 * Spins up an in-process PGlite instance and applies the REAL migration
 * files from /migrations (not hand-written DDL) in journal order, via
 * drizzle-kit's own `--> statement-breakpoint` split convention. This is
 * the "real migrations on in-process PGlite" harness: it proves write-path
 * logic against the actual production schema shape, not an approximation.
 *
 * Shared across test files — do not duplicate this setup per-file.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const PGLITE_DIR = process.env.PGLITE_DIR || "D:/tmp/pglite-scratch";
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../migrations");

export async function createPgliteWithRealMigrations() {
  const pgliteModulePath = path.join(PGLITE_DIR, "node_modules", "@electric-sql", "pglite", "dist", "index.js");
  const { PGlite } = await import(pathToFileURL(pgliteModulePath).href);
  const { drizzle } = await import("drizzle-orm/pg-proxy");

  const client = new (PGlite as any)();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 0000_, 0001_, ... — numeric prefix sorts correctly as strings

  for (const file of files) {
    const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await client.exec(stmt);
    }
  }

  // PENDING MIGRATION (code schema ahead of generated migrations — no
  // migration has been generated or run against any real database, per the
  // standing "no migration" constraint on this work). Both `version`
  // columns were added to the Drizzle schema (optimistic-lock token for
  // technician_fixed_inventory_entries and technician_moving_inventory_entries)
  // but no corresponding migration file exists yet. Applied here via ALTER
  // so the real-migrations test harness matches the current CODE schema —
  // this is a test-only stand-in for a migration that still needs to be
  // generated and approved separately.
  await client.exec(`ALTER TABLE technician_fixed_inventory_entries ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;`);
  await client.exec(`ALTER TABLE technician_moving_inventory_entries ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;`);

  const proxiedDb: any = drizzle(async (sql: string, params: any[], method: string) => {
    const result = await client.query(sql, params, { rowMode: "array" });
    return { rows: method === "all" || method === "values" ? result.rows : result.rows.slice(0, 1) };
  });

  // Same TEST-HARNESS-ONLY workaround as DrizzleInventoryEntriesRepository.pglite.test.ts:
  // this drizzle-orm version's pg-proxy .transaction() is an unconditional
  // throwing stub (verified by reading node_modules/drizzle-orm/pg-proxy/session.js).
  // Production uses the standard node-postgres driver, which supports
  // transactions normally. Hand-rolled BEGIN/COMMIT/ROLLBACK over the same
  // single PGlite connection proves real multi-statement atomicity without
  // modifying any production code.
  proxiedDb.transaction = async (cb: (tx: any) => Promise<any>) => {
    await client.query("BEGIN");
    try {
      const result = await cb(proxiedDb);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  };

  return { client, db: proxiedDb };
}
