/**
 * P0 authorization — route-level tests (real Express routers, real role
 * middlewares, real errorHandler). Only authentication identity and data
 * sources are faked. Fixtures model both existing supervisor-scope systems:
 * region (inventory requests) and technician/warehouse assignment.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const h = vi.hoisted(() => ({
  supervisorTechnicians: {} as Record<string, string[]>,
  supervisorWarehouses: {} as Record<string, string[]>,
  requests: {} as Record<string, { technicianId: string; technicianRegionId: string | null }>,
  items: {} as Record<string, { id: string; currentOwnerId: string | null; warehouseId: string | null }>,
  updateStatusRepo: vi.fn(),
  deleteByIdRepo: vi.fn(),
  service: {
    updateItemStatus: vi.fn(),
    getTechnicianSerializedItems: vi.fn(),
    getTechnicianDeliveredItems: vi.fn(),
  },
  holder: { controller: null as any },
  getTechnicianCustody: vi.fn(),
}));

vi.mock("@core/middlewares/auth.middleware", async () => {
  const actual = await vi.importActual<any>("@core/middlewares/auth.middleware");
  return {
    ...actual,
    requireAuth: (req: any, res: any, next: any) => {
      const raw = req.header("x-test-user");
      if (!raw) return res.status(401).json({ message: "unauthenticated" });
      req.user = JSON.parse(raw);
      next();
    },
  };
});

vi.mock("@server/composition/supervisor-assignments.container", () => ({
  supervisorAssignmentsContainer: {
    supervisorAssignmentsUseCase: {
      getTechnicianIdsBySupervisor: async (id: string) => h.supervisorTechnicians[id] ?? [],
      getWarehouseIdsBySupervisor: async (id: string) => h.supervisorWarehouses[id] ?? [],
    },
  },
}));

vi.mock("@server/composition/inventory-requests-management.container", async () => {
  const { InventoryRequestsManagementUseCase } = await vi.importActual<any>(
    "@modules/inventory/application/inventory-requests/use-cases/InventoryRequestsManagement.use-case",
  );
  const repo = {
    updateStatus: (input: any) => h.updateStatusRepo(input),
    deleteById: (id: string) => h.deleteByIdRepo(id),
    getRequestScope: async (id: string) => h.requests[id],
  };
  return {
    inventoryRequestsManagementContainer: {
      inventoryRequestsManagementUseCase: new InventoryRequestsManagementUseCase(repo),
      createSystemLogUseCase: { execute: vi.fn() },
    },
  };
});

vi.mock("@server/composition/item-custody-lookup.container", () => ({
  itemCustodyLookupContainer: {
    itemCustodyLookupRepository: {
      getCustodyById: async (id: string) => h.items[id],
    },
  },
}));

vi.mock("@server/composition/inventory.container", () => ({
  inventoryContainer: {
    get warehouseTransferController() {
      return h.holder.controller;
    },
  },
}));

vi.mock("@server/composition/serialized-items.container", () => ({
  serializedItemsContainer: {
    serializedItemsController: {
      getTechnicianCustody: (req: any, res: any) => {
        h.getTechnicianCustody(req.params.technicianId);
        res.status(200).json([]);
      },
      getMySerializedCustody: (_req: any, res: any) => res.status(200).json([]),
      scanIn: (_req: any, res: any) => res.status(200).json({}),
      batchScanIn: (_req: any, res: any) => res.status(200).json({}),
      scanOut: (_req: any, res: any) => res.status(200).json({}),
      lookup: (_req: any, res: any) => res.status(200).json({}),
      search: (_req: any, res: any) => res.status(200).json({}),
      deleteFromMyCustody: (_req: any, res: any) => res.status(200).json({}),
    },
  },
}));

import { WarehouseTransferController } from "../controllers/warehouse-transfer.controller";
import { registerInventoryRequestsManagementRoutes } from "./inventory-requests-management.routes";
import { registerWarehouseTransferOperationsRoutes } from "./warehouse-transfer-operations.routes";
import { registerSerializedItemsRoutes } from "./serialized-items.routes";
import { errorHandler } from "../../../../core/errors/errorHandler";

const TECH_A = { id: "tech-A", role: "technician", regionId: "R1", username: "a" };
const TECH_B = { id: "tech-B", role: "technician", regionId: "R2", username: "b" };
const SUP_IN = { id: "sup-in", role: "supervisor", regionId: "R1", username: "si" };
const SUP_OUT = { id: "sup-out", role: "supervisor", regionId: "R2", username: "so" };
const COURIER_SUP = { id: "csup", role: "courier_supervisor", regionId: "R1", username: "cs" };
const ADMIN = { id: "admin-1", role: "admin", regionId: null, username: "ad" };

function buildApp() {
  h.holder.controller = new WarehouseTransferController(h.service as any);
  const app = express();
  app.use(express.json());
  registerInventoryRequestsManagementRoutes(app);
  registerWarehouseTransferOperationsRoutes(app);
  registerSerializedItemsRoutes(app);
  app.use(errorHandler);
  return app;
}

function as(user: object | null) {
  return user ? { "x-test-user": JSON.stringify(user) } : {};
}

beforeEach(() => {
  vi.clearAllMocks();
  h.supervisorTechnicians = { "sup-in": ["tech-A"], "sup-out": ["tech-B"] };
  h.supervisorWarehouses = { "sup-in": ["W1"], "sup-out": ["W2"] };
  h.requests = { "REQ-A": { technicianId: "tech-A", technicianRegionId: "R1" } };
  h.items = {
    "ITEM-HELD-BY-A": { id: "ITEM-HELD-BY-A", currentOwnerId: "tech-A", warehouseId: null },
    "ITEM-IN-W1": { id: "ITEM-IN-W1", currentOwnerId: null, warehouseId: "W1" },
  };
  h.updateStatusRepo.mockImplementation(async (input: any) => ({ id: input.id, status: input.status }));
  h.deleteByIdRepo.mockResolvedValue(true);
  h.service.updateItemStatus.mockResolvedValue({ success: true });
  h.service.getTechnicianSerializedItems.mockResolvedValue([]);
  h.service.getTechnicianDeliveredItems.mockResolvedValue([]);
});

describe("Item 1 — PATCH /api/inventory-requests/:id/status", () => {
  const send = (user: object | null) =>
    request(buildApp()).patch("/api/inventory-requests/REQ-A/status").set(as(user)).send({ status: "approved" });

  it("unauthenticated -> 401", async () => {
    expect((await send(null)).status).toBe(401);
    expect(h.updateStatusRepo).not.toHaveBeenCalled();
  });
  it("technician on own request -> 403", async () => {
    expect((await send(TECH_A)).status).toBe(403);
    expect(h.updateStatusRepo).not.toHaveBeenCalled();
  });
  it("technician on another technician's request -> 403", async () => {
    expect((await send(TECH_B)).status).toBe(403);
    expect(h.updateStatusRepo).not.toHaveBeenCalled();
  });
  it("supervisor in scope (same region as the request's technician) -> 200", async () => {
    const res = await send(SUP_IN);
    expect(res.status).toBe(200);
    expect(h.updateStatusRepo).toHaveBeenCalledWith(expect.objectContaining({ id: "REQ-A", respondedBy: "sup-in" }));
  });
  it("supervisor out of scope (other region) -> 403", async () => {
    expect((await send(SUP_OUT)).status).toBe(403);
    expect(h.updateStatusRepo).not.toHaveBeenCalled();
  });
  it("courier_supervisor (passes requireSupervisor level) -> 403", async () => {
    expect((await send(COURIER_SUP)).status).toBe(403);
    expect(h.updateStatusRepo).not.toHaveBeenCalled();
  });
  it("admin -> 200", async () => {
    expect((await send(ADMIN)).status).toBe(200);
    expect(h.updateStatusRepo).toHaveBeenCalledTimes(1);
  });
  it("supervisor on a non-existent request -> 404, nothing written", async () => {
    const res = await request(buildApp())
      .patch("/api/inventory-requests/REQ-MISSING/status").set(as(SUP_IN)).send({ status: "approved" });
    expect(res.status).toBe(404);
    expect(h.updateStatusRepo).not.toHaveBeenCalled();
  });
});

describe("Item 2 — DELETE /api/inventory-requests/:id", () => {
  const send = (user: object | null) => request(buildApp()).delete("/api/inventory-requests/REQ-A").set(as(user));

  it("unauthenticated -> 401", async () => {
    expect((await send(null)).status).toBe(401);
    expect(h.deleteByIdRepo).not.toHaveBeenCalled();
  });
  it("technician deleting own request -> 403", async () => {
    expect((await send(TECH_A)).status).toBe(403);
    expect(h.deleteByIdRepo).not.toHaveBeenCalled();
  });
  it("technician deleting another technician's request -> 403", async () => {
    expect((await send(TECH_B)).status).toBe(403);
    expect(h.deleteByIdRepo).not.toHaveBeenCalled();
  });
  it("supervisor in scope -> 403 (no supervisor delete intent in codebase)", async () => {
    expect((await send(SUP_IN)).status).toBe(403);
    expect(h.deleteByIdRepo).not.toHaveBeenCalled();
  });
  it("supervisor out of scope -> 403", async () => {
    expect((await send(SUP_OUT)).status).toBe(403);
    expect(h.deleteByIdRepo).not.toHaveBeenCalled();
  });
  it("admin -> 200", async () => {
    expect((await send(ADMIN)).status).toBe(200);
    expect(h.deleteByIdRepo).toHaveBeenCalledWith("REQ-A");
  });
});

describe.each([
  ["serialized-custody", () => h.getTechnicianCustody],
  ["serialized-items", () => h.service.getTechnicianSerializedItems],
  ["delivered-items", () => h.service.getTechnicianDeliveredItems],
])("Item 3 — GET /api/technicians/:technicianId/%s", (path, reader) => {
  const send = (user: object | null, technicianId: string) =>
    request(buildApp()).get(`/api/technicians/${technicianId}/${path}`).set(as(user));

  it("unauthenticated -> 401", async () => {
    expect((await send(null, "tech-A")).status).toBe(401);
    expect(reader()).not.toHaveBeenCalled();
  });
  it("technician reading self -> 200", async () => {
    expect((await send(TECH_A, "tech-A")).status).toBe(200);
    expect(reader()).toHaveBeenCalled();
  });
  it("technician reading another technician (URL param swapped) -> 403", async () => {
    expect((await send(TECH_A, "tech-B")).status).toBe(403);
    expect(reader()).not.toHaveBeenCalled();
  });
  it("supervisor in scope -> 200", async () => {
    expect((await send(SUP_IN, "tech-A")).status).toBe(200);
  });
  it("supervisor out of scope -> 403", async () => {
    expect((await send(SUP_IN, "tech-B")).status).toBe(403);
    expect(reader()).not.toHaveBeenCalled();
  });
  it("admin -> 200", async () => {
    expect((await send(ADMIN, "tech-B")).status).toBe(200);
  });
});

describe("Item 4 — PATCH /api/items/:id/status", () => {
  const send = (user: object | null, itemId: string, body: object = { status: "DELIVERED" }) =>
    request(buildApp()).patch(`/api/items/${itemId}/status`).set(as(user)).send(body);

  it("unauthenticated -> 401", async () => {
    expect((await send(null, "ITEM-HELD-BY-A")).status).toBe(401);
    expect(h.service.updateItemStatus).not.toHaveBeenCalled();
  });
  it("technician on an item they hold -> 200", async () => {
    expect((await send(TECH_A, "ITEM-HELD-BY-A")).status).toBe(200);
    expect(h.service.updateItemStatus).toHaveBeenCalledTimes(1);
  });
  it("technician on an item another technician holds -> 403", async () => {
    expect((await send(TECH_B, "ITEM-HELD-BY-A")).status).toBe(403);
    expect(h.service.updateItemStatus).not.toHaveBeenCalled();
  });
  it("technician on a warehouse item they do not hold -> 403", async () => {
    expect((await send(TECH_A, "ITEM-IN-W1")).status).toBe(403);
    expect(h.service.updateItemStatus).not.toHaveBeenCalled();
  });
  it("supervisor in scope (holder is an assigned technician) -> 200", async () => {
    expect((await send(SUP_IN, "ITEM-HELD-BY-A")).status).toBe(200);
  });
  it("supervisor out of scope (holder not assigned) -> 403", async () => {
    expect((await send(SUP_OUT, "ITEM-HELD-BY-A")).status).toBe(403);
    expect(h.service.updateItemStatus).not.toHaveBeenCalled();
  });
  it("supervisor in scope via assigned warehouse (no holder) -> 200", async () => {
    expect((await send(SUP_IN, "ITEM-IN-W1")).status).toBe(200);
  });
  it("supervisor out of scope via warehouse -> 403", async () => {
    expect((await send(SUP_OUT, "ITEM-IN-W1")).status).toBe(403);
    expect(h.service.updateItemStatus).not.toHaveBeenCalled();
  });
  it("courier_supervisor -> 403", async () => {
    expect((await send(COURIER_SUP, "ITEM-HELD-BY-A")).status).toBe(403);
    expect(h.service.updateItemStatus).not.toHaveBeenCalled();
  });
  it("admin -> 200", async () => {
    expect((await send(ADMIN, "ITEM-HELD-BY-A")).status).toBe(200);
  });
  it("non-existent item (non-admin) -> 404, nothing written", async () => {
    expect((await send(SUP_IN, "ITEM-MISSING")).status).toBe(404);
    expect(h.service.updateItemStatus).not.toHaveBeenCalled();
  });
  it("itemTypeId in the body is never forwarded to the write", async () => {
    const res = await send(ADMIN, "ITEM-HELD-BY-A", { status: "DELIVERED", itemTypeId: "SOME-OTHER-TYPE" });
    expect(res.status).toBe(200);
    expect(h.service.updateItemStatus).toHaveBeenCalledWith("admin-1", "ITEM-HELD-BY-A", "DELIVERED", undefined, undefined);
    for (const arg of h.service.updateItemStatus.mock.calls[0]) {
      expect(arg).not.toBe("SOME-OTHER-TYPE");
    }
  });
});
