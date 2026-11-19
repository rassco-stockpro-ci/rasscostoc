/**
 * InventoryReconciliationWorker (ERP-INV-001)
 *
 * Runs every 15 minutes and re-enqueues an ExecutionCompletedEvent for any
 * courier execution that has been stuck in deductionStatus='PENDING' for more
 * than 15 minutes.  This catches cases where the outbox dispatched the event
 * but the subscriber crashed, was restarted, or silently failed before the fix.
 *
 * Safe to run repeatedly:
 * - The subscriber's idempotency key (name:REQ-N:InventorySubscriber:v1) prevents
 *   double-deduction if a COMPLETED record already exists.
 * - After re-enqueueing the row is set to REQUEUED so this worker ignores it next
 *   cycle; the subscriber updates it to COMPLETED/FAILED/SKIPPED when it runs.
 */

import { db } from "@core/config/db";
import { courierExecutions, courierRequests } from "@shared/schema";
import { and, eq, lt } from "drizzle-orm";
import { outboxRepository } from "@core/outbox/outbox.repository";
import { ExecutionCompletedEvent } from "@core/events/events";

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const BATCH_LIMIT = 20;

export class InventoryReconciliationWorker {
  private intervalId: NodeJS.Timeout | null = null;

  start(): void {
    if (this.intervalId) return;
    console.info("[InventoryReconciliationWorker] Started (interval: 15 min).");
    // Initial run after 2 minutes (let the outbox worker clear recent events first)
    setTimeout(() => this.runOnce().catch(console.error), 2 * 60 * 1000);
    this.intervalId = setInterval(
      () => this.runOnce().catch(console.error),
      15 * 60 * 1000
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.info("[InventoryReconciliationWorker] Stopped.");
    }
  }

  async runOnce(): Promise<void> {
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

    const rows = await db
      .select({
        execution: courierExecutions,
        request: courierRequests,
      })
      .from(courierExecutions)
      .innerJoin(courierRequests, eq(courierExecutions.requestId, courierRequests.id))
      .where(
        and(
          eq(courierExecutions.deductionStatus, "PENDING"),
          lt(courierExecutions.updatedAt, staleThreshold)
        )
      )
      .limit(BATCH_LIMIT);

    if (rows.length === 0) return;

    console.warn(
      `[InventoryReconciliationWorker] Found ${rows.length} stale PENDING deduction(s). Re-enqueueing.`
    );

    for (const { execution, request } of rows) {
      try {
        const event = new ExecutionCompletedEvent({
          requestId: execution.requestId,
          actorId: execution.enteredBy ?? "system-reconciliation",
          execution,
          request,
        });

        await outboxRepository.enqueue(event);

        // Mark as REQUEUED so we don't re-enqueue it again next cycle
        await db
          .update(courierExecutions)
          .set({ deductionStatus: "REQUEUED" })
          .where(eq(courierExecutions.id, execution.id));

        console.info(
          `[InventoryReconciliationWorker] Re-enqueued ExecutionCompletedEvent for REQ-${execution.requestId}.`
        );
      } catch (err) {
        console.error(
          `[InventoryReconciliationWorker] Failed to re-enqueue REQ-${execution.requestId}:`,
          err
        );
      }
    }
  }
}

export const inventoryReconciliationWorker = new InventoryReconciliationWorker();
