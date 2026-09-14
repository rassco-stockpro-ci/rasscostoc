/**
 * OPS-SEC-FOLLOWUP-LEADS-AUDIT-SUMMARY-READ-AUTHORIZATION
 *
 * Regression coverage for the Product/Security Owner-approved policy on
 * GET /api/leads/discovery/audit-summary: Admin and Supervisor only, GLOBAL
 * scope. courier_supervisor, technician, viewer, and warehouse are all
 * explicitly denied. courier_supervisor is the load-bearing case: it shares
 * ROLE_ORDER tier 3 with supervisor (packages/shared-types/roles.ts), so
 * the codebase's usual tier-based middlewares (requireSupervisor /
 * requireRole / hasRoleOrAbove) would have wrongly admitted it — this file
 * specifically proves the narrow allow-list in leads-audit.routes.ts
 * (requireAdminOrSupervisorExact) does NOT make that mistake.
 *
 * Only `requireAuth` is mocked below (to inject a deterministic role) — the
 * real, unmocked `requireAdminOrSupervisorExact` (defined locally in
 * leads-audit.routes.ts, not in auth.middleware.ts) and the real,
 * unmodified `registerLeadDiscoveryAuditRoutes` are exercised via supertest
 * for every case. `@core/config/db`'s `pool.query` is mocked with a spy so
 * "zero unauthorized data access" can be proven directly: a denied request
 * must never even reach the pool.query call inside the handler.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { AuthenticationError } from "@core/errors/AppError";
import { errorHandler } from "../../core/errors/errorHandler";
import { registerLeadDiscoveryAuditRoutes } from "./leads-audit.routes";

const AUTHORIZED_ROLES = ["admin", "supervisor"] as const;
const DENIED_ROLES = ["courier_supervisor", "technician", "viewer", "warehouse"] as const;

const { authState, mockQuery } = vi.hoisted(() => ({
  authState: {
    user: { id: "summary-test-actor", username: "summary-test-actor", role: "admin" } as
      | { id: string; username: string; role: string }
      | null,
  },
  // Real system_logs DB access is intentionally never exercised here (this
  // module is designed to run without a database, see
  // leads-foundation.smoke.test.ts) — this spy proves whether the
  // protected read (the SELECT inside the handler) was ever attempted.
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
    // Only requireAuth is replaced — every other export (requireAdmin,
    // etc.) stays the REAL implementation. requireAdminOrSupervisorExact
    // itself lives in leads-audit.routes.ts, which is not mocked at all, so
    // this genuinely exercises the production authorization check.
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

describe("OPS-SEC-FOLLOWUP-LEADS-AUDIT-SUMMARY-READ-AUTHORIZATION — audit-summary is Admin+Supervisor only", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    registerLeadDiscoveryAuditRoutes(app);
    app.use(errorHandler);
    mockQuery.mockClear();
    authState.user = { id: "summary-test-actor", username: "summary-test-actor", role: "admin" };
  });

  // ---------------------------------------------------------------------
  // 7. Unauthenticated -> 401
  // ---------------------------------------------------------------------

  it("unauthenticated request is rejected 401 (before any authorization check), zero data access", async () => {
    authState.user = null;
    const res = await request(app).get("/api/leads/discovery/audit-summary");
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 1 & 2. Admin / Supervisor -> 200 + expected data, GLOBAL scope preserved
  // ---------------------------------------------------------------------

  it.each(AUTHORIZED_ROLES)(
    "authenticated %s is allowed 200 and receives expected aggregate data across all users/regions (GLOBAL scope)",
    async (role) => {
      // Seed two distinct users' scrape activity, in two different "regions".
      authState.user = { id: "seed-user-alpha", username: "seed-user-alpha", role: "technician" };
      const seed1 = await request(app)
        .post("/api/leads/discovery/log")
        .send({ leadsFound: 4, newLeadsCount: 3, searchMode: "CURRENT_LOCATION", regionName: "Region Alpha" });
      expect(seed1.status).toBe(201);

      authState.user = { id: "seed-user-beta", username: "seed-user-beta", role: "technician" };
      const seed2 = await request(app)
        .post("/api/leads/discovery/log")
        .send({ leadsFound: 2, newLeadsCount: 1, searchMode: "CURRENT_LOCATION", regionName: "Region Beta" });
      expect(seed2.status).toBe(201);

      authState.user = { id: `summary-${role}-actor`, username: `summary-${role}-actor`, role };
      const res = await request(app).get("/api/leads/discovery/audit-summary");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.userSummaries)).toBe(true);

      // GLOBAL scope preserved exactly as approved: an authorized caller
      // sees BOTH seeded users across BOTH region labels, unfiltered — no
      // region filtering was invented.
      const names = res.body.userSummaries.map((u: any) => u.userName);
      expect(names).toContain("seed-user-alpha");
      expect(names).toContain("seed-user-beta");
      const regionNames = res.body.recentLogs.map((l: any) => l.regionName);
      expect(regionNames).toContain("Region Alpha");
      expect(regionNames).toContain("Region Beta");
    }
  );

  // ---------------------------------------------------------------------
  // 3, 4, 5, 6. courier_supervisor / technician / viewer / warehouse -> 403,
  // zero unauthorized data access
  // ---------------------------------------------------------------------

  it.each(DENIED_ROLES)(
    "authenticated %s is denied 403, and the protected data operation is never reached (zero unauthorized data access)",
    async (role) => {
      authState.user = { id: `summary-${role}-actor`, username: `summary-${role}-actor`, role };
      const res = await request(app).get("/api/leads/discovery/audit-summary");
      expect(res.status).toBe(403);
      // No field from the protected payload leaks into a denial response.
      expect(res.body.userSummaries).toBeUndefined();
      expect(res.body.recentLogs).toBeUndefined();
      expect(res.body.apiKeysSummary).toBeUndefined();
      // The handler's own protected read was never reached — proves denial
      // happens strictly before the data operation, not merely that the
      // response was reshaped afterward.
      expect(mockQuery).not.toHaveBeenCalled();
    }
  );

  it("courier_supervisor specifically is NOT admitted via the ROLE_ORDER tier tie that requireSupervisor/hasRoleOrAbove would have granted", async () => {
    authState.user = { id: "courier-sup-actor", username: "courier-sup-actor", role: "courier_supervisor" };
    const res = await request(app).get("/api/leads/discovery/audit-summary");
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Regression safety: the previously-committed destructive-endpoint
  // hotfix (1e3b847) is unaffected by this change.
  // ---------------------------------------------------------------------

  it("regression safety: the previously-fixed destructive endpoints remain Admin-only, unaffected by this change", async () => {
    authState.user = { id: "supervisor-actor", username: "supervisor-actor", role: "supervisor" };
    const supervisorToggle = await request(app)
      .post("/api/leads/discovery/toggle-user-access")
      .send({ userName: "irrelevant", allow: false });
    // Supervisor is authorized for audit-summary but NOT for the
    // destructive endpoints — those stay strictly Admin-only.
    expect(supervisorToggle.status).toBe(403);

    authState.user = { id: "admin-actor", username: "admin-actor", role: "admin" };
    const adminToggle = await request(app)
      .post("/api/leads/discovery/toggle-user-access")
      .send({ userName: "regression-safety-target", allow: false });
    expect(adminToggle.status).toBe(200);
  });
});
