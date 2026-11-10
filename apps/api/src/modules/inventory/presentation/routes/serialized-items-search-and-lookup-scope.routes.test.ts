/**
 * HTTP-level proof that:
 *  1) GET /api/serialized-items/lookup/:serialNumber now enforces ownership
 *     scope (the real controller's canViewOwnerDetails(), not a mock of it).
 *  2) GET /api/serialized-items/search?q=... exists, is scoped by role the
 *     same way, and is reachable through the real route + real controller.
 *
 * The service layer (DB access) is mocked — this proves the route wiring and
 * the controller's authorization logic execute for real at the HTTP layer.
 * It does NOT prove the underlying SQL ILIKE query actually finds a real
 * scanIn-written row in Postgres — no DATABASE_URL is available in this
 * environment (confirmed: the existing *.integration.test.ts files in this
 * same module fail with "DATABASE_URL must be set" here too). That specific
 * claim is UNVERIFIED at the integration level and is reported as such.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

let currentUser: { id: string; role: string };

vi.mock("@core/middlewares/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = currentUser;
    next();
  },
}));

const { getTechnicianIdsBySupervisorMock, lookupMock, searchItemsMock } = vi.hoisted(() => ({
  getTechnicianIdsBySupervisorMock: vi.fn(),
  lookupMock: vi.fn(),
  searchItemsMock: vi.fn(),
}));

vi.mock("@server/composition/supervisor-assignments.container", () => ({
  supervisorAssignmentsContainer: {
    supervisorAssignmentsUseCase: {
      getTechnicianIdsBySupervisor: getTechnicianIdsBySupervisorMock,
    },
  },
}));

vi.mock("@modules/inventory/infrastructure/services/serialized-items.service", () => {
  const noop = vi.fn();
  return {
    SerializedItemsService: class {
      lookup = lookupMock;
      search = noop;
      scanIn = noop;
      scanOut = noop;
      batchScanIn = noop;
      getTechnicianCustody = noop;
      searchItems = searchItemsMock;
    },
  };
});

import { registerSerializedItemsRoutes } from "./serialized-items.routes";

function buildApp() {
  const app = express();
  app.use(express.json());
  registerSerializedItemsRoutes(app);
  return app;
}

const TECH_A = "tech-a-111";
const TECH_B = "tech-b-222";
const SUPERVISOR = "sup-999";
const ADMIN = "admin-000";

const ITEM_OWNED_BY_A = {
  id: "item-1",
  serialNumber: "TESTSERIAL0001",
  barcode: "TESTSERIAL0001",
  status: "IN_TRANSIT_CUSTODY",
  carrierName: null,
  simPackageType: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  itemTypeNameAr: "جهاز اختبار",
  itemTypeNameEn: "Test Device",
  ownerName: "Technician A",
  ownerUsername: "tech_a",
  currentOwnerId: TECH_A,
  history: [],
};

describe("GET /api/serialized-items/lookup/:serialNumber — ownership scope (real controller)", () => {
  beforeEach(() => {
    getTechnicianIdsBySupervisorMock.mockReset();
    lookupMock.mockReset();
    searchItemsMock.mockReset();
  });

  it("technician looking up their OWN item: PASS (200), currentOwnerId stripped from response", async () => {
    currentUser = { id: TECH_A, role: "technician" };
    lookupMock.mockResolvedValue(ITEM_OWNED_BY_A);

    const res = await request(buildApp())
      .get("/api/serialized-items/lookup/TESTSERIAL0001")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.serialNumber).toBe("TESTSERIAL0001");
    expect(res.body.data.currentOwnerId).toBeUndefined();
    expect(getTechnicianIdsBySupervisorMock).not.toHaveBeenCalled();
  });

  it("DIFFERENT technician looking up item owned by A: DENIED (403), no data leaked", async () => {
    currentUser = { id: TECH_B, role: "technician" };
    lookupMock.mockResolvedValue(ITEM_OWNED_BY_A);

    const res = await request(buildApp())
      .get("/api/serialized-items/lookup/TESTSERIAL0001")
      .expect(403);

    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeUndefined();
  });

  it("admin looking up any item: PASS (200)", async () => {
    currentUser = { id: ADMIN, role: "admin" };
    lookupMock.mockResolvedValue(ITEM_OWNED_BY_A);

    await request(buildApp()).get("/api/serialized-items/lookup/TESTSERIAL0001").expect(200);
    expect(getTechnicianIdsBySupervisorMock).not.toHaveBeenCalled();
  });

  it("supervisor WITHIN scope (assigned to tech A): PASS (200)", async () => {
    currentUser = { id: SUPERVISOR, role: "supervisor" };
    getTechnicianIdsBySupervisorMock.mockResolvedValue([TECH_A, "tech-c"]);
    lookupMock.mockResolvedValue(ITEM_OWNED_BY_A);

    await request(buildApp()).get("/api/serialized-items/lookup/TESTSERIAL0001").expect(200);
    expect(getTechnicianIdsBySupervisorMock).toHaveBeenCalledWith(SUPERVISOR);
  });

  it("supervisor OUTSIDE scope (not assigned to tech A): DENIED (403)", async () => {
    currentUser = { id: SUPERVISOR, role: "supervisor" };
    getTechnicianIdsBySupervisorMock.mockResolvedValue(["tech-c", "tech-d"]);
    lookupMock.mockResolvedValue(ITEM_OWNED_BY_A);

    await request(buildApp()).get("/api/serialized-items/lookup/TESTSERIAL0001").expect(403);
  });

  it("item with no current owner (unassigned): technician DENIED, admin PASS", async () => {
    currentUser = { id: TECH_A, role: "technician" };
    lookupMock.mockResolvedValue({ ...ITEM_OWNED_BY_A, currentOwnerId: null, ownerName: null });

    await request(buildApp()).get("/api/serialized-items/lookup/TESTSERIAL0001").expect(403);

    currentUser = { id: ADMIN, role: "admin" };
    await request(buildApp()).get("/api/serialized-items/lookup/TESTSERIAL0001").expect(200);
  });
});

describe("GET /api/serialized-items/search?q=... — role-scoped search (real controller + real route)", () => {
  beforeEach(() => {
    getTechnicianIdsBySupervisorMock.mockReset();
    searchItemsMock.mockReset();
  });

  it("empty query returns an empty list without calling the service", async () => {
    currentUser = { id: ADMIN, role: "admin" };

    const res = await request(buildApp()).get("/api/serialized-items/search").expect(200);

    expect(res.body.data).toEqual([]);
    expect(searchItemsMock).not.toHaveBeenCalled();
  });

  it("admin search: service called with NO owner filter (unrestricted)", async () => {
    currentUser = { id: ADMIN, role: "admin" };
    searchItemsMock.mockResolvedValue([ITEM_OWNED_BY_A]);

    const res = await request(buildApp())
      .get("/api/serialized-items/search?q=TESTSERIAL")
      .expect(200);

    expect(res.body.data).toEqual([{ ...ITEM_OWNED_BY_A, createdAt: ITEM_OWNED_BY_A.createdAt.toISOString(), updatedAt: ITEM_OWNED_BY_A.updatedAt.toISOString() }]);
    expect(searchItemsMock).toHaveBeenCalledWith("TESTSERIAL", undefined);
    expect(getTechnicianIdsBySupervisorMock).not.toHaveBeenCalled();
  });

  it("technician search: service called with ownerIdFilter = [self] only", async () => {
    currentUser = { id: TECH_A, role: "technician" };
    searchItemsMock.mockResolvedValue([ITEM_OWNED_BY_A]);

    await request(buildApp()).get("/api/serialized-items/search?q=TESTSERIAL").expect(200);

    expect(searchItemsMock).toHaveBeenCalledWith("TESTSERIAL", [TECH_A]);
  });

  it("supervisor search: service called with ownerIdFilter = their actual assigned technicians", async () => {
    currentUser = { id: SUPERVISOR, role: "supervisor" };
    getTechnicianIdsBySupervisorMock.mockResolvedValue([TECH_A, "tech-c"]);
    searchItemsMock.mockResolvedValue([ITEM_OWNED_BY_A]);

    await request(buildApp()).get("/api/serialized-items/search?q=TESTSERIAL").expect(200);

    expect(getTechnicianIdsBySupervisorMock).toHaveBeenCalledWith(SUPERVISOR);
    expect(searchItemsMock).toHaveBeenCalledWith("TESTSERIAL", [TECH_A, "tech-c"]);
  });

  it("supervisor with zero assignments still queries with an empty (not unrestricted) filter", async () => {
    currentUser = { id: SUPERVISOR, role: "supervisor" };
    getTechnicianIdsBySupervisorMock.mockResolvedValue([]);
    searchItemsMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/serialized-items/search?q=TESTSERIAL").expect(200);

    expect(searchItemsMock).toHaveBeenCalledWith("TESTSERIAL", []);
    expect(res.body.data).toEqual([]);
  });
});
