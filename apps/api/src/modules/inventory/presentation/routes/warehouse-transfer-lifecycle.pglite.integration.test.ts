/**
 * Warehouse transfer lifecycle — technician moving-inventory counter must not be credited twice.
 * Real HTTP routes (POST /accept, /scan-serial, /confirm-receipt) -> real controllers -> real
 * use cases / UnitOfWork / repositories -> "real migrations on in-process PGlite" (NOT parity with
 * a real PostgreSQL server). Only the DB handle and the request identity are substituted.
 * Needs PGLITE_DIR; skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { and, eq } from "drizzle-orm";

const holder = vi.hoisted(() => ({ db: null as any }));

vi.mock("@core/config/db", () => ({
  get db() { return holder.db; },
  get pool() { return {}; },
}));
vi.mock("@core/database/connection", () => ({
  getDatabase: () => holder.db,
  getPool: () => ({}),
  initializeDatabase: async () => {},
  closeDatabase: async () => {},
  get db() { return holder.db; },
}));

let currentUser: { id: string; role: string };
vi.mock("@core/middlewares/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = currentUser;
    next();
  },
}));

import { createPgliteWithRealMigrations } from "./pglite-test-harness";
import { registerWarehouseTransferOperationsRoutes } from "./warehouse-transfer-operations.routes";
import { errorHandler } from "../../../../core/errors/errorHandler";
import { technicianMovingInventoryEntries } from "@shared/schema";

const PGLITE_DIR = process.env.PGLITE_DIR;

function buildApp() {
  const app = express();
  app.use(express.json());
  registerWarehouseTransferOperationsRoutes(app);
  app.use(errorHandler);
  return app;
}

/**
 * Verbatim copy of PR #79's syncMovingInventory (fix/technician-balance-reconciliation,
 * apps/api/src/modules/inventory/contracts/moving-inventory-sync.ts), which that branch calls
 * with +1 at the end of WarehouseTransferService.scanSerial. Used only to reproduce its effect.
 */
async function pr79SyncMovingInventory(tx: any, technicianId: string, itemTypeId: string, delta: number) {
  if (!technicianId || !itemTypeId || delta === 0) return;
  const [existingEntry] = await tx
    .select()
    .from(technicianMovingInventoryEntries)
    .where(and(eq(technicianMovingInventoryEntries.technicianId, technicianId), eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)))
    .limit(1);
  if (existingEntry) {
    await tx
      .update(technicianMovingInventoryEntries)
      .set({ units: Math.max(0, existingEntry.units + delta), updatedAt: new Date() })
      .where(eq(technicianMovingInventoryEntries.id, existingEntry.id));
  } else if (delta > 0) {
    await tx.insert(technicianMovingInventoryEntries).values({ technicianId, itemTypeId, units: delta, boxes: 0 });
  }
}

