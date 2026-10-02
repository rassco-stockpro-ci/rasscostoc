/**
 * Application-layer policy tests for ConsumablesGuard. HTTP behaviour of the
 * rejection (status, body) is covered in the presentation layer:
 * presentation/http/guard-validation-error.http.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { ConsumablesGuard } from "./ConsumablesGuard";
import { GuardValidationError, type GuardContext } from "./guard.types";
import { consumableRequirements } from "../inventory/consumables";
import { AppError } from "@core/errors/AppError";

const TECH = { id: "tech-1", username: "tech.one", fullName: "فني تجريبي" };

function ctx(executionData: Record<string, any>, opts: {
  balances?: Record<string, { unitsPerBox: number; buckets: { boxes: number; units: number }[] }>;
  deducted?: boolean;
  existing?: Record<string, any> | null;
} = {}) {
  const inventoryPort = {
    getTechnicianConsumableBalances: vi.fn(async () => opts.balances ?? {}),
    hasInventoryDeductionCompletion: vi.fn(async () => opts.deducted ?? false),
  };
  const c = {
    requestId: 2304,
    enteredBy: "u",
    executionData: { installationStatus: "Installation Completed", ...executionData },
    request: { id: 2304 },
    existingExecution: opts.existing ?? null,
    requestsRepo: {},
    dashboardRepo: {},
    inventoryPort,
  } as unknown as GuardContext;
  return { c, inventoryPort };
}

const BAL = {
  rollPaper: { unitsPerBox: 50, buckets: [{ boxes: 0, units: 3 }, { boxes: 1, units: 0 }] }, // 53
  stickers: { unitsPerBox: 100, buckets: [{ boxes: 0, units: 10 }] }, // 10
  "1010": { unitsPerBox: 10, buckets: [] }, // 0
};

describe("consumableRequirements", () => {
  it("maps quantities to item types, drops zero/invalid, sorts by itemTypeId", () => {
    expect(consumableRequirements({ paperRollQty: "2", stickersQty: 0, nulipCardsQty: 3 })).toEqual([
      { itemTypeId: "1010", label: "بطاقات نيوليب", quantity: 3 },
      { itemTypeId: "rollPaper", label: "ورق الطباعة (رول)", quantity: 2 },
    ]);
    expect(consumableRequirements({ paperRollQty: null, stickersQty: -4, nulipCardsQty: "abc" })).toEqual([]);
  });
});

describe("ConsumablesGuard — reject the close when the technician balance cannot cover it", () => {
  it("passes when moving + fixed (boxes counted) cover every item", async () => {
    const { c } = ctx({ paperRollQty: 53, stickersQty: 10 }, { balances: BAL });
    await expect(ConsumablesGuard.validate(c, TECH)).resolves.toBeUndefined();
  });

  it("rejects with a clear Arabic reason listing each shortage", async () => {
    const { c } = ctx({ paperRollQty: 60, stickersQty: 10, nulipCardsQty: 1 }, { balances: BAL });
    const err = await ConsumablesGuard.validate(c, TECH).catch((e) => e);
    expect(err).toBeInstanceOf(GuardValidationError);
    expect(err.field).toBe("consumables");
    expect(err.message).toContain("رصيد الفني «فني تجريبي» لا يكفي لإغلاق الطلب");
    expect(err.message).toContain("ورق الطباعة (رول) المطلوب 60 والمتاح 53");
    expect(err.message).toContain("بطاقات نيوليب المطلوب 1 والمتاح 0");
    expect(err.message).not.toContain("الملصقات");
  });

  it("treats an item type with no balance rows as zero available", async () => {
    const { c } = ctx({ stickersQty: 1 }, { balances: {} });
    await expect(ConsumablesGuard.validate(c, TECH)).rejects.toThrow("الملصقات المطلوب 1 والمتاح 0");
  });

  it("does nothing (no DB reads) when no consumables are entered", async () => {
    const { c, inventoryPort } = ctx({ paperRollQty: 0, stickersQty: 0, nulipCardsQty: 0 });
    await ConsumablesGuard.validate(c, TECH);
    expect(inventoryPort.hasInventoryDeductionCompletion).not.toHaveBeenCalled();
    expect(inventoryPort.getTechnicianConsumableBalances).not.toHaveBeenCalled();
  });

  it("does nothing for a non-completing status", async () => {
    const { c, inventoryPort } = ctx({ installationStatus: "Not Completed", paperRollQty: 999 });
    await ConsumablesGuard.validate(c, TECH);
    expect(inventoryPort.getTechnicianConsumableBalances).not.toHaveBeenCalled();
  });

  it("skips the check once the request's deduction is already recorded (edit after close)", async () => {
    const { c, inventoryPort } = ctx({ paperRollQty: 999 }, { balances: BAL, deducted: true });
    await expect(ConsumablesGuard.validate(c, TECH)).resolves.toBeUndefined();
    expect(inventoryPort.getTechnicianConsumableBalances).not.toHaveBeenCalled();
  });

  it("uses the stored quantity when an update omits the field", async () => {
    const { c } = ctx({}, { balances: BAL, existing: { paperRollQty: 54 } });
    await expect(ConsumablesGuard.validate(c, TECH)).rejects.toThrow("المطلوب 54 والمتاح 53");
  });

  it("queries balances for the resolved technician and only the requested item types", async () => {
    const { c, inventoryPort } = ctx({ paperRollQty: 1, nulipCardsQty: 0 }, { balances: BAL });
    await ConsumablesGuard.validate(c, TECH);
    expect(inventoryPort.getTechnicianConsumableBalances).toHaveBeenCalledWith("tech-1", ["rollPaper"]);
  });
});

describe("GuardValidationError is an operational 422 AppError", () => {
  it("is an AppError with status 422 and a stable code", () => {
    const err = new GuardValidationError("سبب الرفض", "sn");
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("GUARD_VALIDATION_FAILED");
    expect(err.name).toBe("GuardValidationError");
    expect(err.field).toBe("sn");
  });
});
