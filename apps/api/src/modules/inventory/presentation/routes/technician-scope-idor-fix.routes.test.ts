/**
 * HTTP-level proof that requireTechnicianScope is actually wired into the
 * real route definitions for the IDOR fix (not just unit-tested in isolation).
 * Covers 2 of the 5 fixed routes end to end via supertest; the full
 * authorization matrix itself is covered by technician-scope.middleware.test.ts.
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
  requireSupervisor: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("@core/middlewares/validation", () => ({
  validateBody: () => (_req: any, _res: any, next: any) => next(),
}));

const {
  getTechnicianIdsBySupervisorMock,
  getTechnicianFixedEntriesMock,
  upsertTechnicianFixedEntryMock,
  getTechnicianCustodyMock,
} = vi.hoisted(() => ({
  getTechnicianIdsBySupervisorMock: vi.fn(),
  getTechnicianFixedEntriesMock: vi.fn(),
  upsertTechnicianFixedEntryMock: vi.fn(),
  getTechnicianCustodyMock: vi.fn(),
}));

vi.mock("@server/composition/supervisor-assignments.container", () => ({
  supervisorAssignmentsContainer: {
    supervisorAssignmentsUseCase: {
      getTechnicianIdsBySupervisor: getTechnicianIdsBySupervisorMock,
    },
  },
}));

vi.mock("@server/composition/inventory-entries.container", () => ({
  inventoryEntriesContainer: {
    inventoryEntriesUseCase: {
      getTechnicianFixedEntries: (...args: any[]) => getTechnicianFixedEntriesMock(...args),
      upsertTechnicianFixedEntry: (...args: any[]) => upsertTechnicianFixedEntryMock(...args),
      getTechnicianMovingEntries: vi.fn(),
      upsertTechnicianMovingEntriesBatch: vi.fn(),
      upsertTechnicianMovingEntry: vi.fn(),
    },
  },
}));

vi.mock("@server/composition/serialized-items.container", () => ({
  serializedItemsContainer: {
    serializedItemsController: {
      getTechnicianCustody: (req: any, res: any) => {
        getTechnicianCustodyMock(req.params.technicianId);
        res.status(200).json({ via: "real-controller", technicianId: req.params.technicianId });
      },
      getMySerializedCustody: (_req: any, res: any) => res.status(200).json({ ok: true }),
      scanIn: (_req: any, res: any) => res.status(200).json({ ok: true }),
      batchScanIn: (_req: any, res: any) => res.status(200).json({ ok: true }),
      scanOut: (_req: any, res: any) => res.status(200).json({ ok: true }),
      lookup: (_req: any, res: any) => res.status(200).json({ ok: true }),
      deleteFromMyCustody: (_req: any, res: any) => res.status(200).json({ ok: true }),
    },
  },
}));

import { registerTechniciansInventoryRoutes } from "./technicians-inventory.routes";
import { registerSerializedItemsRoutes } from "./serialized-items.routes";

function buildApp() {
  const app = express();
  app.use(express.json());
  registerTechniciansInventoryRoutes(app);
  registerSerializedItemsRoutes(app);
  return app;
}

describe("IDOR fix — HTTP-level proof the guard is wired into the real routes", () => {
  beforeEach(() => {
    getTechnicianIdsBySupervisorMock.mockReset();
    getTechnicianFixedEntriesMock.mockReset();
    upsertTechnicianFixedEntryMock.mockReset();
    getTechnicianCustodyMock.mockReset();
  });

  it("Technician reads own fixed-inventory-entries -> 200 (PASS)", async () => {
    currentUser = { id: "tech-A", role: "technician" };
    getTechnicianFixedEntriesMock.mockResolvedValue([{ itemTypeId: "x", boxes: 1, units: 2 }]);
    const res = await request(buildApp()).get("/api/technicians/tech-A/fixed-inventory-entries");
    expect(res.status).toBe(200);
    expect(getTechnicianFixedEntriesMock).toHaveBeenCalledWith("tech-A");
  });

  it("Technician reads ANOTHER technician's fixed-inventory-entries -> 403 (DENIED), use case never called", async () => {
    currentUser = { id: "tech-A", role: "technician" };
    const res = await request(buildApp()).get("/api/technicians/tech-B/fixed-inventory-entries");
    expect(res.status).toBe(403);
    expect(getTechnicianFixedEntriesMock).not.toHaveBeenCalled();
  });

  it("Technician writes to ANOTHER technician's fixed-inventory-entries -> 403 (DENIED), use case never called", async () => {
    currentUser = { id: "tech-A", role: "technician" };
    const res = await request(buildApp())
      .post("/api/technicians/tech-B/fixed-inventory-entries")
      .send({ itemTypeId: "x", boxes: 1, units: 1 });
    expect(res.status).toBe(403);
    expect(upsertTechnicianFixedEntryMock).not.toHaveBeenCalled();
  });

  it("Admin writes to ANY technician's fixed-inventory-entries -> 200 (PASS, per admin permissions)", async () => {
    currentUser = { id: "admin-1", role: "admin" };
    upsertTechnicianFixedEntryMock.mockResolvedValue({ itemTypeId: "x", boxes: 5, units: 5 });
    const res = await request(buildApp())
      .post("/api/technicians/tech-B/fixed-inventory-entries")
      .send({ itemTypeId: "x", boxes: 5, units: 5 });
    expect(res.status).toBe(200);
    expect(upsertTechnicianFixedEntryMock).toHaveBeenCalledWith("tech-B", expect.any(Object));
  });

  it("Supervisor WITHIN scope reads a technician's fixed-inventory-entries -> 200 (PASS)", async () => {
    currentUser = { id: "sup-1", role: "supervisor" };
    getTechnicianIdsBySupervisorMock.mockResolvedValue(["tech-B"]);
    getTechnicianFixedEntriesMock.mockResolvedValue([]);
    const res = await request(buildApp()).get("/api/technicians/tech-B/fixed-inventory-entries");
    expect(res.status).toBe(200);
    expect(getTechnicianIdsBySupervisorMock).toHaveBeenCalledWith("sup-1");
  });

  it("Supervisor OUTSIDE scope reading a technician's fixed-inventory-entries -> 403 (DENIED)", async () => {
    currentUser = { id: "sup-1", role: "supervisor" };
    getTechnicianIdsBySupervisorMock.mockResolvedValue(["tech-OTHER"]);
    const res = await request(buildApp()).get("/api/technicians/tech-B/fixed-inventory-entries");
    expect(res.status).toBe(403);
    expect(getTechnicianFixedEntriesMock).not.toHaveBeenCalled();
  });

  it("Technician reads own serialized-custody -> 200 (PASS, 5th fixed route, different file)", async () => {
    currentUser = { id: "tech-A", role: "technician" };
    const res = await request(buildApp()).get("/api/technicians/tech-A/serialized-custody");
    expect(res.status).toBe(200);
    expect(getTechnicianCustodyMock).toHaveBeenCalledWith("tech-A");
  });

  it("Technician reads ANOTHER technician's serialized-custody -> 403 (DENIED, 5th fixed route, previously the most clearly exploitable gap)", async () => {
    currentUser = { id: "tech-A", role: "technician" };
    const res = await request(buildApp()).get("/api/technicians/tech-B/serialized-custody");
    expect(res.status).toBe(403);
    expect(getTechnicianCustodyMock).not.toHaveBeenCalled();
  });

  it("Changing technicianId in the URL does not bypass authorization: same technician, two requests, only self one passes", async () => {
    currentUser = { id: "tech-A", role: "technician" };
    getTechnicianFixedEntriesMock.mockResolvedValue([]);
    const self = await request(buildApp()).get("/api/technicians/tech-A/fixed-inventory-entries");
    const other = await request(buildApp()).get("/api/technicians/tech-B/fixed-inventory-entries");
    expect(self.status).toBe(200);
    expect(other.status).toBe(403);
  });
});
