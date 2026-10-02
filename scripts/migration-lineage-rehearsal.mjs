/**
 * Migration lineage rehearsal — proves a Production-shaped database can be
 * brought to `main`'s schema by the REAL migrator, without touching business
 * data, and that the result is stable and consistent with a from-zero build.
 *
 *   Production snapshot ─► real migrator ─► every missing migration applied
 *                                          ─► no business-data mutation
 *                                          ─► second run is a NO-OP
 *   main from zero ──────► real migrator ─► same schema (+ platform_lock_state)
 *
 * Two ways to obtain the "Production snapshot":
 *   --synthetic            (CI) replays Production's migration LINEAGE into a
 *                          throwaway database: main 0000-0048, Production's own
 *                          0049_platform_lock_state, then main 0049-0054 under
 *                          Production's numbering/timestamps (+1000 ms). The
 *                          ledger it ends with has Production's high-water mark
 *                          (1785826886000) and no 0055+ objects; like
 *                          Production it lacks tech_product_unique and
 *                          idempotency_keys. Seeded rows stand in for
 *                          business data.
 *   --snapshot-dump FILE   (local) restores a verified pg_dump (custom format)
 *                          of Production into a throwaway database.
 *
 * SAFETY: refuses to run without --allow-test-db, and only against a server
 * URL whose database name contains "test" (TEST_DATABASE_URL). It creates and
 * drops its own throwaway databases; it never reads .env and never connects
 * to anything else. Nothing here writes to __drizzle_migrations by hand: every
 * ledger row is written by drizzle's own migrator.
 *
 * Usage:
 *   TEST_DATABASE_URL=postgresql://u:p@127.0.0.1:5432/x_test \
 *     node scripts/migration-lineage-rehearsal.mjs --allow-test-db --synthetic
 *   ... --snapshot-dump /path/to/nulip_inventory.dump [--report out.json]
 */
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { createRequire } from "module";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const require = createRequire(resolve(root, "package.json"));
const pg = require("pg");

const argv = process.argv.slice(2);
const argVal = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const dumpFile = argVal("--snapshot-dump");
const reportFile = argVal("--report");
const MODE = dumpFile ? "snapshot" : "synthetic";

/** Production's journal high-water mark (drizzle.__drizzle_migrations.created_at). */
const PROD_HIGH_WATER = 1785826886000;
/** Tables whose rows must be byte-identical before and after. */
const BUSINESS_TABLES = [
  "courier_requests",
  "courier_request_items",
  "courier_executions",
  "items",
  "custody_movements",
  "inventory_deduction_completions",
];

