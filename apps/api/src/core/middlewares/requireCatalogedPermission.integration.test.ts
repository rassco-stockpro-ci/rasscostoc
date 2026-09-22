/**
 * OPS-PERM-S2 — proves requireCatalogedPermission() is real backend
 * enforcement, not a cosmetic UI-only gate. Runs against the real app +
 * real registerRoutes() + a real isolated Postgres, same pattern as
 * security-foundation.test.ts — no mocked repository, no mocked evaluator.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "@server/app";
import { registerRoutes } from "@server/routes";
import { db } from "@core/config/db";
import { resetTestDatabase } from "@core/testing/foundation/db.helpers";
import { signTestToken } from "@core/testing/foundation/auth.helpers";
import { hashPassword } from "@server/utils/password";
import { permissionsContainer } from "@server/composition/permissions.container";
import { errorHandler } from "@core/errors/errorHandler";

const TABLES_UNDER_TEST = [
  "users",
  "regions",
  "employee_permission_overrides",
  "permission_change_audit",
];

describe("OPS-PERM-S2 — requireCatalogedPermission real backend enforcement", () => {
  let regionId: string;
  let adminId: string;
  let supervisorId: string;
  let supervisorNoRegionId: string;
  let technicianId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    await registerRoutes(app);
    // security-foundation.test.ts's own registerRoutes(app)-only boot never attaches
    // the production JSON error formatter (that only happens in server.ts, after
    // registerRoutes) — so any next(error) response here would otherwise render as
    // Express's default HTML error page instead of the real JSON shape. Registering
    // it here matches what server.ts actually does, so these assertions reflect
    // real production behavior, not a boot-harness gap.
    app.use(errorHandler);
    await resetTestDatabase(TABLES_UNDER_TEST);

    const { regions, users } = await import("@shared/schema");
    regionId = randomUUID();
    await db.insert(regions).values({ id: regionId, name: "OPS-PERM-S2 Test Region" });

    const passwordHash = await hashPassword("OpsPermS2TestPassword!1");
    adminId = randomUUID();
    supervisorId = randomUUID();
    supervisorNoRegionId = randomUUID();
    technicianId = randomUUID();

    await db.insert(users).values([
      {
        id: adminId,
        username: `s2.admin.${Date.now()}`,
        email: `s2.admin.${Date.now()}@test.invalid`,
        fullName: "S2 Test Admin",
        password: passwordHash,
        role: "admin",
        regionId,
      },
      {
        id: supervisorId,
        username: `s2.supervisor.${Date.now()}`,
        email: `s2.supervisor.${Date.now()}@test.invalid`,
        fullName: "S2 Test Supervisor",
        password: passwordHash,
        role: "supervisor",
        regionId,
      },
      {
        id: supervisorNoRegionId,
        username: `s2.supervisor.noregion.${Date.now()}`,
        email: `s2.supervisor.noregion.${Date.now()}@test.invalid`,
        fullName: "S2 Test Supervisor (no region)",
        password: passwordHash,
        role: "supervisor",
        regionId: null,
      },
      {
        id: technicianId,
        username: `s2.technician.${Date.now()}`,
        email: `s2.technician.${Date.now()}@test.invalid`,
        fullName: "S2 Test Technician",
        password: passwordHash,
        role: "technician",
        regionId,
      },
    ]);
  });

  afterAll(async () => {
    await resetTestDatabase(TABLES_UNDER_TEST);
  });

  function tokenFor(id: string, role: "admin" | "supervisor" | "technician", withRegion: boolean) {
    return signTestToken({ id, role, username: `s2-${role}`, regionId: withRegion ? regionId : null });
  }

  describe("courier.requests:view", () => {
    it("allowed: a supervisor with no override gets default-template access", async () => {
      const res = await request(app)
        .get("/api/courier/requests")
        .set("Authorization", `Bearer ${tokenFor(supervisorId, "supervisor", true)}`);
      expect(res.status).toBe(200);
    });

    it("allowed: admin is always allowed regardless of catalog state", async () => {
      const res = await request(app)
        .get("/api/courier/requests")
        .set("Authorization", `Bearer ${tokenFor(adminId, "admin", true)}`);
      expect(res.status).toBe(200);
    });

    it("unaffected: technician keeps its existing access — this gate only evaluates supervisor-role actors", async () => {
      const res = await request(app)
        .get("/api/courier/requests")
        .set("Authorization", `Bearer ${tokenFor(technicianId, "technician", true)}`);
      expect(res.status).toBe(200);
    });

    it("scope restriction works: a supervisor with no assigned region is denied REGION-scoped view access even though the default template grants it", async () => {
      const res = await request(app)
        .get("/api/courier/requests")
        .set("Authorization", `Bearer ${tokenFor(supervisorNoRegionId, "supervisor", false)}`);
      expect(res.status).toBe(403);
    });

    it("denied action fails / unauthorized direct API call fails: an explicit revoke is enforced server-side, not just hidden in the UI", async () => {
      await permissionsContainer.service.revokePermission(
        adminId,
        supervisorId,
        "courier.requests",
        "view",
        "OPS-PERM-S2 test: prove real enforcement"
      );

      const res = await request(app)
        .get("/api/courier/requests")
        .set("Authorization", `Bearer ${tokenFor(supervisorId, "supervisor", true)}`);
      expect(res.status).toBe(403);

      // Reset back to default so this test doesn't leak state into later ones.
      await permissionsContainer.service.resetPermission(
        adminId,
        supervisorId,
        "courier.requests",
        "view",
        "OPS-PERM-S2 test cleanup"
      );
    });
  });

  describe("courier.requests:update", () => {
    it("allowed: a supervisor with no override gets default-template access (permission gate runs before the route handler)", async () => {
      const res = await request(app)
        .put(`/api/courier/requests/${randomUUID()}`)
        .set("Authorization", `Bearer ${tokenFor(supervisorId, "supervisor", true)}`)
        .send({ notes: "OPS-PERM-S2 test" });
      // A nonexistent id is expected to fail downstream (404/500 depending on the
      // service) — the only thing this test proves is that the PERMISSION gate itself
      // did not block the request (403 would mean the gate fired).
      expect(res.status).not.toBe(403);
    });

    it("denied action fails: an explicit revoke is enforced server-side before the request reaches the controller", async () => {
      await permissionsContainer.service.revokePermission(
        adminId,
        supervisorId,
        "courier.requests",
        "update",
        "OPS-PERM-S2 test: prove real enforcement"
      );

      const res = await request(app)
        .put(`/api/courier/requests/${randomUUID()}`)
        .set("Authorization", `Bearer ${tokenFor(supervisorId, "supervisor", true)}`)
        .send({ notes: "OPS-PERM-S2 test" });
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("ليس لديك صلاحية للقيام بهذا الإجراء");

      await permissionsContainer.service.resetPermission(
        adminId,
        supervisorId,
        "courier.requests",
        "update",
        "OPS-PERM-S2 test cleanup"
      );
    });
  });

  describe("warehouse.transfers:view", () => {
    it("allowed: a supervisor with no override gets default-template access", async () => {
      const res = await request(app)
        .get("/api/warehouse-transfers")
        .set("Authorization", `Bearer ${tokenFor(supervisorId, "supervisor", true)}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("warehouse.inventory:view", () => {
    it("denied action fails: an explicit revoke is enforced server-side on this page too", async () => {
      await permissionsContainer.service.revokePermission(
        adminId,
        supervisorId,
        "warehouse.inventory",
        "view",
        "OPS-PERM-S2 test: prove real enforcement"
      );

      const res = await request(app)
        .get(`/api/warehouse-inventory/${randomUUID()}`)
        .set("Authorization", `Bearer ${tokenFor(supervisorId, "supervisor", true)}`);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("ليس لديك صلاحية للقيام بهذا الإجراء");
    });
  });

  describe("system.auditLogs:view (newly cataloged — GET /api/system-logs was previously requireAuth-only)", () => {
    it("allowed: a supervisor with no override gets default-template access", async () => {
      const res = await request(app)
        .get("/api/system-logs")
        .set("Authorization", `Bearer ${tokenFor(supervisorId, "supervisor", true)}`);
      expect(res.status).toBe(200);
    });

    it("allowed: admin is always allowed", async () => {
      const res = await request(app)
        .get("/api/system-logs")
        .set("Authorization", `Bearer ${tokenFor(adminId, "admin", true)}`);
      expect(res.status).toBe(200);
    });

    it("fixed: a technician (or any non-admin/non-supervisor role) is now denied — previously any authenticated role could read the full audit log", async () => {
      const res = await request(app)
        .get("/api/system-logs")
        .set("Authorization", `Bearer ${tokenFor(technicianId, "technician", true)}`);
      expect(res.status).toBe(403);
    });

    it("denied action fails: an explicit revoke is enforced server-side for a supervisor too", async () => {
      await permissionsContainer.service.revokePermission(
        adminId,
        supervisorId,
        "system.auditLogs",
        "view",
        "OPS-PERM-S2 test: prove real enforcement"
      );

      const res = await request(app)
        .get("/api/system-logs")
        .set("Authorization", `Bearer ${tokenFor(supervisorId, "supervisor", true)}`);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("ليس لديك صلاحية للقيام بهذا الإجراء");

      await permissionsContainer.service.resetPermission(
        adminId,
        supervisorId,
        "system.auditLogs",
        "view",
        "OPS-PERM-S2 test cleanup"
      );
    });
  });
});
