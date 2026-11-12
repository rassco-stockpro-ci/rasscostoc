/**
 * HTTP-level proof (same rigor as the IDOR fix's route-ordering test):
 * `POST /api/stock-transfer` is registered TWICE — once by
 * registerTechniciansInventoryRoutes (guarded: ownership check,
 * X-Idempotency-Key required, requires_serial guard) and once by the
 * legacy registerStockTransferRoutes (unguarded: no ownership check, no
 * idempotency key, missing the new actor/idempotencyKey fields entirely —
 * it fails to typecheck against the updated StockTransferInput). Express
 * dispatches to the FIRST matching handler that sends a response; since
 * registerTechniciansInventoryRoutes runs first in index.ts, this proves
 * the guarded handler always answers and the legacy one is dead code.
 */
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@core/middlewares/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "tech-dup-1", username: "tech1", role: "technician" };
    next();
  },
  requireSupervisor: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@core/middlewares/validation", () => ({
  validateBody: () => (_req: any, _res: any, next: any) => next(),
}));

const { transferMock, createSystemLogMock } = vi.hoisted(() => ({
  transferMock: vi.fn().mockResolvedValue({
    movement: { id: "mv-guarded" },
    updatedInventory: { id: "inv-1" },
  }),
  createSystemLogMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@server/composition/stock-transfer.container", () => ({
  stockTransferContainer: {
    stockTransferUseCase: { transfer: transferMock, getMovements: vi.fn() },
    createSystemLogUseCase: { execute: createSystemLogMock },
  },
}));

describe("POST /api/stock-transfer route-ordering (duplicate registration)", () => {
  it("PROVES the guarded handler (technicians-inventory.routes) answers, not the legacy unguarded duplicate", async () => {
    const { registerTechniciansInventoryRoutes } = await import("./technicians-inventory.routes");
    const { registerStockTransferRoutes } = await import("./stock-transfer.routes");

    const app = express();
    app.use(express.json());
    // Exact order from index.ts: guarded route registered first.
    registerTechniciansInventoryRoutes(app);
    registerStockTransferRoutes(app);

    const res = await request(app)
      .post("/api/stock-transfer")
      .set("X-Idempotency-Key", "dup-route-test-key-0001")
      .send({
        technicianId: "tech-dup-1", // self — passes the guarded route's ownership check
        itemType: "type-x",
        packagingType: "box",
        quantity: 2,
        fromInventory: "fixed",
        toInventory: "moving",
      });

    expect(res.status).toBe(200);
    // The guarded handler's use-case call includes `actor` + `idempotencyKey`
    // (fields the legacy handler's call site doesn't even have, since it was
    // never updated and now fails to typecheck against StockTransferInput).
    expect(transferMock).toHaveBeenCalledTimes(1);
    const callArg = transferMock.mock.calls[0][0];
    expect(callArg.idempotencyKey).toBe("dup-route-test-key-0001");
    expect(callArg.actor).toEqual({ id: "tech-dup-1", username: "tech1", role: "technician" });
  });

  it("PROVES the guarded handler's ownership check rejects a transfer for a DIFFERENT technician (the legacy duplicate has no such check at all)", async () => {
    const { registerTechniciansInventoryRoutes } = await import("./technicians-inventory.routes");
    const { registerStockTransferRoutes } = await import("./stock-transfer.routes");

    const app = express();
    app.use(express.json());
    registerTechniciansInventoryRoutes(app);
    registerStockTransferRoutes(app);

    const res = await request(app)
      .post("/api/stock-transfer")
      .set("X-Idempotency-Key", "dup-route-test-key-0002")
      .send({
        technicianId: "someone-else", // NOT the authenticated user
        itemType: "type-x",
        packagingType: "box",
        quantity: 2,
        fromInventory: "fixed",
        toInventory: "moving",
      });

    expect(res.status).toBe(403);
  });
});
