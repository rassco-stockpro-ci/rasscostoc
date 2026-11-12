import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

function makeSelectChain(rows: any[]) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: (_n: number) => Promise.resolve(rows),
  };
  return chain;
}

vi.mock("@server/core/config/db", () => ({
  db: {
    select: vi.fn(() => makeSelectChain([])), // overridden per-call via mockReturnValueOnce in tests
    insert: vi.fn(() => ({
      values: (v: any) => ({
        returning: () => Promise.resolve([{ id: "new-item-id", ...v }]),
      }),
    })),
    update: vi.fn(() => ({
      set: (v: any) => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: "existing-item-id", ...v }]),
        }),
      }),
    })),
  },
}));

// Catalog-regex resolver mocked here so these tests exercise courier.service.ts's
// own decisions; the resolver's regex logic has its own dedicated test file.
vi.mock("./sim-item-type-resolver", () => ({
  resolveSimItemTypeCandidates: vi.fn(),
}));

import { db } from "@server/core/config/db";
import { resolveSimItemTypeCandidates } from "./sim-item-type-resolver";
import { CourierService } from "./courier.service";
import { AppError } from "@core/errors/AppError";

const mobilyType = { id: "mobilySim", nameEn: "Mobily SIM", nameAr: "شريحة موبايلي", category: "sim" };
const stcType = { id: "stcSim", nameEn: "STC SIM", nameAr: "شريحة STC", category: "sim" };

const ACTOR = "tech-1";
const SIM_SERIAL = "899660000000000001";

function buildReceiptService(opts: {
  reqDataSim?: string | null;
  itemType?: "SIM" | "POS";
  inventoryItem: any | null;
}) {
  const inventoryPort = {
    findItemBySerial: vi.fn().mockResolvedValue(opts.inventoryItem),
    transferCustodyToTechnician: vi.fn().mockResolvedValue(undefined),
    normalizeSerial: vi.fn(),
    mintAndAssignToTechnician: vi.fn(),
  };
  const fakeCtx = {
    requestsRepository: {
      findRequestItemsBySerials: vi.fn().mockResolvedValue([]),
      updateRequestItem: vi.fn().mockResolvedValue({}),
      findRequestItems: vi.fn().mockResolvedValue([
        { id: 1, status: "RECEIVED", itemType: opts.itemType ?? "SIM", serialNumber: null, simSerial: SIM_SERIAL },
      ]),
      findRequestById: vi.fn().mockResolvedValue({ id: 1, sim: opts.reqDataSim ?? "STC", installationType: "N950" }),
      insertRequestItems: vi.fn().mockResolvedValue([]),
    },
    executionsRepository: {
      findExecutionByRequestId: vi.fn().mockResolvedValue(null),
      insertExecution: vi.fn().mockResolvedValue({}),
      updateExecution: vi.fn().mockResolvedValue({}),
    },
    inventoryPort,
    dashboardRepository: {
      insertAuditLog: vi.fn().mockResolvedValue({}),
    },
  };

  const fakeUow = { execute: async (cb: (ctx: any) => Promise<any>) => cb(fakeCtx) };
  const fakeRequestsRepo = {
    findRequestItems: vi.fn().mockResolvedValue([{ id: 1 }]),
    findRequestWithDetails: vi.fn().mockResolvedValue({ id: 1 }),
  };

  const service = new CourierService(
    fakeUow as any,
    fakeRequestsRepo as any,
    {} as any,
    {} as any,
    {} as any,
    inventoryPort as any
  );

  return { service, fakeCtx, inventoryPort };
}

describe("confirmReceiving() — stored itemTypeId is the only authority, no guessing", () => {
  beforeEach(() => {
    vi.mocked(resolveSimItemTypeCandidates).mockReset();
  });

  it("unregistered serial is REJECTED even when the request's free text says 'STC' — nothing is minted under a guessed type", async () => {
    const { service, inventoryPort, fakeCtx } = buildReceiptService({ reqDataSim: "STC 1x", inventoryItem: null });

    await expect(service.confirmReceiving(1, ACTOR)).rejects.toThrow(AppError);
    expect(inventoryPort.mintAndAssignToTechnician).not.toHaveBeenCalled();
    expect(inventoryPort.normalizeSerial).not.toHaveBeenCalled();
    expect(inventoryPort.transferCustodyToTechnician).not.toHaveBeenCalled();
    expect(resolveSimItemTypeCandidates).not.toHaveBeenCalled();
    expect(fakeCtx.dashboardRepository.insertAuditLog).not.toHaveBeenCalled();
  });

  it("unregistered POS serial is REJECTED too — no device-type default from installationType text", async () => {
    const { service, inventoryPort } = buildReceiptService({ itemType: "POS", inventoryItem: null });

    await expect(service.confirmReceiving(1, ACTOR)).rejects.toThrow(AppError);
    expect(inventoryPort.mintAndAssignToTechnician).not.toHaveBeenCalled();
  });

  it("registered item keeps its stored type: custody is transferred, the item's type is never passed, derived, or re-written", async () => {
    const stored = { id: "item-9", itemTypeId: "zainSim", status: "WAREHOUSE", currentOwnerId: null };
    const { service, inventoryPort } = buildReceiptService({ reqDataSim: "STC", inventoryItem: stored });

    await service.confirmReceiving(1, ACTOR);

    expect(inventoryPort.transferCustodyToTechnician).toHaveBeenCalledTimes(1);
    const args = inventoryPort.transferCustodyToTechnician.mock.calls[0][0];
    expect(args).toEqual({
      itemId: "item-9",
      technicianId: ACTOR,
      requestId: 1,
      oldStatus: "WAREHOUSE",
      newStatus: "RECEIVED_BY_TECHNICIAN",
    });
    expect(args).not.toHaveProperty("itemTypeId");
    expect(inventoryPort.mintAndAssignToTechnician).not.toHaveBeenCalled();
    expect(inventoryPort.normalizeSerial).not.toHaveBeenCalled();
    expect(resolveSimItemTypeCandidates).not.toHaveBeenCalled();
  });

  it("idempotent: an item already in this technician's custody gets no second custody movement", async () => {
    const held = { id: "item-9", itemTypeId: "zainSim", status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: ACTOR };
    const { service, inventoryPort } = buildReceiptService({ inventoryItem: held });

    await service.confirmReceiving(1, ACTOR);

    expect(inventoryPort.transferCustodyToTechnician).not.toHaveBeenCalled();
    expect(inventoryPort.mintAndAssignToTechnician).not.toHaveBeenCalled();
  });

  it("idempotent across repeated calls: receiving the same serial twice produces exactly one custody movement", async () => {
    const item: any = { id: "item-9", itemTypeId: "stcSim", status: "WAREHOUSE", currentOwnerId: null };
    const { service, inventoryPort } = buildReceiptService({ inventoryItem: item });
    inventoryPort.transferCustodyToTechnician.mockImplementation(async (p: any) => {
      item.status = p.newStatus;
      item.currentOwnerId = p.technicianId;
    });

    await service.confirmReceiving(1, ACTOR);
    await service.confirmReceiving(1, ACTOR);

    expect(inventoryPort.transferCustodyToTechnician).toHaveBeenCalledTimes(1);
    expect(item.itemTypeId).toBe("stcSim");
  });

  it("an item held by a different technician is transferred (legitimate custody change), type untouched", async () => {
    const other = { id: "item-9", itemTypeId: "mobilySim", status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: "tech-2" };
    const { service, inventoryPort } = buildReceiptService({ inventoryItem: other });

    await service.confirmReceiving(1, ACTOR);

    expect(inventoryPort.transferCustodyToTechnician).toHaveBeenCalledTimes(1);
    expect(inventoryPort.transferCustodyToTechnician.mock.calls[0][0]).not.toHaveProperty("itemTypeId");
  });
});

