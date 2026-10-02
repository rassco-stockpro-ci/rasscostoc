import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  items,
  itemTypes,
  courierRequestItems,
  systemLogs,
  technicianMovingInventoryEntries,
  custodyMovements,
} from "@shared/schema";

const mockTransaction = vi.fn();

vi.mock("@core/config/db", () => ({
  db: {
    transaction: (cb: any) => mockTransaction(cb),
  },
}));

vi.mock("@core/serial/serial-recognition.service", () => ({
  SerialRecognitionService: {
    buildStoredSerialCandidates: vi.fn(async (raw: string) => (raw ? [raw.trim().toUpperCase()] : [])),
  },
}));

import { SerializedItemsService } from "./serialized-items.service";

/** Builds a thenable, chainable Drizzle-style query result stub. */
function makeChain(result: any) {
  const chain: any = {
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    for: vi.fn(() => Promise.resolve(result)),
    limit: vi.fn(() => Promise.resolve(result)),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

type MockTxOptions = {
  itemRow?: any;
  courierRows?: any[];
  itemTypeRow?: any;
  deliveryRecordRows?: any[];
  deleteReturning?: any[];
  movingEntry?: any;
};

function createMockTx(opts: MockTxOptions) {
  const {
    itemRow = null,
    courierRows = [],
    itemTypeRow = { nameAr: "جهاز POS", nameEn: "POS Device", category: "devices" },
    deliveryRecordRows = [],
    deleteReturning = itemRow ? [itemRow] : [],
    movingEntry = { id: "entry-1", technicianId: "tech-1", itemTypeId: "type-1", units: 3, boxes: 0 },
  } = opts;

  const insertValuesMock = vi.fn(() => Promise.resolve());
  const updateSetMock = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));

  const tx: any = {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => {
        if (table === items) return makeChain(itemRow ? [itemRow] : []);
        if (table === courierRequestItems) return makeChain(courierRows);
        if (table === itemTypes) return makeChain(itemTypeRow ? [itemTypeRow] : []);
        if (table === custodyMovements) return makeChain(deliveryRecordRows);
        if (table === systemLogs) return makeChain([]);
        if (table === technicianMovingInventoryEntries) return makeChain(movingEntry ? [movingEntry] : []);
        return makeChain([]);
      }),
    })),
    insert: vi.fn(() => ({ values: insertValuesMock })),
    update: vi.fn(() => ({ set: updateSetMock })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(deleteReturning)) })),
    })),
    execute: vi.fn(() => Promise.resolve()),
    _insertValuesMock: insertValuesMock,
    _updateSetMock: updateSetMock,
  };
  return tx;
}

