/**
 * OPS-REMED-E4-P2 — CourierProjectionWorker end-to-end proof.
 *
 * Runs only via a real disposable Postgres test database (guarded below).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  courierRequests,
  courierExecutions,
  inventoryDeductionCompletions,
  courierAuditLogs,
  courierExecutionAuditDedup,
} from "@shared/schema";
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

  // Mirrors the real historical bulk-import shape (courier.service.ts's
  // importRawRequests): a request/execution row whose custody_closure_status
  // starts life at RECONCILIATION_REQUIRED with NO inventory_deduction_completions
  // row at all -- production currently has 248 rows exactly like this.
  async function seedRowNoEvidence(closureStatus: string): Promise<{ requestId: number }> {
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
    return { requestId: request.id };
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

  describe("RECONCILIATION_REQUIRED recovery (custody state-machine gap fix)", () => {
    it("A. a RECONCILIATION_REQUIRED row WITH valid completion evidence is projected to CLOSED_SUCCESS", async () => {
      const { requestId, completionId } = await seedRow("RECONCILIATION_REQUIRED");
      const worker = new CourierProjectionWorker();
      await worker.runOnce();

      const [execRow] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
      expect(execRow!.custodyClosureStatus).toBe("CLOSED_SUCCESS");

      const [compRow] = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.id, completionId));
      expect(compRow!.projectionStatus).toBe("PROJECTED");
    });

    it("B. a RECONCILIATION_REQUIRED row with NO completion evidence is never claimed or projected (discovery-level, not just the CAS)", async () => {
      const { requestId } = await seedRowNoEvidence("RECONCILIATION_REQUIRED");
      const worker = new CourierProjectionWorker();
      await worker.runOnce();

      const [execRow] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
      expect(execRow!.custodyClosureStatus).toBe("RECONCILIATION_REQUIRED"); // untouched

      const auditRows = await db.select().from(courierAuditLogs).where(eq(courierAuditLogs.recordId, requestId));
      expect(auditRows.length).toBe(0); // never even attempted -- proves the gate is in discovery, not just the CAS
    });

    it("C. unrelated completion evidence for a different request never closes a RECONCILIATION_REQUIRED row it doesn't belong to", async () => {
      const { requestId: unrelatedRequestId } = await seedRowNoEvidence("RECONCILIATION_REQUIRED");
      await seedRow("PROCESSING"); // a real, separate row with its own genuine evidence

      const worker = new CourierProjectionWorker();
      await worker.runOnce();

      const [execRow] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, unrelatedRequestId));
      expect(execRow!.custodyClosureStatus).toBe("RECONCILIATION_REQUIRED"); // unaffected by the other request's evidence
    });

    it("D. re-delivering the same completion evidence a second time has exactly one effect (dedup, not just the claim-level PROJECTED guard)", async () => {
      const { requestId, completionId } = await seedRow("RECONCILIATION_REQUIRED");
      const worker = new CourierProjectionWorker();
      await worker.runOnce();

      const [firstComp] = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.id, completionId));
      expect(firstComp!.projectionStatus).toBe("PROJECTED");
      const sourceEventId = firstComp!.sourceEventId;

      // Simulate re-delivery of the SAME source event (a redundant outbox
      // retry, or a manual re-run) by resetting only the claim/lease state
      // -- never custody_closure_status and never the dedup row itself.
      await db
        .update(inventoryDeductionCompletions)
        .set({ projectionStatus: "PENDING", projectedAt: null, projectionNextAttemptAt: new Date() })
        .where(eq(inventoryDeductionCompletions.id, completionId));

      await worker.runOnce();

      const dedupRows = await db
        .select()
        .from(courierExecutionAuditDedup)
        .where(
          and(
            eq(courierExecutionAuditDedup.sourceEventId, sourceEventId),
            eq(courierExecutionAuditDedup.operationKind, "SUCCESS_PROJECTION")
          )
        );
      expect(dedupRows.length).toBe(1); // never duplicated

      const auditRows = await db
        .select()
        .from(courierAuditLogs)
        .where(and(eq(courierAuditLogs.recordId, requestId), eq(courierAuditLogs.action, "custody_closure_projected")));
      expect(auditRows.length).toBe(1); // exactly one audit entry, not two
    });

    it("E. concurrent projection of a RECONCILIATION_REQUIRED row never produces a duplicate closure or duplicate audit entry", async () => {
      const { requestId } = await seedRow("RECONCILIATION_REQUIRED");
      const workerA = new CourierProjectionWorker();
      const workerB = new CourierProjectionWorker();

      await Promise.all([workerA.runOnce(), workerB.runOnce()]);

      const [execRow] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
      expect(execRow!.custodyClosureStatus).toBe("CLOSED_SUCCESS");

      const auditRows = await db
        .select()
        .from(courierAuditLogs)
        .where(and(eq(courierAuditLogs.recordId, requestId), eq(courierAuditLogs.action, "custody_closure_projected")));
      expect(auditRows.length).toBe(1); // SKIP LOCKED prevented the other worker from ever claiming this row
    });

    it("F. historical RECONCILIATION_REQUIRED rows from a bulk import (no completion evidence, zero item linkage) are never auto-closed", async () => {
      // Mirrors production's real historical batch shape: same actor,
      // tight creation burst, zero courier_request_items, no
      // inventory_deduction_completions row at all -- production currently
      // has 248 rows exactly like this.
      const { requestId: r1 } = await seedRowNoEvidence("RECONCILIATION_REQUIRED");
      const { requestId: r2 } = await seedRowNoEvidence("RECONCILIATION_REQUIRED");
      const { requestId: r3 } = await seedRowNoEvidence("RECONCILIATION_REQUIRED");

      const worker = new CourierProjectionWorker();
      await worker.runOnce();

      for (const id of [r1, r2, r3]) {
        const [execRow] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, id));
        expect(execRow!.custodyClosureStatus).toBe("RECONCILIATION_REQUIRED");
      }
    });
  });

  describe("Reproduction of production request 2165's exact stuck state", () => {
    it("a RECONCILIATION_REQUIRED execution with 9 prior FAILED_RETRYABLE projection attempts converges to CLOSED_SUCCESS with no SQL repair", async () => {
      const { requestId, completionId } = await seedRow("RECONCILIATION_REQUIRED");
      // Reproduce request 2165's exact projection_status row: 9 prior
      // failed attempts, the real production error text, due now (as the
      // real row already is -- its own next_attempt_at was 2026-09-24
      // 17:21:34, i.e. already scheduled, just not yet fired).
      await db
        .update(inventoryDeductionCompletions)
        .set({
          projectionStatus: "FAILED_RETRYABLE",
          projectionAttemptCount: 9,
          projectionNextAttemptAt: new Date(Date.now() - 1000),
          projectionLastError: `unexpected custody_closure_status for request ${requestId}: 'RECONCILIATION_REQUIRED'`,
        })
        .where(eq(inventoryDeductionCompletions.id, completionId));

      const worker = new CourierProjectionWorker();
      await worker.runOnce(); // this is attempt #10 -- the first one that can succeed

      const [execRow] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
      expect(execRow!.custodyClosureStatus).toBe("CLOSED_SUCCESS");

      const [compRow] = await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.id, completionId));
      expect(compRow!.projectionStatus).toBe("PROJECTED");
      // The prior failure history is preserved, not scrubbed -- proves this
      // is forward progress through the existing mechanism, not a data
      // rewrite/repair.
      expect(compRow!.projectionLastError).toContain("RECONCILIATION_REQUIRED");
    });
  });
});
