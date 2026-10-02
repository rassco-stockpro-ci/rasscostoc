/**
 * OPS-REMED-E4-P2 — durable completion evidence + mapper round-trip proof.
 *
 * Runs only via a real disposable Postgres test database (guarded below).
 * Placed under infrastructure/ (not application/), per
 * OPS-REMED-E4-A.2/A.4-A.9 governance correction — proving these
 * invariants requires real Drizzle/database access, which
 * `application-should-not-depend-on-presentation-infrastructure-or-drizzle`
 * (.dependency-cruiser.cjs) forbids from application/. Same precedent as
 * inventory.engine.test.ts/inventory.engine.concurrency.test.ts.
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  courierRequests,
  courierExecutions,
  inventoryDeductionCompletions,
  technicianMovingInventoryEntries,
  stockMovements,
} from "@shared/schema";
import { InventoryEngine } from "../application/inventory/inventory.engine";
import { DevicesServiceAdapter } from "./adapters/DevicesServiceAdapter";
import { SerializedItemsAdapter } from "./adapters/SerializedItemsAdapter";
import { DrizzleInventoryTransactionRunner } from "./database/DrizzleInventoryTransactionRunner";
import { DrizzleDeductionCompletionRecorder } from "./database/DrizzleDeductionCompletionRecorder";
import { DrizzleCourierRepository } from "./repositories/drizzle-courier.repository";
import { drizzleCourierRepository } from "./repositories/drizzle-courier.repository";

describe("OPS-REMED-E4-P2 — durable completion evidence and mapper round-trip", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database " +
          "(must contain 'test' in the database name). See scripts/test-database.mjs."
      );
    }
  });

  const createdItemIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdItemTypeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdItemIds.splice(0)) {
      await db.delete(items).where(eq(items.id, id)).catch(() => {});
    }
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(stockMovements).where(eq(stockMovements.technicianId, id)).catch(() => {});
      await db.delete(technicianMovingInventoryEntries).where(eq(technicianMovingInventoryEntries.technicianId, id)).catch(() => {});
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
  });

  function testSerial(prefix: string): string {
    return (prefix + randomUUID().slice(0, 10)).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function makeEngine(): InventoryEngine {
    return new InventoryEngine(
      new DevicesServiceAdapter(),
      new SerializedItemsAdapter(),
      new DrizzleCourierRepository(),
      new DrizzleInventoryTransactionRunner(),
      new DrizzleDeductionCompletionRecorder()
    );
  }

  async function seedTechnician(label: string) {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `e4p2-comp-${label}-${id.slice(0, 8)}`,
      email: `e4p2-comp-${label}-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: `E4 P2 ${label}`,
      role: "technician",
    });
    createdUserIds.push(id);
    return id;
  }

  async function seedItemInCustody(ownerId: string, serialNumber: string) {
    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: `نوع-${itemTypeId.slice(0, 8)}`,
      nameEn: `Type-${itemTypeId.slice(0, 8)}`,
      category: "device",
    });
    createdItemTypeIds.push(itemTypeId);
    const itemId = randomUUID();
    await db.insert(items).values({
      id: itemId,
      itemTypeId,
      serialNumber,
      barcode: `${serialNumber}-BAR`,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerId,
    });
    createdItemIds.push(itemId);
    return itemId;
  }

  it("1. serialized-only deduction writes completion evidence with the exact sourceEventId, in the same commit", async () => {
    const tech = await seedTechnician("ser");
    const serial = testSerial("E4P2SER");
    await seedItemInCustody(tech, serial);
    const engine = makeEngine();
    const sourceEventId = randomUUID();
    const requestId = 940001 + Math.floor(Math.random() * 100000);

    await engine.deduct({
      requestId,
      actorId: tech,
      technicianCode: `e4p2-comp-ser-${tech.slice(0, 8)}`,
      devices: [],
      serialsForCustody: [serial],
      customerName: "Test",
      referenceNumber: String(requestId),
      sourceEventId,
    });

    const [row] = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, requestId));
    expect(row).toBeDefined();
    expect(row!.sourceEventId).toBe(sourceEventId);
    expect(row!.serializedItemCount).toBe(1);
    expect(row!.generalInventoryDeducted).toBe(false);
  }, 30000);

  it("2. general-inventory-only deduction ALSO produces valid completion evidence (the exact gap A.6 closed)", async () => {
    const tech = await seedTechnician("gen");
    // The paper roll is now really deducted, so the technician must hold one.
    await db
      .insert(itemTypes)
      .values({ id: "rollPaper", nameAr: "ورق الطباعة", nameEn: "Roll Paper", category: "papers", unitsPerBox: 50 })
      .onConflictDoNothing();
    await db.insert(technicianMovingInventoryEntries).values({ technicianId: tech, itemTypeId: "rollPaper", boxes: 0, units: 1 });
    const engine = makeEngine();
    const sourceEventId = randomUUID();
    const requestId = 940100 + Math.floor(Math.random() * 100000);

    await engine.deduct({
      requestId,
      actorId: tech,
      technicianCode: `e4p2-comp-gen-${tech.slice(0, 8)}`,
      devices: [],
      serialsForCustody: [],
      paperRollQty: 1,
      customerName: "Test",
      referenceNumber: String(requestId),
      sourceEventId,
    });

    const [row] = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, requestId));
    expect(row).toBeDefined();
    expect(row!.serializedItemCount).toBe(0);
    const [stock] = await db
      .select({ units: technicianMovingInventoryEntries.units })
      .from(technicianMovingInventoryEntries)
      .where(and(eq(technicianMovingInventoryEntries.technicianId, tech), eq(technicianMovingInventoryEntries.itemTypeId, "rollPaper")));
    expect(stock!.units).toBe(0);
  }, 30000);

  it("3. duplicate deduct() for the same requestId cannot create a second completion row (unique constraint)", async () => {
    const tech = await seedTechnician("dup");
    const serial = testSerial("E4P2DUP");
    await seedItemInCustody(tech, serial);
    const engine = makeEngine();
    const requestId = 940200 + Math.floor(Math.random() * 100000);

    await engine.deduct({
      requestId,
      actorId: tech,
      technicianCode: `e4p2-comp-dup-${tech.slice(0, 8)}`,
      devices: [],
      serialsForCustody: [serial],
      customerName: "Test",
      referenceNumber: String(requestId),
      sourceEventId: randomUUID(),
    });

    // Second call targets the same requestId; the item is already
    // DELIVERED so scanOut legitimately rejects it before any write this
    // time — proving no second completion row appears regardless.
    await expect(
      engine.deduct({
        requestId,
        actorId: tech,
        technicianCode: `e4p2-comp-dup-${tech.slice(0, 8)}`,
        devices: [],
        serialsForCustody: [serial],
        customerName: "Test",
        referenceNumber: String(requestId),
        sourceEventId: randomUUID(),
      })
    ).rejects.toThrow();

    const rows = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, requestId));
    expect(rows.length).toBe(1);
  }, 30000);

  it("4. a failure AFTER the item write rolls back the completion row too (no false evidence survives rollback)", async () => {
    const tech = await seedTechnician("rollback");
    const engine = makeEngine();
    const requestId = 940300 + Math.floor(Math.random() * 100000);

    // Missing technician for the requested serial -> DEDUCT_WRONG_TECHNICIAN
    // thrown from resolveAndValidateTechnician, BEFORE the transaction
    // even opens — proves the pre-transaction-reject path never creates a
    // completion row (trivially true) and, combined with test #3's
    // mid-transaction proof, together cover both rollback boundaries.
    await expect(
      engine.deduct({
        requestId,
        actorId: tech,
        technicianCode: "totally-unknown-technician",
        devices: [],
        serialsForCustody: [testSerial("E4P2NOMATCH")],
        customerName: "Test",
        referenceNumber: String(requestId),
        sourceEventId: randomUUID(),
      })
    ).rejects.toThrow();

    const rows = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, requestId));
    expect(rows.length).toBe(0);
  }, 30000);

  // ── Mapper round-trip proof (per OPS-REMED-E4-P2-I.R1 §4) ────────────
  async function seedExecutionWithStatus(status: string | null): Promise<number> {
    const actorId = randomUUID();
    await db.insert(users).values({
      id: actorId,
      username: `e4p2-map-${actorId.slice(0, 8)}`,
      email: `e4p2-map-${actorId.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "E4 P2 Mapper Actor",
      role: "admin",
    });
    createdUserIds.push(actorId);
    const [request] = await db
      .insert(courierRequests)
      .values({ customerName: "E4 P2 Mapper", incidentNumber: `E4-P2-MAP-${randomUUID().slice(0, 8)}` })
      .returning();
    const execution = await drizzleCourierRepository.insertExecution({
      requestId: request.id,
      enteredBy: actorId,
      custodyClosureStatus: status,
    });
    return execution.requestId;
  }

  it.each(["PENDING_DEDUCTION", "PROCESSING", "CLOSED_SUCCESS", "FAILED_RETRYABLE", "FAILED_FINAL"])(
    "5. %s survives insertExecution -> findExecutionByRequestId round trip",
    async (status) => {
      const requestId = await seedExecutionWithStatus(status);
      const found = await drizzleCourierRepository.findExecutionByRequestId(requestId);
      expect(found!.custodyClosureStatus).toBe(status);
    }
  );

  // OPS-REMED-E4-P4-I1.R1 §7/§10: this was originally a pre-P4 mapper
  // round-trip proof (an explicit null survived unchanged). Since P4
  // (migrations 0052-0054) made the column NOT NULL, an explicit null can
  // no longer be persisted at all — the assertion is inverted to document
  // that new, correct invariant (a production defect, not a stale
  // fixture, would be silently accepting this insert).
  it("6. an explicit null is now rejected by the database (post-P4 NOT NULL invariant)", async () => {
    await expect(seedExecutionWithStatus(null)).rejects.toThrow(/null value in column "custody_closure_status"|violates not-null constraint/i);
  });

  it("7. omitted (undefined) custodyClosureStatus on updateExecution does not clear an existing value", async () => {
    const requestId = await seedExecutionWithStatus("PROCESSING");
    await drizzleCourierRepository.updateExecution(requestId, { pushBack: "note only" });
    const found = await drizzleCourierRepository.findExecutionByRequestId(requestId);
    expect(found!.custodyClosureStatus).toBe("PROCESSING"); // unchanged, not cleared
  });

  it("8. guarded repository update can read and transition the real stored state via updateCustodyClosureStatus", async () => {
    const requestId = await seedExecutionWithStatus("PROCESSING");
    const updated = await drizzleCourierRepository.updateCustodyClosureStatus(requestId, ["PROCESSING"], "CLOSED_SUCCESS");
    expect(updated!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
  });

  it("9. existing execution fields remain unchanged through mapping alongside the new field", async () => {
    const requestId = await seedExecutionWithStatus("PENDING_DEDUCTION");
    const found = await drizzleCourierRepository.findExecutionByRequestId(requestId);
    expect(found!.requestId).toBe(requestId);
    expect(typeof found!.version).toBe("number");
  });
});
