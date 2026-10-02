/**
 * Custody/Inventory Performance Certification — Scenario E remediation,
 * HTTP-level proof.
 *
 * Companion to inventory-scan.idempotency-concurrency.test.ts (service
 * level). This exercises the real, unmocked route -> controller -> service
 * -> DB chain via supertest against the real, fully-booted application
 * (same convention as items-status-authorization.routes.test.ts), per
 * "a green HTTP response matrix alone is insufficient" -- final DB state is
 * asserted directly, not inferred from status codes.
 *
 * Only requireAuth is replaced (to inject a deterministic actor without a
 * full JWT/session flow) -- everything downstream is the real, unmocked
 * production implementation against a real disposable Postgres.
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { app } from "../../../app";
import { registerRoutes } from "../../../routes";
import { AuthenticationError } from "@core/errors/AppError";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  warehouses,
  warehouseInventoryEntries,
  stockMovements,
  systemLogs,
  idempotencyKeys,
} from "@shared/schema";

const { authState } = vi.hoisted(() => ({
  authState: {
    user: null as { id: string; username: string; role: string; regionId: string | null } | null,
  },
}));

vi.mock("@core/middlewares/auth.middleware", async () => {
  const actual = await vi.importActual<typeof import("@core/middlewares/auth.middleware")>(
    "@core/middlewares/auth.middleware",
  );
  return {
    ...actual,
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

describe("Scenario E remediation — POST /api/inventory-scan/execute idempotency concurrency (HTTP)", () => {
  let warehouseId: string;
  let adminId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    await registerRoutes(app);

    adminId = randomUUID();
    await db.insert(users).values({
      id: adminId,
      username: `p4-idem-http-admin-${adminId.slice(0, 8)}`,
      email: `p4-idem-http-admin-${adminId.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "Phase4 Idempotency HTTP Admin",
      role: "admin",
    });

    warehouseId = randomUUID();
    await db.insert(warehouses).values({
      id: warehouseId,
      name: `P4 Idem HTTP Warehouse ${warehouseId.slice(0, 8)}`,
      location: "Test Location",
      createdBy: adminId,
    });
  });

  const createdItemTypeIds: string[] = [];

  afterEach(async () => {
    authState.user = null;
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
      nameAr: `نوع-http-${label}-${itemTypeId.slice(0, 8)}`,
      nameEn: `Http-${label}-Type-${itemTypeId.slice(0, 8)}`,
      category: "device",
    });
    createdItemTypeIds.push(itemTypeId);
    return itemTypeId;
  }

  for (const n of [20, 50]) {
    it(`N=${n} concurrent identical HTTP requests with the same idempotencyKey: exactly one business effect`, async () => {
      authState.user = { id: adminId, username: "p4-idem-http-admin", role: "admin", regionId: null };
      const itemTypeId = await seedItemType(`n${n}`);
      const idempotencyKey = `test-http-idem-n${n}-${randomUUID()}`;

      const body = {
        source: "scanner",
        operationType: "ADD_STOCK",
        itemCode: itemTypeId,
        packagingType: "unit",
        quantity: 1,
        ownerType: "warehouse",
        ownerId: warehouseId,
        idempotencyKey,
      };

      const responses = await Promise.all(
        Array.from({ length: n }, () => request(app).post("/api/inventory-scan/execute").send(body)),
      );

      const statusCounts: Record<number, number> = {};
      for (const res of responses) {
        statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
      }

      // Every response must be either 200 (fresh success or cached replay)
      // or 409 (in progress) -- never a 500, never an unhandled failure.
      for (const status of Object.keys(statusCounts).map(Number)) {
        expect([200, 409]).toContain(status);
      }

      const ok200 = responses.filter((r) => r.status === 200);
      const freshSuccesses = ok200.filter((r) => r.body?.duplicate === false);
      const cachedDuplicates = ok200.filter((r) => r.body?.duplicate === true);
      expect(freshSuccesses.length + cachedDuplicates.length).toBe(ok200.length);

      // exactlyOneBusinessSuccess, proven at the real HTTP layer
      expect(freshSuccesses).toHaveLength(1);

      // Final DB state -- not inferred from status codes.
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

      const idemRows = await db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, `inventory-scan:${idempotencyKey}`));
      expect(idemRows).toHaveLength(1);

      const movementRows = await db.select().from(stockMovements).where(eq(stockMovements.itemType, itemTypeId));
      expect(movementRows).toHaveLength(1);

      const logRows = await db
        .select()
        .from(systemLogs)
        .where(and(eq(systemLogs.action, "inventory_scan_execute"), eq(systemLogs.entityId, itemTypeId)));
      expect(logRows).toHaveLength(1);
    }, 30000);
  }
});
