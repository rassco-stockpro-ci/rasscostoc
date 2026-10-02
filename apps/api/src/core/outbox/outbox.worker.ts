import { outboxRepository } from "./outbox.repository";
import { EventBus } from "../events/event-bus";
import { randomUUID } from "crypto";
import { db } from "../config/db";

export class OutboxWorker {
  private readonly workerId: string;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private inFlightRun: Promise<void> | null = null;

  constructor(options?: { intervalMs?: number; batchSize?: number }) {
    this.workerId = `worker-${randomUUID()}`;
    this.intervalMs = options?.intervalMs || 5000; // default 5 seconds
    this.batchSize = options?.batchSize || 20;
  }

  /**
   * Starts the polling loop for outbox events.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.info(`[OutboxWorker] Started Outbox Worker instance: ${this.workerId}`);
    
    // Run immediately on startup, then trigger interval
    this.inFlightRun = this.runOnce().catch(err => console.error("[OutboxWorker] Error during initial run:", err));

    this.intervalId = setInterval(() => {
      this.inFlightRun = this.runOnce().catch(err => {
        console.error("[OutboxWorker] Error during loop run:", err);
      });
    }, this.intervalMs);
  }

  /**
   * ERP-008 Phase 3: stops the polling loop immediately, then awaits
   * whichever runOnce() batch is currently in flight so a shutdown never
   * cuts off an event mid-publish.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.inFlightRun) {
      await this.inFlightRun;
    }
    console.info(`[OutboxWorker] Stopped Outbox Worker instance: ${this.workerId}`);
  }

  /**
   * Queries pending events, processes them via the event bus,
   * and updates their status (PUBLISHED, FAILED, or DEAD).
   */
  async runOnce(): Promise<void> {
    const pendingEvents = await outboxRepository.getPendingEvents(this.batchSize, this.workerId);
    if (pendingEvents.length === 0) {
      return;
    }

    console.log(`[OutboxWorker] Instance ${this.workerId} processing ${pendingEvents.length} outbox event(s).`);

    const eventBus = EventBus.getInstance();

    for (const record of pendingEvents) {
      // A lease recovered too many times (its worker kept dying mid-event):
      // dead-letter it instead of dispatching it again.
      if (record.retryCount >= MAX_ATTEMPTS) {
        await this.deadLetter(record, `processing lease expired ${record.retryCount} time(s) without completion (worker crashed or stalled)`);
        continue;
      }
      try {
        // Reconstruct event payload conforming to IEvent
        const eventInstance = {
          id: record.id,
          name: record.eventName,
          version: record.eventVersion,
          occurredAt: record.createdAt,
          timestamp: record.createdAt,
          correlationId: record.correlationId,
          causationId: record.causationId,
          payload: record.payload,
        };

        // Dispatch locally to EventBus subscribers
        await eventBus.publishLocal(eventInstance);

        // Success - mark as PUBLISHED, only while this worker still holds the lease
        if (await outboxRepository.markAsPublished(record.id, this.workerId)) {
          console.log(`[OutboxWorker] Event ${record.id} (${record.eventName}) published successfully.`);
        } else {
          console.warn(`[OutboxWorker] Event ${record.id} processed after this worker's lease expired; another worker owns it now.`);
        }
      } catch (err: any) {
        const errorMsg = err.message || String(err);
        const nextRetryCount = record.retryCount + 1;
        
        console.error(`[OutboxWorker] Event ${record.id} (${record.eventName}) failed (Attempt ${nextRetryCount}):`, errorMsg);

        if (nextRetryCount >= MAX_ATTEMPTS) {
          await this.deadLetter(record, errorMsg);
        } else {
          // Calculate interval backoff:
          // Attempt 1 -> retry after 5 sec
          // Attempt 2 -> retry after 30 sec
          // Attempt 3 -> retry after 120 sec (which will trigger DEAD status)
          let delayMs = 5000;
          if (nextRetryCount === 1) {
            delayMs = 30000;
          } else if (nextRetryCount === 2) {
            delayMs = 120000;
          }
          const nextRetryAt = new Date(Date.now() + delayMs);
          if (!(await outboxRepository.markAsFailed(record.id, errorMsg, nextRetryAt, record.retryCount, this.workerId))) {
            console.warn(`[OutboxWorker] Event ${record.id} failed after this worker's lease expired; left to its current owner.`);
          }
        }
      }
    }
  }

  /**
   * OPS-REMED-E4-P2: mark DEAD and enqueue the durable final-failure
   * notification in ONE transaction — previously these were two separate,
   * non-atomic commits (markAsDead, then a best-effort eventBus.publish
   * wrapped in a swallowing try/catch), so a crash between them could
   * permanently strand the row as DEAD while never durably creating the
   * signal courier-saga.subscriber.ts needs to reach FAILED_FINAL. Both
   * writes share one transaction: either both commit or neither does, and
   * the notification itself is enqueued via outboxRepository (durable,
   * retried by this same worker), not published in-memory.
   *
   * Fenced: only while this worker holds the lease. A superseded worker
   * rolls the transaction back and leaves the event to its current owner.
   */
  private async deadLetter(record: any, errorMsg: string): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        if (!(await outboxRepository.markAsDead(record.id, errorMsg, tx, this.workerId))) {
          throw new LeaseLostError(record.id);
        }
        if (record.eventName === "ExecutionCompletedEvent") {
          const payload = record.payload as any;
          const { InventoryDeductionFailedEvent } = await import("../events/events");
          const finalFailureEvent = new InventoryDeductionFailedEvent({
            requestId: payload.requestId,
            actorId: payload.actorId,
            technicianCode: payload.execution?.technicianCode || payload.execution?.salesTechnician || payload.request?.tecName || "unknown",
            errors: [`Failed to process event after ${MAX_ATTEMPTS} attempts: ${errorMsg}`],
            final: true,
            // The original ExecutionCompletedEvent's own outbox row id
            // (== its domain event id, set at enqueue() time) — the
            // one stable causal identifier threaded through the
            // evidence check and the audit-dedup key.
            sourceEventId: record.id,
          });
          await outboxRepository.enqueue(finalFailureEvent, tx);
        }
      });
      console.error(`[OutboxWorker] Event ${record.id} marked as DEAD (${errorMsg}).`);
    } catch (deadErr) {
      if (deadErr instanceof LeaseLostError) {
        console.warn(`[OutboxWorker] ${deadErr.message}`);
        return;
      }
      // The whole transaction rolled back — the row is NOT DEAD (still
      // whatever it was before), so it is picked up again on a later poll.
      // Do not double-report it as DEAD when the commit itself failed.
      console.error(`[OutboxWorker] Failed to atomically mark event ${record.id} DEAD and enqueue its final-failure notification:`, deadErr);
    }
  }
}

/** Attempts per event, a recovered (expired) processing lease included. */
export const MAX_ATTEMPTS = 3;

class LeaseLostError extends Error {
  constructor(eventId: string) {
    super(`Event ${eventId}: lease lost to another worker before it could be dead-lettered; left to its current owner.`);
  }
}

export const outboxWorker = new OutboxWorker();
