/**
 * CloseRequestUseCase against the transaction contract only (fakes, no
 * database): what a close commits, in which order, through which ports.
 * The same behaviour against real Postgres is close-deduction-atomicity.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { CloseRequestUseCase, type ClosePlan } from "./close-request.use-case";
import { DeductionError } from "../inventory/inventory.engine.types";
import { ExecutionCompletedEvent } from "@core/events/events";
import { AppError } from "@core/errors/AppError";

const HANDLE = { opaque: "tx-handle" } as any;

function harness(items: any[] = []) {
  const calls: string[] = [];
  const rows = items.map((i) => ({ ...i }));
  const ctx: any = {
    requestsRepository: {
      insertRequestItems: vi.fn(async (list: any[]) => {
        calls.push("bind");
        for (const r of list) rows.push({ id: 1000 + rows.length, ...r });
        return list;
      }),
      findRequestItems: vi.fn(async () => rows),
      updateRequestItem: vi.fn(async (id: number, data: any) => {
        calls.push(`install:${id}`);
        Object.assign(rows.find((r) => r.id === id), data);
        return rows.find((r) => r.id === id);
      }),
    },
    executionsRepository: {
      updateCustodyClosureStatus: vi.fn(async () => (calls.push("closed"), {})),
      insertExecutionUnits: vi.fn(async (list: any[]) => (calls.push("units"), list.map((u, i) => ({ id: 500 + i, ...u })))),
    },
    dashboardRepository: { insertAuditLog: vi.fn(async () => (calls.push("audit"), {})) },
    outbox: { enqueue: vi.fn(async () => (calls.push("enqueue"), undefined)) },
    inventoryTransaction: HANDLE,
  };
  const engine = {
    prepare: vi.fn(async (c: any) => ({ ctx: c, canonicalSerials: c.serialsForCustody })),
    executePrepared: vi.fn(async (p: any) => {
      calls.push("deduct");
      return { requestId: p.ctx.requestId, generalInventoryDeducted: false, custodyItemsDeducted: p.canonicalSerials, errors: [] };
    }),
  };
  const uow = { execute: vi.fn(async (work: any) => work(ctx)) };
  const inventoryPort = { hasInventoryDeductionCompletion: vi.fn(async () => false) };
  const useCase = new CloseRequestUseCase(uow as any, inventoryPort as any, engine as any);
  return { ctx, rows, calls, engine, uow, inventoryPort, useCase };
}

const CLOSE_ITEMS = [
  { serialNumber: "DEV-A", role: "device" as const, itemId: "dev-a" },
  { serialNumber: "SIM-A", role: "sim" as const, itemId: "sim-a" },
];

const UNITS = [
  { unitNo: 1, device: { itemId: "dev-a", serialNumber: "DEV-A" }, sim: { itemId: "sim-a", serialNumber: "SIM-A", carrierName: "STC" }, simWaived: false, tid: "T1" },
];

const event = (execution: any = { id: 9, paperRollQty: 2 }) =>
  new ExecutionCompletedEvent({ requestId: 7, actorId: "u1", execution, request: { id: 7 } });

async function planFor(h: ReturnType<typeof harness>, bind: any[] = []): Promise<ClosePlan> {
  return h.useCase.plan({
    requestId: 7,
    actorId: "u1",
    request: { customerName: "C", incidentNumber: "INC-7" },
    technicianCode: "tech",
    closeItems: CLOSE_ITEMS,
    requestItemsToBind: bind,
    units: UNITS,
    pairingSource: "EXPLICIT",
    countWarning: null,
  });
}

describe("CloseRequestUseCase — the close transaction contract", () => {
  it("commits in order: bind, install, deduct (on the UoW's handle), CLOSED_SUCCESS, audit, outbox", async () => {
    const h = harness([{ id: 1, status: "RECEIVED", serialNumber: "DEV-A" }]);
    const plan = await planFor(h, [{ requestId: 7, itemType: "SIM", simSerial: "SIM-A", quantity: 1, status: "RECEIVED", technicianId: "t" }]);
    const ev = event();

    await h.useCase.commit(h.ctx, plan, ev);

    expect(h.calls).toEqual(["bind", "units", "install:1", "install:1001", "deduct", "closed", "audit", "enqueue"]);
    // the persisted units carry the SIM type derived from inventory (event payload + response)
    expect((ev.payload.execution as any).units.map((u: any) => u.simType)).toEqual(["STC"]);
    // each installed request item points at its unit
    expect(h.rows.find((r) => r.id === 1)!.executionUnitId).toBe(500);
    expect(h.ctx.executionsRepository.insertExecutionUnits.mock.calls[0][0][0]).toMatchObject({
      requestId: 7, executionId: 9, unitNo: 1, deviceItemId: "dev-a", simItemId: "sim-a", tid: "T1", pairingSource: "EXPLICIT",
    });
    expect(h.engine.executePrepared.mock.calls[0][1]).toBe(HANDLE);
    expect(h.ctx.outbox.enqueue).toHaveBeenCalledWith(ev);
    const prepared = h.engine.executePrepared.mock.calls[0][0] as any;
    expect(prepared.ctx.sourceEventId).toBe(ev.id);
    expect(prepared.ctx.serialsForCustody).toEqual(["DEV-A", "SIM-A"]);
  });

  it("a failing deduction stops the close: no CLOSED_SUCCESS, no audit, no event", async () => {
    const h = harness([{ id: 1, status: "RECEIVED", serialNumber: "DEV-A" }]);
    h.engine.executePrepared.mockRejectedValueOnce(new DeductionError("DEDUCT_INTEGRITY_CONFLICT", 7, "x"));
    const plan = await planFor(h);

    await expect(h.useCase.commit(h.ctx, plan, event())).rejects.toBeInstanceOf(DeductionError);
    expect(h.ctx.executionsRepository.updateCustodyClosureStatus).not.toHaveBeenCalled();
    expect(h.ctx.dashboardRepository.insertAuditLog).not.toHaveBeenCalled();
    expect(h.ctx.outbox.enqueue).not.toHaveBeenCalled();
  });

  it("a failing outbox enqueue fails the close (no fallback)", async () => {
    const h = harness();
    h.ctx.outbox.enqueue.mockRejectedValueOnce(new Error("outbox down"));
    const plan = await planFor(h);
    await expect(h.useCase.run((ctx) => h.useCase.commit(ctx, plan, event()))).rejects.toThrow("outbox down");
  });

  it("run() maps a refused deduction to 422 and a transient one to 503", async () => {
    const h = harness();
    const refused = await h.useCase.run(async () => {
      throw new DeductionError("DEDUCT_INSUFFICIENT_STOCK", 7, "[InventoryEngine] no stock");
    }).catch((e) => e);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused.statusCode).toBe(422);
    expect(refused.code).toBe("INVENTORY_DEDUCTION_REJECTED");

    const transient = await h.useCase.run(async () => {
      throw new DeductionError("DEDUCT_INFRA_TRANSIENT", 7, "db blip");
    }).catch((e) => e);
    expect(transient.statusCode).toBe(503);
    expect(transient.code).toBe("INVENTORY_DEDUCTION_TRANSIENT");
  });

  it("installs only this close's items; a linked PENDING_RECEIPT item is received then installed", async () => {
    const h = harness([
      { id: 1, status: "PENDING_RECEIPT", serialNumber: "DEV-A" },
      { id: 2, status: "RECEIVED", simSerial: "SIM-A" },
      { id: 3, status: "RECEIVED", serialNumber: "ORPHAN-B" },
      { id: 4, status: "INSTALLED", serialNumber: "DEV-A" },
    ]);
    await h.useCase.commit(h.ctx, await planFor(h), event());

    expect(h.rows.find((r) => r.id === 1)!.status).toBe("INSTALLED");
    expect(h.rows.find((r) => r.id === 1)!.receivedAt).toBeInstanceOf(Date);
    expect(h.rows.find((r) => r.id === 2)!.status).toBe("INSTALLED");
    expect(h.rows.find((r) => r.id === 3)!.status).toBe("RECEIVED");
    expect(h.ctx.requestsRepository.updateRequestItem).not.toHaveBeenCalledWith(4, expect.anything());
  });

  it("a close item in a reserved state refuses the close (422) before deducting", async () => {
    const h = harness([{ id: 1, status: "MISSING", serialNumber: "DEV-A" }]);
    const err = await h.useCase.commit(h.ctx, await planFor(h), event()).catch((e) => e);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("REQUEST_ITEM_TRANSITION_INVALID");
    expect(h.engine.executePrepared).not.toHaveBeenCalled();
  });

  it("quantities come from the saved row by the one consumables rule (legacy NULL + 'Yes' = 1 roll)", async () => {
    const h = harness();
    await h.useCase.commit(h.ctx, await planFor(h), event({ id: 9, paperRollQty: null, paperRoll: "Yes", stickersQty: 3, nulipCardsQty: 0 }));
    const c = (h.engine.executePrepared.mock.calls[0][0] as any).ctx;
    expect([c.paperRollQty, c.stickersQty, c.nulipCardsQty]).toEqual([1, 3, 0]);
  });

  it("already deducted request: no second deduction, still CLOSED_SUCCESS and the event", async () => {
    const h = harness();
    h.inventoryPort.hasInventoryDeductionCompletion.mockResolvedValueOnce(true);
    const plan = await planFor(h);
    expect(plan.prepared).toBeNull();
    expect(h.engine.prepare).not.toHaveBeenCalled();

    await h.useCase.commit(h.ctx, plan, event());
    expect(h.engine.executePrepared).not.toHaveBeenCalled();
    expect(h.ctx.executionsRepository.updateCustodyClosureStatus).toHaveBeenCalled();
    expect(h.ctx.dashboardRepository.insertAuditLog).not.toHaveBeenCalled();
    expect(h.ctx.outbox.enqueue).toHaveBeenCalledTimes(1);
  });
});
