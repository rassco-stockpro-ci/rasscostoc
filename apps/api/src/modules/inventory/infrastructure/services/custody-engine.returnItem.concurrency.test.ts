/**
 * Phase 3 database concurrency certification — CustodyEngine.returnItem()
 * concurrent-return race. No dedicated same-item, two-caller concurrency
 * test existed for returnItem prior to this file (the only prior
 * coverage was throughput-style stress testing across DISTINCT items).
 *
 * Uses two genuinely concurrent real-Postgres transactions -- not a
 * simulated/sequential race.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../../core/config/db";
import { CustodyEngine } from "./custody-engine";
import {
  users,
  itemTypes,
  items,
  inventoryTransactions,
  itemHistoryLogs,
  custodyMovements,
  warehouses,
} from "@shared/schema";

describe("Phase 3 — CustodyEngine.returnItem() concurrency", () => {
  let warehouseId: string;
  let warehouseCreatorId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database."
      );
    }
    // items.warehouse_id has a real FK to warehouses.id -- a plain string
    // literal is rejected by the DB, so a real row is required.
    warehouseCreatorId = randomUUID();
    await db.insert(users).values({
      id: warehouseCreatorId,
      username: `p3-return-wh-creator-${warehouseCreatorId.slice(0, 8)}`,
      email: `p3-return-wh-creator-${warehouseCreatorId.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "Phase3 Return Warehouse Creator",
      role: "admin",
    });
    warehouseId = randomUUID();
    await db.insert(warehouses).values({
      id: warehouseId,
      name: `P3 Return Warehouse ${warehouseId.slice(0, 8)}`,
      location: "Test Location",
      createdBy: warehouseCreatorId,
    });
  });

  afterAll(async () => {
    await db.delete(warehouses).where(eq(warehouses.id, warehouseId)).catch(() => {});
    await db.delete(users).where(eq(users.id, warehouseCreatorId)).catch(() => {});
  });

  const createdItemIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdItemTypeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdItemIds.splice(0)) {
      await db.delete(inventoryTransactions).where(eq(inventoryTransactions.itemId, id)).catch(() => {});
      await db.delete(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, id)).catch(() => {});
      await db.delete(custodyMovements).where(eq(custodyMovements.itemId, id)).catch(() => {});
      await db.delete(items).where(eq(items.id, id)).catch(() => {});
    }
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
  });

  async function seedTechnician(label: string) {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `p3-return-${label}-${id.slice(0, 8)}`,
      email: `p3-return-${label}-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: `Phase3 Return Technician ${label}`,
      role: "technician",
    });
    createdUserIds.push(id);
    return id;
  }

  async function seedItemInCustody(ownerId: string) {
    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: `نوع-return-${itemTypeId.slice(0, 8)}`,
      nameEn: `Return-Type-${itemTypeId.slice(0, 8)}`,
      category: "device",
    });
    createdItemTypeIds.push(itemTypeId);

    const itemId = randomUUID();
    const serial = `P3RET-${itemId.slice(0, 10)}`.toUpperCase();
    await db.insert(items).values({
      id: itemId,
      itemTypeId,
      serialNumber: serial,
      barcode: serial,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerId,
    });
    createdItemIds.push(itemId);
    return itemId;
  }

  it("two genuinely concurrent return attempts for the SAME item: exactly one logical return, no duplicate audit trail", async () => {
    const technicianId = await seedTechnician("dup");
    const adminId = await seedTechnician("admin-dup");
    const itemId = await seedItemInCustody(technicianId);

    const results = await Promise.allSettled([
      db.transaction((tx) =>
        CustodyEngine.returnItem(itemId, warehouseId, technicianId, adminId, tx)
      ),
      db.transaction((tx) =>
        CustodyEngine.returnItem(itemId, warehouseId, technicianId, adminId, tx)
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RETURNED");
    expect(item?.currentOwnerId).toBeNull();

    const txRows = await db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.itemId, itemId));
    const historyRows = await db
      .select()
      .from(itemHistoryLogs)
      .where(eq(itemHistoryLogs.itemId, itemId));
    const movementRows = await db
      .select()
      .from(custodyMovements)
      .where(eq(custodyMovements.itemId, itemId));

    // D5: the required, unambiguous outcome of a genuine race -- exactly
    // one attempt wins, the other is deterministically rejected before
    // any write, never both succeeding.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(txRows).toHaveLength(1);
    expect(historyRows).toHaveLength(1);
    expect(movementRows).toHaveLength(1);
  }, 15000);

  it("single-request success path: an uncontested return still succeeds and records history correctly", async () => {
    const technicianId = await seedTechnician("solo");
    const adminId = await seedTechnician("admin-solo");
    const itemId = await seedItemInCustody(technicianId);

    await expect(
      db.transaction((tx) => CustodyEngine.returnItem(itemId, warehouseId, technicianId, adminId, tx))
    ).resolves.not.toThrow();

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RETURNED");
    expect(item?.currentOwnerId).toBeNull();

    const txRows = await db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.itemId, itemId));
    expect(txRows).toHaveLength(1);
  });

  it("returning an item under a DIFFERENT technician than the actual owner is rejected before any write", async () => {
    const owner = await seedTechnician("real-owner");
    const impostor = await seedTechnician("impostor");
    const adminId = await seedTechnician("admin-mismatch");
    const itemId = await seedItemInCustody(owner);

    await expect(
      db.transaction((tx) => CustodyEngine.returnItem(itemId, "WH-MISMATCH", impostor, adminId, tx))
    ).rejects.toThrow(/ليس في عهدة/);

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RECEIVED_BY_TECHNICIAN");
    expect(item?.currentOwnerId).toBe(owner);

    const txRows = await db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.itemId, itemId));
    expect(txRows).toHaveLength(0);
  });
});
