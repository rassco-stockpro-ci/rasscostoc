/**
 * Phase 3B security remediation — real HTTP-level proof for
 * PATCH /api/items/:id/status authorization.
 *
 * Companion to warehouse-transfer.updateItemStatus.authorization.test.ts
 * (service-level). This file proves the SAME boundary holds through the
 * real, unmocked route -> requireAuth -> requireAdmin -> controller ->
 * service -> DB chain via supertest against the real, fully-booted
 * application (same convention as object-level-authorization.test.ts),
 * per "do not rely only on unit tests."
 *
 * Only requireAuth is replaced (to inject a deterministic role without a
 * full JWT/session flow) -- requireAdmin and everything downstream,
 * including the service's own independent DB role re-check, are the real,
 * unmocked production implementations, against a real disposable Postgres.
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { app } from "../../../app";
import { registerRoutes } from "../../../routes";
import { AuthenticationError } from "@core/errors/AppError";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  warehouses,
  inventoryTransactions,
  itemHistoryLogs,
  custodyMovements,
} from "@shared/schema";

const { authState } = vi.hoisted(() => ({
  authState: {
    user: null as { id: string; username: string; role: string; regionId: string | null } | null,
  },
}));

vi.mock("@core/middlewares/auth.middleware", async () => {
  const actual = await vi.importActual<typeof import("@core/middlewares/auth.middleware")>(
    "@core/middlewares/auth.middleware"
  );
  return {
    ...actual,
    // Only requireAuth is replaced -- requireAdmin (and everything else,
    // including the service layer it eventually reaches) remains the REAL
    // implementation, so this genuinely exercises the production
    // authorization chain, not a bypassed mock.
    requireAuth: (req: any, _res: any, next: any) => {
      if (authState.user === null) {
        next(new AuthenticationError("Session expired"));
        return;
      }
      req.user = authState.user;
      next();
    },
  };
});

describe("Phase 3B — PATCH /api/items/:id/status is Admin-only (HTTP)", () => {
  const createdItemIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdItemTypeIds: string[] = [];
  const createdWarehouseIds: string[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database."
      );
    }
    // Real, full application boot (same convention as
    // object-level-authorization.test.ts) -- exercises the actual
    // registered route, not a hand-assembled minimal router.
    await registerRoutes(app);
  });

  afterEach(async () => {
    authState.user = null;
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
      username: `p3b-http-${label}-${id.slice(0, 8)}`,
      email: `p3b-http-${label}-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: `Phase3B HTTP ${label}`,
      role,
    });
    createdUserIds.push(id);
    return id;
  }

  async function seedScenario() {
    const ownerTechId = await seedUser("technician", "owner");
    const adminId = await seedUser("admin", "admin");

    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: `نوع-http-${itemTypeId.slice(0, 8)}`,
      nameEn: `Http-Type-${itemTypeId.slice(0, 8)}`,
      category: "device",
    });
    createdItemTypeIds.push(itemTypeId);

    const whId = randomUUID();
    await db.insert(warehouses).values({
      id: whId,
      name: `HTTP Authz WH ${whId.slice(0, 8)}`,
      location: "Test",
      createdBy: adminId,
    });
    createdWarehouseIds.push(whId);

    const itemId = randomUUID();
    const serial = `P3BHTTP-${itemId.slice(0, 10)}`.toUpperCase();
    await db.insert(items).values({
      id: itemId,
      itemTypeId,
      serialNumber: serial,
      barcode: serial,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerTechId,
    });
    createdItemIds.push(itemId);

    return { ownerTechId, adminId, whId, itemId };
  }

  it("1. unauthenticated request receives 401, handler never reached", async () => {
    const { itemId } = await seedScenario();
    authState.user = null;

    const res = await request(app)
      .patch(`/api/items/${itemId}/status`)
      .send({ status: "RETURNED" });

    expect(res.status).toBe(401);
    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RECEIVED_BY_TECHNICIAN");
  });

  it("2. an authenticated attacker (unrelated technician, not the owner) receives 403 with zero mutation", async () => {
    const { itemId, whId, ownerTechId } = await seedScenario();
    const attackerId = await seedUser("technician", "attacker");
    authState.user = { id: attackerId, username: "http-attacker", role: "technician", regionId: null };

    const res = await request(app)
      .patch(`/api/items/${itemId}/status`)
      .send({ status: "RETURNED", warehouseId: whId });

    expect(res.status).toBe(403);

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RECEIVED_BY_TECHNICIAN");
    expect(item?.currentOwnerId).toBe(ownerTechId);

    const tx = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
    const hist = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
    const mov = await db.select().from(custodyMovements).where(eq(custodyMovements.itemId, itemId));
    expect(tx).toHaveLength(0);
    expect(hist).toHaveLength(0);
    expect(mov).toHaveLength(0);
  });

  it("3. the item's own technician owner (still not an admin) also receives 403 -- not a self-service path", async () => {
    const { itemId, whId, ownerTechId } = await seedScenario();
    authState.user = { id: ownerTechId, username: "http-owner", role: "technician", regionId: null };

    const res = await request(app)
      .patch(`/api/items/${itemId}/status`)
      .send({ status: "RETURNED", warehouseId: whId });

    expect(res.status).toBe(403);
    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RECEIVED_BY_TECHNICIAN");
  });

  it.each(["supervisor", "courier_supervisor", "warehouse", "viewer"])(
    "4. authenticated %s role is denied with 403 (handler never reached)",
    async (role) => {
      const { itemId, whId } = await seedScenario();
      authState.user = { id: randomUUID(), username: `http-${role}`, role, regionId: null };

      const res = await request(app)
        .patch(`/api/items/${itemId}/status`)
        .send({ status: "RETURNED", warehouseId: whId });

      expect(res.status).toBe(403);
      const [item] = await db.select().from(items).where(eq(items.id, itemId));
      expect(item?.status).toBe("RECEIVED_BY_TECHNICIAN");
    }
  );

  it("5. a genuine admin request succeeds end-to-end with correct state and audit identity", async () => {
    const { itemId, whId, adminId } = await seedScenario();
    authState.user = { id: adminId, username: "http-admin", role: "admin", regionId: null };

    const res = await request(app)
      .patch(`/api/items/${itemId}/status`)
      .send({ status: "RETURNED", warehouseId: whId });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item?.status).toBe("RETURNED");
    expect(item?.currentOwnerId).toBeNull();

    const hist = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
    const mov = await db.select().from(custodyMovements).where(eq(custodyMovements.itemId, itemId));
    expect(hist).toHaveLength(1);
    expect(mov).toHaveLength(1);
    expect(hist[0]!.changedById).toBe(adminId);
    expect(mov[0]!.performedById).toBe(adminId);
  });

  it("6. a representative unrelated route on the same router is NOT newly Admin-only (regression safety)", async () => {
    const { adminId } = await seedScenario();
    const techId = await seedUser("technician", "regression-check");
    authState.user = { id: techId, username: "http-regression", role: "technician", regionId: null };

    const res = await request(app).get(`/api/technicians/${techId}/serialized-items`);
    expect(res.status).not.toBe(403);
    void adminId;
  });
});
