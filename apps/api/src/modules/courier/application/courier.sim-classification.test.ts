import { describe, expect, it, vi, beforeEach } from "vitest";

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
        returning: () => Promise.resolve([{ id: "new-type-id", ...v }]),
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

// resolveSimItemTypeCandidates is the catalog-regex resolver this fix now routes
// through — mocked directly so these tests exercise courier.service.ts's own
// candidate-count handling (0/1/2+), not the resolver's own regex logic
// (which has its own dedicated test file).
vi.mock("./sim-item-type-resolver", () => ({
  resolveSimItemTypeCandidates: vi.fn(),
}));

import { db } from "@server/core/config/db";
import { resolveSimItemTypeCandidates } from "./sim-item-type-resolver";
import { CourierService } from "./courier.service";
import { AppError } from "@core/errors/AppError";

const mobilyType = { id: "mobilySim", nameEn: "Mobily SIM", nameAr: "شريحة موبايلي", category: "sim" };
const stcType = { id: "stcSim", nameEn: "STC SIM", nameAr: "شريحة STC", category: "sim" };

function buildServiceWithFakeCtx(opts: {
  reqDataSim: string | null;
  itemType: "SIM" | "POS";
  normalizeSerialMock: ReturnType<typeof vi.fn>;
}) {
  const fakeCtx = {
    requestsRepository: {
      findRequestItemsBySerials: vi.fn().mockResolvedValue([]),
      updateRequestItem: vi.fn().mockResolvedValue({}),
      findRequestItems: vi.fn().mockResolvedValue([
        { id: 1, status: "RECEIVED", itemType: opts.itemType, serialNumber: null, simSerial: "899660000000000001" },
      ]),
      findRequestById: vi.fn().mockResolvedValue({ id: 1, sim: opts.reqDataSim }),
      insertRequestItems: vi.fn().mockResolvedValue([]),
    },
    executionsRepository: {
      findExecutionByRequestId: vi.fn().mockResolvedValue(null),
      insertExecution: vi.fn().mockResolvedValue({}),
      updateExecution: vi.fn().mockResolvedValue({}),
    },
    inventoryPort: {
      findItemBySerial: vi.fn().mockResolvedValue(null), // forces the MINTING branch
      transferCustodyToTechnician: vi.fn().mockResolvedValue({}),
      normalizeSerial: opts.normalizeSerialMock,
      mintAndAssignToTechnician: vi.fn().mockResolvedValue({}),
    },
    dashboardRepository: {
      insertAuditLog: vi.fn().mockResolvedValue({}),
    },
  };

  const fakeUow = {
    execute: async (cb: (ctx: any) => Promise<any>) => cb(fakeCtx),
  };

  const fakeRequestsRepo = {
    findRequestItems: vi.fn().mockResolvedValue([{ id: 1 }]), // non-empty: the pre-transaction guard
    findRequestWithDetails: vi.fn().mockResolvedValue({ id: 1 }), // called at the end via getRequestById
  };
  const fakeExecutionsRepo = {};
  const fakePdfRepo = {};
  const fakeDashboardRepo = {};

  const service = new CourierService(
    fakeUow as any,
    fakeRequestsRepo as any,
    fakeExecutionsRepo as any,
    fakePdfRepo as any,
    fakeDashboardRepo as any,
    fakeCtx.inventoryPort as any
  );

  return { service, fakeCtx };
}

