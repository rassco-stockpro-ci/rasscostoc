/**
 * TEMP-SYSTEM-STABILIZATION-F2 — regression tests for:
 *   B. Password DTO filtering (toMinimalTechnicianView)
 *   D. Mass-assignment hardening on PATCH /api/technicians/:id
 *   E. Active-operation deactivation guard (custody / transfer / courier)
 *   F. Audit log secret filtering
 *
 * Runs only against an isolated Postgres test database.
 */
import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../../../core/config/db";
import {
  users,
  itemTypes,
  items,
  warehouses,
  warehouseTransfers,
  courierRequests,
  courierRequestItems,
  systemLogs,
} from "@shared/schema";
import { TechniciansController, toMinimalTechnicianView } from "../presentation/controllers/technicians.controller";

/**
 * asyncHandler(fn) returns (req,res,next) => { Promise.resolve(fn(...)).catch(next) }
 * — it does NOT return/reject the inner promise itself, errors go to next(err)
 * instead. This harness calls the (already asyncHandler-wrapped) controller
 * method and resolves once either res.json() or next(err) fires.
 */
function invoke(
  handler: (req: any, res: any, next: any) => void,
  overrides: { user: any; params?: any; body?: any }
): Promise<{ json: any; error: any }> {
  const req: any = {
    user: overrides.user,
    params: overrides.params || {},
    body: overrides.body || {},
  };
  return new Promise((resolve) => {
    const res: any = {
      json(payload: any) {
        resolve({ json: payload, error: null });
        return res;
      },
      status() {
        return res;
      },
    };
    const next = (err: any) => resolve({ json: null, error: err });
    handler(req, res, next);
  });
}

