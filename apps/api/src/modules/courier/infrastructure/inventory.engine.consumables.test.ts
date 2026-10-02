/**
 * Consumables (paper rolls, stickers, Neoleap cards) deducted on a courier
 * close, inside InventoryEngine's request-wide transaction. Real adapters,
 * real disposable Postgres (guarded below).
 */
import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  inventoryTransactions,
  itemHistoryLogs,
  custodyMovements,
  stockMovements,
  technicianMovingInventoryEntries,
  technicianFixedInventoryEntries,
  inventoryDeductionCompletions,
} from "@shared/schema";
import { InventoryEngine } from "../application/inventory/inventory.engine";
import { SerializedItemsAdapter } from "./adapters/SerializedItemsAdapter";
import { DevicesServiceAdapter } from "./adapters/DevicesServiceAdapter";
import { DrizzleInventoryTransactionRunner } from "./database/DrizzleInventoryTransactionRunner";
import { DrizzleDeductionCompletionRecorder } from "./database/DrizzleDeductionCompletionRecorder";
import { DrizzleCourierRepository } from "./repositories/drizzle-courier.repository";
import { DeductionError } from "../application/inventory/inventory.engine.types";
import { ConsumablesGuard } from "../application/guards/ConsumablesGuard";
import { GuardValidationError, type GuardContext } from "../application/guards/guard.types";

const CONSUMABLE_TYPES = [
  { id: "rollPaper", nameAr: "ورق الطباعة", nameEn: "Roll Paper", category: "papers", unitsPerBox: 50 },
  { id: "stickers", nameAr: "الملصقات", nameEn: "Stickers", category: "papers", unitsPerBox: 100 },
  { id: "1010", nameAr: "بطاقات نيوليب ATM", nameEn: "Neoleap Cards", category: "sim", unitsPerBox: 10 },
];

