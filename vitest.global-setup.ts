/**
 * Vitest global setup — runs once before the whole test suite.
 *
 * Applies all pending Drizzle migrations to the local test database so that
 * integration tests never fail with "column does not exist" after a migration
 * is added to the codebase.  Idempotent: drizzle-orm tracks applied migrations
 * in the `drizzle.__drizzle_migrations` table and skips already-applied ones.
 */
import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "path";

export async function setup(): Promise<void> {
  // Dynamic import so path aliases resolved by Vite apply at import time.
  const { db, pool } = await import("@core/config/db");
  const migrationsFolder = path.resolve(process.cwd(), "migrations");
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    // Close this setup context's pool; test-worker threads each own their
    // own module registry and pool instance, so this does not affect them.
    await pool.end();
  }
}
