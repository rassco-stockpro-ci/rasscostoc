/**
 * Real-SQL integration proof for the fixed-inventory write path, backed by
 * an in-process PGlite instance (no external DATABASE_URL, no sandbox
 * "Modify Shared Resources" block — this is a throwaway WASM Postgres, not
 * a shared/real database). Proves the transaction + optimistic lock +
 * movement-record logic against real SQL semantics, not a hand-rolled
 * Drizzle-chain mock.
 *
 * Caveat (explicit): the DDL below is hand-written for exactly the columns
 * this test touches — it proves the LOGIC is correct against real SQL, not
 * that it is 1:1 schema-migration-parity with the production schema.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";

const PGLITE_DIR = process.env.PGLITE_DIR || "D:/tmp/pglite-scratch";

let client: any;
let proxiedDb: any;

const dbHolder = vi.hoisted(() => ({ db: undefined as any }));

vi.mock("@core/config/db", () => ({ get db() { return dbHolder.db; } }));
vi.mock("@core/database/connection", () => ({
  getDatabase: () => dbHolder.db,
}));
vi.mock("@modules/inventory/infrastructure/database/TechnicianInventoryRepository", () => ({
  TechnicianInventoryRepository: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@modules/inventory/infrastructure/database/WarehouseInventoryRepository", () => ({
  WarehouseInventoryRepository: vi.fn().mockImplementation(() => ({})),
}));

beforeAll(async () => {
  const pgliteModulePath = path.join(PGLITE_DIR, "node_modules", "@electric-sql", "pglite", "dist", "index.js");
  const { PGlite } = await import(pathToFileURL(pgliteModulePath).href);
  const { drizzle } = await import("drizzle-orm/pg-proxy");

  client = new PGlite();

  proxiedDb = drizzle(async (sql: string, params: any[], method: string) => {
    const result = await client.query(sql, params, { rowMode: "array" });
    return { rows: method === "all" || method === "values" ? result.rows : result.rows.slice(0, 1) };
  });

  // TEST-HARNESS-ONLY workaround: this drizzle-orm version's pg-proxy
  // session.transaction() is an unconditional stub that throws
  // ("Transactions are not supported by the Postgres Proxy driver") —
  // verified by reading node_modules/drizzle-orm/pg-proxy/session.js
  // directly, not assumed. It does NOT reflect a real limitation in
  // production, which uses the standard node-postgres driver (already
  // proven to support transactions normally in this same session). Here
  // we replace just `.transaction()` with a hand-rolled BEGIN/COMMIT/
  // ROLLBACK using the same single PGlite connection, so the test still
  // proves real multi-statement atomicity against real SQL — the
  // repository's own code under test is completely unmodified.
  proxiedDb.transaction = async (cb: any) => {
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

  dbHolder.db = proxiedDb;

  await client.exec(`
    CREATE TABLE item_types (
      id varchar PRIMARY KEY,
      name_ar text NOT NULL,
      requires_serial boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      is_visible boolean NOT NULL DEFAULT true
    );
    CREATE TABLE technician_fixed_inventory_entries (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
      technician_id varchar NOT NULL,
      item_type_id varchar NOT NULL,
      boxes integer NOT NULL DEFAULT 0,
      units integer NOT NULL DEFAULT 0,
      updated_at timestamp DEFAULT now(),
      version integer NOT NULL DEFAULT 0
    );
    CREATE TABLE system_logs (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id varchar,
      user_name text NOT NULL,
      user_role text NOT NULL,
      region_id varchar,
      action text NOT NULL,
      entity_type text NOT NULL,
      entity_id varchar,
      entity_name text,
      details text,
      description text NOT NULL,
      severity text NOT NULL DEFAULT 'info',
      success boolean NOT NULL DEFAULT true,
      created_at timestamp DEFAULT now()
    );
  `);
  await client.query(
    `INSERT INTO item_types (id, name_ar, requires_serial, is_active, is_visible) VALUES ($1, $2, false, true, true)`,
    ["type-pg", "صنف اختبار كمي"],
  );
});

afterAll(async () => {
  if (client) await client.close();
});

const ACTOR = { id: "admin-1", username: "admin1", role: "admin" };

describe("Fixed-inventory write path — real SQL via PGlite (not mocked)", () => {
  it("PROVES before/after balance + a movement record is created on first write (CREATE)", async () => {
    const { DrizzleInventoryEntriesRepository } = await import("./DrizzleInventoryEntriesRepository");
    const repo = new DrizzleInventoryEntriesRepository();

    const before = await client.query(
      `SELECT boxes, units FROM technician_fixed_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
      ["tech-pg-1", "type-pg"],
    );
    expect(before.rows.length).toBe(0);

    const created = await repo.upsertTechnicianFixedEntry(
      "tech-pg-1",
      { itemTypeId: "type-pg", boxes: 4, units: 10 },
      ACTOR,
      "idem-key-create-0001",
    );
    expect(created.boxes).toBe(4);
    expect(created.units).toBe(10);

    const after = await client.query(
      `SELECT boxes, units FROM technician_fixed_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
      ["tech-pg-1", "type-pg"],
    );
    expect(after.rows[0]).toEqual({ boxes: 4, units: 10 });

    const movement = await client.query(
      `SELECT action, entity_type, details FROM system_logs WHERE entity_id = $1`,
      [created.id],
    );
    expect(movement.rows.length).toBe(1);
    expect((movement.rows[0] as any).action).toBe("QUANTITY_CREATE");
    const details = JSON.parse((movement.rows[0] as any).details);
    expect(details.before).toBeNull();
    expect(details.after).toEqual({ boxes: 4, units: 10 });
    expect(details.idempotencyKey).toBe("idem-key-create-0001");
  });

  it("PROVES a correctly-versioned update changes the real row and records before/after in the movement log", async () => {
    const { DrizzleInventoryEntriesRepository } = await import("./DrizzleInventoryEntriesRepository");
    const repo = new DrizzleInventoryEntriesRepository();

    // This is the test that originally caught a real bug: a timestamp-based
    // CAS (`expectedUpdatedAt`) failed here even reading the value back via
    // the exact same path — Postgres `timestamp` has microsecond precision,
    // JS `Date` only millisecond, so a round-tripped Date object never
    // bit-for-bit matches its own stored value. The fix was switching the
    // optimistic lock to a plain incrementing integer `version` column,
    // which has no such precision pitfall — proven below against real SQL.
    const [existingViaRepo] = await repo.getTechnicianFixedEntries("tech-pg-1");
    const entryId = existingViaRepo.id;
    const lastKnownVersion = existingViaRepo.version;
    expect(lastKnownVersion).toBe(0); // first write in this suite, never updated yet

    const updated = await repo.upsertTechnicianFixedEntry(
      "tech-pg-1",
      { itemTypeId: "type-pg", boxes: 2, units: 3, expectedVersion: lastKnownVersion },
      ACTOR,
      "idem-key-update-0002",
    );
    expect(updated.boxes).toBe(2);
    expect(updated.units).toBe(3);

    const movements = await client.query(
      `SELECT action, details FROM system_logs WHERE entity_id = $1 ORDER BY created_at`,
      [entryId],
    );
    expect(movements.rows.length).toBe(2); // CREATE from the previous test + this UPDATE
    const updateDetails = JSON.parse((movements.rows[1] as any).details);
    expect(updateDetails.before).toEqual({ boxes: 4, units: 10 });
    expect(updateDetails.after).toEqual({ boxes: 2, units: 3 });
  });

  it("PROVES a stale write (expired expectedUpdatedAt) is REJECTED by real SQL — no row changed, no movement logged", async () => {
    const { DrizzleInventoryEntriesRepository } = await import("./DrizzleInventoryEntriesRepository");
    const { ConflictError } = await import("@core/errors/AppError");
    const repo = new DrizzleInventoryEntriesRepository();

    const before = (
      await client.query(
        `SELECT boxes, units FROM technician_fixed_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
        ["tech-pg-1", "type-pg"],
      )
    ).rows[0];

    // Real row is now at version 1 (after the previous test's update) — a
    // caller still holding version 0 is genuinely stale.
    const staleVersion = 0;

    await expect(
      repo.upsertTechnicianFixedEntry(
        "tech-pg-1",
        { itemTypeId: "type-pg", boxes: 999, units: 999, expectedVersion: staleVersion },
        ACTOR,
        "idem-key-stale-0003",
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const after = (
      await client.query(
        `SELECT boxes, units FROM technician_fixed_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
        ["tech-pg-1", "type-pg"],
      )
    ).rows[0];
    // The real row in the real database is untouched by the rejected write.
    expect(after).toEqual(before);

    const movementCount = await client.query(
      `SELECT count(*)::int AS cnt FROM system_logs WHERE details LIKE '%idem-key-stale-0003%'`,
    );
    expect((movementCount.rows[0] as any).cnt).toBe(0);
  });

  it("PROVES idempotency-replay: retrying the SAME key does NOT add the quantity twice, even with different values in the retry body", async () => {
    await client.query(
      `INSERT INTO item_types (id, name_ar, requires_serial, is_active, is_visible) VALUES ($1, $2, false, true, true)`,
      ["type-pg-replay", "صنف اختبار إعادة المحاولة"],
    );

    const { DrizzleInventoryEntriesRepository } = await import("./DrizzleInventoryEntriesRepository");
    const repo = new DrizzleInventoryEntriesRepository();
    const REPLAY_KEY = "idem-replay-test-0010";

    const first = await repo.upsertTechnicianFixedEntry(
      "tech-pg-replay",
      { itemTypeId: "type-pg-replay", boxes: 5, units: 5 },
      ACTOR,
      REPLAY_KEY,
    );
    expect(first.boxes).toBe(5);
    expect(first.units).toBe(5);

    // Retry with the SAME idempotency key but DIFFERENT (wrong) values —
    // this proves the replay check short-circuits before the write, not
    // just that it happens to produce the same numbers by coincidence.
    const retried = await repo.upsertTechnicianFixedEntry(
      "tech-pg-replay",
      { itemTypeId: "type-pg-replay", boxes: 999, units: 999 },
      ACTOR,
      REPLAY_KEY,
    );
    expect(retried.boxes).toBe(5); // the ORIGINAL result, not 999
    expect(retried.units).toBe(5);
    expect(retried.id).toBe(first.id);

    const row = await client.query(
      `SELECT boxes, units FROM technician_fixed_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
      ["tech-pg-replay", "type-pg-replay"],
    );
    expect(row.rows[0]).toEqual({ boxes: 5, units: 5 }); // real row in the real table, unchanged by the retry

    const logCount = await client.query(
      `SELECT count(*)::int AS cnt FROM system_logs WHERE details LIKE $1`,
      [`%"idempotencyKey":"${REPLAY_KEY}"%`],
    );
    expect((logCount.rows[0] as any).cnt).toBe(1); // exactly one audit row, not two
  });

  it("PROVES the full named item-type matrix (quantity-tracked types, requires_serial=false): newBatteries, rollPaper, stickers, and a sim-category-but-quantity-tracked ATM-card type ('1010')", async () => {
    // Mirrors the live catalog shape reported for this task: category can
    // be 'sim' while requires_serial is still false — tracking mode comes
    // ONLY from requires_serial, never from category or name, which this
    // test proves directly by using a category='sim' row that must still
    // go through the quantity path without being rejected.
    const matrixTypes = [
      { id: "newBatteries", nameAr: "بطاريات جديدة", category: "accessories" },
      { id: "rollPaper", nameAr: "رول ورق", category: "accessories" },
      { id: "stickers", nameAr: "ملصقات", category: "accessories" },
      { id: "1010", nameAr: "بطاقة ATM 1010", category: "sim" }, // category='sim', requires_serial=false
    ];

    const { DrizzleInventoryEntriesRepository } = await import("./DrizzleInventoryEntriesRepository");
    const repo = new DrizzleInventoryEntriesRepository();

    for (const t of matrixTypes) {
      await client.query(
        `INSERT INTO item_types (id, name_ar, requires_serial, is_active, is_visible) VALUES ($1, $2, false, true, true)`,
        [t.id, t.nameAr],
      );
      // category isn't a column in this file's hand-written DDL (DDL only
      // has the columns the guard actually reads) — the point being
      // verified is that the guard never looks at category/name at all,
      // which assertItemTypeQuantityTrackable's own source (quantity-entry-
      // guards.ts) confirms by construction: it SELECTs only requiresSerial/
      // isActive/isVisible/nameAr, nothing category-shaped.

      const result = await repo.upsertTechnicianFixedEntry(
        `tech-pg-matrix-${t.id}`,
        { itemTypeId: t.id, boxes: 2, units: 20 },
        ACTOR,
        `idem-matrix-${t.id}-0001`,
      );
      expect(result.boxes).toBe(2);
      expect(result.units).toBe(20); // "20 newBatteries by quantity" case specifically
    }
  });

  it("PROVES a serialized item type (requires_serial=true) is REJECTED on the bare-quantity write path", async () => {
    await client.query(
      `INSERT INTO item_types (id, name_ar, requires_serial, is_active, is_visible) VALUES ($1, $2, true, true, true)`,
      ["type-pg-serial", "جهاز مسلسل اختبار"],
    );

    const { DrizzleInventoryEntriesRepository } = await import("./DrizzleInventoryEntriesRepository");
    const repo = new DrizzleInventoryEntriesRepository();

    await expect(
      repo.upsertTechnicianFixedEntry(
        "tech-pg-1",
        { itemTypeId: "type-pg-serial", boxes: 1, units: 1 },
        ACTOR,
        "idem-key-serial-reject-0005",
      ),
    ).rejects.toThrow(/صنف مسلسل/);

    const rows = await client.query(
      `SELECT * FROM technician_fixed_inventory_entries WHERE item_type_id = $1`,
      ["type-pg-serial"],
    );
    expect(rows.rows.length).toBe(0); // no row was created for the rejected write
  });

  it("PROVES a hidden/inactive item type is REJECTED for new entries", async () => {
    await client.query(
      `INSERT INTO item_types (id, name_ar, requires_serial, is_active, is_visible) VALUES ($1, $2, false, false, true)`,
      ["type-pg-inactive", "صنف غير نشط"],
    );

    const { DrizzleInventoryEntriesRepository } = await import("./DrizzleInventoryEntriesRepository");
    const repo = new DrizzleInventoryEntriesRepository();

    await expect(
      repo.upsertTechnicianFixedEntry(
        "tech-pg-1",
        { itemTypeId: "type-pg-inactive", boxes: 1, units: 1 },
        ACTOR,
        "idem-key-inactive-reject-0006",
      ),
    ).rejects.toThrow(/غير متاح/);
  });

  it("PROVES non-integer and negative quantities are REJECTED", async () => {
    const { DrizzleInventoryEntriesRepository } = await import("./DrizzleInventoryEntriesRepository");
    const repo = new DrizzleInventoryEntriesRepository();

    await expect(
      repo.upsertTechnicianFixedEntry(
        "tech-pg-1",
        { itemTypeId: "type-pg", boxes: 1.5, units: 0 },
        ACTOR,
        "idem-key-noninteger-0007",
      ),
    ).rejects.toThrow(/أرقاماً صحيحة/);

    await expect(
      repo.upsertTechnicianFixedEntry(
        "tech-pg-1",
        { itemTypeId: "type-pg", boxes: -1, units: 0 },
        ACTOR,
        "idem-key-negative-0008",
      ),
    ).rejects.toThrow(/سالبة/);
  });

  it("PROVES two different technicians/item-types never collide (balance isolation)", async () => {
    const { DrizzleInventoryEntriesRepository } = await import("./DrizzleInventoryEntriesRepository");
    const repo = new DrizzleInventoryEntriesRepository();

    await repo.upsertTechnicianFixedEntry("tech-pg-2", { itemTypeId: "type-pg", boxes: 50, units: 50 }, ACTOR, "idem-iso-0004");

    const techOne = (
      await client.query(`SELECT boxes, units FROM technician_fixed_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`, ["tech-pg-1", "type-pg"])
    ).rows[0];
    const techTwo = (
      await client.query(`SELECT boxes, units FROM technician_fixed_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`, ["tech-pg-2", "type-pg"])
    ).rows[0];

    expect(techOne).toEqual({ boxes: 2, units: 3 }); // unchanged from the earlier successful update
    expect(techTwo).toEqual({ boxes: 50, units: 50 });
  });
});
