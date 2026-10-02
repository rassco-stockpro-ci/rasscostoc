/**
 * Phase 3 database concurrency certification — CustodyEngine.deliverItem()
 * concurrent-delivery race.
 *
 * BLOCKER #1 fix: deliverItem previously had no FOR UPDATE lock and no
 * CAS-guarded write -- the exact same defect class D5 fixed for
 * returnItem(), left open on the delivery side. This file proves the
 * fix using genuinely concurrent real-Postgres transactions (Promise.all
 * over db.transaction(...), not a simulated/sequential race), at
 * N=2/5/10/20/50, mirroring custody-engine.returnItem.concurrency.test.ts's
 * proven structure.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../../../../core/config/db";
import { CustodyEngine } from "./custody-engine";
import {
  users,
  itemTypes,
  items,
  inventoryTransactions,
  itemHistoryLogs,
  custodyMovements,
  technicianMovingInventoryEntries,
} from "@shared/schema";

describe("Phase 3 — CustodyEngine.deliverItem() concurrency (BLOCKER #1)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database."
      );
    }
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
      await db.delete(technicianMovingInventoryEntries).where(eq(technicianMovingInventoryEntries.itemTypeId, id)).catch(() => {});
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
      username: `p3-deliver-${label}-${id.slice(0, 8)}`,
      email: `p3-deliver-${label}-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: `Phase3 Deliver Technician ${label}`,
      role: "technician",
    });
    createdUserIds.push(id);
    return id;
  }

  // startingUnits lets a test distinguish "decremented once" from
  // "decremented N times" -- with the buggy clamp-at-zero behavior in
  // syncMovingInventory, seeding at 1 would silently hide a double
  // decrement (1-1=0, then max(0,0-1)=0 looks identical to a single
  // decrement). Seeding well above the number of concurrent attempts
  // makes any extra decrement visible as a wrong final count.
  async function seedItemInCustodyWithMovingEntry(ownerId: string, startingUnits: number) {
    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: `نوع-deliver-${itemTypeId.slice(0, 8)}`,
      nameEn: `Deliver-Type-${itemTypeId.slice(0, 8)}`,
      category: "device",
    });
    createdItemTypeIds.push(itemTypeId);

    await db.insert(technicianMovingInventoryEntries).values({
      technicianId: ownerId,
      itemTypeId,
      units: startingUnits,
      boxes: 0,
    });

    const itemId = randomUUID();
    const serial = `P3DLV-${itemId.slice(0, 10)}`.toUpperCase();
    await db.insert(items).values({
      id: itemId,
      itemTypeId,
      serialNumber: serial,
      barcode: serial,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerId,
    });
    createdItemIds.push(itemId);
    return { itemId, itemTypeId };
  }

  const concurrencyLevels = [2, 5, 10, 20, 50];

  for (const n of concurrencyLevels) {
    it(`N=${n} genuinely concurrent delivery attempts for the SAME item: exactly one wins, no double delivery, no double decrement, no state corruption`, async () => {
      const technicianId = await seedTechnician(`dup${n}`);
      const adminId = await seedTechnician(`admin-dup${n}`);
      const startingUnits = n + 10; // comfortably above n so a double/triple decrement is unambiguous
      const { itemId, itemTypeId } = await seedItemInCustodyWithMovingEntry(technicianId, startingUnits);
      const orderNumber = `ORD-P3-${n}-${itemId.slice(0, 6)}`;

      const attempts = Array.from({ length: n }, () =>
        db.transaction((tx) => CustodyEngine.deliverItem(itemId, orderNumber, technicianId, adminId, tx))
      );
      const results = await Promise.allSettled(attempts);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Deterministic outcome: exactly one winner, all others rejected --
      // never zero winners (item stuck), never more than one (double
      // delivery).
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(n - 1);

      const [item] = await db.select().from(items).where(eq(items.id, itemId));
      expect(item?.status).toBe("DELIVERED");
      expect(item?.currentOwnerId).toBeNull(); // no invalid/negative/leftover custody state

      const txRows = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
      const historyRows = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
      const movementRows = await db.select().from(custodyMovements).where(eq(custodyMovements.itemId, itemId));

      // No duplicate side effects -- exactly one of each ledger row,
      // regardless of how many concurrent callers raced.
      expect(txRows).toHaveLength(1);
      expect(historyRows).toHaveLength(1);
      expect(movementRows).toHaveLength(1);

      const [movingEntry] = await db
        .select()
        .from(technicianMovingInventoryEntries)
        .where(
          and(
            eq(technicianMovingInventoryEntries.technicianId, technicianId),
            eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
          )
        );
      // Exactly one decrement, not N -- the winning caller's decrement
      // only; losers never reach syncMovingInventory because their
      // deliverItem() call throws before that line.
      expect(movingEntry?.units).toBe(startingUnits - 1);
      expect(movingEntry?.units).toBeGreaterThanOrEqual(0); // never negative/invalid
    }, 30000);
  }

  it("single-request success path: an uncontested delivery still succeeds and records history correctly", async () => {
    const technicianId = await seedTechnician("solo");
    const adminId = await seedTechnician("admin-solo");
    const { itemId, itemTypeId } = await seedItemInCustodyWithMovingEntry(technicianId, 5);

    await expect(
      db.transaction((tx) => CustodyEngine.deliverItem(itemId, "ORD-SOLO", technicianId, adminId, tx))
    ).resolves.not.toThrow();

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("DELIVERED");
    expect(item?.currentOwnerId).toBeNull();

    const txRows = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
    expect(txRows).toHaveLength(1);

    const [movingEntry] = await db
      .select()
      .from(technicianMovingInventoryEntries)
      .where(
        and(
          eq(technicianMovingInventoryEntries.technicianId, technicianId),
          eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
        )
      );
    expect(movingEntry?.units).toBe(4);
  });

  it("delivering an item under a DIFFERENT technician than the actual owner is rejected before any write", async () => {
    const owner = await seedTechnician("real-owner");
    const impostor = await seedTechnician("impostor");
    const adminId = await seedTechnician("admin-mismatch");
    const { itemId } = await seedItemInCustodyWithMovingEntry(owner, 3);

    await expect(
      db.transaction((tx) => CustodyEngine.deliverItem(itemId, "ORD-MISMATCH", impostor, adminId, tx))
    ).rejects.toThrow(/ليس في عهدة/);

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RECEIVED_BY_TECHNICIAN");
    expect(item?.currentOwnerId).toBe(owner);

    const txRows = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
    expect(txRows).toHaveLength(0);
  });

  it("delivering an item that was already delivered (null owner) is rejected with the null-owner-specific message", async () => {
    const technicianId = await seedTechnician("already-null");
    const adminId = await seedTechnician("admin-already-null");
    const { itemId } = await seedItemInCustodyWithMovingEntry(technicianId, 2);

    // First delivery succeeds.
    await db.transaction((tx) => CustodyEngine.deliverItem(itemId, "ORD-FIRST", technicianId, adminId, tx));

    // A second, later (non-concurrent) attempt against the now-delivered
    // item must hit the explicit null-owner branch, not the generic
    // wrong-owner branch.
    await expect(
      db.transaction((tx) => CustodyEngine.deliverItem(itemId, "ORD-SECOND", technicianId, adminId, tx))
    ).rejects.toThrow(/تم تسليمه مسبقاً/);

    const txRows = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
    expect(txRows).toHaveLength(1); // still only the first, real delivery
  });
});
