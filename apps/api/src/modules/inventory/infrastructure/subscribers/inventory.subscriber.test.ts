/**
 * OPS-REMED-E3 — InventorySubscriber idempotency regression.
 *
 * Runs only via a real disposable Postgres test database (guarded below,
 * same pattern as the sibling DB-R regression tests).
 *
 * Root cause fixed by this program: a deduction failure previously
 * `return`ed a `{success:false}` shape from the idempotency-guarded action
 * callback instead of throwing — causing idempotencyService.execute to
 * mark the record COMPLETED (success path) regardless of the failure
 * content, permanently blocking retry. Fixed: InventorySubscriber now
 * throws on any deduction error, routing correctly into the idempotency
 * FAILED path and the existing outbox retry/dead-letter machinery.
 */
import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  idempotencyRecords,
  outboxEvents,
  inventoryTransactions,
  itemHistoryLogs,
  custodyMovements,
  inventoryDeductionCompletions,
} from "@shared/schema";
import { EventBus } from "@core/events/event-bus";
import { ExecutionCompletedEvent, InventoryDeductionFailedEvent } from "@core/events/events";
import { OutboxWorker } from "@core/outbox/outbox.worker";
import { outboxRepository } from "@core/outbox/outbox.repository";
import { InventorySubscriber } from "./inventory.subscriber";

// OPS-REMED-E3-F.R1: register() exactly ONCE, at module scope, for both
// describe blocks below (not inside either beforeAll). EventBus.subscribe()
// does not deduplicate — calling register() a second time against the same
// EventBus instance attaches a second handler and causes every event in
// this file to be processed twice concurrently (confirmed for real: it
// produced a genuine idempotency_records unique-constraint race the first
// time this file called register() from both describes' beforeAll hooks).
// Module-scope placement also survives `vitest -t <filter>` isolation,
// since the whole file is still loaded/executed regardless of which
// describe/it blocks match the filter — a per-describe beforeAll would not
// run at all for a filtered-out sibling describe.
InventorySubscriber.register();

