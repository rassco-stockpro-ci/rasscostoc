/**
 * PRE-MULTI-DEVICE HARDENING — a completed close commits together with its
 * inventory deduction and its ExecutionCompletedEvent, or not at all.
 *
 * Real CourierService, real unit of work, real InventoryEngine and adapters,
 * real disposable Postgres (guarded below). Failures are injected with spies
 * at each write of the close transaction; every case then asserts that
 * nothing of the close survived.
 */
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  courierRequests,
  courierRequestItems,
  courierExecutions,
  courierAuditLogs,
  courierPdfReports,
  custodyMovements,
  outboxEvents,
  inventoryDeductionCompletions,
  technicianMovingInventoryEntries,
} from "@shared/schema";
import { CourierService } from "../application/courier.service";
import { CompletionGuard } from "../application/guards/CompletionGuard";
import { InventoryEngine } from "../application/inventory/inventory.engine";
import { DrizzleCourierRepository } from "./repositories/drizzle-courier.repository";
import { DrizzleCourierUnitOfWork } from "./repositories/DrizzleCourierUnitOfWork";
import { SerializedItemsAdapter } from "./adapters/SerializedItemsAdapter";
import { DevicesServiceAdapter } from "./adapters/DevicesServiceAdapter";
import { DrizzleInventoryTransactionRunner } from "./database/DrizzleInventoryTransactionRunner";
import { DrizzleDeductionCompletionRecorder } from "./database/DrizzleDeductionCompletionRecorder";
import { outboxRepository } from "@core/outbox/outbox.repository";
import { EventBus } from "@core/events/event-bus";
import { ExecutionCompletedEvent } from "@core/events/events";
import { AppError } from "@core/errors/AppError";
import { InventorySubscriber } from "../../inventory/contracts";

const COMPLETED = "Installation Completed - NL";
const ROLL_PAPER = { id: "rollPaper", nameAr: "ورق الطباعة", nameEn: "Roll Paper", category: "papers", unitsPerBox: 50 };

