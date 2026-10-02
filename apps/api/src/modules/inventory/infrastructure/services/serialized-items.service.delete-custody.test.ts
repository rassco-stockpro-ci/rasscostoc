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
  priorDeletionRows?: any[];
  deleteReturning?: any[];
  movingEntry?: any;
};

function createMockTx(opts: MockTxOptions) {
  const {
    itemRow = null,
    courierRows = [],
    itemTypeRow = { nameAr: "جهاز POS", nameEn: "POS Device", category: "devices" },
    priorDeletionRows = [],
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
        if (table === systemLogs) return makeChain(priorDeletionRows);
        if (table === technicianMovingInventoryEntries) return makeChain(movingEntry ? [movingEntry] : []);
        return makeChain([]);
      }),
    })),
    insert: vi.fn(() => ({ values: insertValuesMock })),
    update: vi.fn(() => ({ set: updateSetMock })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(deleteReturning)) })),
    })),
    // TEMP-SYSTEM-STABILIZATION: syncMovingInventory now acquires a
    // transaction-scoped Postgres advisory lock (pg_advisory_xact_lock) via
    // tx.execute(sql`...`) before its read/update — the mock tx needs this
    // method too, or that call throws "tx.execute is not a function".
    execute: vi.fn(() => Promise.resolve()),
    _insertValuesMock: insertValuesMock,
    _updateSetMock: updateSetMock,
  };
  return tx;
}