describe("InventoryEngine — consumables deducted on close (moving first, then fixed, boxes opened as needed)", () => {
  const upb: Record<string, number> = {};
  const createdUserIds: string[] = [];
  const createdItemIds: string[] = [];
  const createdItemTypeIds: string[] = [];
  const usedRequestIds: number[] = [];
  let nextRequestId = 980000 + Math.floor(Math.random() * 9000) * 10;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    await db.insert(itemTypes).values(CONSUMABLE_TYPES).onConflictDoNothing();
    const rows = await db
      .select({ id: itemTypes.id, unitsPerBox: itemTypes.unitsPerBox })
      .from(itemTypes)
      .where(inArray(itemTypes.id, CONSUMABLE_TYPES.map((t) => t.id)));
    for (const r of rows) upb[r.id] = r.unitsPerBox;
  });

  afterEach(async () => {
    for (const techId of createdUserIds) {
      await db.delete(stockMovements).where(eq(stockMovements.technicianId, techId)).catch(() => {});
      await db.delete(technicianMovingInventoryEntries).where(eq(technicianMovingInventoryEntries.technicianId, techId)).catch(() => {});
      await db.delete(technicianFixedInventoryEntries).where(eq(technicianFixedInventoryEntries.technicianId, techId)).catch(() => {});
    }
    for (const id of usedRequestIds.splice(0)) {
      await db.delete(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, id)).catch(() => {});
    }
    for (const id of createdItemIds.splice(0)) {
      await db.delete(inventoryTransactions).where(eq(inventoryTransactions.itemId, id)).catch(() => {});
      await db.delete(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, id)).catch(() => {});
      await db.delete(custodyMovements).where(eq(custodyMovements.itemId, id)).catch(() => {});
      await db.delete(items).where(eq(items.id, id)).catch(() => {});
    }
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
  });

  const requestId = () => {
    nextRequestId += 1;
    usedRequestIds.push(nextRequestId);
    return nextRequestId;
  };

  const engine = () =>
    new InventoryEngine(
      new DevicesServiceAdapter(),
      new SerializedItemsAdapter(),
      new DrizzleCourierRepository(),
      new DrizzleInventoryTransactionRunner(),
      new DrizzleDeductionCompletionRecorder()
    );

  async function seedTechnicianWithDevice(label: string) {
    const id = randomUUID();
    const username = `cons-${label}-${id.slice(0, 8)}`;
    await db.insert(users).values({
      id, username, email: `${username}@test.local`, password: "x", fullName: `Cons ${label}`, role: "technician",
    });
    createdUserIds.push(id);

    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId, nameAr: `نوع-${itemTypeId.slice(0, 8)}`, nameEn: `Type-${itemTypeId.slice(0, 8)}`, category: "device",
    });
    createdItemTypeIds.push(itemTypeId);

    const serial = `CONS${randomUUID().slice(0, 10)}`.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const itemId = randomUUID();
    await db.insert(items).values({
      id: itemId, itemTypeId, serialNumber: serial, barcode: `${serial}-BAR`,
      status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: id,
    });
    createdItemIds.push(itemId);
    return { techId: id, username, serial };
  }

  async function setStock(techId: string, kind: "moving" | "fixed", itemTypeId: string, boxes: number, units: number) {
    const table = kind === "moving" ? technicianMovingInventoryEntries : technicianFixedInventoryEntries;
    await db.insert(table).values({ technicianId: techId, itemTypeId, boxes, units });
  }

  async function stock(techId: string, kind: "moving" | "fixed", itemTypeId: string) {
    const table = kind === "moving" ? technicianMovingInventoryEntries : technicianFixedInventoryEntries;
    const rows = await db
      .select({ boxes: table.boxes, units: table.units })
      .from(table)
      .where(and(eq(table.technicianId, techId), eq(table.itemTypeId, itemTypeId)));
    return rows;
  }

  async function consumableMovements(techId: string) {
    const rows = await db.select().from(stockMovements).where(eq(stockMovements.technicianId, techId));
    return rows
      .filter((r: any) => r.reason === "courier_consumables_delivery")
      .map((r: any) => ({ itemType: r.itemType, quantity: r.quantity, from: r.fromInventory, to: r.toInventory }))
      .sort((a, b) => (a.itemType + a.from < b.itemType + b.from ? -1 : 1));
  }

  async function itemStatus(serial: string) {
    const [row] = await db.select().from(items).where(eq(items.serialNumber, serial));
    return row?.status;
  }

  it("deducts paper rolls across moving then fixed (opening a box) and stickers, with the device, atomically", async () => {
    const { techId, username, serial } = await seedTechnicianWithDevice("ok");
    const rp = upb.rollPaper;
    await setStock(techId, "moving", "rollPaper", 1, 3);
    await setStock(techId, "fixed", "rollPaper", 2, 0);
    await setStock(techId, "moving", "stickers", 0, 5);
    const rid = requestId();

    await engine().deduct({
      requestId: rid, actorId: techId, technicianCode: username, devices: [], serialsForCustody: [serial],
      customerName: "Test Customer", referenceNumber: String(rid),
      paperRollQty: rp + 3 + 2, stickersQty: 5, nulipCardsQty: 0,
    });

    expect(await itemStatus(serial)).toBe("DELIVERED");
    expect(await stock(techId, "moving", "rollPaper")).toEqual([{ boxes: 0, units: 0 }]);
    expect(await stock(techId, "fixed", "rollPaper")).toEqual([{ boxes: 1, units: rp - 2 }]);
    expect(await stock(techId, "moving", "stickers")).toEqual([{ boxes: 0, units: 0 }]);
    expect(await consumableMovements(techId)).toEqual([
      { itemType: "rollPaper", quantity: 2, from: `technician:${techId}:fixed`, to: "customer" },
      { itemType: "rollPaper", quantity: rp + 3, from: `technician:${techId}:moving`, to: "customer" },
      { itemType: "stickers", quantity: 5, from: `technician:${techId}:moving`, to: "customer" },
    ]);
    expect(await new DrizzleCourierRepository().hasInventoryDeductionCompletion(rid)).toBe(true);
  }, 20000);

  it("a consumable shortfall rolls back everything — device, balances, movements, completion evidence", async () => {
    const { techId, username, serial } = await seedTechnicianWithDevice("short");
    await setStock(techId, "moving", "rollPaper", 0, 2);
    await setStock(techId, "fixed", "rollPaper", 0, 1);
    const rid = requestId();

    const err = await engine()
      .deduct({
        requestId: rid, actorId: techId, technicianCode: username, devices: [], serialsForCustody: [serial],
        customerName: "Test Customer", referenceNumber: String(rid), paperRollQty: 4,
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(DeductionError);
    expect(err.code).toBe("DEDUCT_INSUFFICIENT_STOCK");
    expect(await itemStatus(serial)).toBe("RECEIVED_BY_TECHNICIAN");
    expect(await stock(techId, "moving", "rollPaper")).toEqual([{ boxes: 0, units: 2 }]);
    expect(await stock(techId, "fixed", "rollPaper")).toEqual([{ boxes: 0, units: 1 }]);
    expect(await consumableMovements(techId)).toEqual([]);
    expect(await new DrizzleCourierRepository().hasInventoryDeductionCompletion(rid)).toBe(false);
  }, 20000);

  it("Neoleap cards (item type 1010) are deducted from moving custody", async () => {
    const { techId, username, serial } = await seedTechnicianWithDevice("cards");
    await setStock(techId, "moving", "1010", 1, 0);
    const rid = requestId();
    await engine().deduct({
      requestId: rid, actorId: techId, technicianCode: username, devices: [], serialsForCustody: [serial],
      customerName: "Test Customer", referenceNumber: String(rid), nulipCardsQty: 3,
    });
    expect(await stock(techId, "moving", "1010")).toEqual([{ boxes: 0, units: upb["1010"] - 3 }]);
  }, 20000);

  it("no consumables entered: device deducted, consumable balances and movements untouched", async () => {
    const { techId, username, serial } = await seedTechnicianWithDevice("none");
    await setStock(techId, "moving", "rollPaper", 3, 7);
    const rid = requestId();
    await engine().deduct({
      requestId: rid, actorId: techId, technicianCode: username, devices: [], serialsForCustody: [serial],
      customerName: "Test Customer", referenceNumber: String(rid), paperRollQty: 0, stickersQty: 0, nulipCardsQty: 0,
    });
    expect(await itemStatus(serial)).toBe("DELIVERED");
    expect(await stock(techId, "moving", "rollPaper")).toEqual([{ boxes: 3, units: 7 }]);
    expect(await consumableMovements(techId)).toEqual([]);
  }, 20000);

  it("getTechnicianConsumableBalances returns every moving and fixed row with unitsPerBox", async () => {
    const { techId } = await seedTechnicianWithDevice("bal");
    await setStock(techId, "moving", "rollPaper", 1, 2);
    await setStock(techId, "fixed", "rollPaper", 3, 4);
    const balances = await new DrizzleCourierRepository().getTechnicianConsumableBalances(techId, ["rollPaper", "stickers"]);
    expect(balances.rollPaper.unitsPerBox).toBe(upb.rollPaper);
    expect(balances.rollPaper.buckets).toEqual(expect.arrayContaining([{ boxes: 1, units: 2 }, { boxes: 3, units: 4 }]));
    expect(balances.stickers).toEqual({ unitsPerBox: upb.stickers, buckets: [] });
  });

  it("ConsumablesGuard against real balances: rejects a shortfall, accepts what moving + fixed can cover", async () => {
    const { techId, username } = await seedTechnicianWithDevice("guard");
    await setStock(techId, "moving", "rollPaper", 0, 2);
    await setStock(techId, "fixed", "rollPaper", 1, 0);
    const available = 2 + upb.rollPaper;
    const guardCtx = (qty: number) =>
      ({
        requestId: requestId(),
        enteredBy: techId,
        executionData: { installationStatus: "Installation Completed", paperRollQty: qty },
        request: { id: 1 },
        existingExecution: null,
        requestsRepo: {},
        dashboardRepo: {},
        inventoryPort: new DrizzleCourierRepository(),
      }) as unknown as GuardContext;
    const tech = { id: techId, username, fullName: "فني الحارس" };

    await expect(ConsumablesGuard.validate(guardCtx(available), tech)).resolves.toBeUndefined();
    const err = await ConsumablesGuard.validate(guardCtx(available + 1), tech).catch((e) => e);
    expect(err).toBeInstanceOf(GuardValidationError);
    expect(err.message).toContain(`المطلوب ${available + 1} والمتاح ${available}`);
  });
});
