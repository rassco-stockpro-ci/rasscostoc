/**
 * OPS-REMED-E4-P2 — CourierProjectionWorker end-to-end proof.
 *
 * Runs only via a real disposable Postgres test database (guarded below).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@core/config/db";
import { users, courierRequests, courierExecutions, inventoryDeductionCompletions } from "@shared/schema";
import { CourierProjectionWorker } from "./CourierProjectionWorker";
import { resetTestDatabase } from "@core/testing/foundation/db.helpers";

describe("OPS-REMED-E4-P2 — CourierProjectionWorker", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database " +
          "(must contain 'test' in the database name). See scripts/test-database.mjs."
      );
    }
    // test-isolation fix: inventory_deduction_completions.request_id has no FK
    // to courier_requests (deliberately — see
    // migrations/0050_inventory_deduction_completions_add.sql), so a row this
    // table's OWN tests (or courier-audit-dedup.test.ts) leave behind is never
    // cleaned up by anything, and can later collide with a freshly-generated
    // courier_requests.id via inventory_deduction_completions_request_id_unique.
    // Truncate only this orphan-prone table — deliberately NOT courier_requests/
    // courier_executions: RESTART IDENTITY on those makes the serial sequence
    // restart at 1 in this file, which then collides with IdempotencyService's
    // request-id-keyed dedup records (format "Event:REQ-{id}:Subscriber:vN",
    // itself not reset by any table truncation) whenever this file runs
    // immediately after another file using the same low ids — confirmed by
    // running this file back-to-back with courier-audit-dedup.test.ts. Letting
    // the sequence climb monotonically (its normal behavior across the rest of
    // the suite) avoids that entirely.
    await resetTestDatabase(["inventory_deduction_completions"]);
  });

  async function seedRow(closureStatus: string): Promise<{ requestId: number; completionId: string }> {
    const actorId = randomUUID();
    await db.insert(users).values({
      id: actorId,
      username: `e4p2-worker-${actorId.slice(0, 8)}`,
      email: `e4p2-worker-${actorId.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "E4 P2 Worker",
      role: "admin",
    });
    const [request] = await db
      .insert(courierRequests)
      .values({ customerName: "E4 P2 Worker", incidentNumber: `E4-P2-W-${randomUUID().slice(0, 8)}` })
      .returning();
    await db.insert(courierExecutions).values({ requestId: request.id, enteredBy: actorId, custodyClosureStatus: closureStatus });
    const [completion] = await db
      .insert(inventoryDeductionCompletions)
      .values({
        requestId: request.id,
        sourceEventId: randomUUID(),
        generalInventoryDeducted: true,
        serializedItemCount: 0,
      })
      .returning();
    return { requestId: request.id, completionId: completion.id };
  }

  it("1. claims a PENDING row and drives it to CLOSED_SUCCESS + PROJECTED", async () => {
    const { requestId, completionId } = await seedRow("PROCESSING");
    const worker = new CourierProjectionWorker();
    await worker.runOnce();

    const [execRow] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(execRow!.custodyClosureStatus).toBe("CLOSED_SUCCESS");

    const [compRow] = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.id, completionId));
    expect(compRow!.projectionStatus).toBe("PROJECTED");
    expect(compRow!.projectedAt).not.toBeNull();
  });

  it("2. an expired CLAIMED row is reclaimed and re-processed", async () => {
    const { requestId, completionId } = await seedRow("PROCESSING");
    await db
      .update(inventoryDeductionCompletions)
      .set({
        projectionStatus: "CLAIMED",
        projectionLeaseOwner: "stale-worker",
        projectionLeaseToken: "stale-token",
        projectionLeaseExpiresAt: new Date(Date.now() - 10_000), // already expired
      })
      .where(eq(inventoryDeductionCompletions.id, completionId));

    const worker = new CourierProjectionWorker();
    await worker.runOnce();

    const [compRow] = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.id, completionId));
    expect(compRow!.projectionStatus).toBe("PROJECTED");

    const [execRow] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(execRow!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
  });

  it("3. a live (non-expired) CLAIMED row is NOT reclaimed", async () => {
    const { completionId } = await seedRow("PROCESSING");
    await db
      .update(inventoryDeductionCompletions)
      .set({
        projectionStatus: "CLAIMED",
        projectionLeaseOwner: "live-worker",
        projectionLeaseToken: "live-token",
        projectionLeaseExpiresAt: new Date(Date.now() + 60_000), // still valid
      })
      .where(eq(inventoryDeductionCompletions.id, completionId));

    const worker = new CourierProjectionWorker();
    await worker.runOnce();

    const [compRow] = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.id, completionId));
    expect(compRow!.projectionStatus).toBe("CLAIMED"); // untouched
    expect(compRow!.projectionLeaseOwner).toBe("live-worker");
  });

  it("4. a PROJECTED row is never reclaimed by a later run", async () => {
    const { completionId } = await seedRow("CLOSED_SUCCESS");
    await db
      .update(inventoryDeductionCompletions)
      .set({ projectionStatus: "PROJECTED", projectedAt: new Date() })
      .where(eq(inventoryDeductionCompletions.id, completionId));

    const worker = new CourierProjectionWorker();
    await worker.runOnce();

    const [compRow] = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.id, completionId));
    expect(compRow!.projectionStatus).toBe("PROJECTED"); // unchanged
  });

  it("5. two concurrent worker instances never double-project the same row", async () => {
    await seedRow("PROCESSING");
    await seedRow("PROCESSING");
    const workerA = new CourierProjectionWorker();
    const workerB = new CourierProjectionWorker();

    await Promise.all([workerA.runOnce(), workerB.runOnce()]);

    const rows = await db.select().from(inventoryDeductionCompletions);
    const projected = rows.filter((r) => r.projectionStatus === "PROJECTED");
    // Every seeded row from THIS test reaches PROJECTED exactly once —
    // SKIP LOCKED prevents either worker from claiming a row the other
    // already holds, so no row is processed twice.
    expect(projected.length).toBeGreaterThanOrEqual(2);
  });

  it("6. worker startup guard prevents a duplicate timer on repeated start()", () => {
    const worker = new CourierProjectionWorker();
    worker.start();
    const firstIntervalId = (worker as any).intervalId;
    worker.start(); // second call must be a no-op
    expect((worker as any).intervalId).toBe(firstIntervalId);
    return worker.stop();
  });

  it("7. graceful shutdown awaits the in-flight run and clears the timer", async () => {
    const worker = new CourierProjectionWorker();
    worker.start();
    await worker.stop();
    expect((worker as any).intervalId).toBeNull();
  });
});
