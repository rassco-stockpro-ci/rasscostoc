import { db } from "../config/db";
import { idempotencyRecords } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { metrics } from "../telemetry/metrics";

/**
 * PROCESSING is intentionally never reclaimed by age in this generic service.
 * A timeout alone cannot distinguish a dead worker from a slow live worker and
 * could run non-idempotent subscriber side effects twice. Business-specific
 * durable evidence must own crash recovery.
 */

export class IdempotencyInProgressError extends Error {
  readonly code = "IDEMPOTENCY_IN_PROGRESS";

  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} is currently PROCESSING.`);
    this.name = "IdempotencyInProgressError";
  }
}

export class IdempotencyService {
  /**
   * Atomically claims an idempotency key before executing the business action.
   *
   * Contract:
   * - COMPLETED: return cached response; never execute the action.
   * - PROCESSING: reject concurrent duplicate execution.
   * - FAILED: reset to PROCESSING and execute.
   * - missing: create PROCESSING atomically and execute.
   *
   * PROCESSING crash recovery is deliberately not generic; a business owner
   * must first prove its durable side effect and then call completeIfProcessing().
   */
  /**
   * Evidence-driven recovery primitive. A caller may mark PROCESSING as
   * COMPLETED only after it independently proves that the business effect
   * committed durably. The row lock and causal event-id check prevent a
   * different attempt from being overwritten.
   */
  async completeIfProcessing(
    idempotencyKey: string,
    eventId: string,
    responsePayload: unknown
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey))
        .limit(1)
        .for("update");

      if (!row) return false;
      if (row.status === "COMPLETED") return true;
      if (row.status !== "PROCESSING" || row.eventId !== eventId) return false;

      const updated = await tx
        .update(idempotencyRecords)
        .set({
          status: "COMPLETED",
          responsePayload: responsePayload ?? null,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(idempotencyRecords.idempotencyKey, idempotencyKey),
            eq(idempotencyRecords.eventId, eventId),
            eq(idempotencyRecords.status, "PROCESSING")
          )
        )
        .returning({ id: idempotencyRecords.id });

      return updated.length === 1;
    });
  }

  async execute<T = any>(
    idempotencyKey: string,
    eventId: string,
    subscriberName: string,
    action: () => Promise<T>
  ): Promise<T | null> {
    let completedRecord: any = null;
    let claimed = false;

    await db.transaction(async (tx) => {
      // ON CONFLICT avoids turning concurrent first-seen deliveries into a
      // poisoned transaction while the uniqueness constraint remains authoritative.
      const [inserted] = await tx
        .insert(idempotencyRecords)
        .values({
          idempotencyKey,
          eventId,
          subscriberName,
          status: "PROCESSING",
        })
        .onConflictDoNothing({
          target: idempotencyRecords.idempotencyKey,
        })
        .returning();

      if (inserted) {
        claimed = true;
        return;
      }

      // Serialize all existing-key decisions. This closes the concurrent
      // FAILED/stale-PROCESSING read→update race.
      const [existing] = await tx
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey))
        .limit(1)
        .for("update");

      if (!existing) {
        throw new Error(
          `Idempotency claim failed: key "${idempotencyKey}" disappeared after conflict resolution.`
        );
      }

      if (existing.status === "COMPLETED") {
        completedRecord = existing;
        return;
      }

      if (existing.status === "PROCESSING") {
        throw new IdempotencyInProgressError(idempotencyKey);
      }

      // FAILED: reset the key for a new delivery attempt.
      await tx
        .update(idempotencyRecords)
        .set({
          eventId,
          subscriberName,
          status: "PROCESSING",
          responsePayload: null,
          createdAt: new Date(),
          completedAt: null,
        })
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));

      claimed = true;
    });

    if (completedRecord) {
      console.log(
        `[IdempotencyService] Duplicate execution detected and skipped for key: ${idempotencyKey}`
      );
      metrics.incrementCounter("idempotency_hits_total");
      return completedRecord.responsePayload as T;
    }

    if (!claimed) {
      throw new Error(`Idempotency claim failed for key "${idempotencyKey}".`);
    }

    metrics.incrementCounter("idempotency_misses_total");

    try {
      const result = await action();

      // Fenced terminal write: only the event that currently owns
      // PROCESSING may publish COMPLETED. A stale attempt whose lease was
      // reclaimed cannot overwrite the newer owner.
      await db
        .update(idempotencyRecords)
        .set({
          status: "COMPLETED",
          responsePayload: result !== undefined ? result : null,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(idempotencyRecords.idempotencyKey, idempotencyKey),
            eq(idempotencyRecords.eventId, eventId),
            eq(idempotencyRecords.status, "PROCESSING")
          )
        );

      return result;
    } catch (err: any) {
      const errorMsg = err.message || String(err);

      // Same fencing rule for failure: a superseded/stale attempt
      // must not move a newer owner's PROCESSING record back to FAILED.
      await db
        .update(idempotencyRecords)
        .set({
          status: "FAILED",
          responsePayload: { error: errorMsg },
          completedAt: new Date(),
        })
        .where(
          and(
            eq(idempotencyRecords.idempotencyKey, idempotencyKey),
            eq(idempotencyRecords.eventId, eventId),
            eq(idempotencyRecords.status, "PROCESSING")
          )
        );

      throw err;
    }
  }
}

export const idempotencyService = new IdempotencyService();