describe("SerializedItemsService.deleteFromTechnicianCustody (TEMPORARY FEATURE)", () => {
  let service: SerializedItemsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SerializedItemsService();
  });

  const ACTIVE_DEVICE = {
    id: "item-1",
    serialNumber: "SN-DEVICE-777",
    itemTypeId: "type-1",
    status: "RECEIVED_BY_TECHNICIAN",
    currentOwnerId: "tech-1",
    warehouseId: null,
  };

  const ACTIVE_SIM = {
    id: "item-2",
    serialNumber: "89966020000000123456",
    itemTypeId: "type-sim",
    status: "RECEIVED_BY_TECHNICIAN",
    currentOwnerId: "tech-1",
    warehouseId: null,
  };
  const SIM_ITEM_TYPE_ROW = { nameAr: "شريحة STC", nameEn: "STC SIM", category: "sim" };

  it("rejects an itemType outside DEVICE/SIM before ever touching the database", async () => {
    await expect(
      service.deleteFromTechnicianCustody(
        "tech-1",
        "tech1user",
        "technician",
        "TABLET",
        "SN-DEVICE-777",
        "SN-DEVICE-777"
      )
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_ITEM_TYPE" });

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("DEVICE_DELETE_USES_SERIAL_NUMBER: deletes a DEVICE identified by serial_number", async () => {
    const tx = createMockTx({ itemRow: ACTIVE_DEVICE });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.deleteFromTechnicianCustody(
      "tech-1",
      "tech1user",
      "technician",
      "DEVICE",
      "SN-DEVICE-777",
      "SN-DEVICE-777"
    );

    expect(result).toEqual({
      itemType: "DEVICE",
      serialNumber: "SN-DEVICE-777",
      deleted: true,
      alreadyDeleted: false,
    });
    expect(tx.delete).toHaveBeenCalledWith(items);
  });

  it("SIM_DELETE_USES_SIM_SERIAL: deletes a SIM identified by sim_serial / ICCID serial_number", async () => {
    const tx = createMockTx({ itemRow: ACTIVE_SIM, itemTypeRow: SIM_ITEM_TYPE_ROW });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.deleteFromTechnicianCustody(
      "tech-1",
      "tech1user",
      "technician",
      "SIM",
      ACTIVE_SIM.serialNumber,
      ACTIVE_SIM.serialNumber
    );

    expect(result).toEqual({
      itemType: "SIM",
      serialNumber: ACTIVE_SIM.serialNumber,
      deleted: true,
      alreadyDeleted: false,
    });
    expect(tx.delete).toHaveBeenCalledWith(items);
  });

  it("deletes a DEVICE that is genuinely in the technician's own active custody", async () => {
    const tx = createMockTx({ itemRow: ACTIVE_DEVICE });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.deleteFromTechnicianCustody(
      "tech-1",
      "tech1user",
      "technician",
      "DEVICE",
      "SN-DEVICE-777",
      "SN-DEVICE-777"
    );

    expect(result).toEqual({
      itemType: "DEVICE",
      serialNumber: "SN-DEVICE-777",
      deleted: true,
      alreadyDeleted: false,
    });
    // Audit record written before the delete
    expect(tx.insert).toHaveBeenCalledWith(systemLogs);
    expect(tx._insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "tech-1",
        action: "delete_custody_serial",
        entityType: "item",
        entityId: "item-1",
        entityName: "SN-DEVICE-777",
        severity: "warn",
        success: true,
      })
    );
    // The item row itself was deleted
    expect(tx.delete).toHaveBeenCalledWith(items);
    // Balance recalculated via the official decrement path (syncMovingInventory).
    // TEMP-SYSTEM-STABILIZATION: the decrement is now computed as an atomic SQL
    // expression (GREATEST(0, units + delta)) rather than a plain JS-computed
    // literal, closing a lost-update race — so this asserts the `units` field
    // was set at all (behavior), not the exact value shape of the computation
    // (implementation detail covered instead by the dedicated real-Postgres
    // concurrency test, syncMovingInventoryConcurrency.test.ts).
    expect(tx.update).toHaveBeenCalledWith(technicianMovingInventoryEntries);
    expect(tx._updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ units: expect.anything() })
    );
  });

  it("deletes a SIM that is genuinely in the technician's own active custody", async () => {
    const tx = createMockTx({ itemRow: ACTIVE_SIM, itemTypeRow: SIM_ITEM_TYPE_ROW });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.deleteFromTechnicianCustody(
      "tech-1",
      "tech1user",
      "technician",
      "SIM",
      ACTIVE_SIM.serialNumber,
      ACTIVE_SIM.serialNumber
    );

    expect(result).toEqual({
      itemType: "SIM",
      serialNumber: ACTIVE_SIM.serialNumber,
      deleted: true,
      alreadyDeleted: false,
    });
    expect(tx.delete).toHaveBeenCalledWith(items);
  });

  it("returns 404 when the itemType segment doesn't match what the serial actually is (a SIM requested as DEVICE)", async () => {
    // The serial genuinely belongs to this technician, but it's a SIM, not a device —
    // requesting it via .../DEVICE/... must not delete it and must not confirm its existence.
    const tx = createMockTx({ itemRow: ACTIVE_SIM, itemTypeRow: SIM_ITEM_TYPE_ROW });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.deleteFromTechnicianCustody(
        "tech-1",
        "tech1user",
        "technician",
        "DEVICE",
        ACTIVE_SIM.serialNumber,
        ACTIVE_SIM.serialNumber
      )
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("rejects mismatched confirmation before ever touching the database", async () => {
    await expect(
      service.deleteFromTechnicianCustody(
        "tech-1",
        "tech1user",
        "technician",
        "DEVICE",
        "SN-DEVICE-777",
        "WRONG"
      )
    ).rejects.toMatchObject({ statusCode: 400, code: "CONFIRMATION_MISMATCH" });

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 403 ITEM_NOT_IN_YOUR_CUSTODY when the item belongs to a different technician", async () => {
    const otherTechItem = { ...ACTIVE_DEVICE, currentOwnerId: "some-other-technician-id" };
    const tx = createMockTx({ itemRow: otherTechItem });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.deleteFromTechnicianCustody(
        "tech-1",
        "tech1user",
        "technician",
        "DEVICE",
        "SN-DEVICE-777",
        "SN-DEVICE-777"
      )
    ).rejects.toMatchObject({ statusCode: 403, code: "ITEM_NOT_IN_YOUR_CUSTODY" });

    // Must never delete or touch balance when ownership doesn't match
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("does not leak the other technician's identity in the error", async () => {
    const otherTechItem = { ...ACTIVE_DEVICE, currentOwnerId: "some-other-technician-id" };
    const tx = createMockTx({ itemRow: otherTechItem });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    try {
      await service.deleteFromTechnicianCustody(
        "tech-1",
        "tech1user",
        "technician",
        "DEVICE",
        "SN-DEVICE-777",
        "SN-DEVICE-777"
      );
      throw new Error("expected rejection");
    } catch (err: any) {
      expect(err.message).not.toContain("some-other-technician-id");
    }
  });

  it("ignores a client-supplied ownerId/technicianId — authorization is derived only from the locked row", async () => {
    // Even though the caller "claims" to be tech-1 (as req.user.id would be), the locked
    // row's currentOwnerId is the source of truth; a mismatched row is still rejected.
    const otherTechItem = { ...ACTIVE_DEVICE, currentOwnerId: "attacker-controlled-id" };
    const tx = createMockTx({ itemRow: otherTechItem });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.deleteFromTechnicianCustody(
        "tech-1",
        "tech1user",
        "technician",
        "DEVICE",
        "SN-DEVICE-777",
        "SN-DEVICE-777"
      )
    ).rejects.toMatchObject({ code: "ITEM_NOT_IN_YOUR_CUSTODY" });
  });

  it("returns 409 ITEM_HAS_ACTIVE_RELATIONS when an open courier request references the item", async () => {
    const tx = createMockTx({
      itemRow: ACTIVE_DEVICE,
      courierRows: [{ status: "PENDING_RECEIPT" }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.deleteFromTechnicianCustody(
        "tech-1",
        "tech1user",
        "technician",
        "DEVICE",
        "SN-DEVICE-777",
        "SN-DEVICE-777"
      )
    ).rejects.toMatchObject({ statusCode: 409, code: "ITEM_HAS_ACTIVE_RELATIONS" });

    expect(tx.delete).not.toHaveBeenCalled();
  });

  it("allows deletion when linked courier requests are all terminal (delivered/rejected/missing)", async () => {
    const tx = createMockTx({
      itemRow: ACTIVE_DEVICE,
      courierRows: [{ status: "DELIVERED" }, { status: "REJECTED" }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.deleteFromTechnicianCustody(
      "tech-1",
      "tech1user",
      "technician",
      "DEVICE",
      "SN-DEVICE-777",
      "SN-DEVICE-777"
    );

    expect(result.deleted).toBe(true);
  });

  it("returns 404 for a serial that was never registered", async () => {
    const tx = createMockTx({ itemRow: null, priorDeletionRows: [] });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.deleteFromTechnicianCustody(
        "tech-1",
        "tech1user",
        "technician",
        "DEVICE",
        "SN-NEVER-EXISTED",
        "SN-NEVER-EXISTED"
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("is idempotent: a retried request after a prior successful delete reports alreadyDeleted without side effects", async () => {
    const tx = createMockTx({
      itemRow: null,
      priorDeletionRows: [{ id: "log-1" }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.deleteFromTechnicianCustody(
      "tech-1",
      "tech1user",
      "technician",
      "DEVICE",
      "SN-DEVICE-777",
      "SN-DEVICE-777"
    );

    expect(result).toEqual({
      itemType: "DEVICE",
      serialNumber: "SN-DEVICE-777",
      deleted: true,
      alreadyDeleted: true,
    });
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("rolls back (propagates the error, never returns a partial result) when the balance sync step fails", async () => {
    const tx = createMockTx({ itemRow: ACTIVE_DEVICE });
    tx.update = vi.fn(() => {
      throw new Error("simulated balance-sync failure");
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.deleteFromTechnicianCustody(
        "tech-1",
        "tech1user",
        "technician",
        "DEVICE",
        "SN-DEVICE-777",
        "SN-DEVICE-777"
      )
    ).rejects.toThrow("simulated balance-sync failure");
  });
});
