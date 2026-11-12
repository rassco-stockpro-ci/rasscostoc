/**
 * Regression test for a real triple-counting bug found by PR #77's
 * reviewer: processWarehouseTransferBatch (accept) already credits
 * technician_moving_inventory_entries with the FULL transfer.quantity.
 * A syncMovingInventory(+1) call previously added to
 * WarehouseTransferService.scanSerial stacked a THIRD credit per scanned
 * serial on top of that (a second, independent double-count inside
 * confirmReceipt was fixed on PR #77's own branch — not this file).
 *
 * This test proves, against REAL migrations on in-process PGlite:
 * accept() credits the counter once, and scanning N items against that
 * same transfer afterward leaves the counter UNCHANGED.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createPgliteWithRealMigrations } from "../../../../test-support/pglite-real-migrations";

const dbHolder = vi.hoisted(() => ({ db: undefined as any }));

vi.mock("@core/config/db", () => ({ get db() { return dbHolder.db; } }));
vi.mock("@core/database/connection", () => ({
  getDatabase: () => dbHolder.db,
}));

let client: any;

beforeAll(async () => {
  const setup = await createPgliteWithRealMigrations();
  client = setup.client;
  dbHolder.db = setup.db;
});

afterAll(async () => {
  if (client) await client.close();
});

async function seed() {
  await client.query(
    `INSERT INTO users (id, username, email, password, full_name, role) VALUES
     ('tech-scan-1', 'tech_scan_1', 'tech1@test.local', 'x', 'Tech One', 'technician'),
     ('admin-scan-1', 'admin_scan_1', 'admin1@test.local', 'x', 'Admin One', 'admin')`,
  );
  await client.query(
    `INSERT INTO warehouses (id, name, location, created_by) VALUES
     ('wh-scan-1', 'Test Warehouse', 'Riyadh', 'admin-scan-1')`,
  );
  await client.query(
    `INSERT INTO item_types (id, name_ar, name_en, category, units_per_box, is_active, is_visible, requires_serial, serial_regex)
     VALUES ('test-dev-scan', 'جهاز اختبار', 'Test Device', 'devices', 1, true, true, true, '^[A-Z0-9]+$')`,
  );
  await client.query(
    `INSERT INTO warehouse_inventory_entries (warehouse_id, item_type_id, boxes, units)
     VALUES ('wh-scan-1', 'test-dev-scan', 0, 100)`,
  );
  await client.query(
    `INSERT INTO warehouse_transfers (id, warehouse_id, technician_id, item_type, packaging_type, quantity, performed_by, status)
     VALUES ('xfer-scan-1', 'wh-scan-1', 'tech-scan-1', 'test-dev-scan', 'unit', 3, 'admin-scan-1', 'pending')`,
  );
}

async function getCounter() {
  const r = await client.query(
    `SELECT units FROM technician_moving_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
    ["tech-scan-1", "test-dev-scan"],
  );
  return r.rows[0]?.units ?? null;
}

describe("WarehouseTransferService.scanSerial must NOT double/triple-count the moving-inventory counter", () => {
  it("PROVES: accept() credits the counter ONCE (full batch quantity), then scanning each item leaves it UNCHANGED", async () => {
    await seed();

    // Step 1: accept() -> processWarehouseTransferBatch credits the FULL
    // transfer.quantity (3) into technician_moving_inventory_entries.
    const { DrizzleInventoryUnitOfWork } = await import(
      "../database/DrizzleInventoryUnitOfWork"
    );
    const { processWarehouseTransferBatch } = await import(
      "../../application/inventory/use-cases/warehouse-transfer-batch.processor"
    );
    const unitOfWork = new DrizzleInventoryUnitOfWork();
    await unitOfWork.execute(async (context: any) => {
      await processWarehouseTransferBatch(context, ["xfer-scan-1"]);
    });

    const afterAccept = await getCounter();
    expect(afterAccept).toBe(3); // credited exactly once, matching transfer.quantity

    // Step 2: scanSerial each of the 3 physical units. Before the fix, each
    // call added +1 to the SAME counter on top of the 3 already credited —
    // 3 scans would have produced units=6, not 3.
    const { WarehouseTransferService } = await import("./warehouse-transfer.service");
    const service = new WarehouseTransferService();

    await service.scanSerial("tech-scan-1", "xfer-scan-1", "TD0001", "test-dev-scan");
    const afterScan1 = await getCounter();
    expect(afterScan1).toBe(3); // UNCHANGED after first scan

    await service.scanSerial("tech-scan-1", "xfer-scan-1", "TD0002", "test-dev-scan");
    await service.scanSerial("tech-scan-1", "xfer-scan-1", "TD0003", "test-dev-scan");
    const afterAllScans = await getCounter();
    expect(afterAllScans).toBe(3); // STILL 3 after all 3 scans — this is the proof

    // Sanity: scanSerial still does its real job (creating the audit-trail
    // items rows) — it just must not touch the counter.
    const itemsRows = await client.query(
      `SELECT serial_number, status, current_owner_id FROM items WHERE item_type_id = $1 ORDER BY serial_number`,
      ["test-dev-scan"],
    );
    expect(itemsRows.rows.length).toBe(3);
    expect(itemsRows.rows.every((r: any) => r.current_owner_id === "tech-scan-1")).toBe(true);
  });
});
