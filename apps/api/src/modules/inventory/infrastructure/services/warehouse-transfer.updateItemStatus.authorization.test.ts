/**
 * Phase 3B security remediation — Broken Access Control on
 * PATCH /api/items/:id/status.
 *
 * WarehouseTransferService.updateItemStatus() is an administrative
 * override capable of forcing ANY item to DELIVERED/RETURNED regardless
 * of who currently owns it. It previously trusted its caller completely:
 * the route had only requireAuth (any authenticated role), the controller
 * did no role check, and the service itself substituted the item's own
 * currentOwnerId for the ownership-check subject -- comparing the owner
 * to itself, which always passed. A real disposable-Postgres PoC proved
 * an unrelated, non-admin technician could force another technician's
 * item into RETURNED via a single call.
 *
 * Fix: the route now also requires requireAdmin, and (per "the service
 * must not assume route middleware already proved authorization") this
 * method independently re-verifies the caller's role fresh from the DB
 * using only their id.
 *
 * Runs against a real disposable Postgres -- no mocks for the
 * authorization semantics under test.
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../../core/config/db";
import { WarehouseTransferService } from "./warehouse-transfer.service";
import {
  users,
  itemTypes,
  items,
  warehouses,
  inventoryTransactions,
  itemHistoryLogs,
  custodyMovements,
} from "@shared/schema";

describe("Phase 3B — WarehouseTransferService.updateItemStatus() authorization", () => {
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
  const createdWarehouseIds: string[] = [];

  afterEach(async () => {
    for (const id of createdItemIds.splice(0)) {
      await db.delete(inventoryTransactions).where(eq(inventoryTransactions.itemId, id)).catch(() => {});
      await db.delete(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, id)).catch(() => {});
      await db.delete(custodyMovements).where(eq(custodyMovements.itemId, id)).catch(() => {});
      await db.delete(items).where(eq(items.id, id)).catch(() => {});
    }
    for (const id of createdWarehouseIds.splice(0)) {
      await db.delete(warehouses).where(eq(warehouses.id, id)).catch(() => {});
    }
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
  });

  async function seedUser(role: string, label: string) {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `p3b-authz-${label}-${id.slice(0, 8)}`,
      email: `p3b-authz-${label}-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: `Phase3B Authz ${label}`,
      role,
    });
    createdUserIds.push(id);
    return id;
  }

  async function seedScenario() {
    const ownerTechId = await seedUser("technician", "owner");
    const attackerTechId = await seedUser("technician", "attacker");
    const adminId = await seedUser("admin", "admin");

    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: `نوع-authz-${itemTypeId.slice(0, 8)}`,
      nameEn: `Authz-Type-${itemTypeId.slice(0, 8)}`,
      category: "device",
    });
    createdItemTypeIds.push(itemTypeId);

    const whId = randomUUID();
    await db.insert(warehouses).values({
      id: whId,
      name: `Authz WH ${whId.slice(0, 8)}`,
      location: "Test",
      createdBy: adminId,
    });
    createdWarehouseIds.push(whId);

    const itemId = randomUUID();
    const serial = `P3BAUTHZ-${itemId.slice(0, 10)}`.toUpperCase();
    await db.insert(items).values({
      id: itemId,
      itemTypeId,
      serialNumber: serial,
      barcode: serial,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerTechId,
    });
    createdItemIds.push(itemId);

    return { ownerTechId, attackerTechId, adminId, whId, itemId };
  }

  it("A. an unrelated, non-admin technician attacking another technician's item is rejected with zero mutation", async () => {
    const { attackerTechId, whId, itemId } = await seedScenario();
    const service = new WarehouseTransferService();

    await expect(
      service.updateItemStatus(attackerTechId, itemId, "RETURNED", undefined, whId)
    ).rejects.toMatchObject({ name: "AuthorizationError", statusCode: 403 });

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RECEIVED_BY_TECHNICIAN");
    expect(item?.currentOwnerId).not.toBeNull();

    const tx = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
    const hist = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
    const mov = await db.select().from(custodyMovements).where(eq(custodyMovements.itemId, itemId));
    expect(tx).toHaveLength(0);
    expect(hist).toHaveLength(0);
    expect(mov).toHaveLength(0);
  });

  it("B. an unauthorized role (the item's own technician owner, who is not an admin) is also rejected -- this is not a self-service path", async () => {
    const { ownerTechId, whId, itemId } = await seedScenario();
    const service = new WarehouseTransferService();

    await expect(
      service.updateItemStatus(ownerTechId, itemId, "RETURNED", undefined, whId)
    ).rejects.toMatchObject({ name: "AuthorizationError", statusCode: 403 });

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RECEIVED_BY_TECHNICIAN");
  });

  it("C. a legitimate admin caller succeeds, with the correct final state and correct audit identity", async () => {
    const { adminId, whId, itemId } = await seedScenario();
    const service = new WarehouseTransferService();

    const result = await service.updateItemStatus(adminId, itemId, "RETURNED", undefined, whId);
    expect(result).toEqual({ success: true });

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RETURNED");
    expect(item?.currentOwnerId).toBeNull();

    const hist = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
    const mov = await db.select().from(custodyMovements).where(eq(custodyMovements.itemId, itemId));
    expect(hist).toHaveLength(1);
    expect(mov).toHaveLength(1);
    // The recorded actor must be the ACTUAL caller (adminId) -- never the
    // item's own currentOwnerId, which is a completely different concept.
    expect(hist[0]!.changedById).toBe(adminId);
    expect(mov[0]!.performedById).toBe(adminId);
  });

  it("D. caller identity and item ownership are never silently interchanged: rejecting a non-admin caller is unaffected by whether that caller happens to be the item's owner", async () => {
    const { ownerTechId, attackerTechId, itemId, whId } = await seedScenario();
    const service = new WarehouseTransferService();

    // Both a non-owning technician and the actual owning technician are
    // rejected for the identical reason (not an admin) -- proving the
    // decision is driven by the CALLER's own role, never by comparing the
    // caller to item.currentOwnerId.
    const attackerResult = await service
      .updateItemStatus(attackerTechId, itemId, "RETURNED", undefined, whId)
      .catch((e) => e);
    const ownerResult = await service
      .updateItemStatus(ownerTechId, itemId, "RETURNED", undefined, whId)
      .catch((e) => e);

    expect(attackerResult).toMatchObject({ name: "AuthorizationError", statusCode: 403 });
    expect(ownerResult).toMatchObject({ name: "AuthorizationError", statusCode: 403 });
  });

  it("rejects a caller id that does not correspond to any real user", async () => {
    const { whId, itemId } = await seedScenario();
    const service = new WarehouseTransferService();

    await expect(
      service.updateItemStatus(randomUUID(), itemId, "RETURNED", undefined, whId)
    ).rejects.toMatchObject({ name: "AuthorizationError", statusCode: 403 });

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RECEIVED_BY_TECHNICIAN");
  });
});