describe("linkSimToTechnician() — explicit simType required for new items, stored type kept", () => {
  const newService = () =>
    new CourierService({ execute: async (cb: any) => cb({}) } as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(resolveSimItemTypeCandidates).mockReset();
  });

  it("new item without simType is rejected even if exactly one catalog regex matches — the server never picks the type", async () => {
    vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([stcType] as any);
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any);

    await expect(newService().linkSimToTechnician({ simSerial: SIM_SERIAL } as any)).rejects.toThrow(AppError);
    expect(resolveSimItemTypeCandidates).not.toHaveBeenCalled();
  });

  it("new item, explicit simType agreeing with no catalog type — rejected", async () => {
    vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([]);
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any);

    await expect(
      newService().linkSimToTechnician({ simSerial: SIM_SERIAL, simType: "Virgin" } as any)
    ).rejects.toThrow(AppError);
  });

  it("new item, explicit simType still ambiguous across 2+ catalog types — rejected", async () => {
    vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([mobilyType, stcType] as any);
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any);

    await expect(
      newService().linkSimToTechnician({ simSerial: SIM_SERIAL, simType: "SIM" } as any)
    ).rejects.toThrow(AppError);
  });

  it("new item, explicit simType confirmed by exactly one catalog type — stored under that type with the explicit carrier name", async () => {
    vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([mobilyType] as any);
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any);

    const result = await newService().linkSimToTechnician({ simSerial: SIM_SERIAL, simType: "Mobily" } as any);

    expect(result.success).toBe(true);
    expect(result.item.itemTypeId).toBe("mobilySim");
    expect(result.item.carrierName).toBe("Mobily");
  });

  it("existing item keeps its stored type and carrierName; the update never writes itemTypeId and the resolver is never consulted", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      makeSelectChain([{ id: "existing-item-id", itemTypeId: "zainSim", carrierName: "Zain" }]) as any
    );

    const result = await newService().linkSimToTechnician({ simSerial: SIM_SERIAL } as any);

    expect(result.success).toBe(true);
    expect(result.item.carrierName).toBe("Zain");
    expect(result.item).not.toHaveProperty("itemTypeId");
    expect(resolveSimItemTypeCandidates).not.toHaveBeenCalled();
  });
});

describe("courier.controller — linkSimToTechnician no longer defaults simType", () => {
  it("passes undefined (not a default carrier) to the service when the client omits simType", async () => {
    const { CourierController } = await import("../presentation/controllers/courier.controller");
    const fakeService = { linkSimToTechnician: vi.fn().mockResolvedValue({ success: true }) };
    const controller = new (CourierController as any)(fakeService);

    await controller.linkSimToTechnician({ body: { simSerial: SIM_SERIAL } } as any, { json: vi.fn() } as any, vi.fn());

    expect(fakeService.linkSimToTechnician).toHaveBeenCalledWith(expect.objectContaining({ simType: undefined }));
  });
});

describe("regression guard — no carrier names or default type ids hardcoded in production code", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const productionFiles = [
    resolve(here, "courier.service.ts"),
    resolve(here, "sim-item-type-resolver.ts"),
    resolve(here, "../presentation/controllers/courier.controller.ts"),
  ];
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  const forbidden = /["'`](stc|zain|mobily|lebara|stcSim|zainSim|mobilySim|lebaraSim|n950|i9000s|i9100|a960)["'`]/i;

  for (const file of productionFiles) {
    it(`${file.split(/[\\/]/).pop()} contains no hardcoded carrier/type literal`, () => {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code.match(forbidden)).toBeNull();
    });
  }
});
