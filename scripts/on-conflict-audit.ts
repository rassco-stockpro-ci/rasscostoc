/**
 * ON CONFLICT audit — every ON CONFLICT target the backend uses must be backed
 * by a unique index (or constraint) in the given database, otherwise Postgres
 * rejects the statement at runtime ("there is no unique or exclusion
 * constraint matching the ON CONFLICT specification").
 *
 * Targets are read from the backend source, not from a hand-kept list:
 *   - drizzle: .onConflictDoUpdate/.onConflictDoNothing({ target: X.col | [X.a, X.b] }),
 *     resolved to table/column names through the shared drizzle schema;
 *   - raw SQL: INSERT INTO <table> ... ON CONFLICT (<cols>) / ON CONSTRAINT <name>.
 *
 * Read-only: it only reads pg_catalog. Exit 1 if any target is unbacked,
 * unresolvable, or if no target is found at all.
 *
 * Usage: npx tsx scripts/on-conflict-audit.ts <postgres-url> [--json]
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../packages/shared-types/schema";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "apps/api/src");

type Target = { where: string; table: string; columns?: string[]; constraint?: string; error?: string };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__integration__" || name === "testing" || name === "node_modules") continue;
      sourceFiles(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

export function collectTargets(): Target[] {
  const targets: Target[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(root, file).replace(/\\/g, "/");
    for (const m of text.matchAll(/onConflictDo(?:Update|Nothing)\(\s*\{[^}]*?target:\s*(\[[^\]]*\]|[\w$]+\.[\w$]+)/g)) {
      const where = `${rel}:${lineOf(text, m.index!)}`;
      const refs = [...m[1].matchAll(/([\w$]+)\.([\w$]+)/g)];
      const tables = new Set<string>();
      const columns: string[] = [];
      let error: string | undefined;
      for (const [, exp, prop] of refs) {
        const t = (schema as Record<string, unknown>)[exp];
        if (!is(t, PgTable)) {
          error = `cannot resolve ${exp} to a schema table`;
          continue;
        }
        tables.add(getTableConfig(t).name);
        const col = (t as unknown as Record<string, { name?: string }>)[prop];
        if (!col?.name) error = `cannot resolve ${exp}.${prop} to a column`;
        else columns.push(col.name);
      }
      if (tables.size !== 1) error ??= `target spans ${tables.size} tables`;
      targets.push({ where, table: [...tables][0] ?? "?", columns, error });
    }
    for (const m of text.matchAll(/INSERT\s+INTO\s+"?(\w+)"?[^;]{0,800}?ON\s+CONFLICT\s*(?:\(([^)]+)\)|ON\s+CONSTRAINT\s+"?(\w+)"?)/gi)) {
      const where = `${rel}:${lineOf(text, m.index!)}`;
      if (m[2]) targets.push({ where, table: m[1], columns: m[2].split(",").map((c) => c.trim().replace(/"/g, "")) });
      else targets.push({ where, table: m[1], constraint: m[3] });
    }
  }
  return targets;
}

export async function auditDatabase(url: string, targets: Target[]) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const idx = (
      await c.query(`
        select t.relname as table, ci.relname as name,
               array_agg(a.attname::text order by k.ord) as cols
        from pg_index i
        join pg_class t on t.oid = i.indrelid and t.relnamespace = 'public'::regnamespace
        join pg_class ci on ci.oid = i.indexrelid
        join unnest(i.indkey) with ordinality k(attnum, ord) on true
        join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
        where i.indisunique and i.indpred is null
        group by t.relname, ci.relname`)
    ).rows as { table: string; name: string; cols: string[] }[];
    const cons = new Set(
      (await c.query(`select conname from pg_constraint where connamespace = 'public'::regnamespace and contype in ('u','p','x')`)).rows.map(
        (r) => r.conname as string
      )
    );
    const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
    return targets.map((t) => {
      if (t.error) return { ...t, ok: false, backedBy: null as string | null };
      if (t.constraint) return { ...t, ok: cons.has(t.constraint), backedBy: cons.has(t.constraint) ? t.constraint : null };
      const hit = idx.find((i) => i.table === t.table && same(i.cols, t.columns!));
      return { ...t, ok: !!hit, backedBy: hit?.name ?? null };
    });
  } finally {
    await c.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: tsx scripts/on-conflict-audit.ts <postgres-url> [--json]");
    process.exit(2);
  }
  const targets = collectTargets();
  const results = await auditDatabase(url, targets);
  const bad = results.filter((r) => !r.ok);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ total: results.length, missing: bad }));
  else {
    for (const r of results)
      console.log(`${r.ok ? "  ok     " : "  MISSING"} ${r.table}(${r.columns?.join(", ") ?? r.constraint}) <- ${r.where}${r.ok ? `  [${r.backedBy}]` : r.error ? `  (${r.error})` : ""}`);
    console.log(`ON CONFLICT targets: ${results.length}, unbacked: ${bad.length}`);
  }
  process.exit(results.length > 0 && bad.length === 0 ? 0 : 1);
}