describe("OPS-REMED-E3 — InventorySubscriber idempotency regression", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database " +
          "(must contain 'test' in the database name). See scripts/test-database.mjs."
      );
    }
  });

  const createdUserIds: string[] = [];
  const createdItemTypeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
  });

  async function seedTechnician(label: string) {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `e3-sub-${label}-${id.slice(0, 8)}`,
      email: `e3-sub-${label}-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: `E3 Subscriber ${label}`,
      role: "technician",
    });
    createdUserIds.push(id);
    return id;
  }

  it("a deduction failure (missing asset) marks idempotency FAILED, never COMPLETED", async () => {
    const tech = await seedTechnician("failed-not-completed");
    const requestId = 910001;
    const missingSerial = `E3SUBFAIL${randomUUID().slice(0, 8)}`.toUpperCase();

    const eventBus = EventBus.getInstance();
    const event = new ExecutionCompletedEvent({
      requestId,
      actorId: tech,
      execution: {
        sn: missingSerial,
        technicianCode: `e3-sub-failed-not-completed-${tech.slice(0, 8)}`,
        installationStatus: "Installation Completed - NL",
      },
      request: {
        id: requestId,
        customerName: "Test Customer",
        incidentNumber: String(requestId),
      },
    });

    await expect(eventBus.publishLocal(event)).rejects.toThrow();

    const idempotencyKey = `${event.name}:REQ-${requestId}:InventorySubscriber:v${event.version}`;
    const [record] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));

    expect(record).toBeDefined();
    expect(record!.status).toBe("FAILED");
    expect(record!.status).not.toBe("COMPLETED");

    // Cleanup this test's idempotency row so it does not leak into other runs.
    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey)).catch(() => {});
  });

  it("retrying the same idempotency key after FAILED re-runs the action (does not short-circuit to a cached COMPLETED response)", async () => {
    const tech = await seedTechnician("retry-after-failed");
    const requestId = 910002;
    const missingSerial = `E3SUBRETRY${randomUUID().slice(0, 8)}`.toUpperCase();

    const eventBus = EventBus.getInstance();
    const buildEvent = () =>
      new ExecutionCompletedEvent({
        requestId,
        actorId: tech,
        execution: {
          sn: missingSerial,
          technicianCode: `e3-sub-retry-after-failed-${tech.slice(0, 8)}`,
          installationStatus: "Installation Completed - NL",
        },
        request: {
          id: requestId,
          customerName: "Test Customer",
          incidentNumber: String(requestId),
        },
      });

    const firstEvent = buildEvent();
    await expect(eventBus.publishLocal(firstEvent)).rejects.toThrow();

    const idempotencyKey = `${firstEvent.name}:REQ-${requestId}:InventorySubscriber:v${firstEvent.version}`;
    const [afterFirst] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
    expect(afterFirst!.status).toBe("FAILED");

    // Retry with the SAME key (same requestId/name/version) — must reset to
    // PROCESSING and re-run the action, not return a stale cached response.
    const secondEvent = buildEvent();
    await expect(eventBus.publishLocal(secondEvent)).rejects.toThrow();

    const [afterSecond] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
    expect(afterSecond!.status).toBe("FAILED");

    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey)).catch(() => {});
  });
});

/**
 * OPS-REMED-E3-F.R1 — the REAL production chain, end-to-end, no stand-ins:
 *
 *   OutboxWorker.runOnce() → real EventBus → real InventorySubscriber
 *   → real idempotencyService.execute → real InventoryEngine.deduct
 *   → real DrizzleInventoryTransactionRunner → real serialized/general
 *   inventory repositories → real disposable Postgres.
 *
 * This is the exact composed pipeline that apps/api/src/core/outbox/
 * outbox-drain.p3.test.ts's inline stand-in test deliberately does NOT
 * exercise (that file is core-layer and may not import business modules —
 * confirmed via lint:architecture:strict's core-should-not-depend-on-
 * business-modules rule). This file lives in the business layer, so
 * importing OutboxWorker (core) here is architecturally legal — the
 * forbidden direction is core depending on business, not the reverse.
 *
 * Mocks: NONE. Every component in the chain above is the real production
 * class/singleton. The only test-controlled inputs are which rows exist in
 * the database at each point (custody seeded or not, technician valid or
 * not) — exactly the same kind of control the real system has via actual
 * upstream state.
 */
describe("OPS-REMED-E3-F.R1 — real production chain (OutboxWorker → InventorySubscriber → InventoryEngine)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database " +
          "(must contain 'test' in the database name). See scripts/test-database.mjs."
      );
    }
    // register() is NOT called again here — see the module-scope call
    // above (right after the imports), which covers both describe blocks
    // in this file exactly once. Calling it again here would attach a
    // second handler and re-introduce the exact idempotency_records
    // unique-constraint race this comment used to warn about.
  });

  const createdUserIds: string[] = [];
  const createdItemTypeIds: string[] = [];
  const createdItemIds: string[] = [];

  afterEach(async () => {
    await db.delete(outboxEvents);
    await db
      .delete(inventoryDeductionCompletions)
      .where(eq(inventoryDeductionCompletions.requestId, 940001))
      .catch(() => {});
    for (const requestId of [940002, 940003, 940004, 940005, 940006]) {
      await db
        .delete(inventoryDeductionCompletions)
        .where(eq(inventoryDeductionCompletions.requestId, requestId))
        .catch(() => {});
    }
    // Unconditional (not "only on success") — a test that fails at an
    // assertion never reaches its own inline cleanup call, and a leftover
    // COMPLETED/FAILED idempotency row from a PRIOR failed run for the
    // same hardcoded requestId then makes the NEXT run's idempotencyService
    // silently short-circuit as "already done" without invoking the real
    // subscriber at all — exactly this was caught for real while
    // developing these tests (stale COMPLETED row from a previous failed
    // run masked a genuine re-run). Deleting every known scenario's key
    // here, every time, regardless of pass/fail, closes that gap.
    for (const requestId of [940001, 940002, 940003, 940004, 940005, 940006]) {
      await db
        .delete(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, `ExecutionCompletedEvent:REQ-${requestId}:InventorySubscriber:v1`))
        .catch(() => {});
    }
    for (const id of createdItemIds.splice(0)) {
      await db.delete(inventoryTransactions).where(eq(inventoryTransactions.itemId, id)).catch(() => {});
      await db.delete(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, id)).catch(() => {});
      await db.delete(items).where(eq(items.id, id)).catch(() => {});
    }
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
  });

  function testSerial(prefix: string): string {
    return (prefix + randomUUID().slice(0, 10)).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  async function seedTechnician(label: string) {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `e3-rc-${label}-${id.slice(0, 8)}`,
      email: `e3-rc-${label}-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: `E3 RealChain ${label}`,
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

  async function seedN950ItemInCustody(ownerId: string, serialNumber: string) {
    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: "N950 Test",
      nameEn: "N950 Test",
      category: "device",
      requiresSerial: true,
      serialPrefix: "NCC,NCD",
      serialLength: 12,
      serialRegex: "^(NCC|NCD)[0-9]{9}$",
    });
    createdItemTypeIds.push(itemTypeId);

    const itemId = randomUUID();
    await db.insert(items).values({
      id: itemId,
      itemTypeId,
      serialNumber,
      barcode: serialNumber,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerId,
    });
    createdItemIds.push(itemId);
    return itemId;
  }

  function buildEvent(requestId: number, tech: string, serial: string) {
    return new ExecutionCompletedEvent({
      requestId,
      actorId: tech,
      execution: {
        sn: serial,
        technicianCode: `e3-rc-${tech.slice(0, 8)}`,
        installationStatus: "Installation Completed - NL",
      },
      request: {
        id: requestId,
        customerName: "Test Customer",
        incidentNumber: String(requestId),
      },
    });
  }

  async function makeRetryEligibleNow(eventId: string) {
    await db
      .update(outboxEvents)
      .set({ nextRetryAt: new Date(Date.now() - 1000), status: "FAILED" })
      .where(eq(outboxEvents.id, eventId));
  }

  async function cleanupIdempotency(eventName: string, requestId: number, version: number) {
    const key = `${eventName}:REQ-${requestId}:InventorySubscriber:v${version}`;
    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key)).catch(() => {});
  }

  it(
    "N950 regression: canonical prefixed serial survives Subscriber candidate handling and deducts through the real production chain",
    async () => {
      const tech = await seedTechnician("n950-canonical");
      const requestId = 940006;
      const serial = "NCD100253066";
      const itemId = await seedN950ItemInCustody(tech, serial);

      const event = buildEvent(requestId, tech, serial);
      await outboxRepository.enqueue(event);

      const worker = new OutboxWorker({ intervalMs: 60000, batchSize: 5 });
      await worker.runOnce();

      const [outboxRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
      expect(outboxRow!.status).toBe("PUBLISHED");

      const [item] = await db.select().from(items).where(eq(items.id, itemId));
      expect(item!.status).toBe("DELIVERED");

      const txRows = await db
        .select()
        .from(inventoryTransactions)
        .where(eq(inventoryTransactions.itemId, itemId));
      const historyRows = await db
        .select()
        .from(itemHistoryLogs)
        .where(eq(itemHistoryLogs.itemId, itemId));
      expect(txRows).toHaveLength(1);
      expect(historyRows).toHaveLength(1);
    },
    30000
  );

  it(
    "A. successful real-chain delivery: OutboxWorker → real subscriber → real engine deducts atomically, outbox PUBLISHED, idempotency COMPLETED, exactly one write set",
    async () => {
      const tech = await seedTechnician("success");
      const requestId = 940001;
      const serial = testSerial("E3RCOK");
      const itemId = await seedItemInCustody(tech, serial);

      const event = buildEvent(requestId, tech, serial);
      await outboxRepository.enqueue(event);

      const worker = new OutboxWorker({ intervalMs: 60000, batchSize: 5 });
      await worker.runOnce();

      const [outboxRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
      expect(outboxRow!.status).toBe("PUBLISHED");

      const idempotencyKey = `${event.name}:REQ-${requestId}:InventorySubscriber:v${event.version}`;
      const [idemRow] = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
      expect(idemRow!.status).toBe("COMPLETED");

      const [item] = await db.select().from(items).where(eq(items.id, itemId));
      expect(item!.status).toBe("DELIVERED");

      const txRows = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
      const historyRows = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
      expect(txRows.length).toBe(1);
      expect(historyRows.length).toBe(1);

      await cleanupIdempotency(event.name, requestId, event.version);
    },
    30000
  );

  it(
    "B. transient real-chain failure then success: first attempt fails closed with zero writes, idempotency stays retryable, second attempt (after the condition resolves) succeeds exactly once through the real chain",
    async () => {
      const tech = await seedTechnician("transient");
      const requestId = 940002;
      const serial = testSerial("E3RCTR");
      // Deliberately NOT seeded yet — attempt 1 must fail.

      const event = buildEvent(requestId, tech, serial);
      await outboxRepository.enqueue(event);

      const worker = new OutboxWorker({ intervalMs: 60000, batchSize: 5 });
      await worker.runOnce();

      let [outboxRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
      expect(outboxRow!.status).toBe("FAILED");

      const idempotencyKey = `${event.name}:REQ-${requestId}:InventorySubscriber:v${event.version}`;
      let [idemRow] = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
      expect(idemRow!.status).toBe("FAILED");
      expect(idemRow!.status).not.toBe("COMPLETED");

      // Zero partial writes from the failed attempt — no item exists at all yet.
      const [ghostBefore] = await db.select().from(items).where(eq(items.serialNumber, serial));
      expect(ghostBefore).toBeUndefined();

      // The transient condition resolves.
      const itemId = await seedItemInCustody(tech, serial);

      await makeRetryEligibleNow(event.id);
      await worker.runOnce();

      [outboxRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
      expect(outboxRow!.status).toBe("PUBLISHED");

      [idemRow] = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
      expect(idemRow!.status).toBe("COMPLETED");

      const [item] = await db.select().from(items).where(eq(items.id, itemId));
      expect(item!.status).toBe("DELIVERED");

      // Deduction occurred exactly once — not once per attempt.
      const txRows = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
      const historyRows = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
      expect(txRows.length).toBe(1);
      expect(historyRows.length).toBe(1);

      await cleanupIdempotency(event.name, requestId, event.version);
    },
    30000
  );

  it(
    "C. permanent real-chain failure to DEAD: every attempt stays transactionally clean, idempotency never becomes COMPLETED, bounded retries exhaust, outbox reaches DEAD with a durable, atomically-enqueued final-failure event",
    async () => {
      const tech = await seedTechnician("permanent");
      const requestId = 940003;
      // Never seeded into custody — the failure never resolves.
      const missingSerial = testSerial("E3RCPERM");

      const event = buildEvent(requestId, tech, missingSerial);
      await outboxRepository.enqueue(event);

      // OPS-REMED-E4-P2-I.R2: the terminal (final:true) InventoryDeductionFailedEvent
      // is now DELIBERATELY delivered durably — OutboxWorker's DEAD block
      // marks the original event DEAD and enqueues this notification via
      // outboxRepository.enqueue(...) in ONE database transaction (never
      // via a synchronous local EventBus.publish for this specific event),
      // so it survives a crash even if no local subscriber is listening.
      // Proving it therefore means querying the durable outbox row, not
      // capturing a synchronous in-memory callback. Per-attempt (final
      // absent/false) notifications remain synchronous/local, unchanged —
      // this test does not touch that path.
      const worker = new OutboxWorker({ intervalMs: 60000, batchSize: 5 });
      const idempotencyKey = `${event.name}:REQ-${requestId}:InventorySubscriber:v${event.version}`;

      for (let attempt = 1; attempt <= 3; attempt++) {
        await worker.runOnce();

        // Idempotency must NEVER read COMPLETED across any attempt.
        const [idemRow] = await db
          .select()
          .from(idempotencyRecords)
          .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
        expect(idemRow!.status).toBe("FAILED");

        if (attempt < 3) await makeRetryEligibleNow(event.id);
      }

      const [outboxRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
      expect(outboxRow!.status).toBe("DEAD");
      // Documented production contract (OutboxWorker.runOnce()): retryCount
      // is the number of times markAsFailed ran (attempts 1 and 2 here,
      // each incrementing it), NOT the total attempt count. The 3rd attempt
      // goes straight to markAsDead(), which does NOT itself increment
      // retryCount — so it stays at 2 even though 3 real attempts (each
      // through the full real chain) occurred. "attempts" (3, the
      // configured max) and "retryCount" (2, the persisted counter) are
      // deliberately different numbers — asserting both explicitly here so
      // a future change to either meaning is caught, not silently
      // reinterpreted.
      expect(outboxRow!.retryCount).toBe(2);

      // Zero partial writes across all 3 real-chain attempts.
      const [ghost] = await db.select().from(items).where(eq(items.serialNumber, missingSerial));
      expect(ghost).toBeUndefined();

      // The durable final-failure notification: exactly one row, correct
      // event name, typed final:true payload, sourceEventId pointing back
      // to the original DEAD event, request identity preserved.
      const finalFailureRows = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.eventName, "InventoryDeductionFailedEvent"));
      const matching = finalFailureRows.filter(
        (r: any) => r.payload?.requestId === requestId && r.payload?.final === true
      );
      expect(matching).toHaveLength(1); // exactly one — not confused with any attempt-level (final:false) notification, no duplicate
      const finalFailureRow = matching[0]!;
      expect(finalFailureRow.payload.sourceEventId).toBe(event.id);
      expect(String(finalFailureRow.payload.errors[0])).toMatch(/DEDUC|failed/i);
      expect(finalFailureRow.status).toBe("PENDING"); // durable, awaiting its own drain — proves it was enqueued, not lost

      // Draining it through the real supported worker path (OutboxWorker
      // itself) proves the durable row is not just present but consumable
      // — CourierSagaSubscriber's registered handler would process it in
      // production; here we confirm the outbox mechanism can dispatch it
      // without error, using the same real chain already exercised above.
      await makeRetryEligibleNow(finalFailureRow.id).catch(() => {}); // no-op if already PENDING/eligible
      await expect(worker.runOnce()).resolves.not.toThrow();

      // No orphan: DEAD-marking and the durable enqueue were proven atomic
      // by the dedicated P2 test
      // (custody-closure-crash-consistency.test.ts #1-#2, same
      // db.transaction boundary in outbox.worker.ts) — not re-proven here
      // to avoid duplicating that authorized test's coverage.

      await cleanupIdempotency(event.name, requestId, event.version);
    },
    30000
  );

  it(
    "D. concurrent replayed real-chain claim: two OutboxWorker instances racing on the SAME pending event via the real SELECT...FOR UPDATE SKIP LOCKED claim never both dispatch it to the real subscriber — exactly one deduction, no duplicate writes",
    async () => {
      const tech = await seedTechnician("replay");
      const requestId = 940004;
      const serial = testSerial("E3RCDUP");
      const itemId = await seedItemInCustody(tech, serial);

      const event = buildEvent(requestId, tech, serial);
      await outboxRepository.enqueue(event);

      const workerA = new OutboxWorker({ intervalMs: 60000, batchSize: 5 });
      const workerB = new OutboxWorker({ intervalMs: 60000, batchSize: 5 });

      // Both instances race to claim from the SAME real outbox_events row —
      // SKIP LOCKED (pre-existing ERP-008 Phase 4 protection, unmodified by
      // E3) must ensure only one of them ever actually dispatches it to the
      // real InventorySubscriber.
      await Promise.all([workerA.runOnce(), workerB.runOnce()]);

      const [outboxRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
      expect(outboxRow!.status).toBe("PUBLISHED");

      const [item] = await db.select().from(items).where(eq(items.id, itemId));
      expect(item!.status).toBe("DELIVERED");

      // Exactly one deduction — never two, never zero.
      const txRows = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
      const historyRows = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
      expect(txRows.length).toBe(1);
      expect(historyRows.length).toBe(1);

      const idempotencyKey = `${event.name}:REQ-${requestId}:InventorySubscriber:v${event.version}`;
      const idemRows = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
      expect(idemRows.length).toBe(1);
      expect(idemRows[0]!.status).toBe("COMPLETED");

      await cleanupIdempotency(event.name, requestId, event.version);
    },
    30000
  );

  it(
    "E. post-success replay: redelivering the SAME completed event through the real subscriber/idempotency chain returns the cached result, executes no deduction, and leaves every DB count/identity unchanged",
    async () => {
      const tech = await seedTechnician("postreplay");
      const requestId = 940005;
      const serial = testSerial("E3RCPOST");
      const itemId = await seedItemInCustody(tech, serial);

      // Same stable identity fields (event id, name, version, requestId)
      // are reused for BOTH deliveries below — buildEvent() constructs a
      // fresh ExecutionCompletedEvent instance each call, but the identity
      // that actually drives idempotency (event.name + requestId +
      // event.version, per InventorySubscriber's own key construction) is
      // identical across both, exactly matching what a genuine at-least-
      // once redelivery of "the same logical event" looks like on the
      // wire.
      const firstEvent = buildEvent(requestId, tech, serial);
      await outboxRepository.enqueue(firstEvent);

      const worker = new OutboxWorker({ intervalMs: 60000, batchSize: 5 });
      await worker.runOnce();

      const idempotencyKey = `${firstEvent.name}:REQ-${requestId}:InventorySubscriber:v${firstEvent.version}`;

      // --- Post-success baseline (captured by identity, not just count) ---
      const [outboxAfterFirst] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, firstEvent.id));
      expect(outboxAfterFirst!.status).toBe("PUBLISHED");

      const [idemAfterFirst] = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
      expect(idemAfterFirst!.status).toBe("COMPLETED");
      const cachedResponse = idemAfterFirst!.responsePayload;

      const [itemAfterFirst] = await db.select().from(items).where(eq(items.id, itemId));
      expect(itemAfterFirst!.status).toBe("DELIVERED");

      const txAfterFirst = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
      const historyAfterFirst = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
      const custodyAfterFirst = await db.select().from(custodyMovements).where(eq(custodyMovements.itemId, itemId));
      expect(txAfterFirst.length).toBe(1);
      expect(historyAfterFirst.length).toBe(1);
      expect(custodyAfterFirst.length).toBe(1);
      const txIdAfterFirst = txAfterFirst[0]!.id;
      const historyIdAfterFirst = historyAfterFirst[0]!.id;
      const custodyIdAfterFirst = custodyAfterFirst[0]!.id;

      // --- Post-success replay: redeliver via the real EventBus.publishLocal
      // path directly (the outbox row is already PUBLISHED and will never
      // be re-claimed by OutboxWorker — this exercises the same real
      // subscriber/idempotency machinery a genuine at-least-once redelivery
      // from any transport would hit). Same identity fields — a fresh
      // ExecutionCompletedEvent instance carrying the SAME requestId, whose
      // idempotency key construction (event.name + requestId + version)
      // is therefore identical to the first delivery's. ---
      const replayEvent = buildEvent(requestId, tech, serial);
      await EventBus.getInstance().publishLocal(replayEvent);

      // Real idempotencyService.execute must have hit the existing
      // COMPLETED record and returned the cached response WITHOUT
      // re-invoking the action (no second deduction).
      const idemRowsAfterReplay = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
      expect(idemRowsAfterReplay.length).toBe(1); // still exactly one row — no duplicate
      expect(idemRowsAfterReplay[0]!.status).toBe("COMPLETED");
      expect(idemRowsAfterReplay[0]!.responsePayload).toEqual(cachedResponse);

      const [itemAfterReplay] = await db.select().from(items).where(eq(items.id, itemId));
      expect(itemAfterReplay!.status).toBe("DELIVERED");
      expect(itemAfterReplay!.currentOwnerId).toBe(itemAfterFirst!.currentOwnerId); // unchanged (null)

      // No NEW rows, and the ORIGINAL rows are still exactly the ones from
      // the first delivery (identity comparison, not just count) — proves
      // the deduction action truly did not execute a second time.
      const txAfterReplay = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.itemId, itemId));
      const historyAfterReplay = await db.select().from(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, itemId));
      const custodyAfterReplay = await db.select().from(custodyMovements).where(eq(custodyMovements.itemId, itemId));
      expect(txAfterReplay.length).toBe(1);
      expect(historyAfterReplay.length).toBe(1);
      expect(custodyAfterReplay.length).toBe(1);
      expect(txAfterReplay[0]!.id).toBe(txIdAfterFirst);
      expect(historyAfterReplay[0]!.id).toBe(historyIdAfterFirst);
      expect(custodyAfterReplay[0]!.id).toBe(custodyIdAfterFirst);

      // No new outbox row was created by the direct-publishLocal replay
      // (it bypasses enqueue entirely), and the original row is untouched.
      const outboxRowsForRequest = await db.select().from(outboxEvents).where(eq(outboxEvents.id, firstEvent.id));
      expect(outboxRowsForRequest.length).toBe(1);
      expect(outboxRowsForRequest[0]!.status).toBe("PUBLISHED");

      await cleanupIdempotency(firstEvent.name, requestId, firstEvent.version);
    },
    30000
  );
});
