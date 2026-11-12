/**
 * Connected integration proof (in-process PGlite, no external DB, no mocks of
 * the controller/service/repository code under test):
 *
 *   pre-selected itemTypeId -> REAL route + REAL controller -> REAL
 *   SerializedItemsService.scanIn/batchScanIn -> REAL SerialRecognitionService
 *   -> row in `items` -> REAL admin search route (GET /api/serialized-items/search)
 *   -> result carries the SAME item type that the technician selected.
 *
 * Only the DB handle (@core/config/db, @core/database/connection), the auth
 * identity and the supervisor-assignment lookup are substituted.
 *
 * HONESTY NOTES
 *  - The schema is built by applying the repository's REAL drizzle migration
 *    SQL files (migrations/meta/_journal.json order) into in-process PGlite
 *    (PG 16 WASM). That is "real migrations on in-process PGlite" — NOT parity
 *    with a real PostgreSQL server (no extensions, no server settings, no
 *    production data/constraints drift, single connection).
 *  - Drizzle is wired through drizzle-orm/pg-proxy; its .transaction() stub
 *    throws, so BEGIN/COMMIT/ROLLBACK are issued by hand in this harness only.
 *  - Needs PGLITE_DIR (a scratch dir OUTSIDE the repo containing
 *    node_modules/@electric-sql/pglite@0.2.17). Skipped when it is not set.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";

const holder = vi.hoisted(() => ({ db: null as any, pool: {} as any }));

vi.mock("@core/config/db", () => ({
  get db() { return holder.db; },
  get pool() { return holder.pool; },
}));
vi.mock("@core/database/connection", () => ({
  get db() { return holder.db; },
  get pool() { return holder.pool; },
}));

let currentUser: { id: string; role: string };
vi.mock("@core/middlewares/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = currentUser;
    next();
  },
}));

const { assignedBySupervisor } = vi.hoisted(() => ({
  assignedBySupervisor: new Map<string, string[]>(),
}));
vi.mock("@server/composition/supervisor-assignments.container", () => ({
  supervisorAssignmentsContainer: {
    supervisorAssignmentsUseCase: {
      getTechnicianIdsBySupervisor: async (id: string) => assignedBySupervisor.get(id) ?? [],
    },
  },
}));

import { registerSerializedItemsRoutes } from "./serialized-items.routes";
import { createPgliteWithRealMigrations } from "./pglite-test-harness";
import { errorHandler } from "../../../../core/errors/errorHandler";
import { SerialRecognitionService } from "../../../../core/serial/serial-recognition.service";

const PGLITE_DIR = process.env.PGLITE_DIR;

// 19-digit ICCIDs matching ^89966[0-9]{14}$ — identical rule for STC and Mobily.
const SN_MOBILY = "8996600000000000011";
const SN_STC = "8996600000000000022";
const SN_BATCH_A = "8996600000000000033";
const SN_BATCH_B = "8996600000000000044";
const SN_ROLLBACK = "8996600000000000055";
const SN_BAD_TYPE = "8996600000000000066";

function buildApp() {
  const app = express();
  app.use(express.json());
  registerSerializedItemsRoutes(app);
  app.use(errorHandler);
  return app;
}

describe.skipIf(!PGLITE_DIR)("item type authority — scan-in -> admin search (PGlite, real code path)", () => {
  let client: any;
  let migrationReport: { files: number; statements: number; failures: string[] };
  let techA: string;
  let techB: string;
  let supIn: string;
  let supOut: string;

  const countItems = async (serial: string) =>
    (await client.query("SELECT count(*)::int AS n FROM items WHERE serial_number = $1", [serial])).rows[0].n;
  const storedType = async (serial: string) =>
    (await client.query("SELECT item_type_id FROM items WHERE serial_number = $1", [serial])).rows[0]?.item_type_id;

  beforeAll(async () => {
    const h = await createPgliteWithRealMigrations(PGLITE_DIR!);
    client = h.client;
    migrationReport = h.report;
    holder.db = h.db;

    const user = async (name: string, role: string) =>
      (await client.query(
        "INSERT INTO users (username,email,password,full_name,role) VALUES ($1,$2,'x',$3,$4) RETURNING id",
        [name, `${name}@example.invalid`, `Full ${name}`, role]
      )).rows[0].id as string;
    techA = await user("tech_a", "technician");
    techB = await user("tech_b", "technician");
    supIn = await user("sup_in", "supervisor");
    supOut = await user("sup_out", "supervisor");
    assignedBySupervisor.set(supIn, [techA]);
    assignedBySupervisor.set(supOut, [techB]);

    const type = (id: string, ar: string, en: string, opts: { regex?: string | null; len?: number | null; active?: boolean; visible?: boolean } = {}) =>
      client.query(
        `INSERT INTO item_types (id,name_ar,name_en,category,is_active,is_visible,requires_serial,serial_prefix,serial_length,serial_regex)
         VALUES ($1,$2,$3,'sim',$4,$5,true,$6,$7,$8)`,
        [id, ar, en, opts.active ?? true, opts.visible ?? true, opts.regex ? "89966" : null, opts.len ?? null, opts.regex ?? null]
      );
    const RX = "^89966[0-9]{14}$";
    await type("sim-stc", "شريحة STC", "STC SIM", { regex: RX, len: 19 });
    await type("sim-mobily", "شريحة موبايلي", "Mobily SIM", { regex: RX, len: 19 });
    await type("sim-zain-new", "شريحة زين جديدة", "Zain SIM New"); // no serialRegex, no length
    await type("sim-hidden", "شريحة مخفية", "Hidden SIM", { regex: RX, len: 19, visible: false });
    await type("sim-inactive", "شريحة معطلة", "Inactive SIM", { regex: RX, len: 19, active: false });
  });

  afterAll(async () => {
    await client?.close?.();
  });

  const scanIn = (serialNumber: string, itemTypeId: string, as = techA) => {
    currentUser = { id: as, role: "technician" };
    return request(buildApp()).post("/api/serialized-items/scan-in").send({ serialNumber, itemTypeId });
  };
  const adminSearch = async (q: string) => {
    currentUser = { id: "admin-1", role: "admin" };
    const res = await request(buildApp()).get(`/api/serialized-items/search?q=${encodeURIComponent(q)}`).expect(200);
    return res.body.data as any[];
  };

  it("pre-selected type is stored as-is and the admin search shows the SAME type", async () => {
    await scanIn(SN_MOBILY, "sim-mobily").expect(200);

    expect(await storedType(SN_MOBILY)).toBe("sim-mobily");
    const rows = await adminSearch(SN_MOBILY);
    expect(rows).toHaveLength(1);
    expect(rows[0].serialNumber).toBe(SN_MOBILY);
    expect(rows[0].itemTypeId).toBe("sim-mobily");
    expect(rows[0].itemTypeNameEn).toBe("Mobily SIM");
    expect(rows[0].currentOwnerId).toBe(techA);
  });

  it("two regex-identical SIM types: each stored and found under its OWN selected id", async () => {
    await scanIn(SN_STC, "sim-stc").expect(200);

    expect(await storedType(SN_STC)).toBe("sim-stc");
    expect(await storedType(SN_MOBILY)).toBe("sim-mobily");

    const stc = await adminSearch(SN_STC);
    expect(stc.map((r) => [r.serialNumber, r.itemTypeId])).toEqual([[SN_STC, "sim-stc"]]);
    const mobily = await adminSearch(SN_MOBILY);
    expect(mobily.map((r) => [r.serialNumber, r.itemTypeId])).toEqual([[SN_MOBILY, "sim-mobily"]]);
  });

  it("an unknown / inactive / hidden itemTypeId is REJECTED (400) — never substituted by another type", async () => {
    for (const bad of ["does-not-exist", "sim-inactive", "sim-hidden"]) {
      const res = await scanIn(SN_BAD_TYPE, bad).expect(400);
      expect(res.body.message ?? res.body.error ?? JSON.stringify(res.body)).toContain(bad);
      expect(await countItems(SN_BAD_TYPE)).toBe(0);
    }
  });

  it("documents the substitution that strict mode prevents: legacy non-strict recognize() swaps an unknown hint for another sim type", async () => {
    const legacy = await SerialRecognitionService.recognize(SN_BAD_TYPE, "does-not-exist", holder.db);
    expect(legacy.itemTypeId).not.toBe("does-not-exist");
    expect(legacy.itemTypeId.startsWith("sim")).toBe(true);
  });

  it("a selected type with NO serialRegex is rejected with a clear error (no guess, no arbitrary serial accepted)", async () => {
    const res = await scanIn(SN_BAD_TYPE, "sim-zain-new").expect(400);
    expect(JSON.stringify(res.body)).toContain("شريحة زين جديدة");
    expect(await countItems(SN_BAD_TYPE)).toBe(0);
  });

  it("serial that violates the SELECTED type's rule is rejected, not re-typed", async () => {
    await scanIn("1234567890123", "sim-stc").expect(400);
    expect(await countItems("1234567890123")).toBe(0);
  });

  it("batch-scan-in: each item keeps its own selected type", async () => {
    currentUser = { id: techA, role: "technician" };
    await request(buildApp())
      .post("/api/serialized-items/batch-scan-in")
      .send({ items: [
        { serialNumber: SN_BATCH_A, itemTypeId: "sim-stc" },
        { serialNumber: SN_BATCH_B, itemTypeId: "sim-mobily" },
      ] })
      .expect(200);

    expect(await storedType(SN_BATCH_A)).toBe("sim-stc");
    expect(await storedType(SN_BATCH_B)).toBe("sim-mobily");
    expect((await adminSearch(SN_BATCH_B))[0].itemTypeId).toBe("sim-mobily");
  });

  it("batch-scan-in with one invalid type rolls the whole batch back", async () => {
    currentUser = { id: techA, role: "technician" };
    await request(buildApp())
      .post("/api/serialized-items/batch-scan-in")
      .send({ items: [
        { serialNumber: SN_ROLLBACK, itemTypeId: "sim-stc" },
        { serialNumber: "8996600000000000077", itemTypeId: "does-not-exist" },
      ] })
      .expect(400);

    expect(await countItems(SN_ROLLBACK)).toBe(0);
    expect(await countItems("8996600000000000077")).toBe(0);
  });

  it("scope: supervisor assigned to the owner finds it; supervisor of another technician sees nothing", async () => {
    currentUser = { id: supIn, role: "supervisor" };
    const inRes = await request(buildApp()).get(`/api/serialized-items/search?q=${SN_MOBILY}`).expect(200);
    expect(inRes.body.data.map((r: any) => r.itemTypeId)).toEqual(["sim-mobily"]);

    currentUser = { id: supOut, role: "supervisor" };
    const outRes = await request(buildApp()).get(`/api/serialized-items/search?q=${SN_MOBILY}`).expect(200);
    expect(outRes.body.data).toEqual([]);
  });

  it("lookup ownership scope holds against real rows: other technician 403, owner 200", async () => {
    currentUser = { id: techB, role: "technician" };
    await request(buildApp()).get(`/api/serialized-items/lookup/${SN_MOBILY}`).expect(403);
    currentUser = { id: techA, role: "technician" };
    const ok = await request(buildApp()).get(`/api/serialized-items/lookup/${SN_MOBILY}`).expect(200);
    expect(ok.body.data.serialNumber).toBe(SN_MOBILY);
  });

  it("the schema came from the REAL migrations (all journal files, zero failed statements)", () => {
    expect(migrationReport.files).toBeGreaterThanOrEqual(27);
    expect(migrationReport.failures).toEqual([]);
  });

  describe.each([
    ["hidden", "UPDATE item_types SET is_visible = false WHERE id = $1"],
    ["inactive", "UPDATE item_types SET is_active = false WHERE id = $1"],
  ])("type turned %s AFTER items were stored under it", (label, flipSql) => {
    const TYPE = `sim-hist-${label}`;
    const SN_OLD = label === "hidden" ? "8996600000000000101" : "8996600000000000102";
    const SN_NEW = label === "hidden" ? "8996600000000000111" : "8996600000000000112";
    const SN_NEW_B = label === "hidden" ? "8996600000000000121" : "8996600000000000122";

    it("new scan-in / batch are rejected (400, no insert) while the old item stays searchable with its original type", async () => {
      await client.query(
        `INSERT INTO item_types (id,name_ar,name_en,category,requires_serial,serial_prefix,serial_length,serial_regex)
         VALUES ($1,$2,$3,'sim',true,'89966',19,'^89966[0-9]{14}$')`,
        [TYPE, `شريحة تاريخية ${label}`, `Historic SIM ${label}`]
      );
      await scanIn(SN_OLD, TYPE).expect(200);
      expect(await storedType(SN_OLD)).toBe(TYPE);

      await client.query(flipSql, [TYPE]);

      await scanIn(SN_NEW, TYPE).expect(400);
      expect(await countItems(SN_NEW)).toBe(0);

      currentUser = { id: techA, role: "technician" };
      await request(buildApp())
        .post("/api/serialized-items/batch-scan-in")
        .send({ items: [
          { serialNumber: SN_NEW, itemTypeId: TYPE },
          { serialNumber: SN_NEW_B, itemTypeId: "sim-stc" },
        ] })
        .expect(400);
      expect(await countItems(SN_NEW)).toBe(0);
      expect(await countItems(SN_NEW_B)).toBe(0);

      const rows = await adminSearch(SN_OLD);
      expect(rows).toHaveLength(1);
      expect(rows[0].itemTypeId).toBe(TYPE);
      expect(rows[0].itemTypeNameEn).toBe(`Historic SIM ${label}`);
      expect(rows[0].itemTypeNameAr).toBe(`شريحة تاريخية ${label}`);

      currentUser = { id: techA, role: "technician" };
      const lookup = await request(buildApp()).get(`/api/serialized-items/lookup/${SN_OLD}`).expect(200);
      expect(lookup.body.data.itemTypeNameEn).toBe(`Historic SIM ${label}`);
    });
  });

  it("Zain SIM New (no serial_regex) is rejected for scan-in AND batch-scan-in; nothing is stored", async () => {
    const SN = "8996600000000000201";
    await scanIn(SN, "sim-zain-new").expect(400);
    currentUser = { id: techA, role: "technician" };
    await request(buildApp())
      .post("/api/serialized-items/batch-scan-in")
      .send({ items: [{ serialNumber: SN, itemTypeId: "sim-zain-new" }] })
      .expect(400);
    expect(await countItems(SN)).toBe(0);
  });

  it("warehouse-transfer scanSerial: the transfer's item type is the authority — exact type stored, unknown type rejected (no re-typing)", async () => {
    const { WarehouseTransferService } = await import("../../infrastructure/services/warehouse-transfer.service");
    const svc = new WarehouseTransferService();
    const SN_OK = "8996600000000000301";
    const SN_BAD = "8996600000000000302";

    await svc.scanSerial(techA, "transfer-1", SN_OK, "sim-mobily");
    expect(await storedType(SN_OK)).toBe("sim-mobily");

    await expect(svc.scanSerial(techA, "transfer-1", SN_BAD, "does-not-exist")).rejects.toThrow(/does-not-exist/);
    expect(await countItems(SN_BAD)).toBe(0);
  });
});
