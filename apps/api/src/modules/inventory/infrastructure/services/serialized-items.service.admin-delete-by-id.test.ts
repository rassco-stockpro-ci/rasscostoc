import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  items,
  itemTypes,
  courierRequestItems,
  systemLogs,
  technicianMovingInventoryEntries,
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

/**
 * TEMPORARY FEATURE (regression guard, not itself temporary) — this pins
 * adminDeleteSerializedItemById's behavior AFTER the hardDeleteItemCore
 * extraction (done to let technicianDeleteOwnSerializedItem reuse the same
 * logic). There was no pre-existing unit test file for this method before
 * that refactor; these tests exist specifically to prove the admin route's
 * public behavior — no ownership check, same conditional sync, same audit
 * action/description text, same active-courier-relation guard — is
 * byte-for-byte identical to before, per the explicit requirement that the
 * admin endpoint remain completely unchanged.
 */
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
  deleteReturning?: any[];
  movingEntry?: any;
};

function createMockTx(opts: MockTxOptions) {
  const {
    itemRow = null,
    courierRows = [],
    itemTypeRow = { nameAr: "جهاز POS", nameEn: "POS Device", category: "devices" },
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

describe("SerializedItemsService.adminDeleteSerializedItemById — unchanged after hardDeleteItemCore extraction", () => {
  let service: SerializedItemsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SerializedItemsService();
  });

  const ACTIVE_DEVICE_OWNED_BY_TECH = {
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

  it("returns 404 for a nonexistent item id", async () => {
    const tx = createMockTx({ itemRow: null });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.adminDeleteSerializedItemById("admin-1", "adminuser", "admin", "nonexistent-id")
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("deletes ANY technician's actively-held item with NO ownership check, and decrements that technician's balance", async () => {
    const tx = createMockTx({ itemRow: ACTIVE_DEVICE_OWNED_BY_TECH });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.adminDeleteSerializedItemById(
      "admin-1",
      "adminuser",
      "admin",
      "item-1"
    );

    expect(result).toEqual({
      itemId: "item-1",
      serialNumber: "SN-DEVICE-777",
      deleted: true,
    });
    expect(tx.delete).toHaveBeenCalledWith(items);
    // Same audit action string as before the refactor.
    expect(tx._insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "admin_delete_serialized_item",
        entityId: "item-1",
        entityName: "SN-DEVICE-777",
        description: "حذف الأدمن الجهاز SN-DEVICE-777 نهائيًا من عهدة الفني",
      })
    );
    // Conditional sync still fires for an actively-held item.
    expect(tx.update).toHaveBeenCalledWith(technicianMovingInventoryEntries);
  });

  it("deletes a DELIVERED item with NO balance decrement (currentOwnerId is null, status not in TECHNICIAN_HELD_STATUSES)", async () => {
    const tx = createMockTx({ itemRow: DELIVERED_ITEM });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.adminDeleteSerializedItemById(
      "admin-1",
      "adminuser",
      "admin",
      "item-2"
    );

    expect(result.deleted).toBe(true);
    expect(tx.delete).toHaveBeenCalledWith(items);
    // This is the exact conditional this refactor must preserve verbatim.
    expect(tx.update).not.toHaveBeenCalledWith(technicianMovingInventoryEntries);
  });

  it("uses the SIM audit label when the item's category is sim", async () => {
    const simItem = { ...ACTIVE_DEVICE_OWNED_BY_TECH, id: "item-3", serialNumber: "89966020000000123456" };
    const tx = createMockTx({
      itemRow: simItem,
      itemTypeRow: { nameAr: "شريحة STC", nameEn: "STC SIM", category: "sim" },
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await service.adminDeleteSerializedItemById("admin-1", "adminuser", "admin", "item-3");

    expect(tx._insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "حذف الأدمن الشريحة 89966020000000123456 نهائيًا من عهدة الفني",
      })
    );
  });

  it("still returns 409 ITEM_HAS_ACTIVE_RELATIONS when an open courier request references the item — no delete happens", async () => {
    const tx = createMockTx({
      itemRow: ACTIVE_DEVICE_OWNED_BY_TECH,
      courierRows: [{ status: "PENDING_RECEIPT" }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.adminDeleteSerializedItemById("admin-1", "adminuser", "admin", "item-1")
    ).rejects.toMatchObject({ statusCode: 409, code: "ITEM_HAS_ACTIVE_RELATIONS" });

    expect(tx.delete).not.toHaveBeenCalled();
  });

  it("allows deletion when linked courier requests are all terminal", async () => {
    const tx = createMockTx({
      itemRow: ACTIVE_DEVICE_OWNED_BY_TECH,
      courierRows: [{ status: "DELIVERED" }, { status: "REJECTED" }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.adminDeleteSerializedItemById(
      "admin-1",
      "adminuser",
      "admin",
      "item-1"
    );

    expect(result.deleted).toBe(true);
  });

  it("propagates (rolls back) rather than returning a partial result when the delete step fails", async () => {
    const tx = createMockTx({ itemRow: ACTIVE_DEVICE_OWNED_BY_TECH, deleteReturning: [] });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.adminDeleteSerializedItemById("admin-1", "adminuser", "admin", "item-1")
    ).rejects.toThrow("فشل حذف العنصر");
  });
});