describe("Close + deduction atomicity, event durability, guards, orphan items, idempotency, concurrency", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    await db.insert(itemTypes).values(ROLL_PAPER).onConflictDoNothing();
    InventorySubscriber.register();
  });

  const requestIds: number[] = [];

  // Completion rows are claimed in batches by CourierProjectionWorker (and
  // its tests, which share this database), and request ids are reused after
  // another file's TRUNCATE ... RESTART IDENTITY — never leave completion or
  // outbox rows keyed by these request ids behind.
  afterEach(async () => {
    vi.restoreAllMocks();
    const ids = requestIds.splice(0);
    if (ids.length > 0) {
      await db.delete(inventoryDeductionCompletions).where(inArray(inventoryDeductionCompletions.requestId, ids));
      await db
        .delete(outboxEvents)
        .where(inArray(sql<number>`((${outboxEvents.payload})->>'requestId')::int`, ids));
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────

  function makeService() {
    const serialized = new SerializedItemsAdapter();
    const general = new DevicesServiceAdapter();
    const engine = new InventoryEngine(
      general,
      serialized,
      new DrizzleCourierRepository(),
      new DrizzleInventoryTransactionRunner(),
      new DrizzleDeductionCompletionRecorder()
    );
    const repo = new DrizzleCourierRepository();
    const service = new CourierService(new DrizzleCourierUnitOfWork(), repo, repo, repo, repo, repo, engine);
    return { service, serialized, general };
  }

  function serial(prefix: string) {
    return (prefix + randomUUID().slice(0, 10)).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  async function seedTechnician(label: string, rolls = 10) {
    const id = randomUUID();
    const username = `hd-${label}-${id.slice(0, 8)}`;
    await db.insert(users).values({
      id, username, email: `${username}@test.local`, password: "x", fullName: `HD ${label}`, role: "technician",
    });
    if (rolls > 0) {
      await db.insert(technicianMovingInventoryEntries).values({ technicianId: id, itemTypeId: "rollPaper", boxes: 0, units: rolls });
    }
    return { id, username };
  }

  /** Item in active custody. `order` (one hex digit) fixes the lock order (items are locked by id). */
  async function seedItem(ownerId: string, serialNumber: string, order: string = "0") {
    const itemTypeId = randomUUID();
    // SIM fixtures use HDS / HDMS serial prefixes; everything else is a device.
    const category = /^HDM?S/.test(serialNumber) ? "sim" : "devices";
    await db.insert(itemTypes).values({
      id: itemTypeId, nameAr: `نوع-${itemTypeId.slice(0, 8)}`, nameEn: `Type-${itemTypeId.slice(0, 8)}`, category,
    });
    const id = order + randomUUID().slice(1);
    await db.insert(items).values({
      id, itemTypeId, serialNumber, barcode: `${serialNumber}-BAR`, status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: ownerId,
    });
    return id;
  }

  async function seedRequest(label: string) {
    const [row] = await db
      .insert(courierRequests)
      .values({ customerName: `HD ${label}`, incidentNumber: `HD-${label}-${randomUUID().slice(0, 8)}` })
      .returning();
    requestIds.push(row.id);
    return row.id as number;
  }

  /** A technician holding one device and one SIM, and a request to close. */
  async function seedClose(label: string, rolls = 10) {
    const tech = await seedTechnician(label, rolls);
    const device = serial("HDD");
    const sim = serial("HDS");
    const deviceId = await seedItem(tech.id, device, "0");
    const simId = await seedItem(tech.id, sim, "f");
    const requestId = await seedRequest(label);
    return { tech, device, sim, deviceId, simId, requestId };
  }

  function closeBody(s: { device: string; sim: string }, extra: Record<string, unknown> = {}) {
    return { installationStatus: COMPLETED, sn: s.device, simSerial: s.sim, paperRollQty: 2, ...extra };
  }

  async function item(id: string) {
    const [row] = await db.select().from(items).where(eq(items.id, id));
    return row!;
  }

  async function rolls(techId: string) {
    const rows = await db
      .select({ boxes: technicianMovingInventoryEntries.boxes, units: technicianMovingInventoryEntries.units })
      .from(technicianMovingInventoryEntries)
      .where(and(eq(technicianMovingInventoryEntries.technicianId, techId), eq(technicianMovingInventoryEntries.itemTypeId, "rollPaper")));
    return rows.reduce((sum, r) => sum + r.boxes * 50 + r.units, 0);
  }

  async function completedEvents(requestId: number) {
    const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.eventName, "ExecutionCompletedEvent"));
    return rows.filter((r) => (r.payload as any)?.requestId === requestId);
  }

  async function completions(requestId: number) {
    return db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, requestId));
  }

  /** Delivers an outbox row exactly as OutboxWorker.processSequentially does. */
  async function deliver(row: any) {
    await EventBus.getInstance().publishLocal({
      id: row.id,
      name: row.eventName,
      version: row.eventVersion,
      occurredAt: row.createdAt,
      timestamp: row.createdAt,
      correlationId: row.correlationId,
      causationId: row.causationId,
      payload: row.payload,
    } as any);
  }

  /** Nothing of the close committed: no execution, no deduction, no event, no binding, no audit. */
  async function expectNothingCommitted(s: Awaited<ReturnType<typeof seedClose>>, rollsBefore: number) {
    expect(await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, s.requestId))).toHaveLength(0);
    for (const id of [s.deviceId, s.simId]) {
      const row = await item(id);
      expect(row.status).toBe("RECEIVED_BY_TECHNICIAN");
      expect(row.currentOwnerId).toBe(s.tech.id);
    }
    expect(await db.select().from(custodyMovements).where(inArray(custodyMovements.itemId, [s.deviceId, s.simId]))).toHaveLength(0);
    expect(await completions(s.requestId)).toHaveLength(0);
    expect(await completedEvents(s.requestId)).toHaveLength(0);
    expect(await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, s.requestId))).toHaveLength(0);
    expect(
      await db.select().from(courierAuditLogs).where(and(eq(courierAuditLogs.recordId, s.requestId), eq(courierAuditLogs.action, "INVENTORY_DEDUCTED")))
    ).toHaveLength(0);
    expect(await rolls(s.tech.id)).toBe(rollsBefore);
  }

  // ── atomicity ─────────────────────────────────────────────────────────────

  it("commits the close, the deduction, CLOSED_SUCCESS, the audit and a durable event together", async () => {
    const s = await seedClose("ok");
    const { service } = makeService();

    await service.saveExecution(s.requestId, closeBody(s), s.tech.id);

    const [exec] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, s.requestId));
    expect(exec!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
    for (const id of [s.deviceId, s.simId]) {
      const row = await item(id);
      expect(row.status).toBe("DELIVERED");
      expect(row.currentOwnerId).toBeNull();
    }
    expect(await rolls(s.tech.id)).toBe(8);

    const events = await completedEvents(s.requestId);
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("PENDING");
    const [completion] = await completions(s.requestId);
    expect(completion!.sourceEventId).toBe(events[0]!.id);
    expect(completion!.serializedItemCount).toBe(2);

    const bound = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, s.requestId));
    expect(bound.map((r) => r.serialNumber ?? r.simSerial).sort()).toEqual([s.device, s.sim].sort());
    expect(
      await db.select().from(courierAuditLogs).where(and(eq(courierAuditLogs.recordId, s.requestId), eq(courierAuditLogs.action, "INVENTORY_DEDUCTED")))
    ).toHaveLength(1);
  }, 30000);

  it("device deduction failure: refused with 422 and nothing of the close commits", async () => {
    const s = await seedClose("devfail");
    const { service, serialized } = makeService();
    vi.spyOn(serialized, "scanOut").mockResolvedValue(false);

    const err = await service.saveExecution(s.requestId, closeBody(s), s.tech.id).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("INVENTORY_DEDUCTION_REJECTED");
    await expectNothingCommitted(s, 10);
  }, 30000);

  it("SIM deduction failure after the device was scanned out: the device scan-out rolls back too", async () => {
    const s = await seedClose("simfail");
    const { service, serialized } = makeService();
    const original = serialized.scanOut.bind(serialized);
    const scanned: string[] = [];
    vi.spyOn(serialized, "scanOut").mockImplementation(async (techId, serialNumber, ...rest) => {
      if (serialNumber === s.sim) throw new Error("injected SIM scan-out failure");
      scanned.push(serialNumber);
      return original(techId, serialNumber, ...rest);
    });

    const err = await service.saveExecution(s.requestId, closeBody(s), s.tech.id).catch((e) => e);
    expect(scanned).toEqual([s.device]); // the device really was scanned out first
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(503);
    await expectNothingCommitted(s, 10);
  }, 30000);

  it("consumables deduction failure (balance gone by commit time): refused and nothing commits", async () => {
    const s = await seedClose("consfail");
    const { service, general } = makeService();
    vi.spyOn(general, "deductTechnicianConsumables").mockRejectedValue(
      Object.assign(new Error("رصيد ورق الطباعة لا يكفي"), { code: "DEDUCT_INSUFFICIENT_STOCK" })
    );

    const err = await service.saveExecution(s.requestId, closeBody(s), s.tech.id).catch((e) => e);
    expect(err.statusCode).toBe(422);
    expect(err.message).toContain("رصيد الفني لا يكفي");
    await expectNothingCommitted(s, 10);
  }, 30000);

  it("audit write failure: nothing commits", async () => {
    const s = await seedClose("auditfail");
    const { service } = makeService();
    const original = DrizzleCourierRepository.prototype.insertAuditLog;
    vi.spyOn(DrizzleCourierRepository.prototype, "insertAuditLog").mockImplementation(async function (this: any, entry: any, ...rest: any[]) {
      if (entry?.action === "INVENTORY_DEDUCTED") throw new Error("injected audit failure");
      return (original as any).call(this, entry, ...rest);
    });

    await expect(service.saveExecution(s.requestId, closeBody(s), s.tech.id)).rejects.toThrow("injected audit failure");
    await expectNothingCommitted(s, 10);
  }, 30000);

  it("event persistence failure: the close is not committed without its outbox row (no in-memory fallback)", async () => {
    const s = await seedClose("eventfail");
    const { service } = makeService();
    const original = outboxRepository.enqueue.bind(outboxRepository);
    const localDispatch = vi.spyOn(EventBus.getInstance(), "publishLocal");
    vi.spyOn(outboxRepository, "enqueue").mockImplementation(async (event: any, tx?: any) => {
      if (event.name === "ExecutionCompletedEvent") throw new Error("injected outbox failure");
      return original(event, tx);
    });

    await expect(service.saveExecution(s.requestId, closeBody(s), s.tech.id)).rejects.toThrow("injected outbox failure");
    expect(localDispatch.mock.calls.some(([e]: any) => e?.name === "ExecutionCompletedEvent")).toBe(false);
    await expectNothingCommitted(s, 10);
  }, 30000);

  it("CLOSED_SUCCESS write failure: nothing commits", async () => {
    const s = await seedClose("closefail");
    const { service } = makeService();
    const original = DrizzleCourierRepository.prototype.updateCustodyClosureStatus;
    vi.spyOn(DrizzleCourierRepository.prototype, "updateCustodyClosureStatus").mockImplementation(async function (this: any, ...args: any[]) {
      if (args[2] === "CLOSED_SUCCESS") throw new Error("injected close failure");
      return (original as any).apply(this, args);
    });

    await expect(service.saveExecution(s.requestId, closeBody(s), s.tech.id)).rejects.toThrow("injected close failure");
    await expectNothingCommitted(s, 10);
  }, 30000);

  // ── event durability / worker restarts / duplicates ───────────────────────

  it("worker restart before the event is processed: the persisted event is acknowledged without a second deduction", async () => {
    const s = await seedClose("restart-before");
    const { service } = makeService();
    await service.saveExecution(s.requestId, closeBody(s), s.tech.id);

    // A new process reads the PENDING row from the database (nothing in memory survives).
    const [row] = await completedEvents(s.requestId);
    expect(row!.status).toBe("PENDING");
    await deliver(row);

    expect(await completions(s.requestId)).toHaveLength(1);
    expect(await rolls(s.tech.id)).toBe(8);
    expect(await db.select().from(custodyMovements).where(inArray(custodyMovements.itemId, [s.deviceId, s.simId]))).toHaveLength(2);
    const [exec] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, s.requestId));
    expect(exec!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
  }, 30000);

  it("worker restart after the event was processed (redelivery) and a duplicate event: still exactly one deduction", async () => {
    const s = await seedClose("restart-after");
    const { service } = makeService();
    await service.saveExecution(s.requestId, closeBody(s), s.tech.id);
    const [row] = await completedEvents(s.requestId);

    await deliver(row); // processed
    await deliver(row); // redelivered after a restart before markAsPublished
    const duplicate = new ExecutionCompletedEvent({ requestId: s.requestId, actorId: s.tech.id, execution: row!.payload.execution, request: row!.payload.request });
    await outboxRepository.enqueue(duplicate);
    const [dupRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, duplicate.id));
    await deliver(dupRow);

    expect(await completions(s.requestId)).toHaveLength(1);
    expect(await rolls(s.tech.id)).toBe(8);
    expect(await db.select().from(custodyMovements).where(inArray(custodyMovements.itemId, [s.deviceId, s.simId]))).toHaveLength(2);
  }, 30000);

  it("duplicate close: the second close is refused and deducts nothing", async () => {
    const s = await seedClose("dupclose");
    const { service } = makeService();
    await service.saveExecution(s.requestId, closeBody(s), s.tech.id);
    const [exec] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, s.requestId));

    const err = await service.saveExecution(s.requestId, closeBody(s, { version: exec!.version }), s.tech.id).catch((e) => e);
    expect(err.statusCode).toBe(422);

    expect(await completions(s.requestId)).toHaveLength(1);
    expect(await completedEvents(s.requestId)).toHaveLength(1);
    expect(await rolls(s.tech.id)).toBe(8);
  }, 30000);

  it("an event enqueued before this change (no completion yet) is still deducted by InventorySubscriber", async () => {
    const s = await seedClose("legacy");
    const repo = new DrizzleCourierRepository();
    const execution = await repo.insertExecution({
      requestId: s.requestId, installationStatus: COMPLETED, sn: s.device, simSerial: s.sim,
      enteredBy: s.tech.id, technicianCode: s.tech.username, custodyClosureStatus: "PENDING_DEDUCTION",
    });
    const [request] = await db.select().from(courierRequests).where(eq(courierRequests.id, s.requestId));
    const legacy = new ExecutionCompletedEvent({ requestId: s.requestId, actorId: s.tech.id, execution, request });
    await outboxRepository.enqueue(legacy);
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, legacy.id));

    await deliver(row);

    const [completion] = await completions(s.requestId);
    expect(completion!.sourceEventId).toBe(legacy.id);
    expect((await item(s.deviceId)).status).toBe("DELIVERED");
    expect((await item(s.simId)).status).toBe("DELIVERED");
  }, 30000);

  // ── guards are read-only ──────────────────────────────────────────────────

  it("guards write nothing: CompletionGuard returns the bindings instead of inserting them", async () => {
    const s = await seedClose("guardro");
    const repo = new DrizzleCourierRepository();
    const [request] = await db.select().from(courierRequests).where(eq(courierRequests.id, s.requestId));

    const decision = await CompletionGuard.run({
      requestId: s.requestId,
      enteredBy: s.tech.id,
      executionData: { installationStatus: COMPLETED, sn: s.device, simSerial: s.sim, deviceSerials: [s.device], simSerials: [s.sim] },
      request: request as any,
      existingExecution: null,
      requestsRepo: repo,
      dashboardRepo: repo,
      inventoryPort: repo,
    });

    expect(decision.techUser?.id).toBe(s.tech.id);
    expect(decision.closeItems).toEqual([
      { serialNumber: s.device, role: "device", itemId: s.deviceId },
      { serialNumber: s.sim, role: "sim", itemId: s.simId },
    ]);
    expect(decision.units).toEqual([
      { unitNo: 1, device: { itemId: s.deviceId, serialNumber: s.device }, sim: { itemId: s.simId, serialNumber: s.sim, carrierName: null }, simWaived: false, tid: null },
    ]);
    expect(decision.requestItemsToBind).toHaveLength(2);
    expect(await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, s.requestId))).toHaveLength(0);
  }, 30000);

  it("a later guard rejecting (consumables) leaves no request items bound by the custody guard", async () => {
    const s = await seedClose("guardreject", 1);
    const { service } = makeService();

    const err = await service.saveExecution(s.requestId, closeBody(s, { paperRollQty: 5 }), s.tech.id).catch((e) => e);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("GUARD_VALIDATION_FAILED");
    await expectNothingCommitted(s, 1);
  }, 30000);

  // ── orphan request items ──────────────────────────────────────────────────

  it("orphan protection: Device A + SIM A are deducted, an earlier RECEIVED Device B is not", async () => {
    const s = await seedClose("orphan");
    const deviceB = serial("HDB");
    const deviceBId = await seedItem(s.tech.id, deviceB);
    await db.insert(courierRequestItems).values({
      requestId: s.requestId, itemType: "POS", serialNumber: deviceB, quantity: 1, status: "RECEIVED", technicianId: s.tech.id,
    });
    const { service } = makeService();

    await service.saveExecution(s.requestId, closeBody(s), s.tech.id);

    expect((await item(s.deviceId)).status).toBe("DELIVERED");
    expect((await item(s.simId)).status).toBe("DELIVERED");
    const b = await item(deviceBId);
    expect(b.status).toBe("RECEIVED_BY_TECHNICIAN");
    expect(b.currentOwnerId).toBe(s.tech.id);
    const [bLink] = await db
      .select()
      .from(courierRequestItems)
      .where(and(eq(courierRequestItems.requestId, s.requestId), eq(courierRequestItems.serialNumber, deviceB)));
    expect(bLink!.status).toBe("RECEIVED");
    const [completion] = await completions(s.requestId);
    expect(completion!.serializedItemCount).toBe(2);

    // State machine (2026-10-02): the close's own items are INSTALLED, B is untouched.
    const links = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, s.requestId));
    const statusOf = (sn: string) => links.find((l) => l.serialNumber === sn || l.simSerial === sn)!.status;
    expect(statusOf(s.device)).toBe("INSTALLED");
    expect(statusOf(s.sim)).toBe("INSTALLED");
    expect(statusOf(deviceB)).toBe("RECEIVED");
  }, 30000);

  // ── multiple devices / multiple SIMs (current supported set: deviceSerials[] + simSerials[]) ──

  /** Two devices + two SIMs held by one technician, locked in the order D1, D2, S1, S2. */
  async function seedMulti(label: string, rollsAvailable = 10) {
    const tech = await seedTechnician(label, rollsAvailable);
    const devices = [serial("HDMD"), serial("HDMD")];
    const sims = [serial("HDMS"), serial("HDMS")];
    const ids = {
      d1: await seedItem(tech.id, devices[0]!, "0"),
      d2: await seedItem(tech.id, devices[1]!, "1"),
      s1: await seedItem(tech.id, sims[0]!, "2"),
      s2: await seedItem(tech.id, sims[1]!, "3"),
    };
    const requestId = await seedRequest(label);
    const body = {
      installationStatus: COMPLETED,
      sn: devices[0],
      simSerial: sims[0],
      deviceSerials: devices,
      simSerials: sims,
      paperRollQty: 2,
      stickersQty: 0,
    };
    return { tech, devices, sims, ids, requestId, body };
  }

  it("2 devices + 2 SIMs + consumables close in one transaction: all deducted, all INSTALLED, one completion", async () => {
    const m = await seedMulti("multi-ok");
    const { service } = makeService();

    await service.saveExecution(m.requestId, m.body, m.tech.id);

    for (const id of Object.values(m.ids)) {
      const row = await item(id);
      expect(row.status).toBe("DELIVERED");
      expect(row.currentOwnerId).toBeNull();
    }
    expect(await db.select().from(custodyMovements).where(inArray(custodyMovements.itemId, Object.values(m.ids)))).toHaveLength(4);
    expect(await rolls(m.tech.id)).toBe(8);
    const [completion] = await completions(m.requestId);
    expect(completion!.serializedItemCount).toBe(4);
    const [exec] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, m.requestId));
    expect(exec!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
    const links = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, m.requestId));
    expect(links).toHaveLength(4);
    expect(links.every((l) => l.status === "INSTALLED")).toBe(true);
    expect(await completedEvents(m.requestId)).toHaveLength(1);
  }, 30000);

  it("multi-item close failing on its LAST SIM: no partial deduction, linked RECEIVED items untouched, nothing committed", async () => {
    const m = await seedMulti("multi-fail");
    // The request already lists the two devices as RECEIVED (mobile receiving).
    await db.insert(courierRequestItems).values(
      m.devices.map((sn) => ({ requestId: m.requestId, itemType: "POS", serialNumber: sn, quantity: 1, status: "RECEIVED", technicianId: m.tech.id }))
    );
    const { service, serialized } = makeService();
    const original = serialized.scanOut.bind(serialized);
    const scanned: string[] = [];
    vi.spyOn(serialized, "scanOut").mockImplementation(async (techId, serialNumber, ...rest) => {
      if (serialNumber === m.sims[1]) throw new Error("injected failure on the last SIM");
      scanned.push(serialNumber);
      return original(techId, serialNumber, ...rest);
    });

    const err = await service.saveExecution(m.requestId, m.body, m.tech.id).catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(scanned).toEqual([m.devices[0], m.devices[1], m.sims[0]]); // three really were scanned out first

    for (const id of Object.values(m.ids)) {
      const row = await item(id);
      expect(row.status).toBe("RECEIVED_BY_TECHNICIAN");
      expect(row.currentOwnerId).toBe(m.tech.id);
    }
    expect(await db.select().from(custodyMovements).where(inArray(custodyMovements.itemId, Object.values(m.ids)))).toHaveLength(0);
    expect(await rolls(m.tech.id)).toBe(10);
    expect(await completions(m.requestId)).toHaveLength(0);
    expect(await completedEvents(m.requestId)).toHaveLength(0);
    expect(await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, m.requestId))).toHaveLength(0);
    // No orphan request-item mutation: the pre-existing rows are exactly as before, nothing bound.
    const links = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, m.requestId));
    expect(links.map((l) => `${l.serialNumber}:${l.status}`).sort()).toEqual(m.devices.map((d) => `${d}:RECEIVED`).sort());
  }, 30000);

  // ── active custody policy / request item state machine (governance remediation) ──

  it("a device IN_TRANSIT (task started, on the way to the customer) is active custody: closed and deducted", async () => {
    const s = await seedClose("intransit");
    await db.update(items).set({ status: "IN_TRANSIT" }).where(inArray(items.id, [s.deviceId, s.simId]));
    const { service } = makeService();

    await service.saveExecution(s.requestId, closeBody(s), s.tech.id);

    for (const id of [s.deviceId, s.simId]) {
      const row = await item(id);
      expect(row.status).toBe("DELIVERED");
      expect(row.currentOwnerId).toBeNull();
    }
    expect(await completions(s.requestId)).toHaveLength(1);
  }, 30000);

  it("receiving accepts RECEIVED only, and only for items of the same request", async () => {
    const s = await seedClose("receive");
    const other = await seedRequest("receive-other");
    const { service } = makeService();
    await service.acceptRequest(s.requestId, s.tech.id);
    await service.acceptRequest(other, s.tech.id);
    const [mine] = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, s.requestId));
    const [theirs] = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, other));

    const missing = await service.confirmReceiving(s.requestId, s.tech.id, [{ itemId: mine!.id, status: "MISSING" }]).catch((e) => e);
    expect(missing.statusCode).toBe(422);
    expect(missing.code).toBe("REQUEST_ITEM_TRANSITION_INVALID");

    const foreign = await service.confirmReceiving(s.requestId, s.tech.id, [{ itemId: theirs!.id, status: "RECEIVED" }]).catch((e) => e);
    expect(foreign.statusCode).toBe(422);
    expect(foreign.code).toBe("REQUEST_ITEM_NOT_IN_REQUEST");
    const [theirsAfter] = await db.select().from(courierRequestItems).where(eq(courierRequestItems.id, theirs!.id));
    expect(theirsAfter!.status).toBe("PENDING_RECEIPT");

    await service.confirmReceiving(s.requestId, s.tech.id, [{ itemId: mine!.id, status: "RECEIVED", serialNumber: s.device }]);
    const [mineAfter] = await db.select().from(courierRequestItems).where(eq(courierRequestItems.id, mine!.id));
    expect(mineAfter!.status).toBe("RECEIVED");
  }, 30000);

  it("re-assigning a request cannot wipe items that were already received or installed", async () => {
    const s = await seedClose("reassign");
    const { service } = makeService();
    await service.saveExecution(s.requestId, closeBody(s), s.tech.id);

    const err = await service.assignRequestItems(s.requestId, [{ itemType: "POS", quantity: 1 }], s.tech.id).catch((e) => e);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("REQUEST_ITEM_TRANSITION_INVALID");
    const links = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, s.requestId));
    expect(links.map((l) => l.status).sort()).toEqual(["INSTALLED", "INSTALLED"]);
  }, 30000);

  it("an invalid consumable quantity is refused with 422 before anything is written", async () => {
    const s = await seedClose("badqty");
    const { service } = makeService();
    const err = await service.saveExecution(s.requestId, closeBody(s, { stickersQty: -2 }), s.tech.id).catch((e) => e);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("CONSUMABLE_QUANTITY_INVALID");
    await expectNothingCommitted(s, 10);
  }, 30000);

  it("mobile SUCCESS attempt: deducts and marks INSTALLED only its own serials, atomically", async () => {
    const s = await seedClose("mobile");
    const deviceB = serial("HDM");
    const deviceBId = await seedItem(s.tech.id, deviceB);
    const { service } = makeService();
    await service.acceptRequest(s.requestId, s.tech.id);
    await db.insert(courierRequestItems).values([
      { requestId: s.requestId, itemType: "POS", serialNumber: s.device, quantity: 1, status: "RECEIVED", technicianId: s.tech.id },
      { requestId: s.requestId, itemType: "SIM", simSerial: s.sim, quantity: 1, status: "RECEIVED", technicianId: s.tech.id },
      { requestId: s.requestId, itemType: "POS", serialNumber: deviceB, quantity: 1, status: "RECEIVED", technicianId: s.tech.id },
    ]);
    await db.update(courierExecutions).set({ technicianCode: s.tech.username }).where(eq(courierExecutions.requestId, s.requestId));

    await service.createExecutionAttempt(s.requestId, s.tech.id, { status: "SUCCESS", snInstalled: s.device, simInstalled: s.sim });

    const links = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, s.requestId));
    const statusOf = (sn: string) => links.find((l) => l.serialNumber === sn || l.simSerial === sn)!.status;
    expect(statusOf(s.device)).toBe("INSTALLED");
    expect(statusOf(s.sim)).toBe("INSTALLED");
    expect(statusOf(deviceB)).toBe("RECEIVED");
    expect((await item(s.deviceId)).status).toBe("DELIVERED");
    expect((await item(deviceBId)).status).toBe("RECEIVED_BY_TECHNICIAN");
    const [exec] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, s.requestId));
    expect(exec!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
    expect(await completedEvents(s.requestId)).toHaveLength(1);
  }, 30000);

  it("PDF apply with a completed status closes through the same atomic path", async () => {
    const s = await seedClose("apply");
    const [pdf] = await db
      .insert(courierPdfReports)
      .values({ requestId: s.requestId, fileName: "r.pdf", filePath: `/tmp/${randomUUID()}.pdf`, uploadedBy: s.tech.id, status: "pending" })
      .returning();
    const { service } = makeService();

    await service.applyPdfReport(pdf!.id, s.requestId, { installationStatus: COMPLETED, sn: s.device, simSerial: s.sim }, {}, s.tech.id);

    const [exec] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, s.requestId));
    expect(exec!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
    expect((await item(s.deviceId)).status).toBe("DELIVERED");
    expect(await completions(s.requestId)).toHaveLength(1);
    expect(await completedEvents(s.requestId)).toHaveLength(1);
  }, 30000);

  // ── concurrency ───────────────────────────────────────────────────────────

  it("the same device closed on two requests at once: exactly one close commits", async () => {
    const s = await seedClose("race-dev");
    const otherRequest = await seedRequest("race-dev-2");
    const a = makeService().service;
    const b = makeService().service;

    const results = await Promise.allSettled([
      a.saveExecution(s.requestId, closeBody(s), s.tech.id),
      b.saveExecution(otherRequest, closeBody(s), s.tech.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect([422, 503]).toContain(loser.reason?.statusCode);
    const done = [...(await completions(s.requestId)), ...(await completions(otherRequest))];
    expect(done).toHaveLength(1);
    expect(await rolls(s.tech.id)).toBe(8);
    expect(await db.select().from(custodyMovements).where(inArray(custodyMovements.itemId, [s.deviceId, s.simId]))).toHaveLength(2);
    const losingId = done[0]!.requestId === s.requestId ? otherRequest : s.requestId;
    expect(await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, losingId))).toHaveLength(0);
  }, 30000);

  it("the same request closed twice at once: exactly one close and one deduction", async () => {
    const s = await seedClose("race-req");
    const a = makeService().service;
    const b = makeService().service;

    const results = await Promise.allSettled([
      a.saveExecution(s.requestId, closeBody(s), s.tech.id),
      b.saveExecution(s.requestId, closeBody(s), s.tech.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await completions(s.requestId)).toHaveLength(1);
    expect(await completedEvents(s.requestId)).toHaveLength(1);
    expect(await rolls(s.tech.id)).toBe(8);
  }, 30000);
});