describe.skipIf(!PGLITE_DIR)("warehouse transfer lifecycle — no double credit (PGlite on real migrations)", () => {
  let client: any;
  let admin: string;
  let warehouseId: string;

  const q = async (sql: string, params: any[] = []) => (await client.query(sql, params)).rows;
  const counter = async (tech: string, type: string) =>
    (await q("SELECT units, boxes FROM technician_moving_inventory_entries WHERE technician_id=$1 AND item_type_id=$2", [tech, type]))[0] ?? { units: 0, boxes: 0 };
  const held = async (tech: string, type: string) =>
    (await q("SELECT count(*)::int n FROM items WHERE current_owner_id=$1 AND item_type_id=$2", [tech, type]))[0].n;
  const transferStatus = async (id: string) => (await q("SELECT status FROM warehouse_transfers WHERE id=$1", [id]))[0].status;
  const newTech = async (name: string) =>
    (await q("INSERT INTO users (username,email,password,full_name,role) VALUES ($1,$2,'x',$3,'technician') RETURNING id",
      [name, `${name}@example.invalid`, `Full ${name}`]))[0].id as string;
  const newTransfer = async (tech: string, type: string, quantity: number, createdAt?: string) =>
    (await q(
      `INSERT INTO warehouse_transfers (warehouse_id,technician_id,item_type,packaging_type,quantity,performed_by,status,created_at)
       VALUES ($1,$2,$3,'unit',$4,$5,'pending',COALESCE($6::timestamp, now())) RETURNING id`,
      [warehouseId, tech, type, quantity, admin, createdAt ?? null]
    ))[0].id as string;
  const as = (id: string) => { currentUser = { id, role: "technician" }; return request(buildApp()); };

  beforeAll(async () => {
    const h = await createPgliteWithRealMigrations(PGLITE_DIR!);
    expect(h.report.failures).toEqual([]);
    client = h.client;
    holder.db = h.db;

    admin = (await q("INSERT INTO users (username,email,password,full_name,role) VALUES ('adm','adm@example.invalid','x','Admin','admin') RETURNING id"))[0].id;
    warehouseId = (await q("INSERT INTO warehouses (name,location,created_by) VALUES ('WH','Riyadh',$1) RETURNING id", [admin]))[0].id;
    const RX = "^89966[0-9]{14}$";
    await q(`INSERT INTO item_types (id,name_ar,name_en,category,requires_serial,serial_prefix,serial_length,serial_regex)
             VALUES ('sim-mobily','شريحة موبايلي','Mobily SIM','sim',true,'89966',19,$1),
                    ('sim-retired','شريحة متقاعدة','Retired SIM','sim',true,'89966',19,$1)`, [RX]);
    await q(`INSERT INTO item_types (id,name_ar,name_en,category,requires_serial) VALUES ('roll-paper','ورق','Roll Paper','papers',false)`);
    for (const t of ["sim-mobily", "sim-retired", "roll-paper"]) {
      await q("INSERT INTO warehouse_inventory_entries (warehouse_id,item_type_id,boxes,units) VALUES ($1,$2,0,100)", [warehouseId, t]);
    }
  });

  afterAll(async () => { await client?.close?.(); });

  it("P0: accept + scan + confirm (+ repeated accept/scan/confirm) credits the counter exactly once", async () => {
    const tech = await newTech("t_lifecycle");
    const id = await newTransfer(tech, "sim-mobily", 2);
    const S1 = "8996600000000001001", S2 = "8996600000000001002";

    await as(tech).post(`/api/warehouse-transfers/${id}/accept`).expect(200);
    expect(await transferStatus(id)).toBe("accepted");
    expect((await counter(tech, "sim-mobily")).units).toBe(2);
    expect((await q("SELECT units FROM warehouse_inventory_entries WHERE warehouse_id=$1 AND item_type_id='sim-mobily'", [warehouseId]))[0].units).toBe(98);

    await as(tech).post(`/api/warehouse-transfers/${id}/accept`).expect(200); // repeated accept: guarded no-op
    expect((await counter(tech, "sim-mobily")).units).toBe(2);

    await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: S1 }).expect(200);
    await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: S2 }).expect(200);
    const rescan = await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: S1 });
    expect(rescan.status).toBeGreaterThanOrEqual(400); // repeated scan rejected
    expect((await q("SELECT count(*)::int n FROM items WHERE serial_number=$1", [S1]))[0].n).toBe(1);
    expect((await q(
      "SELECT count(*)::int n FROM inventory_transactions t JOIN items i ON i.id=t.item_id WHERE i.serial_number=$1", [S1]))[0].n).toBe(1);
    expect((await q("SELECT DISTINCT item_type_id FROM items WHERE serial_number IN ($1,$2)", [S1, S2])).map((r: any) => r.item_type_id)).toEqual(["sim-mobily"]);
    expect((await counter(tech, "sim-mobily")).units).toBe(2);

    await as(tech).post(`/api/warehouse-transfers/${id}/confirm-receipt`).expect(200);
    expect(await transferStatus(id)).toBe("approved");
    await as(tech).post(`/api/warehouse-transfers/${id}/confirm-receipt`).expect(400); // repeated confirm
    await as(tech).post(`/api/warehouse-transfers/${id}/accept`).expect(200);          // accept after approve: no-op

    expect((await counter(tech, "sim-mobily")).units).toBe(2);
    expect(await held(tech, "sim-mobily")).toBe(2);
    expect((await q("SELECT count(*)::int n FROM stock_movements WHERE technician_id=$1", [tech]))[0].n).toBe(1);
  });

  it("confirm-receipt before all serials of the transfer are scanned is refused and credits nothing", async () => {
    const tech = await newTech("t_partial");
    const id = await newTransfer(tech, "sim-mobily", 2);
    await as(tech).post(`/api/warehouse-transfers/${id}/accept`).expect(200);
    await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: "8996600000000002001" }).expect(200);
    await as(tech).post(`/api/warehouse-transfers/${id}/confirm-receipt`).expect(400);
    expect(await transferStatus(id)).toBe("accepted");
    expect((await counter(tech, "sim-mobily")).units).toBe(2);
  });

  it("quantity-tracked type (requires_serial=false): scan-serial is refused; accept + confirm credit once", async () => {
    const tech = await newTech("t_qty");
    const id = await newTransfer(tech, "roll-paper", 5);
    await as(tech).post(`/api/warehouse-transfers/${id}/accept`).expect(200);
    const scan = await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: "8996600000000003001" });
    expect(scan.status).toBe(400);
    expect((await q("SELECT count(*)::int n FROM items WHERE serial_number='8996600000000003001'"))[0].n).toBe(0);
    await as(tech).post(`/api/warehouse-transfers/${id}/confirm-receipt`).expect(200);
    expect((await counter(tech, "roll-paper")).units).toBe(5);
  });

  it("type hidden AFTER the transfer was created: only that transfer's own quantity of its own type can still be scanned", async () => {
    const tech = await newTech("t_retired");
    const id = await newTransfer(tech, "sim-retired", 2, "2026-01-01T00:00:00");
    await as(tech).post(`/api/warehouse-transfers/${id}/accept`).expect(200);
    await q("UPDATE item_types SET is_visible=false, updated_at=now() WHERE id='sim-retired'");

    await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: "8996600000000004001" }).expect(200);
    await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: "8996600000000004002" }).expect(200);
    expect((await q("SELECT DISTINCT item_type_id FROM items WHERE current_owner_id=$1", [tech])).map((r: any) => r.item_type_id)).toEqual(["sim-retired"]);

    // a third item of the hidden type is NOT part of the transfer (quantity reached) -> rejected
    const extra = await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: "8996600000000004003" });
    expect(extra.status).toBe(400);
    expect((await q("SELECT count(*)::int n FROM items WHERE serial_number='8996600000000004003'"))[0].n).toBe(0);

    // serial that violates the retired type's own rule -> still rejected
    const bad = await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: "12345" });
    expect(bad.status).toBe(400);

    await as(tech).post(`/api/warehouse-transfers/${id}/confirm-receipt`).expect(200);
    expect((await counter(tech, "sim-retired")).units).toBe(2);
    expect(await held(tech, "sim-retired")).toBe(2);
  });

  it("transfer created AFTER the type was hidden gets no exception", async () => {
    const tech = await newTech("t_after_hide");
    await q("UPDATE item_types SET is_visible=false, updated_at='2026-02-01T00:00:00' WHERE id='sim-retired'");
    const id = await newTransfer(tech, "sim-retired", 1, "2026-03-01T00:00:00");
    await q("UPDATE warehouse_transfers SET status='accepted' WHERE id=$1", [id]);
    const res = await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: "8996600000000005001" });
    expect(res.status).toBe(400);
    expect((await q("SELECT count(*)::int n FROM items WHERE serial_number='8996600000000005001'"))[0].n).toBe(0);
  });

  it("unknown / undefined item type on a transfer is rejected", async () => {
    const tech = await newTech("t_unknown");
    const id = await newTransfer(tech, "no-such-type", 1);
    await q("UPDATE warehouse_transfers SET status='accepted' WHERE id=$1", [id]);
    const res = await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: "8996600000000006001" });
    expect(res.status).toBe(400);
    expect((await q("SELECT count(*)::int n FROM items WHERE serial_number='8996600000000006001'"))[0].n).toBe(0);
  });

  it("REPRODUCTION — PR #79 logic (+1 per scanSerial) on top of accept doubles the counter vs items held", async () => {
    const tech = await newTech("t_pr79");
    const id = await newTransfer(tech, "sim-mobily", 3);
    await as(tech).post(`/api/warehouse-transfers/${id}/accept`).expect(200);
    for (const sn of ["8996600000000007001", "8996600000000007002", "8996600000000007003"]) {
      await as(tech).post(`/api/warehouse-transfers/${id}/scan-serial`).send({ serialNumber: sn }).expect(200);
      await pr79SyncMovingInventory(holder.db, tech, "sim-mobily", 1); // what PR #79 adds inside scanSerial
    }
    await as(tech).post(`/api/warehouse-transfers/${id}/confirm-receipt`).expect(200);
    expect(await held(tech, "sim-mobily")).toBe(3);
    expect((await counter(tech, "sim-mobily")).units).toBe(6); // 3 from accept + 3 from PR #79 scans
  });
});