describe("courier.service — catalog-regex SIM classification (no hardcoded carrier keywords)", () => {
  beforeEach(() => {
    vi.mocked(resolveSimItemTypeCandidates).mockReset();
  });

  describe("confirmReceiving(): SIM minting hint resolution", () => {
    it("0 regex matches — does NOT silently mint anything, throws instead", async () => {
      vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([]);
      const normalizeSerialMock = vi.fn().mockResolvedValue({
        normalizedSerial: "899660000000000001",
        itemTypeId: "stcSim",
        carrierName: null,
      });
      const { service } = buildServiceWithFakeCtx({
        reqDataSim: "Virgin Mobile 2x",
        itemType: "SIM",
        normalizeSerialMock,
      });

      await expect(service.confirmReceiving(1, "tech-1")).rejects.toThrow(AppError);
      expect(normalizeSerialMock).not.toHaveBeenCalled();
    });

    it("exactly 1 regex match (STC) — auto-resolves correctly (no regression)", async () => {
      vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([stcType] as any);
      const normalizeSerialMock = vi.fn().mockResolvedValue({
        normalizedSerial: "899660000000000001",
        itemTypeId: "stcSim",
        carrierName: null,
      });
      const { service } = buildServiceWithFakeCtx({
        reqDataSim: "STC 1x",
        itemType: "SIM",
        normalizeSerialMock,
      });

      await service.confirmReceiving(1, "tech-1");
      expect(normalizeSerialMock).toHaveBeenCalledWith("899660000000000001", "stcSim");
    });

    it("exactly 1 regex match (Mobily) — auto-resolves correctly (unaffected branch)", async () => {
      vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([mobilyType] as any);
      const normalizeSerialMock = vi.fn().mockResolvedValue({
        normalizedSerial: "899660000000000001",
        itemTypeId: "mobilySim",
        carrierName: null,
      });
      const { service } = buildServiceWithFakeCtx({
        reqDataSim: "Mobily 1x",
        itemType: "SIM",
        normalizeSerialMock,
      });

      await service.confirmReceiving(1, "tech-1");
      expect(normalizeSerialMock).toHaveBeenCalledWith("899660000000000001", "mobilySim");
    });

    it("2+ regex matches (proven real scenario: mobily/stc share a pattern) — ambiguous, throws, never picks one", async () => {
      vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([mobilyType, stcType] as any);
      const normalizeSerialMock = vi.fn();
      const { service } = buildServiceWithFakeCtx({
        reqDataSim: "some SIM",
        itemType: "SIM",
        normalizeSerialMock,
      });

      await expect(service.confirmReceiving(1, "tech-1")).rejects.toThrow(AppError);
      expect(normalizeSerialMock).not.toHaveBeenCalled();
    });
  });

  describe("linkSimToTechnician(): catalog-driven type + carrierName resolution", () => {
    beforeEach(() => {
      vi.mocked(db.select).mockReset();
    });

    it("new item, 0 regex matches, no simType — throws instead of defaulting to STC", async () => {
      vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([]);
      const fakeUow = { execute: async (cb: any) => cb({}) } as any;
      const service = new CourierService(fakeUow, {} as any, {} as any, {} as any, {} as any, {} as any);

      vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any); // existing items lookup -> none found

      await expect(
        service.linkSimToTechnician({ simSerial: "899660000000000099" } as any)
      ).rejects.toThrow(AppError);
    });

    it("new item, 2+ regex matches, no simType — throws (ambiguous), requires explicit simType", async () => {
      vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([mobilyType, stcType] as any);
      const fakeUow = { execute: async (cb: any) => cb({}) } as any;
      const service = new CourierService(fakeUow, {} as any, {} as any, {} as any, {} as any, {} as any);

      vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any);

      await expect(
        service.linkSimToTechnician({ simSerial: "899660000000000099" } as any)
      ).rejects.toThrow(AppError);
    });

    it("new item, exactly 1 regex match, explicit simType provided — resolves via catalog, carrierName is the explicit value (not STC)", async () => {
      vi.mocked(resolveSimItemTypeCandidates).mockResolvedValue([mobilyType] as any);
      const fakeUow = { execute: async (cb: any) => cb({}) } as any;
      const service = new CourierService(fakeUow, {} as any, {} as any, {} as any, {} as any, {} as any);

      vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any);

      const result = await service.linkSimToTechnician({
        simSerial: "899660000000000099",
        simType: "Mobily",
      } as any);

      expect(result.success).toBe(true);
      expect(result.item.itemTypeId).toBe("mobilySim");
      expect(result.item.carrierName).toBe("Mobily");
      expect(result.item.carrierName).not.toBe("STC");
    });

    it("existing item found — keeps its stored itemTypeId AND carrierName verbatim; the catalog resolver is never called (re-deriving on every re-link risks flipping a correctly-classified item under overlapping regexes)", async () => {
      const fakeUow = { execute: async (cb: any) => cb({}) } as any;
      const service = new CourierService(fakeUow, {} as any, {} as any, {} as any, {} as any, {} as any);

      vi.mocked(db.select).mockReturnValueOnce(
        makeSelectChain([{ id: "existing-item-id", itemTypeId: "zainSim", carrierName: "Zain" }]) as any
      );

      const result = await service.linkSimToTechnician({
        simSerial: "899660000000000099",
      } as any);

      expect(result.success).toBe(true);
      expect(result.item.carrierName).toBe("Zain");
      expect(resolveSimItemTypeCandidates).not.toHaveBeenCalled();
    });
  });
});

describe("courier.controller — linkSimToTechnician no longer defaults simType to STC", () => {
  it("passes undefined (not 'STC') to the service when the client omits simType", async () => {
    const { CourierController } = await import("../presentation/controllers/courier.controller");
    const fakeService = {
      linkSimToTechnician: vi.fn().mockResolvedValue({ success: true }),
    };
    const controller = new (CourierController as any)(fakeService);

    const req: any = { body: { simSerial: "899660000000000099" } };
    const res: any = { json: vi.fn() };

    await controller.linkSimToTechnician(req, res, vi.fn());

    expect(fakeService.linkSimToTechnician).toHaveBeenCalledWith(
      expect.objectContaining({ simType: undefined })
    );
  });
});
