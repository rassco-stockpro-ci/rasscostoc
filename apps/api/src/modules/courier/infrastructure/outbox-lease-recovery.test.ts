/**
 * Outbox processing lease (outbox.repository.ts / outbox.worker.ts), against
 * real Postgres with the real OutboxWorker and InventorySubscriber:
 *
 *   claim -> PROCESSING + lease -> worker crash -> lease expires
 *         -> another worker recovers it -> processed exactly once logically
 */
import { describe, expect, it, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  courierRequests,
  courierExecutions,
  custodyMovements,
  outboxEvents,
  inventoryDeductionCompletions,
} from "@shared/schema";
import { OutboxWorker, MAX_ATTEMPTS } from "@core/outbox/outbox.worker";
import { outboxRepository, OUTBOX_LEASE_MS } from "@core/outbox/outbox.repository";
import { EventBus } from "@core/events/event-bus";
import { ExecutionCompletedEvent } from "@core/events/events";
import { DrizzleCourierRepository } from "./repositories/drizzle-courier.repository";
import { InventorySubscriber } from "../../inventory/contracts";

const PROBE = "LeaseProbeEvent";

describe("outbox processing lease: crash recovery, fencing, poison events", () => {
  let probeDispatches: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    InventorySubscriber.register();
    EventBus.getInstance().subscribe(PROBE, async (event: any) => {
      probeDispatches.push(event.id);
    });
  });

  const row = async (id: string) => (await db.select().from(outboxEvents).where(eq(outboxEvents.id, id)))[0]!;
  const expireLease = (id: string) =>
    db
      .update(outboxEvents)
      .set({ lockedAt: new Date(Date.now() - OUTBOX_LEASE_MS - 60_000) })
      .where(eq(outboxEvents.id, id));
  /** A worker that sees every eligible row in one batch (the table is shared). */
  const worker = () => new OutboxWorker({ batchSize: 10_000 });
  const toEvent = (r: any) => ({
    id: r.id,
    name: r.eventName,
    version: r.eventVersion,
    occurredAt: r.createdAt,
    timestamp: r.createdAt,
    correlationId: r.correlationId,
    causationId: r.causationId,
    payload: r.payload,
  });

  async function enqueueProbe() {
    const id = randomUUID();
    await outboxRepository.enqueue({
      id,
      name: PROBE,
      version: 1,
      payload: { probe: true },
      correlationId: id,
      causationId: id,
      occurredAt: new Date(),
      timestamp: new Date(),
    } as any);
    return id;
  }

  /** A close committed before the in-transaction deduction: its event has no completion row. */
  async function legacyClose() {
    const techId = randomUUID();
    const username = `lease-${techId.slice(0, 8)}`;
    await db.insert(users).values({ id: techId, username, email: `${username}@test.local`, password: "x", fullName: "Lease", role: "technician" });
    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({ id: itemTypeId, nameAr: `n-${itemTypeId.slice(0, 6)}`, nameEn: `t-${itemTypeId.slice(0, 6)}`, category: "device" });
    const serial = `LEASE${randomUUID().slice(0, 8)}`.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const itemId = randomUUID();
    await db.insert(items).values({ id: itemId, itemTypeId, serialNumber: serial, barcode: `${serial}-B`, status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: techId });
    const [request] = await db.insert(courierRequests).values({ customerName: "Lease", incidentNumber: `L-${randomUUID().slice(0, 8)}` }).returning();
    const execution = await new DrizzleCourierRepository().insertExecution({
      requestId: request!.id,
      installationStatus: "Installation Completed - NL",
      sn: serial,
      enteredBy: techId,
      technicianCode: username,
      custodyClosureStatus: "PENDING_DEDUCTION",
    });
    const event = new ExecutionCompletedEvent({ requestId: request!.id, actorId: techId, execution, request });
    await outboxRepository.enqueue(event);
    return { eventId: event.id, requestId: request!.id as number, itemId };
  }

  it("a PROCESSING event whose worker crashed is recovered after the lease expires, and deducted exactly once", async () => {
    const legacy = await legacyClose();

    // Worker A claims it, then "crashes" (never dispatches, never finalizes).
    const claimedByA = await outboxRepository.getPendingEvents(10_000, "worker-A");
    const mine = claimedByA.find((r) => r.id === legacy.eventId);
    expect(mine?.status).toBe("PROCESSING");
    expect((await row(legacy.eventId)).lockedBy).toBe("worker-A");

    // Before the lease expires nobody may take it.
    await worker().runOnce();
    expect((await row(legacy.eventId)).lockedBy).toBe("worker-A");
    expect(await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, legacy.requestId))).toHaveLength(0);

    // Lease expires -> worker B recovers and processes it.
    await expireLease(legacy.eventId);
    await worker().runOnce();
    const afterB = await row(legacy.eventId);
    expect(afterB.status).toBe("PUBLISHED");
    expect(afterB.retryCount).toBe(1); // the crashed attempt counts

    // Worker A wakes up and finishes its stale copy: logically a no-op, and fenced.
    await EventBus.getInstance().publishLocal(toEvent(mine) as any);
    expect(await outboxRepository.markAsPublished(legacy.eventId, "worker-A")).toBe(false);

    const completions = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, legacy.requestId));
    expect(completions).toHaveLength(1);
    expect(completions[0]!.sourceEventId).toBe(legacy.eventId);
    expect(await db.select().from(custodyMovements).where(eq(custodyMovements.itemId, legacy.itemId))).toHaveLength(1);
    const [item] = await db.select().from(items).where(eq(items.id, legacy.itemId));
    expect(item!.status).toBe("DELIVERED");
  }, 30000);

  it("two workers polling at the same moment: the event is claimed once and deducted once", async () => {
    const legacy = await legacyClose();

    await Promise.all([worker().runOnce(), worker().runOnce(), worker().runOnce()]);

    const r = await row(legacy.eventId);
    expect(r.status).toBe("PUBLISHED");
    expect(r.retryCount).toBe(0); // claimed by exactly one worker, never recovered
    expect(await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, legacy.requestId))).toHaveLength(1);
    expect(await db.select().from(custodyMovements).where(eq(custodyMovements.itemId, legacy.itemId))).toHaveLength(1);
  }, 30000);

  it("finalizing writes are fenced to the lease owner", async () => {
    const id = await enqueueProbe();
    await outboxRepository.getPendingEvents(10_000, "owner-1");
    expect(await outboxRepository.markAsFailed(id, "x", new Date(), 0, "intruder")).toBe(false);
    expect(await outboxRepository.markAsDead(id, "x", undefined, "intruder")).toBe(false);
    expect((await row(id)).status).toBe("PROCESSING");
    expect(await outboxRepository.markAsPublished(id, "owner-1")).toBe(true);
    expect((await row(id)).status).toBe("PUBLISHED");
  });

  it("an event whose lease keeps expiring reaches DEAD instead of looping, without another dispatch", async () => {
    const id = await enqueueProbe();
    // Already recovered MAX_ATTEMPTS - 1 times, and its current worker died too.
    await db
      .update(outboxEvents)
      .set({ status: "PROCESSING", lockedBy: "dead-worker", lockedAt: new Date(Date.now() - OUTBOX_LEASE_MS - 60_000), retryCount: MAX_ATTEMPTS - 1 })
      .where(eq(outboxEvents.id, id));
    probeDispatches = [];

    await worker().runOnce();

    const dead = await row(id);
    expect(dead.status).toBe("DEAD");
    expect(dead.retryCount).toBe(MAX_ATTEMPTS);
    expect(dead.lastError).toContain("lease expired");
    expect(probeDispatches).not.toContain(id);
  });

  it("before this change the same crash stranded the event forever (regression guard on the claim query)", async () => {
    const id = await enqueueProbe();
    await outboxRepository.getPendingEvents(10_000, "crashed-worker");
    await expireLease(id);
    const reclaimed = await outboxRepository.getPendingEvents(10_000, "rescuer");
    expect(reclaimed.map((r) => r.id)).toContain(id);
    expect((await row(id)).lockedBy).toBe("rescuer");
    await outboxRepository.markAsPublished(id, "rescuer");
  });

  it("cleanup: no probe event left PROCESSING", async () => {
    const left = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(sql`${outboxEvents.eventName} = ${PROBE} and ${outboxEvents.status} = 'PROCESSING'`);
    if (left.length) await db.update(outboxEvents).set({ status: "PUBLISHED", lockedBy: null, lockedAt: null }).where(inArray(outboxEvents.id, left.map((r) => r.id)));
    expect(true).toBe(true);
  });
});