// ── safety ───────────────────────────────────────────────────────────────────
function resolveAdminUrl() {
  if (!argv.includes("--allow-test-db")) {
    throw new Error("Refusing to run: pass --allow-test-db to confirm the target server is disposable.");
  }
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL is required (this script never reads .env).");
  const u = new URL(raw);
  if (!/test/i.test(u.pathname.replace(/^\//, ""))) {
    throw new Error('Refusing to run: the database name in TEST_DATABASE_URL must contain "test".');
  }
  return raw;
}
const withDb = (adminUrl, name) => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};
const redact = (s) => String(s).replace(/postgres(ql)?:\/\/[^\s'"]+/g, "postgresql://***");

// ── results ──────────────────────────────────────────────────────────────────
const checks = [];
const check = (id, ok, detail = "") => {
  checks.push({ id, ok: !!ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${id}${detail ? " — " + detail : ""}`);
  return !!ok;
};

// ── migration folders ────────────────────────────────────────────────────────
const journal = JSON.parse(readFileSync(resolve(root, "migrations/meta/_journal.json"), "utf8"));
const sqlOf = (tag) => readFileSync(resolve(root, "migrations", `${tag}.sql`), "utf8");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const tagNo = (tag) => Number(tag.slice(0, 4));

function buildFolder(entries) {
  const dir = mkdtempSync(join(tmpdir(), "lineage-mig-"));
  mkdirSync(join(dir, "meta"));
  const out = { version: journal.version, dialect: journal.dialect, entries: [] };
  entries.forEach((e, i) => {
    writeFileSync(join(dir, `${e.tag}.sql`), e.sql);
    out.entries.push({ idx: i, version: "7", when: e.when, tag: e.tag, breakpoints: true });
  });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(out, null, 2));
  return dir;
}
const mainEntries = (filter) =>
  journal.entries.filter(filter).map((e) => ({ tag: e.tag, when: e.when, sql: sqlOf(e.tag) }));

/**
 * Production's own migration "0049_platform_lock_state" (it exists only in the Production deployment
 * branch), reduced to the one table that actually exists in the Production database. Reproduced here
 * so the rehearsal can rebuild a Production-shaped ledger. Production's original file also declares
 * platform_ops_snapshots; that table is NOT in the Production database, so it is not reproduced.
 */
const PROD_0049_PLATFORM_LOCK_STATE = `CREATE TABLE IF NOT EXISTS "platform_lock_state" (
	"id" varchar PRIMARY KEY DEFAULT 'default',
	"mode" text NOT NULL DEFAULT 'ACTIVE',
	"public_message" text,
	"internal_reason" text,
	"locked_at" timestamp,
	"locked_by" text,
	"subscription_expires_at" timestamp,
	"grace_period_ends_at" timestamp,
	"stop_workers" boolean NOT NULL DEFAULT true,
	"revoke_sessions" boolean NOT NULL DEFAULT true,
	"system_lock_version" integer NOT NULL DEFAULT 0,
	"suspended_at" timestamp,
	"reactivated_at" timestamp,
	"suspension_reason" text,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "platform_lock_state" ("id", "mode")
VALUES ('default', 'ACTIVE')
ON CONFLICT ("id") DO NOTHING;
`;

/** Production's lineage: main 0000-0048, Production's 0049, then main 0049-0054 as Production's 0050-0055. */
function prodLineageEntries() {
  const base = mainEntries((e) => tagNo(e.tag) <= 48);
  const lockWhen = journal.entries.find((e) => tagNo(e.tag) === 49).when;
  const lock = {
    tag: "0049_platform_lock_state",
    when: lockWhen,
    sql: PROD_0049_PLATFORM_LOCK_STATE,
  };
  const shifted = journal.entries
    .filter((e) => tagNo(e.tag) >= 49 && tagNo(e.tag) <= 54)
    .map((e) => ({
      tag: String(tagNo(e.tag) + 1).padStart(4, "0") + e.tag.slice(4),
      when: e.when + 1000,
      sql: sqlOf(e.tag),
    }));
  return [...base, lock, ...shifted];
}

async function migrateFolder(url, folder) {
  const pool = new pg.Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

/** The REAL migrator entry point, exactly as `npm run db:migrate` runs it. */
function runRealMigrator(url) {
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "scripts/migrate.ts"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const out = redact(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  return { ok: r.status === 0 && out.includes("Migrations completed successfully"), out };
}

/** scripts/on-conflict-audit.ts: every ON CONFLICT target in the backend source has a unique index. */
function audit(url) {
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "scripts/on-conflict-audit.ts", url, "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  try {
    return { exit: r.status, ...JSON.parse((r.stdout ?? "").trim().split("\n").pop()) };
  } catch {
    return { exit: r.status, total: 0, missing: [{ table: "?", error: redact(r.stderr).slice(0, 200) }] };
  }
}

// ── database helpers ─────────────────────────────────────────────────────────
async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const ledger = (url) =>
  withClient(url, async (c) =>
    (await c.query(`select id, hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id`)).rows
  );

async function publicColumns(c) {
  const r = await c.query(`
    select t.tablename as t, array_agg(a.attname::text order by a.attnum) as cols
    from pg_tables t
    join pg_class k on k.relname = t.tablename and k.relnamespace = 'public'::regnamespace
    join pg_attribute a on a.attrelid = k.oid and a.attnum > 0 and not a.attisdropped
    where t.schemaname = 'public' group by t.tablename order by 1`);
  return Object.fromEntries(r.rows.map((x) => [x.t, x.cols]));
}

/** md5 per table over an explicit column list (so added columns never count as a change). */
async function fingerprint(c, colMap, where = {}) {
  const out = {};
  for (const [table, cols] of Object.entries(colMap)) {
    const list = cols.map((x) => `"${x}"`).join(",");
    const w = where[table] ? ` where ${where[table]}` : "";
    const r = await c.query(
      `select count(*)::int as n, md5(coalesce(string_agg(t, '|' order by t collate "C"), '')) as h
       from (select row(${list})::text as t from "public"."${table}"${w}) x`
    );
    out[table] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}

/** Catalog-level description of the schema, order-insensitive. */
async function catalog(c) {
  const q = (sql) => c.query(sql).then((r) => r.rows.map((x) => x.l));
  const kinds = {
    table: `select 'table|'||tablename as l from pg_tables where schemaname='public'`,
    column: `select 'column|'||c.relname||'.'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||
               case when a.attnotnull then 'NOT NULL' else 'NULL' end||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') as l
             from pg_attribute a join pg_class c on c.oid=a.attrelid
             left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
             where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped`,
    constraint: `select 'constraint|'||c.relname||'|'||k.conname||'|'||pg_get_constraintdef(k.oid)||'|'||
                   case when k.convalidated then 'VALID' else 'NOT VALID' end as l
                 from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace`,
    index: `select 'index|'||tablename||'|'||indexname||'|'||indexdef as l from pg_indexes where schemaname='public'`,
    sequence: `select 'sequence|'||sequencename||'|'||data_type||'|'||start_value||'|'||increment_by as l from pg_sequences where schemaname='public'`,
    function: `select 'function|'||p.proname||'|'||md5(pg_get_functiondef(p.oid)) as l from pg_proc p
               where p.pronamespace='public'::regnamespace and p.prokind='f'`,
    trigger: `select 'trigger|'||c.relname||'|'||t.tgname||'|'||pg_get_triggerdef(t.oid) as l from pg_trigger t
              join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relnamespace='public'::regnamespace`,
  };
  const out = new Set();
  for (const sql of Object.values(kinds)) for (const l of await q(sql)) out.add(l);
  return out;
}
const countKinds = (set) => {
  const m = {};
  for (const l of set) m[l.split("|")[0]] = (m[l.split("|")[0]] ?? 0) + 1;
  return m;
};
const diffSet = (a, b) =>
  new Set([...[...a].filter((l) => !b.has(l)).map((l) => `- ${l}`), ...[...b].filter((l) => !a.has(l)).map((l) => `+ ${l}`)]);

// ── synthetic business data ──────────────────────────────────────────────────
const dummy = (type, table, col, n, maxLen) => {
  if (/int|serial/.test(type)) return n;
  if (type === "boolean") return false;
  if (/timestamp|date/.test(type)) return new Date("2026-09-01T00:00:00Z");
  if (type === "numeric" || /double|real/.test(type)) return 0;
  if (/json/.test(type)) return "{}";
  if (type === "ARRAY") return "{}";
  const s = `${table}-${col}-${n}`;
  return maxLen ? s.slice(0, maxLen) : s;
};
async function seedRows(c, table, rows) {
  const cols = (
    await c.query(
      `select column_name, data_type, is_nullable, column_default, character_maximum_length
       from information_schema.columns where table_schema='public' and table_name=$1`,
      [table]
    )
  ).rows;
  let n = 0;
  for (const over of rows) {
    n += 1;
    const vals = {};
    for (const col of cols) {
      if (col.column_name in over) vals[col.column_name] = over[col.column_name];
      else if (col.is_nullable === "NO" && col.column_default === null)
        vals[col.column_name] = dummy(col.data_type, table, col.column_name, n, col.character_maximum_length);
    }
    const names = Object.keys(vals);
    await c.query(
      names.length
        ? `insert into "${table}" (${names.map((x) => `"${x}"`).join(",")}) values (${names.map((_, i) => `$${i + 1}`).join(",")})`
        : `insert into "${table}" default values`,
      names.map((x) => vals[x])
    );
  }
}
async function seedSynthetic(c) {
  await c.query("set session_replication_role = replica"); // seed rows only; no FK graph needed
  await seedRows(c, "users", [
    { id: "lin-u-active", is_active: true },
    { id: "lin-u-inactive", is_active: false },
  ]);
  await seedRows(c, "bearer_sessions", [{ user_id: "lin-u-active" }, { user_id: "lin-u-inactive" }]);
  await seedRows(c, "courier_requests", [{}, {}, {}]);
  await seedRows(c, "courier_executions", [{ custody_closure_status: "PENDING_DEDUCTION" }, { custody_closure_status: "CLOSED_SUCCESS" }]);
  await seedRows(c, "courier_request_items", [{}, {}]);
  await seedRows(c, "items", [{}, {}, {}]);
  await seedRows(c, "custody_movements", [{}, {}]);
  await seedRows(c, "inventory_deduction_completions", [{}]);
  await c.query("set session_replication_role = origin");
}

// ── main ─────────────────────────────────────────────────────────────────────
const adminUrl = resolveAdminUrl();
const stamp = Date.now();
const dbs = [];
async function createDb(tag) {
  const name = `lineage_${tag}_test_${stamp}`;
  await withClient(adminUrl, (c) => c.query(`create database ${name}`));
  dbs.push(name);
  return withDb(adminUrl, name);
}
const folders = [];
const mk = (entries) => {
  const f = buildFolder(entries);
  folders.push(f);
  return f;
};

console.log(`Lineage rehearsal — mode: ${MODE}`);
let exitCode = 1;
try {
  // 1. Production snapshot ────────────────────────────────────────────────────
  const prodUrl = await createDb("prod");
  if (MODE === "snapshot") {
    const r = spawnSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", prodUrl, dumpFile], { encoding: "utf8" });
    check("snapshot.restore", r.status === 0, r.status === 0 ? "pg_restore exit 0" : redact(r.stderr).slice(0, 300));
  } else {
    await migrateFolder(prodUrl, mk(prodLineageEntries()));
    // Production's schema predates main's chain and lacks two objects main creates early
    // (verified on the restored backup): mirror that so 0063 is exercised, not a no-op.
    await withClient(prodUrl, (c) => c.query(`drop index "tech_product_unique"; drop table "idempotency_keys"`));
    await withClient(prodUrl, seedSynthetic);
    check("snapshot.build", true, "Production lineage replayed + business rows seeded");
  }

  const pre = await withClient(prodUrl, async (c) => {
    const l = (await c.query(`select max(created_at)::text as m, count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0];
    const has = async (sql) => (await c.query(sql)).rows[0].v;
    return {
      highWater: Number(l.m),
      rows: l.n,
      regionId: await has(`select exists(select 1 from information_schema.columns where table_name='courier_requests' and column_name='region_id') as v`),
      assigned: await has(`select exists(select 1 from information_schema.columns where table_name='courier_requests' and column_name='assigned_to_user_id') as v`),
      units: await has(`select to_regclass('public.courier_execution_units') is not null as v`),
      perm: await has(`select to_regclass('public.employee_permission_overrides') is not null as v`),
      lock: await has(`select to_regclass('public.platform_lock_state') is not null as v`),
      cols: await publicColumns(c),
      catalog: await catalog(c),
    };
  });
  check("pre.high_water_is_production", pre.highWater === PROD_HIGH_WATER, `created_at ${pre.highWater}, ${pre.rows} ledger rows`);
  check("pre.0055-0060_absent", !pre.regionId && !pre.assigned && !pre.units && !pre.perm, "region_id / assigned_to_user_id / units / permission tables absent");
  check("pre.platform_lock_state_present", pre.lock, "exists (created outside the migration chain)");
  {
    // the audit must see the real gap before reconciliation (proves it is not vacuous)
    const aPre = audit(prodUrl);
    const preMissing = (aPre.missing ?? []).map((m) => `${m.table}(${(m.columns ?? []).join(",")})`);
    check("pre.onconflict_gap_detected", aPre.exit === 1 && preMissing.join(" ") === "technician_product_stock(technician_id,product_id)", `unbacked before: ${preMissing.join(" ") || "none"}`);
    check("pre.idempotency_keys_absent", !(await withClient(prodUrl, (c) => c.query(`select to_regclass('public.idempotency_keys') is not null as v`))).rows[0].v, "as in Production");
  }

  const biz = BUSINESS_TABLES.filter((t) => pre.cols[t]);
  const bizCols = Object.fromEntries(biz.map((t) => [t, pre.cols[t]]));
  const allBefore = await withClient(prodUrl, (c) => fingerprint(c, pre.cols));
  // bearer_sessions is the one table migration 0058 is *meant* to delete from (inactive users' sessions)
  const expectedBearer = await withClient(prodUrl, async (c) => {
    if (!pre.cols.bearer_sessions) return null;
    const r = await fingerprint(
      c,
      { bearer_sessions: pre.cols.bearer_sessions },
      { bearer_sessions: `not coalesce(user_id in (select id from users where is_active = false), false)` }
    );
    const gone = (await c.query(`select count(*)::int as n from bearer_sessions where coalesce(user_id in (select id from users where is_active = false), false)`)).rows[0].n;
    return { fp: r.bearer_sessions, deleted: gone };
  });
  const zeroPartialUrl = await createDb("z0054");
  await migrateFolder(zeroPartialUrl, mk(mainEntries((e) => tagNo(e.tag) <= 54)));
  const catZeroPartial = await withClient(zeroPartialUrl, catalog);

  // 2. Real migrator on the snapshot ──────────────────────────────────────────
  const ledgerBefore = await ledger(prodUrl);
  const run1 = runRealMigrator(prodUrl);
  check("run1.migrator_exit", run1.ok, run1.ok ? "Migrations completed successfully" : run1.out.slice(-400));
  if (!run1.ok) throw new Error("first migrator run failed");

  const ledgerAfter = await ledger(prodUrl);
  const added = ledgerAfter.slice(ledgerBefore.length);
  const applied = journal.entries.filter((e) => e.when > PROD_HIGH_WATER);
  const expectedTags = applied.map((e) => e.tag);
  const byHash = new Map(applied.map((e) => [sha256(sqlOf(e.tag)), e]));
  const addedTags = added.map((r) => byHash.get(r.hash)?.tag ?? `?${r.hash.slice(0, 8)}`);
  check("ledger.rows_added_in_order", JSON.stringify(addedTags) === JSON.stringify(expectedTags), `added: ${addedTags.map((t) => t.slice(0, 4)).join(", ")}`);
  check(
    "ledger.created_at_equals_journal_when",
    added.every((r, i) => Number(r.created_at) === applied[i].when),
    "every new row carries the journal timestamp (written by the migrator, not by hand)"
  );
  check("ledger.prior_rows_untouched", JSON.stringify(ledgerAfter.slice(0, ledgerBefore.length)) === JSON.stringify(ledgerBefore), `${ledgerBefore.length} existing rows identical`);
  const gap = journal.entries.find((e) => tagNo(e.tag) === 55);
  check("ledger.0055_skipped_by_high_water_and_covered", !ledgerAfter.some((r) => r.hash === sha256(sqlOf(gap.tag))), "0055 has no ledger row on a Production-shaped ledger; its objects come from the guarded reconcile migration");

  const post = await withClient(prodUrl, async (c) => {
    const v = async (sql) => (await c.query(sql)).rows;
    return {
      region: await v(`select data_type, is_nullable from information_schema.columns where table_name='courier_requests' and column_name='region_id'`),
      regionFk: await v(`select convalidated from pg_constraint where conname='courier_requests_region_id_regions_id_fk'`),
      regionIdx: await v(`select 1 from pg_indexes where indexname='courier_requests_region_id_idx'`),
      assigned: await v(`select 1 from information_schema.columns where table_name='courier_requests' and column_name='assigned_to_user_id'`),
      assignedFk: await v(`select convalidated from pg_constraint where conname='courier_requests_assigned_to_user_id_users_id_fk'`),
      auth: await v(`select table_name, is_nullable, column_default from information_schema.columns where column_name='auth_generation' and table_name in ('users','refresh_tokens') order by 1`),
      permTables: await v(`select tablename from pg_tables where tablename in ('employee_permission_overrides','permission_change_audit') order by 1`),
      units: await v(`select 1 from pg_tables where tablename='courier_execution_units'`),
      itemLinks: await v(`select column_name from information_schema.columns where table_name='courier_request_items' and column_name in ('execution_unit_id','item_id') order by 1`),
      lock: await v(`select 1 from pg_tables where tablename='platform_lock_state'`),
      techUnique: await v(`select 1 from pg_indexes where indexname='tech_product_unique' and indexdef like 'CREATE UNIQUE INDEX%(technician_id, product_id)'`),
      idemKeys: await v(`select 1 from pg_constraint where conname='idempotency_keys_pkey'`),
    };
  });
  const tagOk = (prefix) => added.some((r, i) => addedTags[i].startsWith(prefix));
  check("0055.reconciliation", tagOk("0061") && post.region.length === 1 && post.region[0].is_nullable === "YES" && post.regionIdx.length === 1 && post.regionFk.length === 1, "region_id column + index + FK present after the guarded reconcile migration");
  check("0056", tagOk("0056") && post.regionFk[0]?.convalidated === true, "region FK validated");
  check("0057", tagOk("0057") && post.assigned.length === 1 && post.assignedFk.length === 1, "assigned_to_user_id + FK");
  check("0058", tagOk("0058") && post.auth.length === 2 && post.auth.every((x) => x.is_nullable === "NO" && String(x.column_default) === "0"), "auth_generation on users + refresh_tokens (NOT NULL DEFAULT 0)");
  check("0059", tagOk("0059") && post.permTables.length === 2, "employee_permission_overrides + permission_change_audit");
  check("0060", tagOk("0060") && post.units.length === 1 && post.itemLinks.length === 2, "courier_execution_units + request-item links");
  check("platform_lock_state.baseline_noop_on_existing", tagOk("0062") && post.lock.length === 1, "baseline migration recorded; existing Production table left as is");
  check("0063.runtime_dependencies", tagOk("0063") && post.techUnique.length === 1 && post.idemKeys.length === 1, "tech_product_unique (technician_id, product_id) + idempotency_keys present");

  // 3. Data unchanged ─────────────────────────────────────────────────────────
  const allAfter = await withClient(prodUrl, (c) => fingerprint(c, pre.cols));
  const changed = Object.keys(allBefore).filter((t) => allBefore[t] !== allAfter[t]);
  const unexpected = changed.filter((t) => t !== "bearer_sessions");
  check("data.business_tables_identical", biz.every((t) => allBefore[t] === allAfter[t]), biz.map((t) => `${t}=${allAfter[t].split(":")[0]}`).join(" "));
  check("data.no_other_table_changed", unexpected.length === 0, unexpected.length ? `changed: ${unexpected.join(", ")}` : `${Object.keys(allBefore).length} tables compared on pre-existing columns`);
  if (expectedBearer) {
    check(
      "data.bearer_sessions_only_inactive_users_removed",
      allAfter.bearer_sessions === expectedBearer.fp && (changed.includes("bearer_sessions") ? expectedBearer.deleted > 0 : expectedBearer.deleted === 0),
      `migration 0058 intentionally revokes sessions of inactive users: ${expectedBearer.deleted} row(s)`
    );
  }

  // 4. Second run is a NO-OP ──────────────────────────────────────────────────
  const snap2 = await withClient(prodUrl, async (c) => {
    const cols = await publicColumns(c);
    return { fp: await fingerprint(c, cols), cat: await catalog(c) };
  });
  const run2 = runRealMigrator(prodUrl);
  check("run2.migrator_exit", run2.ok, run2.ok ? "Migrations completed successfully" : run2.out.slice(-300));
  const ledger2 = await ledger(prodUrl);
  const snap2b = await withClient(prodUrl, async (c) => {
    const cols = await publicColumns(c);
    return { fp: await fingerprint(c, cols), cat: await catalog(c) };
  });
  check("run2.ledger_unchanged", JSON.stringify(ledger2) === JSON.stringify(ledgerAfter), `${ledger2.length} rows, none added`);
  check("run2.schema_unchanged", diffSet(snap2.cat, snap2b.cat).size === 0, `${snap2.cat.size} catalog entries identical`);
  check("run2.data_unchanged", JSON.stringify(snap2.fp) === JSON.stringify(snap2b.fp), "all tables, all columns identical");
  check("run2.NO-OP", run2.ok && ledger2.length === ledgerAfter.length && diffSet(snap2.cat, snap2b.cat).size === 0 && JSON.stringify(snap2.fp) === JSON.stringify(snap2b.fp), "");

  // 5. main from zero ─────────────────────────────────────────────────────────
  const zeroUrl = await createDb("zero");
  const runZ = runRealMigrator(zeroUrl);
  check("zero.migrator_exit", runZ.ok, runZ.ok ? "Migrations completed successfully" : runZ.out.slice(-300));
  const zero = await withClient(zeroUrl, async (c) => ({
    rows: (await c.query(`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0].n,
    lock: (await c.query(`select to_regclass('public.platform_lock_state') is not null as v`)).rows[0].v,
    cat: await catalog(c),
  }));
  check("zero.ledger_matches_journal", zero.rows === journal.entries.length, `${zero.rows} rows / ${journal.entries.length} journal entries`);
  check("zero.platform_lock_state_exists", zero.lock, "created by the baseline migration");
  const lockShape = (cat) => [...cat].filter((l) => /^(column|constraint|index)\|(platform_lock_state\.|platform_lock_state\|)/.test(l)).sort();
  const lockEq = JSON.stringify(lockShape(snap2b.cat)) === JSON.stringify(lockShape(zero.cat)) && lockShape(zero.cat).length > 0;
  check("zero.platform_lock_state_shape_equals_reconciled", lockEq, `${lockShape(zero.cat).length} column/constraint/index entries identical`);
  const rtShape = (cat) =>
    [...cat].filter((l) => /^(column|constraint|index)\|idempotency_keys[.|]/.test(l) || /^index\|technician_product_stock\|tech_product_unique\|/.test(l)).sort();
  const rtEq = JSON.stringify(rtShape(snap2b.cat)) === JSON.stringify(rtShape(zero.cat)) && rtShape(zero.cat).length >= 8;
  check("zero.0063_objects_equal_reconciled", rtEq, `${rtShape(zero.cat).length} idempotency_keys / tech_product_unique entries identical`);

  // ON CONFLICT audit: every target used by the backend source has a unique index
  const aRec = audit(prodUrl);
  const aZero = audit(zeroUrl);
  const missingList = (a) => a.missing.map((m) => `${m.table}(${(m.columns ?? []).join(",")})`).join(" ") || "none";
  check("onconflict.reconciled", aRec.exit === 0 && aRec.total > 0, `${aRec.total} targets, unbacked: ${missingList(aRec)}`);
  check("onconflict.from_zero", aZero.exit === 0 && aZero.total > 0, `${aZero.total} targets, unbacked: ${missingList(aZero)}`);

  // 6. Drift / schema consistency ─────────────────────────────────────────────
  const dBefore = diffSet(pre.catalog, catZeroPartial); // legacy + lineage gap
  const dAfter = diffSet(snap2b.cat, zero.cat); // what is left after reconciliation
  const resolved = [...dBefore].filter((l) => !dAfter.has(l));
  const introduced = [...dAfter].filter((l) => !dBefore.has(l));
  console.log(`  info  schema kinds (reconciled): ${JSON.stringify(countKinds(snap2b.cat))}`);
  console.log(`  info  schema kinds (from zero) : ${JSON.stringify(countKinds(zero.cat))}`);
  console.log(`  info  differences before reconciliation (vs main@0054): ${dBefore.size}; resolved: ${resolved.length}; remaining: ${dAfter.size}; newly introduced: ${introduced.length}`);
  if (dAfter.size) for (const l of [...dAfter].slice(0, 25)) console.log(`        ${l.slice(0, 190)}`);
  check("schema.no_new_drift_introduced", introduced.length === 0, `${introduced.length} line(s) introduced by reconciliation`);
  if (MODE === "synthetic") check("schema.reconciled_equals_from_zero", dAfter.size === 0, `${dAfter.size} remaining difference(s)`);
  else check("schema.legacy_residual_reported", true, `${dAfter.size} pre-existing difference(s) unrelated to lineage (listed above)`);

  exitCode = checks.every((x) => x.ok) ? 0 : 1;
  if (reportFile) {
    writeFileSync(
      reportFile,
      JSON.stringify(
        { mode: MODE, checks, residual: [...dAfter], resolved, introduced, legacyBefore: [...dBefore], bearerDeleted: expectedBearer?.deleted ?? null },
        null,
        2
      )
    );
  }
} catch (e) {
  console.error("REHEARSAL ABORTED:", redact(e?.stack ?? e));
  check("rehearsal.completed", false, redact(e?.message ?? e).slice(0, 200));
} finally {
  for (const name of dbs) {
    try {
      await withClient(adminUrl, (c) => c.query(`drop database if exists ${name} with (force)`));
    } catch {}
  }
  for (const f of folders) rmSync(f, { recursive: true, force: true });
}
console.log(exitCode === 0 ? "LINEAGE REHEARSAL PASS" : "LINEAGE REHEARSAL FAIL");
process.exit(exitCode);
