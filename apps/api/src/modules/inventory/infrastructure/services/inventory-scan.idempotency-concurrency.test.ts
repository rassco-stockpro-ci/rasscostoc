/**
 * Custody/Inventory Performance Certification — Scenario E remediation.
 *
 * Proves the fix for a real, empirically-confirmed defect found during
 * load testing of POST /api/inventory-scan/execute: 20 concurrent requests
 * sharing one idempotencyKey produced 12 HTTP 200s, a warehouse balance
 * delta of 4 instead of 1, and 20 duplicate audit-log rows instead of 1.
 *
 * Root cause was two interacting races in InventoryScanService:
 *   1. checkIdempotency() ran a plain SELECT against systemLogs before the
 *      transaction opened, with the durable record written only after
 *      commit -- a wide TOCTOU window.
 *   2. adjustWarehouseBalance()/adjustTechnicianMovingBalance() did a
 *      non-locked read-then-write with an absolute SET computed from a
 *      stale read -- a classic lost update.
 *
 * The fix reuses the same DB-backed atomic primitive already proven in
 * core/middlewares/idempotency.middleware.ts (idempotency_keys, key as
 * PRIMARY KEY) for (1), and the same lock-an-always-existing-anchor-first
 * pattern already proven in
 * DrizzleWithdrawTechnicianInventoryToWarehouseUnitOfWork (Phase C4.6C.2)
 * for (2). This file proves both hold under real concurrent Postgres
 * transactions through the real, unmocked service.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../core/config/db";
import { inventoryScanService, InventoryScanError, type InventoryScanActor } from "./inventory-scan.service";
import {
  users,
  itemTypes,
  warehouses,
  warehouseInventoryEntries,
  stockMovements,
  systemLogs,
  idempotencyKeys,
} from "@shared/schema";

describe("Scenario E remediation — InventoryScanService idempotency + balance concurrency", () => {
  let warehouseId: string;
  let warehouseCreatorId: string;
  let actor: InventoryScanActor;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }

    warehouseCreatorId = randomUUID();
    await db.insert(users).values({
      id: warehouseCreatorId,
      username: `p4-idem-admin-${warehouseCreatorId.slice(0, 8)}`,
      email: `p4-idem-admin-${warehouseCreatorId.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "Phase4 Idempotency Admin",
      role: "admin",
    });
    actor = {
      id: warehouseCreatorId,
      username: "p4-idem-admin",
      role: "admin",
      regionId: null,
    };

    warehouseId = randomUUID();
    await db.insert(warehouses).values({
      id: warehouseId,
      name: `P4 Idem Warehouse ${warehouseId.slice(0, 8)}`,
      location: "Test Location",
      createdBy: warehouseCreatorId,
    });
  });

  afterAll(async () => {
    await db.delete(warehouses).where(eq(warehouses.id, warehouseId)).catch(() => {});
    await db.delete(users).where(eq(users.id, warehouseCreatorId)).catch(() => {});
  });

  const createdItemTypeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(warehouseInventoryEntries).where(eq(warehouseInventoryEntries.itemTypeId, id)).catch(() => {});
      await db.delete(stockMovements).where(eq(stockMovements.itemType, id)).catch(() => {});
      await db.delete(systemLogs).where(eq(systemLogs.entityId, id)).catch(() => {});
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
  });

  async function seedItemType(label: string) {
    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: `نوع-${label}-${itemTypeId.slice(0, 8)}`,
      nameEn: `${label}-Type-${itemTypeId.slice(0, 8)}`,
      category: "device",
    });
    createdItemTypeIds.push(itemTypeId);
    return itemTypeId;
  }

  const RACE_LEVELS = [2, 5, 10, 20, 50];

  for (const n of RACE_LEVELS) {
    it(`N=${n} concurrent requests sharing one idempotency key: exactly one business effect`, async () => {
      const itemTypeId = await seedItemType(`race-n${n}`);
      const idempotencyKey = `test-idem-n${n}-${randomUUID()}`;

      const input = {
        source: "scanner" as const,
        operationType: "ADD_STOCK" as const,
        itemCode: itemTypeId,
        packagingType: "unit" as const,
        quantity: 1,
        ownerType: "warehouse" as const,
        ownerId: warehouseId,
        idempotencyKey,
      };

      const results = await Promise.allSettled(
        Array.from({ length: n }, () => inventoryScanService.execute(input, actor)),
      );

      expect(results).toHaveLength(n);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      // Every non-winning outcome must be the deterministic, clean 409
      // "in progress" path -- never a raw/unexpected exception.
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(InventoryScanError);
        expect((r.reason as InventoryScanError).statusCode).toBe(409);
      }

      const freshSuccesses = fulfilled.filter((r) => r.value?.duplicate === false);
      const cachedDuplicates = fulfilled.filter((r) => r.value?.duplicate === true);
      expect(freshSuccesses.length + cachedDuplicates.length).toBe(fulfilled.length);

      // exactlyOneBusinessSuccess
      expect(freshSuccesses).toHaveLength(1);

      // warehouseDelta = expectedSingleDelta (1x quantity, never Nx --
      // this is the exact lost-update reproduction from the original find)
      const [entry] = await db
        .select()
        .from(warehouseInventoryEntries)
        .where(
          and(
            eq(warehouseInventoryEntries.warehouseId, warehouseId),
            eq(warehouseInventoryEntries.itemTypeId, itemTypeId),
          ),
        );
      expect(Number(entry?.units || 0)).toBe(1);

      // idempotencyRecordCount = 1 (namespaced key)
      const idemRows = await db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, `inventory-scan:${idempotencyKey}`));
      expect(idemRows).toHaveLength(1);

      // One real business-effect side record, not N
      const movementRows = await db.select().from(stockMovements).where(eq(stockMovements.itemType, itemTypeId));
      expect(movementRows).toHaveLength(1);

      // systemLogCount = 1 -- only the winner logs; 409-rejections throw
      // before reaching logScanEvent, and cached-duplicate replays never
      // re-execute service logic.
      const logRows = await db
        .select()
        .from(systemLogs)
        .where(and(eq(systemLogs.action, "inventory_scan_execute"), eq(systemLogs.entityId, itemTypeId)));
      expect(logRows).toHaveLength(1);

      // inventory_transactions / custody_movements: not applicable to this
      // operation (warehouse-quantity scan, not a serialized custody item)
      // -- no such rows are ever written by this path, verified separately
      // by the D5 custody-engine test suite for the item-custody path.
    }, 30000);
  }

  it("20 concurrent DISTINCT (non-duplicate) increments to the same warehouse balance: no lost update", async () => {
    const itemTypeId = await seedItemType("balance-race");
    const N = 20;

    const requests = Array.from({ length: N }, (_, i) =>
      inventoryScanService.execute(
        {
          source: "scanner" as const,
          operationType: "ADD_STOCK" as const,
          itemCode: itemTypeId,
          packagingType: "unit" as const,
          quantity: 1,
          ownerType: "warehouse" as const,
          ownerId: warehouseId,
          idempotencyKey: `balance-race-${i}-${randomUUID()}`,
        },
        actor,
      ),
    );

    const results = await Promise.allSettled(requests);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    if (failed.length > 0) {
      // Surface the real reason on failure for diagnosability rather than
      // a bare length-mismatch assertion.
      throw failed[0].reason;
    }

    expect(succeeded).toHaveLength(N);

    const [entry] = await db
      .select()
      .from(warehouseInventoryEntries)
      .where(
        and(
          eq(warehouseInventoryEntries.warehouseId, warehouseId),
          eq(warehouseInventoryEntries.itemTypeId, itemTypeId),
        ),
      );

    // final balance = initial balance (0) + sum(all N independent +1 deltas)
    expect(Number(entry?.units || 0)).toBe(N);
  }, 120000);

  it("a single request with insufficient warehouse balance is still rejected, balance unchanged (negative-balance guard intact under the new locking)", async () => {
    const itemTypeId = await seedItemType("negative-guard");

    await expect(
      inventoryScanService.execute(
        {
          source: "scanner" as const,
          operationType: "DEDUCT_STOCK" as const,
          itemCode: itemTypeId,
          packagingType: "unit" as const,
          quantity: 5,
          ownerType: "warehouse" as const,
          ownerId: warehouseId,
          idempotencyKey: `negative-guard-${randomUUID()}`,
        },
        actor,
      ),
    ).rejects.toThrow(/الرصيد غير كافٍ/);

    const [entry] = await db
      .select()
      .from(warehouseInventoryEntries)
      .where(
        and(
          eq(warehouseInventoryEntries.warehouseId, warehouseId),
          eq(warehouseInventoryEntries.itemTypeId, itemTypeId),
        ),
      );
    expect(Number(entry?.units || 0)).toBe(0);
  }, 30000);
});