describe("TEMP-STABILIZATION — TechniciansController", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL must be an isolated test database.");
    }
  });

  const controller = new TechniciansController();
  const createdUserIds: string[] = [];
  const createdItemIds: string[] = [];
  const createdItemTypeIds: string[] = [];
  const createdWarehouseIds: string[] = [];
  const createdTransferIds: string[] = [];
  const createdCourierRequestIds: number[] = [];

  afterEach(async () => {
    for (const id of createdCourierRequestIds.splice(0)) {
      await db.delete(courierRequests).where(eq(courierRequests.id, id)).catch(() => {});
    }
    for (const id of createdTransferIds.splice(0)) {
      await db.delete(warehouseTransfers).where(eq(warehouseTransfers.id, id)).catch(() => {});
    }
    for (const id of createdItemIds.splice(0)) {
      await db.delete(items).where(eq(items.id, id)).catch(() => {});
    }
    for (const id of createdWarehouseIds.splice(0)) {
      await db.delete(warehouses).where(eq(warehouses.id, id)).catch(() => {});
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(systemLogs).where(eq(systemLogs.entityId, id)).catch(() => {});
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
  });

  async function seedUser(role: "technician" | "admin", password = "super-secret-hash-value"): Promise<any> {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `stab-${role}-${id.slice(0, 8)}`,
      email: `stab-${role}-${id.slice(0, 8)}@test.local`,
      password,
      fullName: `Stabilization ${role}`,
      role,
    });
    createdUserIds.push(id);
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async function seedItemType(): Promise<string> {
    const id = `stabtype-${randomUUID().slice(0, 8)}`;
    await db.insert(itemTypes).values({ id, nameAr: "نوع", nameEn: "Type", category: "devices", isActive: true });
    createdItemTypeIds.push(id);
    return id;
  }

  // ── B. Password DTO filtering ──────────────────────────────────────────
  describe("B. toMinimalTechnicianView never leaks secrets", () => {
    it("strips password even when the input object carries it (defends the DTO boundary itself)", () => {
      const maliciousRawRow = {
        id: "x",
        username: "u",
        fullName: "F",
        role: "technician",
        isActive: true,
        password: "SHOULD-NEVER-APPEAR",
        passwordHash: "SHOULD-NEVER-APPEAR-EITHER",
        refreshToken: "SHOULD-NEVER-APPEAR-EITHER",
      };
      const view = toMinimalTechnicianView(maliciousRawRow);
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("SHOULD-NEVER-APPEAR");
      expect(view).not.toHaveProperty("password");
      expect(view).not.toHaveProperty("passwordHash");
      expect(view).not.toHaveProperty("refreshToken");
    });

    it("GET /api/technicians/:id response contains no password-shaped key, using a REAL seeded row", async () => {
      const technician = await seedUser("technician");
      const admin = await seedUser("admin");
      const { json } = await invoke(controller.getById, { user: admin, params: { id: technician.id } });
      expect(JSON.stringify(json)).not.toContain(technician.password);
      expect(json).not.toHaveProperty("password");
    });
  });

  // ── D. Mass assignment hardening ───────────────────────────────────────
  describe("D. PATCH /api/technicians/:id — mass assignment must be impossible", () => {
    it("malicious payload cannot change role/password/permissions/isActive", async () => {
      const technician = await seedUser("technician");
      const admin = await seedUser("admin");
      const originalPassword = technician.password;

      const { json } = await invoke(controller.update, {
        user: admin,
        params: { id: technician.id },
        body: {
          fullName: "Allowed New Name",
          role: "admin",
          password: "attacker-value",
          permissions: JSON.stringify(["*"]),
          isActive: false,
        },
      });

      const [reloaded] = await db.select().from(users).where(eq(users.id, technician.id));
      expect(reloaded.role).toBe("technician"); // unchanged
      expect(reloaded.password).toBe(originalPassword); // unchanged
      expect(reloaded.isActive).toBe(true); // unchanged
      expect(reloaded.fullName).toBe("Allowed New Name"); // the one allowed field DID change

      // and the response itself must not leak the password either
      expect(JSON.stringify(json)).not.toContain(originalPassword);
    });
  });

  // ── E. Active-operation deactivation guard ─────────────────────────────
  describe("E. DELETE /api/technicians/:id — active-operation guard", () => {
    it("blocks deactivation when technician holds active serialized custody (409)", async () => {
      const technician = await seedUser("technician");
      const admin = await seedUser("admin");
      const itemTypeId = await seedItemType();
      const itemId = randomUUID();
      await db.insert(items).values({
        id: itemId,
        itemTypeId,
        serialNumber: `STAB${itemId.slice(0, 12)}`,
        barcode: `STAB${itemId.slice(0, 12)}`,
        status: "RECEIVED_BY_TECHNICIAN",
        currentOwnerId: technician.id,
      });
      createdItemIds.push(itemId);

      const { error } = await invoke(controller.delete, { user: admin, params: { id: technician.id } });
      expect(error?.statusCode).toBe(409);

      const [reloaded] = await db.select().from(users).where(eq(users.id, technician.id));
      expect(reloaded.isActive).toBe(true); // deactivation did NOT happen
    });

    it("blocks deactivation when technician has an in-progress warehouse transfer (409)", async () => {
      const technician = await seedUser("technician");
      const admin = await seedUser("admin");
      const warehouseId = randomUUID();
      await db.insert(warehouses).values({ id: warehouseId, name: "Stab WH", location: "x", createdBy: admin.id });
      createdWarehouseIds.push(warehouseId);
      const itemTypeId = await seedItemType();
      const transferId = randomUUID();
      await db.insert(warehouseTransfers).values({
        id: transferId,
        warehouseId,
        technicianId: technician.id,
        itemType: itemTypeId,
        packagingType: "unit",
        quantity: 1,
        performedBy: admin.id,
        status: "pending",
      });
      createdTransferIds.push(transferId);

      const { error } = await invoke(controller.delete, { user: admin, params: { id: technician.id } });
      expect(error?.statusCode).toBe(409);

      const [reloaded] = await db.select().from(users).where(eq(users.id, technician.id));
      expect(reloaded.isActive).toBe(true);
    });

    it("blocks deactivation when technician has a non-terminal courier request (409)", async () => {
      const technician = await seedUser("technician");
      const admin = await seedUser("admin");

      const [request] = await db.insert(courierRequests).values({}).returning({ id: courierRequests.id });
      createdCourierRequestIds.push(request.id);
      await db.insert(courierRequestItems).values({
        requestId: request.id,
        itemType: "POS",
        technicianId: technician.id,
        status: "RECEIVED",
      });

      const { error } = await invoke(controller.delete, { user: admin, params: { id: technician.id } });
      expect(error?.statusCode).toBe(409);

      const [reloaded] = await db.select().from(users).where(eq(users.id, technician.id));
      expect(reloaded.isActive).toBe(true);
    });

    it("allows deactivation (soft delete) when there are no active operational dependencies", async () => {
      const technician = await seedUser("technician");
      const admin = await seedUser("admin");

      const { json, error } = await invoke(controller.delete, { user: admin, params: { id: technician.id } });
      expect(error).toBeNull();
      expect(json).toMatchObject({ message: "Technician deleted successfully" });

      const [reloaded] = await db.select().from(users).where(eq(users.id, technician.id));
      // Soft delete only — row must still exist.
      expect(reloaded).toBeDefined();
      expect(reloaded.isActive).toBe(false);
    });

    it("a courier request in a TERMINAL status does not block deactivation", async () => {
      const technician = await seedUser("technician");
      const admin = await seedUser("admin");

      const [request] = await db.insert(courierRequests).values({}).returning({ id: courierRequests.id });
      createdCourierRequestIds.push(request.id);
      await db.insert(courierRequestItems).values({
        requestId: request.id,
        itemType: "POS",
        technicianId: technician.id,
        status: "DELIVERED",
      });

      const { json, error } = await invoke(controller.delete, { user: admin, params: { id: technician.id } });
      expect(error).toBeNull();
      expect(json).toMatchObject({ message: "Technician deleted successfully" });
      const [reloaded] = await db.select().from(users).where(eq(users.id, technician.id));
      expect(reloaded.isActive).toBe(false);
    });
  });

  // ── F. Audit log secret filtering ──────────────────────────────────────
  describe("F. Audit log never contains password/secrets", () => {
    it("technician update writes an audit row with no password in details", async () => {
      const technician = await seedUser("technician");
      const admin = await seedUser("admin");
      const secretValue = technician.password;

      await invoke(controller.update, {
        user: admin,
        params: { id: technician.id },
        body: { fullName: "Audited Name" },
      });

      const [log] = await db
        .select()
        .from(systemLogs)
        .where(and(eq(systemLogs.entityId, technician.id), eq(systemLogs.action, "update")))
        .orderBy(desc(systemLogs.createdAt))
        .limit(1);

      expect(log).toBeDefined();
      expect(log.userId).toBe(admin.id);
      expect(log.entityId).toBe(technician.id);
      expect(log.details).not.toContain(secretValue);
      expect(log.details).not.toContain("password");
    });

    it("technician deactivation writes an audit row with no password in details", async () => {
      const technician = await seedUser("technician");
      const admin = await seedUser("admin");
      const secretValue = technician.password;

      await invoke(controller.delete, { user: admin, params: { id: technician.id } });

      const [log] = await db
        .select()
        .from(systemLogs)
        .where(and(eq(systemLogs.entityId, technician.id), eq(systemLogs.action, "deactivate")))
        .orderBy(desc(systemLogs.createdAt))
        .limit(1);

      expect(log).toBeDefined();
      expect(log.details).not.toContain(secretValue);
      expect(log.details).not.toContain("password");
    });
  });
});
