/**
 * Test-only harness: in-process PGlite with the repository's REAL drizzle migrations applied,
 * exposed as a Drizzle (pg-proxy) handle. "Real migrations on in-process PGlite" — not parity
 * with a real PostgreSQL server. Requires PGLITE_DIR (scratch dir containing
 * node_modules/@electric-sql/pglite@0.2.17, outside the repo).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";

export type MigrationReport = { files: number; statements: number; failures: string[] };

function readRealMigrations(): { files: number; sql: string[] } {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, "migrations", "meta", "_journal.json"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("migrations/meta/_journal.json not found");
    dir = up;
  }
  const journal = JSON.parse(fs.readFileSync(path.join(dir, "migrations", "meta", "_journal.json"), "utf8"));
  const sql: string[] = [];
  for (const e of journal.entries) {
    const text = fs.readFileSync(path.join(dir, "migrations", `${e.tag}.sql`), "utf8");
    for (const stmt of text.split("--> statement-breakpoint")) if (stmt.trim()) sql.push(stmt.trim());
  }
  return { files: journal.entries.length, sql };
}

export async function createPgliteWithRealMigrations(pgliteDir: string) {
  const entry = pathToFileURL(
    path.join(pgliteDir, "node_modules", "@electric-sql", "pglite", "dist", "index.js")
  ).href;
  const { PGlite } = await import(/* @vite-ignore */ entry);
  // Keep timestamps as raw strings so Drizzle's own timestamp mapper parses them.
  const client = new PGlite({ parsers: { 1114: (v: string) => v, 1184: (v: string) => v } });

  const mig = readRealMigrations();
  const report: MigrationReport = { files: mig.files, statements: mig.sql.length, failures: [] };
  for (const stmt of mig.sql) {
    try {
      await client.exec(stmt);
    } catch (e: any) {
      report.failures.push(`${String(e.message).split("\n")[0]} :: ${stmt.slice(0, 80)}`);
    }
  }

  const base = drizzle(async (sql: string, params: any[]) => {
    const r = await client.query(sql, params, { rowMode: "array" });
    return { rows: r.rows };
  });
  // pg-proxy's .transaction() stub throws; emulate BEGIN/COMMIT/ROLLBACK at the harness only.
  const db: any = Object.create(base);
  db.transaction = async (cb: (tx: any) => Promise<any>) => {
    await client.exec("BEGIN");
    try {
      const out = await cb(base);
      await client.exec("COMMIT");
      return out;
    } catch (e) {
      await client.exec("ROLLBACK");
      throw e;
    }
  };

  return { client, db, report };
}
