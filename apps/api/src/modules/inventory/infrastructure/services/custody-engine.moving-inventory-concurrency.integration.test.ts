/**
 * Governance regression: custody moving-inventory first-row race.
 *
 * Two real concurrent custody scan-ins for the same technician/item type must
 * converge on one moving-inventory row with the sum of both units. A duplicate
 * row is a custody accounting defect even if individual item rows are correct.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./../../../../core/config/db";
import {
  users,
  itemTypes,
  items,
  inventoryTransactions,
  itemHistoryLogs,
  custodyMovements,
  technicianMovingInventoryEntries,
} from "@shared/schema";
import { CustodyEngine } from "./custody-engine";

describe("Governance — custody moving-inventory concurrency", () => {
  let technicianId: string;
  let itemTypeId: string;
  const itemIds: string[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database."
      );
    }

    technicianId = randomUUID();
    itemTypeId = randomUUID();

    await db.insert(users).values({
      id: technicianId,
      username: `gov-custody-${technicianId.slice(0, 8)}`,
      email: `gov-custody-${technicianId.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "Governance Custody Technician",
      role: "technician",
    });

    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: "Governance Custody Type",
      nameEn: "Governance Custody Type",
      category: "devices",
      isActive: true,
      requiresSerial: true,
      serialPrefix: "ZZ",
      serialLength: 12,
      serialRegex: "^ZZ[0-9]{10}$",
    });
  });

  afterAll(async () => {
    for (const itemId of itemIds) {
      await db.delete(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId)).catch(() => {});
      await db.delete(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId)).catch(() => {});
      await db.delete(custodyMovements).where(eq(custodyMovements.itemId, itemId)).catch(() => {});
      await db.delete(items).where(eq(items.id, itemId)).catch(() => {});
    }

    await db.delete(technicianMovingInventoryEntries)
      .where(eq(technicianMovingInventoryEntries.technicianId, technicianId))
      .catch(() => {});

    await db.delete(itemTypes).where(eq(itemTypes.id, itemTypeId)).catch(() => {});
    await db.delete(users).where(eq(users.id, technicianId)).catch(() => {});
  });

  it("concurrent first custody receipts create one moving row with both units", async () => {
    const serialA = `ZZ${randomUUID().replace(/-/g, "").slice(0, 10)}`.toUpperCase();
    const serialB = `ZZ${randomUUID().replace(/-/g, "").slice(0, 10)}`.toUpperCase();

    const results = await Promise.all([
      CustodyEngine.scanItem(serialA, itemTypeId, technicianId),
      CustodyEngine.scanItem(serialB, itemTypeId, technicianId),
    ]);

    itemIds.push(results[0].id, results[1].id);

    const rows = await db
      .select()
      .from(technicianMovingInventoryEntries)
      .where(
        and(
          eq(technicianMovingInventoryEntries.technicianId, technicianId),
          eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
        )
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.units).toBe(2);

    const [itemA] = await db.select().from(items).where(eq(items.id, results[0].id));
    const [itemB] = await db.select().from(items).where(eq(items.id, results[1].id));
    expect(itemA?.status).toBe("RECEIVED_BY_TECHNICIAN");
    expect(itemB?.status).toBe("RECEIVED_BY_TECHNICIAN");
    expect(itemA?.currentOwnerId).toBe(technicianId);
    expect(itemB?.currentOwnerId).toBe(technicianId);
  });
});
