import { describe, expect, it, vi, beforeEach } from "vitest";

// --- Mock the raw `db` import used directly by linkSimToTechnician (no live DB needed) ---
const dbState = {
  itemTypesRows: [{ id: "mobilySim", category: "sim", nameAr: "شريحة موبايلي" }] as any[],
  itemsRows: [] as any[],
};

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
    select: vi.fn(() => makeSelectChain([])), // overridden per-call via mockImplementationOnce in tests
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

import { db } from "@server/core/config/db";
import { CourierService } from "./courier.service";
import { AppError } from "@core/errors/AppError";

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

describe("courier.service — silent STC-default classification fix", () => {
  describe("confirmReceiving(): SIM minting hint resolution", () => {
    it("does NOT silently mint an unrecognized carrier as STC — throws instead", async () => {
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

    it("still resolves an explicit STC request correctly (no regression)", async () => {
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

    it("still resolves Mobily correctly (unaffected branch)", async () => {
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
  });

  describe("linkSimToTechnician(): carrierName fallback fix", () => {
    beforeEach(() => {
      vi.mocked(db.select).mockReset();
    });

    it("throws instead of silently defaulting carrierName to STC when inserting a brand-new SIM with no simType", async () => {
      const fakeUow = { execute: async (cb: any) => cb({}) } as any;
      const service = new CourierService(fakeUow, {} as any, {} as any, {} as any, {} as any, {} as any);

      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([{ id: "mobilySim", category: "sim" }]) as any) // itemTypesList lookup
        .mockReturnValueOnce(makeSelectChain([]) as any); // existing items lookup -> none found (insert path)

      await expect(
        service.linkSimToTechnician({ simSerial: "899660000000000099" } as any)
      ).rejects.toThrow(AppError);
    });

    it("accepts an explicit simType and does not fall back to STC", async () => {
      const fakeUow = { execute: async (cb: any) => cb({}) } as any;
      const service = new CourierService(fakeUow, {} as any, {} as any, {} as any, {} as any, {} as any);

      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([{ id: "mobilySim", category: "sim" }]) as any)
        .mockReturnValueOnce(makeSelectChain([]) as any);

      const result = await service.linkSimToTechnician({
        simSerial: "899660000000000099",
        simType: "Mobily",
      } as any);

      expect(result.success).toBe(true);
      expect(result.item.carrierName).toBe("Mobily");
      expect(result.item.carrierName).not.toBe("STC");
    });

    it("update path: keeps the existing stored carrierName when no new simType is sent (not an STC override)", async () => {
      const fakeUow = { execute: async (cb: any) => cb({}) } as any;
      const service = new CourierService(fakeUow, {} as any, {} as any, {} as any, {} as any, {} as any);

      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([{ id: "mobilySim", category: "sim" }]) as any)
        .mockReturnValueOnce(
          makeSelectChain([{ id: "existing-item-id", carrierName: "Zain" }]) as any
        ); // existing item found -> update path

      const result = await service.linkSimToTechnician({
        simSerial: "899660000000000099",
      } as any);

      expect(result.success).toBe(true);
      expect(result.item.carrierName).toBe("Zain");
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
