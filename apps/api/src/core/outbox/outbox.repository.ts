import { db } from "@core/config/db";
import { outboxEvents } from "@shared/schema";
import { eq, and, or, lte, inArray, isNull, sql } from "drizzle-orm";
import type { IEvent } from "../events/event.types";
import { metrics } from "../telemetry/metrics";

/**
 * Processing lease. A claimed event is PROCESSING and owned by one worker
 * (locked_by) until it is finalized. If that worker dies, the lease expires
 * after OUTBOX_LEASE_MS and the event becomes claimable again. Every recovery
 * of an expired PROCESSING lease counts as one attempt (retry_count + 1), so
 * an event that keeps crashing its worker still reaches DEAD instead of
 * looping forever.
 */
export const OUTBOX_LEASE_MS = 5 * 60 * 1000;

export class OutboxRepository {
  /**
   * Enqueues a domain event into the outbox table.
   * Can accept a transaction object (tx) to ensure atomicity with business operations.
   */
  async enqueue(event: IEvent, tx?: any): Promise<void> {
    const client = tx || db;
    await client.insert(outboxEvents).values({
      id: event.id,
      eventName: event.name,
      eventVersion: event.version,
      payload: event.payload,
      correlationId: event.correlationId,
      causationId: event.causationId,
      status: "PENDING",
      retryCount: 0,
      createdAt: event.occurredAt || new Date(),
    });
  }

  /**
   * Helper to query current outbox statistics for metrics/dashboard.
   */
  async getStats() {
    try {
      const [pendingCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(outboxEvents)
        .where(eq(outboxEvents.status, "PENDING"));
      const [deadCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(outboxEvents)
        .where(eq(outboxEvents.status, "DEAD"));
      return {
        pending: Number(pendingCount?.count || 0),
        dead: Number(deadCount?.count || 0),
      };
    } catch {
      return { pending: 0, dead: 0 };
    }
  }

  async updateStatsGauges(): Promise<void> {
    const stats = await this.getStats();
    metrics.setGauge("outbox_pending_total", stats.pending);
    metrics.setGauge("outbox_dead_total", stats.dead);
  }

  /**
   * Retrieves pending or failed events that are eligible for processing,
   * and locks them for the current worker instance to prevent concurrent execution.
   */
  /**
   * ERP-008 Phase 4: SELECT + UPDATE used to be two separate statements
   * with no row locking, so two OutboxWorker instances (e.g. under PM2
   * cluster) could both see the same event as eligible before either had
   * claimed it, and both would publish it — proven via a forced-interleaving
   * repro. Now runs inside one transaction with SELECT ... FOR UPDATE SKIP
   * LOCKED (same pattern JobsRepository.claimNextJob() already used
   * correctly), so a second concurrent claimant skips rows already locked
   * by the first instead of re-selecting them.
   */
  async getPendingEvents(limit: number, lockedBy: string): Promise<any[]> {
    const now = new Date();
    const expiryThreshold = new Date(Date.now() - OUTBOX_LEASE_MS);

    const claimed = await db.transaction(async (tx) => {
      // Claimable:
      //   PENDING                         (new, or released)
      //   FAILED with nextRetryAt <= now  (retry due)
      //   PROCESSING with lockedAt <= expiryThreshold
      //                                   (lease expired: its worker died)
      // and not currently leased by a live worker.
      const eligibleEvents = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            or(
              eq(outboxEvents.status, "PENDING"),
              and(eq(outboxEvents.status, "FAILED"), lte(outboxEvents.nextRetryAt, now)),
              and(eq(outboxEvents.status, "PROCESSING"), lte(outboxEvents.lockedAt, expiryThreshold))
            ),
            or(isNull(outboxEvents.lockedBy), lte(outboxEvents.lockedAt, expiryThreshold))
          )
        )
        .limit(limit)
        .for("update", { skipLocked: true });

      if (eligibleEvents.length === 0) {
        return [];
      }

      // A recovered PROCESSING row is an attempt its previous worker never
      // finished: count it (the right-hand side reads the pre-update row).
      return tx
        .update(outboxEvents)
        .set({
          status: "PROCESSING",
          lockedBy,
          lockedAt: now,
          retryCount: sql`CASE WHEN ${outboxEvents.status} = 'PROCESSING' THEN ${outboxEvents.retryCount} + 1 ELSE ${outboxEvents.retryCount} END`,
        })
        .where(inArray(outboxEvents.id, eligibleEvents.map((e) => e.id)))
        .returning();
    });

    // Update stats gauges (read-only, safe outside the claim transaction)
    await this.updateStatsGauges();

    return claimed;
  }

  /**
   * The finalizing writes below are fenced: when `owner` is given, the row is
   * updated only while that worker still holds the lease. A worker that
   * stalled past its lease (and was superseded by another) gets `false` and
   * must not treat the event as its own any more.
   */
  private ownedBy(id: string, owner?: string) {
    return owner ? and(eq(outboxEvents.id, id), eq(outboxEvents.lockedBy, owner)) : eq(outboxEvents.id, id);
  }

  async markAsPublished(id: string, owner?: string): Promise<boolean> {
    const rows = await db
      .update(outboxEvents)
      .set({
        status: "PUBLISHED",
        processedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
      })
      .where(this.ownedBy(id, owner))
      .returning({ id: outboxEvents.id });
    await this.updateStatsGauges();
    return rows.length > 0;
  }

  async markAsFailed(id: string, error: string, nextRetryAt: Date, currentRetryCount: number, owner?: string): Promise<boolean> {
    const rows = await db
      .update(outboxEvents)
      .set({
        status: "FAILED",
        retryCount: currentRetryCount + 1,
        lastError: error,
        nextRetryAt,
        lockedBy: null,
        lockedAt: null,
      })
      .where(this.ownedBy(id, owner))
      .returning({ id: outboxEvents.id });
    await this.updateStatsGauges();
    return rows.length > 0;
  }

  /**
   * OPS-REMED-E4-P2: accepts an optional transaction so the caller
   * (OutboxWorker's DEAD block) can mark this row DEAD and enqueue the
   * durable final-failure notification in ONE atomic transaction — closing
   * a crash gap where the two used to be separate, non-atomic commits.
   */
  async markAsDead(id: string, error: string, tx?: any, owner?: string): Promise<boolean> {
    const client = tx || db;
    const rows = await client
      .update(outboxEvents)
      .set({
        status: "DEAD",
        lastError: error,
        lockedBy: null,
        lockedAt: null,
      })
      .where(this.ownedBy(id, owner))
      .returning({ id: outboxEvents.id });
    // Stats gauges are a best-effort read-only side effect — skip them
    // when running inside the caller's transaction to avoid a nested
    // query racing the still-open transaction; the top-level (non-tx)
    // caller path still updates them as before.
    if (!tx) {
      await this.updateStatsGauges();
    }
    return rows.length > 0;
  }
}

export const outboxRepository = new OutboxRepository();
