/**
 * OPS-SEC-HOTFIX-LEADS-AUDIT-ADMIN-AUTHORIZATION
 *
 * Regression coverage for a confirmed broken-access-control bug: both
 * POST /api/leads/discovery/toggle-user-access and
 * POST /api/leads/discovery/clear-user-leads previously carried only
 * `requireAuth` — ANY authenticated account (technician, viewer, warehouse,
 * supervisor, courier_supervisor) could block/unblock any other account's
 * lead-discovery access, or delete another account's audit logs and
 * system_logs DB rows. Neither route checked req.user.role at all.
 *
 * Fix: both routes now also carry `requireAdmin`
 * (apps/api/src/core/middlewares/auth.middleware.ts), the repository's
 * existing canonical Admin authorization mechanism — a strict
 * `req.user.role === ROLES.ADMIN` check. This is NOT the legacy
 * `users.permissions` authority (removed in fee58cc / OPS-PERM series) and
 * does not reintroduce it.
 *
 * Only `requireAuth` is mocked below — to inject a deterministic
 * authenticated role — the real, unmocked `requireAdmin` middleware and the
 * real, unmodified `registerLeadDiscoveryAuditRoutes` are exercised via
 * supertest for every case. `@core/config/db`'s `pool.query` is mocked with
 * a spy (not left pointed at a real database — this module is intentionally
 * DB-free, see leads-foundation.smoke.test.ts) so that "zero mutation on
 * denial" can be proven directly: a denied request must never even reach
 * the pool.query call that performs the destructive DELETE.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { AuthenticationError } from "@core/errors/AppError";
import { errorHandler } from "../../core/errors/errorHandler";
import { registerLeadDiscoveryAuditRoutes } from "./leads-audit.routes";

const NON_ADMIN_ROLES = [
  "supervisor",
  "technician",
  "viewer",
  "courier_supervisor",
  "warehouse",
] as const;

const { authState, mockQuery } = vi.hoisted(() => ({
  authState: {
    user: { id: "hotfix-test-actor", username: "hotfix-test-actor", role: "admin" } as
      | { id: string; username: string; role: string }
      | null,
  },
  // Real system_logs DB access is intentionally never exercised here (this
  // module is designed to run without a database, see
  // leads-foundation.smoke.test.ts) — this spy proves whether the
  // destructive DELETE / audit INSERT was ever attempted, independent of
  // whether a real DB would be reachable.
  mockQuery: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
}));

vi.mock("@core/config/db", () => ({
  pool: { query: mockQuery },
  db: {},
}));

vi.mock("@core/middlewares/auth.middleware", async () => {
  const actual = await vi.importActual<typeof import("@core/middlewares/auth.middleware")>(
    "@core/middlewares/auth.middleware"
  );
  return {
    ...actual,
    // Only requireAuth is replaced — requireAdmin (and everything else)
    // remains the REAL implementation, so this genuinely exercises the
    // production authorization check, not a bypassed mock.
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

describe("OPS-SEC-HOTFIX-LEADS-AUDIT-ADMIN-AUTHORIZATION — lead-discovery admin endpoints are Admin-only", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    registerLeadDiscoveryAuditRoutes(app);
    app.use(errorHandler);
    mockQuery.mockClear();
    authState.user = { id: "hotfix-test-actor", username: "hotfix-test-actor", role: "admin" };
  });

  // ---------------------------------------------------------------------
  // Unauthenticated
  // ---------------------------------------------------------------------

  it("unauthenticated request to toggle-user-access is rejected 401 (before any admin check)", async () => {
    authState.user = null;
    const res = await request(app)
      .post("/api/leads/discovery/toggle-user-access")
      .send({ userName: "irrelevant-target", allow: false });
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("unauthenticated request to clear-user-leads is rejected 401 (before any admin check)", async () => {
    authState.user = null;
    const res = await request(app)
      .post("/api/leads/discovery/clear-user-leads")
      .send({ userName: "irrelevant-target" });
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Non-admin roles denied — toggle-user-access — and zero mutation proven
  // ---------------------------------------------------------------------

  it.each(NON_ADMIN_ROLES)(
    "authenticated %s is denied 403 attempting toggle-user-access, and the target account is left completely unblocked",
    async (role) => {
      const target = `victim-toggle-${role}`;

      authState.user = { id: target, username: target, role };
      const res = await request(app)
        .post("/api/leads/discovery/toggle-user-access")
        .send({ userName: target, allow: false });
      expect(res.status).toBe(403);

      // Prove zero mutation: authenticate AS the would-be victim and confirm
      // their own access was never touched by the denied request.
      authState.user = { id: target, username: target, role: "technician" };
      const check = await request(app).get("/api/leads/discovery/check-access");
      expect(check.status).toBe(200);
      expect(check.body.allowed).toBe(true);
    }
  );

  // ---------------------------------------------------------------------
  // Non-admin roles denied — clear-user-leads — and zero mutation proven
  // ---------------------------------------------------------------------

  it.each(NON_ADMIN_ROLES)(
    "authenticated %s is denied 403 attempting clear-user-leads, and no DB/in-memory mutation is attempted",
    async (role) => {
      const target = `victim-clear-${role}`;

      // Seed one real discovery log entry for the target account.
      authState.user = { id: target, username: target, role: "technician" };
      const logRes = await request(app)
        .post("/api/leads/discovery/log")
        .send({ leadsFound: 3, newLeadsCount: 2, searchMode: "CURRENT_LOCATION", regionName: "Test Region" });
      expect(logRes.status).toBe(201);

      mockQuery.mockClear();

      authState.user = { id: `${target}-attacker`, username: `${target}-attacker`, role };
      const res = await request(app)
        .post("/api/leads/discovery/clear-user-leads")
        .send({ userName: target });
      expect(res.status).toBe(403);
      // The handler (which issues the DELETE FROM system_logs query) must
      // never have been reached.
      expect(mockQuery).not.toHaveBeenCalled();

      // Prove the seeded log survives: it is still visible in the audit
      // summary for the target account.
      authState.user = { id: "hotfix-test-actor", username: "hotfix-test-actor", role: "admin" };
      const summary = await request(app).get("/api/leads/discovery/audit-summary");
      expect(summary.status).toBe(200);
      const userSummary = summary.body.userSummaries.find((u: any) => u.userName === target);
      expect(userSummary).toBeDefined();
      expect(userSummary.scrapesCount).toBeGreaterThanOrEqual(1);
    }
  );

  // ---------------------------------------------------------------------
  // Admin allowed — mutation actually occurs
  // ---------------------------------------------------------------------

  it("authenticated Admin passes requireAdmin and reaches the handler for toggle-user-access, actually blocking the target account", async () => {
    const target = "victim-toggle-admin-allowed";

    authState.user = { id: "hotfix-admin", username: "hotfix-admin", role: "admin" };
    const res = await request(app)
      .post("/api/leads/discovery/toggle-user-access")
      .send({ userName: target, allow: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Confirm the mutation actually took effect for the target account.
    authState.user = { id: target, username: target, role: "technician" };
    const check = await request(app).get("/api/leads/discovery/check-access");
    expect(check.status).toBe(403);
    expect(check.body.allowed).toBe(false);
    expect(check.body.error).toBe("DISCOVERY_BLOCKED");
  });

  it("authenticated Admin passes requireAdmin and reaches the handler for clear-user-leads, actually deleting the target account's logged data", async () => {
    const target = "victim-clear-admin-allowed";

    // Seed one real discovery log entry for the target account.
    authState.user = { id: target, username: target, role: "technician" };
    const logRes = await request(app)
      .post("/api/leads/discovery/log")
      .send({ leadsFound: 5, newLeadsCount: 4, searchMode: "CURRENT_LOCATION", regionName: "Test Region" });
    expect(logRes.status).toBe(201);

    mockQuery.mockClear();

    authState.user = { id: "hotfix-admin", username: "hotfix-admin", role: "admin" };
    const res = await request(app)
      .post("/api/leads/discovery/clear-user-leads")
      .send({ userName: target });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The handler reached and issued the real DELETE against system_logs.
    expect(mockQuery).toHaveBeenCalled();
    const deleteCall = mockQuery.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM system_logs"));
    expect(deleteCall).toBeDefined();

    // Confirm the in-memory mutation actually took effect: the target no
    // longer appears in the audit summary.
    const summary = await request(app).get("/api/leads/discovery/audit-summary");
    expect(summary.status).toBe(200);
    const userSummary = summary.body.userSummaries.find((u: any) => u.userName === target);
    expect(userSummary).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Regression safety: read-only routes are unaffected by this hotfix
  // ---------------------------------------------------------------------

  it("a non-admin can still use the unrelated read-only check-access route (regression safety)", async () => {
    authState.user = { id: "regression-actor", username: "regression-actor", role: "technician" };
    const res = await request(app).get("/api/leads/discovery/check-access");
    expect(res.status).not.toBe(403);
  });
});