describe("SerializedItemsService.technicianDeleteOwnSerializedItem (TEMPORARY FEATURE)", () => {
  let service: SerializedItemsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SerializedItemsService();
  });

  const ACTIVE_OWNED_DEVICE = {
    id: "item-1",
    serialNumber: "SN-DEVICE-777",
    itemTypeId: "type-1",
    status: "RECEIVED_BY_TECHNICIAN",
    currentOwnerId: "tech-1",
    warehouseId: null,
  };

  const DELIVERED_ITEM = {
    id: "item-2",
    serialNumber: "SN-DEVICE-888",
    itemTypeId: "type-1",
    status: "DELIVERED",
    currentOwnerId: null,
    warehouseId: null,
  };

  it("returns 404 for an item id that does not exist — never touches balance", async () => {
    const tx = createMockTx({ itemRow: null });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.technicianDeleteOwnSerializedItem("tech-1", "tech1user", "technician", "nonexistent-id")
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("deletes an actively-held item owned by this technician and decrements moving inventory", async () => {
    const tx = createMockTx({ itemRow: ACTIVE_OWNED_DEVICE });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.technicianDeleteOwnSerializedItem(
      "tech-1",
      "tech1user",
      "technician",
      "item-1"
    );

    expect(result).toEqual({
      itemId: "item-1",
      serialNumber: "SN-DEVICE-777",
      deleted: true,
    });
    expect(tx.delete).toHaveBeenCalledWith(items);
    // Decrement path (syncMovingInventory) was exercised for an actively-held item.
    expect(tx.update).toHaveBeenCalledWith(technicianMovingInventoryEntries);
    expect(tx._insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "tech-1",
        action: "technician_delete_own_serialized_item",
        entityId: "item-1",
        entityName: "SN-DEVICE-777",
      })
    );
  });

  it("rejects an actively-held item belonging to a DIFFERENT technician — 403, no delete, no balance change", async () => {
    const otherTechItem = { ...ACTIVE_OWNED_DEVICE, currentOwnerId: "some-other-technician-id" };
    const tx = createMockTx({ itemRow: otherTechItem });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.technicianDeleteOwnSerializedItem("tech-1", "tech1user", "technician", "item-1")
    ).rejects.toMatchObject({ statusCode: 403, code: "ITEM_NOT_IN_YOUR_CUSTODY" });

    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("does not leak the other technician's identity in the error", async () => {
    const otherTechItem = { ...ACTIVE_OWNED_DEVICE, currentOwnerId: "some-other-technician-id" };
    const tx = createMockTx({ itemRow: otherTechItem });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    try {
      await service.technicianDeleteOwnSerializedItem("tech-1", "tech1user", "technician", "item-1");
      throw new Error("expected rejection");
    } catch (err: any) {
      expect(err.message).not.toContain("some-other-technician-id");
    }
  });

  it("deletes a DELIVERED item whose LATEST delivery movement names this technician — NO decrement", async () => {
    // The mock stands in for "after ORDER BY performed_at DESC LIMIT 1, this is the
    // single row the real query returns" — it does not itself apply the query's WHERE
    // filter (see the note on the next test for what this mock can and cannot prove).
    const tx = createMockTx({
      itemRow: DELIVERED_ITEM,
      deliveryRecordRows: [{ fromOwnerId: "tech-1" }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.technicianDeleteOwnSerializedItem(
      "tech-1",
      "tech1user",
      "technician",
      "item-2"
    );

    expect(result).toEqual({
      itemId: "item-2",
      serialNumber: "SN-DEVICE-888",
      deleted: true,
    });
    expect(tx.delete).toHaveBeenCalledWith(items);
    // Critical regression guard: scanOut/custody-engine already decremented once at
    // delivery time — deleting a DELIVERED item must NEVER decrement a second time.
    expect(tx.update).not.toHaveBeenCalledWith(technicianMovingInventoryEntries);
  });

  it("rejects a DELIVERED item whose LATEST delivery movement names a DIFFERENT technician — 403, " +
      "even though this technician may appear elsewhere in the item's older history " +
      "(e.g. delivered once by A, later returned, transferred, and redelivered by B: " +
      "A must get 403 for the CURRENT DELIVERED state)", async () => {
    // This proves the JS-side comparison (latestDeliveryMovement.fromOwnerId === technicianId)
    // is correct given whatever single row the ORDER BY...LIMIT 1 query returns. It does NOT,
    // by itself, prove the real SQL query omits a `fromOwnerId = technicianId` WHERE filter —
    // this mock's `.where()` is a no-op passthrough, so it cannot distinguish the old (buggy,
    // filtered-by-technician) query shape from the corrected one. That SQL-shape guarantee is
    // verified by code review of the query itself (no `eq(custodyMovements.fromOwnerId, technicianId)`
    // in its WHERE clause) — a real-database test would be the only way to verify it end-to-end,
    // and per policy this feature no longer runs DB-writing integration tests against production.
    const tx = createMockTx({
      itemRow: DELIVERED_ITEM,
      deliveryRecordRows: [{ fromOwnerId: "some-other-technician-id" }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.technicianDeleteOwnSerializedItem("tech-1", "tech1user", "technician", "item-2")
    ).rejects.toMatchObject({ statusCode: 403, code: "ITEM_NOT_IN_YOUR_CUSTODY" });

    expect(tx.delete).not.toHaveBeenCalled();
  });

  it("rejects a DELIVERED item with no delivery movement recorded at all — 403", async () => {
    const tx = createMockTx({
      itemRow: DELIVERED_ITEM,
      deliveryRecordRows: [],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.technicianDeleteOwnSerializedItem("tech-1", "tech1user", "technician", "item-2")
    ).rejects.toMatchObject({ statusCode: 403, code: "ITEM_NOT_IN_YOUR_CUSTODY" });

    expect(tx.delete).not.toHaveBeenCalled();
  });

  it("rejects a status that is neither actively-held nor DELIVERED (e.g. RETURNED) even if currentOwnerId once matched", async () => {
    const returnedItem = { ...ACTIVE_OWNED_DEVICE, status: "RETURNED" };
    const tx = createMockTx({ itemRow: returnedItem });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.technicianDeleteOwnSerializedItem("tech-1", "tech1user", "technician", "item-1")
    ).rejects.toMatchObject({ statusCode: 403, code: "ITEM_NOT_IN_YOUR_CUSTODY" });

    expect(tx.delete).not.toHaveBeenCalled();
  });

  it("returns 409 ITEM_HAS_ACTIVE_RELATIONS when an open courier request references the item", async () => {
    const tx = createMockTx({
      itemRow: ACTIVE_OWNED_DEVICE,
      courierRows: [{ status: "PENDING_RECEIPT" }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.technicianDeleteOwnSerializedItem("tech-1", "tech1user", "technician", "item-1")
    ).rejects.toMatchObject({ statusCode: 409, code: "ITEM_HAS_ACTIVE_RELATIONS" });

    expect(tx.delete).not.toHaveBeenCalled();
  });

  it("propagates (rolls back) instead of returning a partial result when the balance sync step fails", async () => {
    const tx = createMockTx({ itemRow: ACTIVE_OWNED_DEVICE });
    tx.update = vi.fn(() => {
      throw new Error("simulated balance-sync failure");
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.technicianDeleteOwnSerializedItem("tech-1", "tech1user", "technician", "item-1")
    ).rejects.toThrow("simulated balance-sync failure");
  });
});
