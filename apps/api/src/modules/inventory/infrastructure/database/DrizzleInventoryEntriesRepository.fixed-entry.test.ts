import { describe, expect, it, vi, beforeEach } from "vitest";
import { technicianFixedInventoryEntries, systemLogs } from "@shared/schema";

const mockTransaction = vi.fn();

vi.mock("@core/database/connection", () => ({
  getDatabase: () => ({ transaction: (cb: any) => mockTransaction(cb) }),
}));

vi.mock("@modules/inventory/infrastructure/database/TechnicianInventoryRepository", () => ({
  TechnicianInventoryRepository: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@modules/inventory/infrastructure/database/WarehouseInventoryRepository", () => ({
  WarehouseInventoryRepository: vi.fn().mockImplementation(() => ({})),
}));

import { DrizzleInventoryEntriesRepository } from "./DrizzleInventoryEntriesRepository";
import { ConflictError } from "@core/errors/AppError";

/** Thenable, chainable Drizzle-style query-result stub. */
function makeChain(result: any) {
  const chain: any = {
    where: vi.fn(() => chain),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

type TxOpts = {
  existingEntry?: any;
  updateReturning?: any[];
};

function createMockTx({ existingEntry = null, updateReturning }: TxOpts) {
  const insertValuesMock = vi.fn(() => ({
    returning: vi.fn(() => Promise.resolve([
      { id: "entry-new", technicianId: "tech-1", itemTypeId: "type-x", boxes: 5, units: 5 },
    ])),
  }));
  const systemLogsInsertMock = vi.fn(() => Promise.resolve());
  const updateReturningMock = vi.fn(() =>
    Promise.resolve(
      updateReturning !== undefined
        ? updateReturning
        : [{ id: existingEntry?.id, technicianId: "tech-1", itemTypeId: "type-x", boxes: 9, units: 9 }],
    ),
  );

  const tx: any = {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => {
        if (table === technicianFixedInventoryEntries) return makeChain(existingEntry ? [existingEntry] : []);
        return makeChain([]);
      }),
    })),
    insert: vi.fn((table: any) => {
      if (table === systemLogs) return { values: systemLogsInsertMock };
      return { values: insertValuesMock };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: updateReturningMock })),
      })),
    })),
    _systemLogsInsertMock: systemLogsInsertMock,
    _insertValuesMock: insertValuesMock,
  };
  return tx;
}

const ACTOR = { id: "admin-1", username: "admin1", role: "admin" };
const IDEMPOTENCY_KEY = "test-idem-key-aaaa1111";

describe("DrizzleInventoryEntriesRepository.upsertTechnicianFixedEntry — transactional write safety", () => {
  let repo: DrizzleInventoryEntriesRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new DrizzleInventoryEntriesRepository();
  });

  it("creates a new entry and writes a movement/audit log in the SAME transaction", async () => {
    const tx = createMockTx({ existingEntry: null });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await repo.upsertTechnicianFixedEntry(
      "tech-1",
      { itemTypeId: "type-x", boxes: 5, units: 5 },
      ACTOR,
      IDEMPOTENCY_KEY,
    );

    expect(result.boxes).toBe(5);
    expect(tx._systemLogsInsertMock).toHaveBeenCalledTimes(1);
    const logged = tx._systemLogsInsertMock.mock.calls[0][0];
    expect(logged.action).toBe("QUANTITY_CREATE");
    expect(logged.entityType).toBe("technician_fixed_inventory_entry");
    const details = JSON.parse(logged.details);
    expect(details.before).toBeNull();
    expect(details.after).toEqual({ boxes: 5, units: 5 });
    expect(details.idempotencyKey).toBe(IDEMPOTENCY_KEY);
  });

  it("updates an existing entry with a matching expectedVersion and logs before/after", async () => {
    const existingEntry = { id: "entry-1", technicianId: "tech-1", itemTypeId: "type-x", boxes: 3, units: 3, version: 4 };
    const tx = createMockTx({
      existingEntry,
      updateReturning: [{ id: "entry-1", technicianId: "tech-1", itemTypeId: "type-x", boxes: 9, units: 9, version: 5 }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await repo.upsertTechnicianFixedEntry(
      "tech-1",
      { itemTypeId: "type-x", boxes: 9, units: 9, expectedVersion: 4 },
      ACTOR,
      IDEMPOTENCY_KEY,
    );

    expect(result.boxes).toBe(9);
    const details = JSON.parse(tx._systemLogsInsertMock.mock.calls[0][0].details);
    expect(details.before).toEqual({ boxes: 3, units: 3 });
    expect(details.after).toEqual({ boxes: 9, units: 9 });
  });

  it("REJECTS a stale write (optimistic lock: 0 rows returned) instead of silently overwriting", async () => {
    const existingEntry = { id: "entry-1", technicianId: "tech-1", itemTypeId: "type-x", boxes: 3, units: 3, version: 7 };
    // Simulate: someone else already updated it (real version is now 7) —
    // the caller still thinks it's version 4, so the WHERE matches zero rows.
    const tx = createMockTx({ existingEntry, updateReturning: [] });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      repo.upsertTechnicianFixedEntry(
        "tech-1",
        { itemTypeId: "type-x", boxes: 9, units: 9, expectedVersion: 4 },
        ACTOR,
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // No movement record for a rejected write — the transaction must not
    // have reached the systemLogs insert at all.
    expect(tx._systemLogsInsertMock).not.toHaveBeenCalled();
  });

  it("allows a write with NO expectedVersion (back-compat for callers not yet sending it)", async () => {
    const existingEntry = { id: "entry-1", technicianId: "tech-1", itemTypeId: "type-x", boxes: 3, units: 3, version: 0 };
    const tx = createMockTx({
      existingEntry,
      updateReturning: [{ id: "entry-1", technicianId: "tech-1", itemTypeId: "type-x", boxes: 7, units: 7 }],
    });
    mockTransaction.mockImplementation((cb: any) => cb(tx));

    const result = await repo.upsertTechnicianFixedEntry(
      "tech-1",
      { itemTypeId: "type-x", boxes: 7, units: 7 },
      ACTOR,
      IDEMPOTENCY_KEY,
    );

    expect(result.boxes).toBe(7);
  });
});
