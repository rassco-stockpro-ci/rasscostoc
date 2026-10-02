/**
 * OPS-REMED-E4-P2 — legacy classification and backfill script proof.
 *
 * OPS-REMED-E4-P4-I1.R1 §6.B: this suite's entire premise is inserting
 * legacy-shaped rows with a genuinely NULL custody_closure_status — the
 * exact pre-P2 shape the backfill script exists to classify. Since P4
 * (migrations 0052-0054) made that column NOT NULL on the shared
 * isolated-test database, this file now runs against its OWN disposable
 * database, migrated only through 0051 via
 * scripts/test-historical-migration-database.mjs — never the shared,
 * fully-migrated (through 0054) isolated-test database, and never
 * touching its container. All 12 certified tests, names, and assertions
 * are preserved unchanged; only the database wiring changed. Several
 * `courier_executions` inserts intentionally omit `custodyClosureStatus`
 * (that is the entire point of a legacy row) and are cast `as any` since
 * the shared Drizzle schema type is now `.notNull()` post-P4 — this
 * historical database's actual runtime column remains nullable, which is
 * exactly what's being proven.
 *
 * OPS-PERM-S0-B1-A.I1: every `courierRequests` insert now uses raw SQL
 * (via the same `pool` already used elsewhere in this file) instead of
 * the Drizzle ORM builder. Drizzle's node-postgres insert always lists
 * every column defined in the current shared schema in its generated
 * INSERT statement (using `default` for any column omitted from
 * `.values()`) — confirmed via `.toSQL()` — regardless of what
 * `.returning()` requests. Since migrations 0055-0056 added
 * `courier_requests.region_id` to the shared schema, but this suite's
 * own historical database is cut off at 0051 (before that column
 * exists), Drizzle's generated statement would always reference
 * `region_id` and fail with "column region_id does not exist" no matter
 * what `.returning()` selects. Raw SQL sidesteps schema-driven column
 * generation entirely. Only `.id` was ever consumed downstream.
 *
 * OPS-REMED-E4-P3-I.R3: one test (12) additionally launches the script as
 * a real, separate Node subprocess — the actual `main()`/direct-invocation
 * CLI path — to prove it is genuinely operable outside Vitest's own
 * transform pipeline (which previously masked a `pg` ESM/CJS interop
 * defect that broke every real CLI launch). All other tests continue to
 * exercise the exported functions directly.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { itemTypes, items, courierRequests, courierRequestItems, courierExecutions, idempotencyRecords } from "@shared/schema";
import { createHistoricalMigrationDatabase } from "../../../../../../scripts/test-historical-migration-database.mjs";
import {
  classifyOneRow,
  runSweep,
  applyGuardedClassification,
  runBackfillCli,
  type ClassificationCounts,
} from "../../../../../../scripts/backfill-custody-closure-status";

const { Pool } = pg;

const BACKFILL_SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../scripts/backfill-custody-closure-status.ts"
);

describe("OPS-REMED-E4-P2 — legacy classification and backfill", () => {
  let pool: InstanceType<typeof Pool>;
  let db: ReturnType<typeof drizzle>;
  let historicalDatabaseUrl: string;
  let cleanupHistoricalDatabase: () => void;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database " +
          "(must contain 'test' in the database name). See scripts/test-database.mjs."
      );
    }
    const historical = await createHistoricalMigrationDatabase("0051");
    historicalDatabaseUrl = historical.databaseUrl;
    cleanupHistoricalDatabase = historical.cleanup;
    pool = new Pool({ connectionString: historicalDatabaseUrl });
    db = drizzle({ client: pool, schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    cleanupHistoricalDatabase?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function freshCounts(): ClassificationCounts {
    return {
      success: 0,
      failedFinal: 0,
      reconciliationRequired: 0,
      skippedActiveProcessing: 0,
      concurrentAnomalousSkip: 0,
    };
  }

  // OPS-PERM-S0-B1-C.I2A.I0.C1.E3: this database is intentionally migrated
  // only through 0051, and this insert must reflect exactly the users
  // table shape that actually existed at that cutoff — never the current
  // shared Drizzle `users` schema, which now includes columns (e.g.
  // migration 0058's authGeneration) added long after 0051. Using
  // `db.insert(users)` here would have Drizzle generate an INSERT
  // referencing every column in the *current* schema (confirmed via
  // `.toSQL()`, same reasoning already documented above for
  // `courierRequests`), which does not exist on this historical database.
  // Raw parameterized SQL naming only the columns proven (by directly
  // introspecting a disposable 0051-cutoff database's
  // information_schema.columns) to exist at that cutoff sidesteps this
  // entirely, with no risk of interpolating unparameterized values.
  async function insertLegacyUser(fields: {
    id: string;
    username: string;
    email: string;
    fullName: string;
    role: string;
  }) {
    await pool.query(
      `INSERT INTO users (id, username, email, password, full_name, role) VALUES ($1, $2, $3, $4, $5, $6)`,
      [fields.id, fields.username, fields.email, "x", fields.fullName, fields.role]
    );
  }

  async function seedRequestWithItem(deliveredStatus: string) {
    const actorId = randomUUID();
    await insertLegacyUser({
      id: actorId,
      username: `e4p2-legacy-${actorId.slice(0, 8)}`,
      email: `e4p2-legacy-${actorId.slice(0, 8)}@test.local`,
      fullName: "E4 P2 Legacy",
      role: "admin",
    });
    const { rows: [request] } = await pool.query<{ id: number }>(
      "INSERT INTO courier_requests (customer_name, incident_number) VALUES ($1, $2) RETURNING id",
      ["E4 P2 Legacy", `E4-P2-LEG-${randomUUID().slice(0, 8)}`]
      );

    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({ id: itemTypeId, nameAr: `نوع-${itemTypeId.slice(0, 8)}`, nameEn: `Type-${itemTypeId.slice(0, 8)}`, category: "device" });
    const serial = ("E4P2LEG" + randomUUID().slice(0, 10)).toUpperCase().replace(/[^A-Z0-9]/g, "");
    await db.insert(items).values({
      id: randomUUID(),
      itemTypeId,
      serialNumber: serial,
      barcode: `${serial}-BAR`,
      status: deliveredStatus,
      currentOwnerId: actorId,
    });
    // Raw SQL with explicit columns: this historical database predates
    // columns the current Drizzle schema would list (e.g. migration 0060).
    await pool.query(
      "INSERT INTO courier_request_items (request_id, item_type, serial_number, status) VALUES ($1, 'POS', $2, 'RECEIVED')",
      [request.id, serial]
    );
    // Legacy pre-P2 shape: no custodyClosureStatus at all — genuinely NULL
    // on this pre-P4 historical database. Cast `as any` because the
    // shared Drizzle schema type is now `.notNull()` post-P4; this
    // database's actual column remains nullable (only through 0051).
    await db.insert(courierExecutions).values({ requestId: request.id, enteredBy: actorId } as any);
    return request.id;
  }

  it("1. all resolvable items DELIVERED -> CLOSED_SUCCESS", async () => {
    const requestId = await seedRequestWithItem("DELIVERED");
    const { status } = await classifyOneRow(pool, requestId);
    expect(status).toBe("CLOSED_SUCCESS");
  });

  it("2. resolvable item NOT delivered, no failure evidence -> RECONCILIATION_REQUIRED", async () => {
    const requestId = await seedRequestWithItem("RECEIVED_BY_TECHNICIAN");
    const { status } = await classifyOneRow(pool, requestId);
    expect(status).toBe("RECONCILIATION_REQUIRED");
  });

  it("3. no item linkage at all, zero evidence -> RECONCILIATION_REQUIRED", async () => {
    const actorId = randomUUID();
    await insertLegacyUser({
      id: actorId,
      username: `e4p2-legacy-none-${actorId.slice(0, 8)}`,
      email: `e4p2-legacy-none-${actorId.slice(0, 8)}@test.local`,
      fullName: "E4 P2 Legacy None",
      role: "admin",
    });
    const { rows: [request] } = await pool.query<{ id: number }>(
      "INSERT INTO courier_requests (customer_name, incident_number) VALUES ($1, $2) RETURNING id",
      ["E4 P2 Legacy None", `E4-P2-LEGN-${randomUUID().slice(0, 8)}`]
      );
    const { status } = await classifyOneRow(pool, request.id);
    expect(status).toBe("RECONCILIATION_REQUIRED");
  });

  it("4. no item linkage, idempotency FAILED -> FAILED_FINAL", async () => {
    const actorId = randomUUID();
    await insertLegacyUser({
      id: actorId,
      username: `e4p2-legacy-ff-${actorId.slice(0, 8)}`,
      email: `e4p2-legacy-ff-${actorId.slice(0, 8)}@test.local`,
      fullName: "E4 P2 Legacy FF",
      role: "admin",
    });
    const { rows: [request] } = await pool.query<{ id: number }>(
      "INSERT INTO courier_requests (customer_name, incident_number) VALUES ($1, $2) RETURNING id",
      ["E4 P2 Legacy FF", `E4-P2-LEGFF-${randomUUID().slice(0, 8)}`]
      );
    await db.insert(idempotencyRecords).values({
      idempotencyKey: `ExecutionCompletedEvent:REQ-${request.id}:InventorySubscriber:v1`,
      eventId: randomUUID(),
      subscriberName: "InventorySubscriber",
      status: "FAILED",
    });
    const { status } = await classifyOneRow(pool, request.id);
    expect(status).toBe("FAILED_FINAL");
  });

  it("5. idempotency PROCESSING, fresh (< 155s) -> null (skip this pass)", async () => {
    const actorId = randomUUID();
    await insertLegacyUser({
      id: actorId,
      username: `e4p2-legacy-fresh-${actorId.slice(0, 8)}`,
      email: `e4p2-legacy-fresh-${actorId.slice(0, 8)}@test.local`,
      fullName: "E4 P2 Legacy Fresh",
      role: "admin",
    });
    const { rows: [request] } = await pool.query<{ id: number }>(
      "INSERT INTO courier_requests (customer_name, incident_number) VALUES ($1, $2) RETURNING id",
      ["E4 P2 Legacy Fresh", `E4-P2-LEGFR-${randomUUID().slice(0, 8)}`]
      );
    await db.insert(idempotencyRecords).values({
      idempotencyKey: `ExecutionCompletedEvent:REQ-${request.id}:InventorySubscriber:v1`,
      eventId: randomUUID(),
      subscriberName: "InventorySubscriber",
      status: "PROCESSING",
      createdAt: new Date(),
    });
    const { status } = await classifyOneRow(pool, request.id);
    expect(status).toBeNull();
  });

  it("6. idempotency PROCESSING, stale (> 155s) -> RECONCILIATION_REQUIRED", async () => {
    const actorId = randomUUID();
    await insertLegacyUser({
      id: actorId,
      username: `e4p2-legacy-stale-${actorId.slice(0, 8)}`,
      email: `e4p2-legacy-stale-${actorId.slice(0, 8)}@test.local`,
      fullName: "E4 P2 Legacy Stale",
      role: "admin",
    });
    const { rows: [request] } = await pool.query<{ id: number }>(
      "INSERT INTO courier_requests (customer_name, incident_number) VALUES ($1, $2) RETURNING id",
      ["E4 P2 Legacy Stale", `E4-P2-LEGST-${randomUUID().slice(0, 8)}`]
      );
    await db.insert(idempotencyRecords).values({
      idempotencyKey: `ExecutionCompletedEvent:REQ-${request.id}:InventorySubscriber:v1`,
      eventId: randomUUID(),
      subscriberName: "InventorySubscriber",
      status: "PROCESSING",
      createdAt: new Date(Date.now() - 200_000),
    });
    const { status } = await classifyOneRow(pool, request.id);
    expect(status).toBe("RECONCILIATION_REQUIRED");
  });

  it("7. missing item linkage for a resolvable-shaped row -> RECONCILIATION_REQUIRED", async () => {
    const actorId = randomUUID();
    await insertLegacyUser({
      id: actorId,
      username: `e4p2-legacy-miss-${actorId.slice(0, 8)}`,
      email: `e4p2-legacy-miss-${actorId.slice(0, 8)}@test.local`,
      fullName: "E4 P2 Legacy Missing",
      role: "admin",
    });
    const { rows: [request] } = await pool.query<{ id: number }>(
      "INSERT INTO courier_requests (customer_name, incident_number) VALUES ($1, $2) RETURNING id",
      ["E4 P2 Legacy Missing", `E4-P2-LEGMS-${randomUUID().slice(0, 8)}`]
      );
    await pool.query(
      "INSERT INTO courier_request_items (request_id, item_type, serial_number, status) VALUES ($1, 'POS', $2, 'RECEIVED')",
      [request.id, "NONEXISTENT-SERIAL-" + randomUUID().slice(0, 8)]
    );
    const { status } = await classifyOneRow(pool, request.id);
    expect(status).toBe("RECONCILIATION_REQUIRED");
  });

  it("8. runSweep is idempotent — a second run on already-classified rows changes nothing further", async () => {
    const requestId = await seedRequestWithItem("DELIVERED");
    const counts1 = freshCounts();
    await runSweep(pool, false, counts1);
    const [after1] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(after1!.custodyClosureStatus).toBe("CLOSED_SUCCESS");

    const counts2 = freshCounts();
    const secondPassCount = await runSweep(pool, false, counts2);
    // The already-classified row no longer matches `IS NULL`, so it is not
    // reprocessed — proves safe re-run behavior (interruption/resume).
    const [after2] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(after2!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
    void secondPassCount;
  });

  it("9. dry-run mode classifies but does not write", async () => {
    const requestId = await seedRequestWithItem("DELIVERED");
    const counts = freshCounts();
    await runSweep(pool, true, counts);
    expect(counts.success).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(row!.custodyClosureStatus).toBeNull(); // untouched — dry run
  });

  // OPS-REMED-E4-P3-I.R1: guarded-update race regression. Exercises the
  // real UPDATE ... WHERE ... AND custody_closure_status IS NULL path
  // directly (via applyGuardedClassification, the extracted helper
  // runSweep itself calls) — no mock, no sleep. Ordering is deterministic
  // because the test itself performs the "concurrent" write before
  // invoking the guarded write, rather than racing a background process.
  it("10. a row claimed by a concurrent (legitimate) writer between classification and the guarded update is never overwritten, and is counted as concurrentAnomalousSkip, not success", async () => {
    const requestId = await seedRequestWithItem("DELIVERED");
    const [execRow] = await db
      .select()
      .from(courierExecutions)
      .where(eq(courierExecutions.requestId, requestId));
    expect(execRow!.custodyClosureStatus).toBeNull();

    // Simulate a concurrent, legitimate P2 writer claiming this exact row
    // (e.g. InventorySubscriber's PENDING_DEDUCTION|FAILED_RETRYABLE ->
    // PROCESSING transition) *before* the backfill's own guarded UPDATE
    // executes for it — deterministic ordering, not a timing race.
    await db
      .update(courierExecutions)
      .set({ custodyClosureStatus: "PROCESSING" })
      .where(eq(courierExecutions.requestId, requestId));

    const counts = freshCounts();
    const written = await applyGuardedClassification(
      pool,
      { id: execRow!.id, request_id: requestId },
      "CLOSED_SUCCESS",
      /* dryRun */ false,
      counts
    );

    // The guarded UPDATE must affect zero rows (IS NULL guard no longer
    // matches), must not overwrite the concurrent writer's real value,
    // and must be reported as its own anomaly bucket — never silently
    // folded into a successful classification count.
    expect(written).toBe(false);
    expect(counts.concurrentAnomalousSkip).toBe(1);
    expect(counts.success).toBe(0);
    expect(counts.failedFinal).toBe(0);
    expect(counts.reconciliationRequired).toBe(0);

    const [afterRow] = await db
      .select()
      .from(courierExecutions)
      .where(eq(courierExecutions.requestId, requestId));
    expect(afterRow!.custodyClosureStatus).toBe("PROCESSING"); // unchanged — not overwritten
  });

  // OPS-REMED-E4-P3-R0/I.R2: real outer-orchestration regression. Exercises
  // runBackfillCli() — the exact function main() calls — proving the real
  // default-CLI dry-run control flow end-to-end, not merely one isolated
  // runSweep() call. Two distinguishable candidates (one DELIVERED, one
  // zero-evidence) prove per-category accounting, not just total counts.
  it("11. default CLI dry-run performs exactly one sweep, classifies every candidate exactly once, writes nothing, and exits 0", async () => {
    const deliveredRequestId = await seedRequestWithItem("DELIVERED");

    const actorId = randomUUID();
    await insertLegacyUser({
      id: actorId,
      username: `e4p3-cli-${actorId.slice(0, 8)}`,
      email: `e4p3-cli-${actorId.slice(0, 8)}@test.local`,
      fullName: "E4 P3 CLI Zero-Evidence",
      role: "admin",
    });
    const { rows: [zeroEvidenceRequest] } = await pool.query<{ id: number }>(
      "INSERT INTO courier_requests (customer_name, incident_number) VALUES ($1, $2) RETURNING id",
      ["E4 P3 CLI Zero-Evidence", `E4-P3-CLI-${randomUUID().slice(0, 8)}`]
      );
    await db.insert(courierExecutions).values({ requestId: zeroEvidenceRequest.id, enteredBy: actorId } as any);

    // This test file does not isolate the whole `courier_executions` table
    // between tests (test #9's own dry-run row is expected, by design, to
    // remain NULL forever — that is exactly what dry-run must do). So the
    // total NULL candidate pool at this point may legitimately contain
    // rows left behind by earlier tests in this file, not just the two
    // seeded above. The accounting equation below (total classified across
    // every bucket == total candidates seen) is therefore the rigorous,
    // pollution-independent proof that each candidate — whichever test
    // left it — was classified exactly once, not multiplied by a phantom
    // repeated sweep.
    const [{ c: candidateTotalBefore }] = (await pool.query(
      `SELECT count(*)::int AS c FROM courier_executions WHERE custody_closure_status IS NULL`
    )).rows;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runBackfillCli(/* dryRun */ true, historicalDatabaseUrl);

    // Exactly one sweep — the defect this gate corrects allowed dry-run to
    // silently repeat up to MAX_STABILIZATION_SWEEPS (5) times.
    expect(result.dryRun).toBe(true);
    expect(result.sweeps).toBe(1);
    expect(result.exitCode).toBe(0);

    // Accounting equation: every candidate present before the run is
    // classified into exactly one bucket, exactly once — never multiplied.
    const totalClassified =
      result.counts.success +
      result.counts.reconciliationRequired +
      result.counts.failedFinal +
      result.counts.concurrentAnomalousSkip +
      result.counts.skippedActiveProcessing;
    expect(totalClassified).toBe(candidateTotalBefore);

    // At minimum, this test's own two distinguishable candidates are
    // represented — one per category.
    expect(result.counts.success).toBeGreaterThanOrEqual(1);
    expect(result.counts.reconciliationRequired).toBeGreaterThanOrEqual(1);
    expect(result.counts.concurrentAnomalousSkip).toBe(0);

    // 0 rows written — both candidates remain NULL, unchanged.
    const [deliveredRow] = await db
      .select()
      .from(courierExecutions)
      .where(eq(courierExecutions.requestId, deliveredRequestId));
    expect(deliveredRow!.custodyClosureStatus).toBeNull();
    const [zeroEvidenceRow] = await db
      .select()
      .from(courierExecutions)
      .where(eq(courierExecutions.requestId, zeroEvidenceRequest.id));
    expect(zeroEvidenceRow!.custodyClosureStatus).toBeNull();

    const allLogText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(allLogText).toMatch(/Dry-run complete/);
    expect(allLogText).not.toMatch(/FAILED/);
    expect(allLogText).not.toMatch(/Sweep 2\/5/);

    // Each candidate's per-row classification line appears exactly once —
    // not duplicated across a phantom repeated sweep.
    const deliveredLogLines = allLogText
      .split("\n")
      .filter((line) => line.includes(`execution ${deliveredRow!.id} `));
    expect(deliveredLogLines).toHaveLength(1);
    const zeroEvidenceLogLines = allLogText
      .split("\n")
      .filter((line) => line.includes(`execution ${zeroEvidenceRow!.id} `));
    expect(zeroEvidenceLogLines).toHaveLength(1);
  });

  // OPS-REMED-E4-P3-I.R3: real operational-CLI proof. Launches the script
  // as a genuinely separate Node process (no shell, no npx package
  // resolution/download — the process executable and the real script path
  // are passed directly as argv, and Vitest's own module transform never
  // touches this child at all) — the only way to prove the script's
  // actual direct-invocation guard, main(), and runBackfillCli() are
  // reachable and correct outside the test harness. This is what
  // previously caught a genuine `pg` ESM/CJS interop defect that every
  // function-level test (including #11) was structurally blind to.
  it("12. real CLI subprocess: default dry-run launches successfully as a separate Node process, performs exactly one sweep, and writes nothing", async () => {
    const successRequestId = await seedRequestWithItem("DELIVERED");

    const actorId = randomUUID();
    await insertLegacyUser({
      id: actorId,
      username: `e4p3-subproc-${actorId.slice(0, 8)}`,
      email: `e4p3-subproc-${actorId.slice(0, 8)}@test.local`,
      fullName: "E4 P3 Subprocess Zero-Evidence",
      role: "admin",
    });
    const { rows: [reconciliationRequest] } = await pool.query<{ id: number }>(
      "INSERT INTO courier_requests (customer_name, incident_number) VALUES ($1, $2) RETURNING id",
      ["E4 P3 Subprocess Zero-Evidence", `E4-P3-SUB-${randomUUID().slice(0, 8)}`]
      );
    await db.insert(courierExecutions).values({ requestId: reconciliationRequest.id, enteredBy: actorId } as any);

    const [{ c: candidateTotalBefore }] = (await pool.query(
      `SELECT count(*)::int AS c FROM courier_executions WHERE custody_closure_status IS NULL`
    )).rows;

    // Baseline connection count from this test file's OWN shared pool
    // (which may legitimately hold more than one idle connection from
    // earlier tests) — the post-run assertion below compares against this
    // baseline (delta === 0), not an absolute 0, since an absolute count
    // cannot distinguish this pool's own connections from a real leak.
    const [{ c: connectionsBefore }] = (await pool.query(
      "SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"
    )).rows;

    // process.execPath is the real Node binary running this test process —
    // no shell, no PATH lookup, no npx package resolution/download.
    // "--import tsx" mirrors the documented direct-invocation form; the
    // real script path is passed literally, not re-resolved by a shell.
    // DATABASE_URL points at this suite's OWN pre-P4 historical database,
    // never the shared isolated-test database.
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", BACKFILL_SCRIPT_PATH],
      {
        env: {
          ...process.env,
          DATABASE_URL: historicalDatabaseUrl,
          NODE_ENV: "test",
        },
        encoding: "utf-8",
        shell: false,
        // Measured real launches (module load + connect + classify 1-2
        // synthetic rows) complete in well under 5s; 30s gives ample
        // margin for CI cold-start without masking a genuine hang.
        timeout: 30_000,
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/Sweep 1\/5/);
    expect(output).not.toMatch(/Sweep 2\/5/);
    expect(output).toMatch(/Dry-run complete/);
    expect(output).not.toMatch(/FAILED/);

    // Accounting equation — pollution-independent, same rigor as test #11.
    const countsMatch = output.match(/\[backfill\] Classification counts: ({[\s\S]*?})\n\[backfill\] Remaining/);
    expect(countsMatch).not.toBeNull();
    const loggedCounts = JSON.parse(
      countsMatch![1]
        .replace(/(\w+):/g, '"$1":')
        .replace(/'/g, '"')
    ) as { success: number; failedFinal: number; reconciliationRequired: number; skippedActiveProcessing: number; concurrentAnomalousSkip: number };
    const totalClassified =
      loggedCounts.success +
      loggedCounts.reconciliationRequired +
      loggedCounts.failedFinal +
      loggedCounts.concurrentAnomalousSkip +
      loggedCounts.skippedActiveProcessing;
    expect(totalClassified).toBe(candidateTotalBefore);
    expect(loggedCounts.success).toBeGreaterThanOrEqual(1);
    expect(loggedCounts.reconciliationRequired).toBeGreaterThanOrEqual(1);

    // Each seeded candidate's own row appears exactly once in the real
    // subprocess's stdout.
    const [successRow] = await db
      .select()
      .from(courierExecutions)
      .where(eq(courierExecutions.requestId, successRequestId));
    const successLines = output.split("\n").filter((line) => line.includes(`execution ${successRow!.id} `));
    expect(successLines).toHaveLength(1);
    const [reconciliationRow] = await db
      .select()
      .from(courierExecutions)
      .where(eq(courierExecutions.requestId, reconciliationRequest.id));
    const reconciliationLines = output
      .split("\n")
      .filter((line) => line.includes(`execution ${reconciliationRow!.id} `));
    expect(reconciliationLines).toHaveLength(1);

    // 0 rows written by the real subprocess.
    expect(successRow!.custodyClosureStatus).toBeNull();
    expect(reconciliationRow!.custodyClosureStatus).toBeNull();

    // The subprocess released its advisory lock and closed its pool on
    // exit — this test's own dedicated session must still acquire the
    // same lock immediately (0 wait), proving nothing was left held.
    //
    // OPS-REMED-E4-P3-I.R4: session-scoped advisory locks belong to the
    // exact Postgres backend connection that acquired them — a plain
    // `pool.query()` call has no guaranteed session affinity with any
    // other `pool.query()` call (node-postgres independently checks out
    // whatever client is available per call), so acquiring on one call
    // and unlocking on another cannot be trusted to touch the same
    // session. A single dedicated client (`pool.connect()`), held for
    // both statements and always released in `finally` (with a defensive
    // `pg_advisory_unlock_all()` on that same client covering the case
    // where the explicit unlock itself failed or an assertion above it
    // threw), guarantees acquire/unlock/cleanup all happen on one
    // identical session, and that no lock this client took survives even
    // a failed assertion.
    const lockClient = await pool.connect();
    try {
      const lockRes = await lockClient.query("SELECT pg_try_advisory_lock(872234501) AS acquired");
      expect(lockRes.rows[0].acquired).toBe(true);

      const unlockRes = await lockClient.query("SELECT pg_advisory_unlock(872234501) AS unlocked");
      expect(unlockRes.rows[0].unlocked).toBe(true);
    } finally {
      try {
        await lockClient.query("SELECT pg_advisory_unlock_all()");
      } finally {
        lockClient.release();
      }
    }

    // Independent proof, via the test's normal shared pool (a separate
    // session from lockClient above, which has already been released),
    // that no session anywhere holds this advisory key.
    const remainingLockRes = await pool.query(
      "SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND objid = 872234501"
    );
    expect(remainingLockRes.rows[0].c).toBe(0);

    // No lingering connection left behind by the child process specifically
    // — compared against this test's own pre-spawn baseline, since the
    // shared test pool may legitimately hold its own idle connections.
    const activeRes = await pool.query(
      "SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"
    );
    expect(activeRes.rows[0].c).toBe(connectionsBefore);
  }, 45_000);
});
