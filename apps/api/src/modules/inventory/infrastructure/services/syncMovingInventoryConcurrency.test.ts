/**
 * TEMP-SYSTEM-STABILIZATION-F2 — regression test for the syncMovingInventory
 * advisory-lock fix (serialized-items.service.ts).
 *
 * Root cause reproduced here: the pre-fix implementation did
 * read(units) -> JS arithmetic -> write(units) with no row lock, on a table
 * with no unique constraint on (technicianId, itemTypeId). Two concurrent
 * calls for the SAME pair could both read the same starting value and lose
 * one decrement ("lost update").
 *
 * This test drives the real private method indirectly via
 * adminDeleteSerializedItemById (each delete calls syncMovingInventory with
 * delta=-1), which is the exact code path this session's changes touch.
 *
 * Runs only against an isolated Postgres test database (DATABASE_URL must
 * contain "test" — same safety convention as the existing DB-R1 suite).
 */
import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../../core/config/db";
import {
  users,
  itemTypes,
  items,
  technicianMovingInventoryEntries,
  systemLogs,
} from "@shared/schema";
import { SerializedItemsService } from "./serialized-items.service";

describe("TEMP-STABILIZATION — syncMovingInventory concurrency (serialized-items.service.ts)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database " +
          "(must contain 'test' in the database name)."
      );
    }
  });

  const service = new SerializedItemsService();
  const createdUserIds: string[] = [];
  const createdItemTypeIds: string[] = [];
  const createdItemIds: string[] = [];

  afterEach(async () => {
    for (const id of createdItemIds.splice(0)) {
      await db.delete(items).where(eq(items.id, id)).catch(() => {});
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(technicianMovingInventoryEntries).where(eq(technicianMovingInventoryEntries.technicianId, id)).catch(() => {});
      await db.delete(systemLogs).where(eq(systemLogs.userId, id)).catch(() => {});
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
  });

  async function seedTechnician(): Promise<string> {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `stab-${id.slice(0, 8)}`,
      email: `stab-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "Stabilization Test Technician",
      role: "technician",
    });
    createdUserIds.push(id);
    return id;
  }

  async function seedAdmin(): Promise<string> {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `stab-admin-${id.slice(0, 8)}`,
      email: `stab-admin-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "Stabilization Test Admin",
      role: "admin",
    });
    createdUserIds.push(id);
    return id;
  }

  async function seedItemType(): Promise<string> {
    const id = `stabtype-${randomUUID().slice(0, 8)}`;
    await db.insert(itemTypes).values({
      id,
      nameAr: "نوع اختبار",
      nameEn: "Test Type",
      category: "devices",
      isActive: true,
    });
    createdItemTypeIds.push(id);
    return id;
  }

  async function seedCustodyItem(technicianId: string, itemTypeId: string): Promise<{ id: string; serialNumber: string }> {
    const id = randomUUID();
    const serialNumber = `STAB${id.slice(0, 12)}`;
    await db.insert(items).values({
      id,
      itemTypeId,
      serialNumber,
      barcode: serialNumber,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: technicianId,
    });
    createdItemIds.push(id);
    return { id, serialNumber };
  }

  async function getMovingUnits(technicianId: string, itemTypeId: string): Promise<number> {
    const [entry] = await db
      .select({ units: technicianMovingInventoryEntries.units })
      .from(technicianMovingInventoryEntries)
      .where(eq(technicianMovingInventoryEntries.technicianId, technicianId));
    return entry?.units ?? 0;
  }

  it("two concurrent deletes for the same technician+itemType both decrement — no lost update", async () => {
    const technicianId = await seedTechnician();
    const adminId = await seedAdmin();
    const itemTypeId = await seedItemType();

    // Seed a starting moving-inventory balance of 5 units (simulating prior
    // scans/receipts), plus two real custody items to delete concurrently.
    await db.insert(technicianMovingInventoryEntries).values({
      technicianId,
      itemTypeId,
      units: 5,
      boxes: 0,
    });

    const itemA = await seedCustodyItem(technicianId, itemTypeId);
    const itemB = await seedCustodyItem(technicianId, itemTypeId);

    // Fire both deletes concurrently — this is the exact race the advisory
    // lock must serialize.
    const [resultA, resultB] = await Promise.all([
      service.adminDeleteSerializedItemById(adminId, "admin", "admin", itemA.id, "concurrency test A"),
      service.adminDeleteSerializedItemById(adminId, "admin", "admin", itemB.id, "concurrency test B"),
    ]);

    expect(resultA.deleted).toBe(true);
    expect(resultB.deleted).toBe(true);

    const finalUnits = await getMovingUnits(technicianId, itemTypeId);
    // Deterministic: 5 - 1 - 1 = 3. A lost update would leave this at 4.
    expect(finalUnits).toBe(3);

    // Both items must actually be gone.
    const remaining = await db.select({ id: items.id }).from(items).where(inArray(items.id, [itemA.id, itemB.id]));
    expect(remaining.length).toBe(0);
  });

  it("balance never goes negative even with more concurrent decrements than available units", async () => {
    const technicianId = await seedTechnician();
    const adminId = await seedAdmin();
    const itemTypeId = await seedItemType();

    await db.insert(technicianMovingInventoryEntries).values({
      technicianId,
      itemTypeId,
      units: 1,
      boxes: 0,
    });

    const itemA = await seedCustodyItem(technicianId, itemTypeId);
    const itemB = await seedCustodyItem(technicianId, itemTypeId);

    await Promise.all([
      service.adminDeleteSerializedItemById(adminId, "admin", "admin", itemA.id),
      service.adminDeleteSerializedItemById(adminId, "admin", "admin", itemB.id),
    ]);

    const finalUnits = await getMovingUnits(technicianId, itemTypeId);
    expect(finalUnits).toBeGreaterThanOrEqual(0);
  });

  it("a failed delete (unknown item id) does not touch the moving-inventory balance (rollback behavior)", async () => {
    const technicianId = await seedTechnician();
    const adminId = await seedAdmin();
    const itemTypeId = await seedItemType();

    await db.insert(technicianMovingInventoryEntries).values({
      technicianId,
      itemTypeId,
      units: 2,
      boxes: 0,
    });

    await expect(
      service.adminDeleteSerializedItemById(adminId, "admin", "admin", randomUUID())
    ).rejects.toThrow();

    const finalUnits = await getMovingUnits(technicianId, itemTypeId);
    expect(finalUnits).toBe(2);
  });
});
