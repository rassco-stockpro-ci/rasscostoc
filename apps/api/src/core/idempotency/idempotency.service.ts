import { db } from "../config/db";
import { idempotencyRecords } from "@shared/schema";
import { eq } from "drizzle-orm";
import { metrics } from "../telemetry/metrics";

/**
 * A PROCESSING row represents a lease owned by the current execution attempt.
 * If the process dies after the business transaction commits but before the
 * idempotency row becomes COMPLETED, a bounded stale lease must be reclaimable
 * so the logical operation cannot remain blocked forever.
 *
 * The custody/inventory subscriber action is expected to finish well below this
 * window; the conservative threshold minimizes accidental takeover of a genuinely
 * long-running attempt while still providing crash recovery.
 */
const PROCESSING_STALE_AFTER_MS = 30 * 60 * 1000;

export class IdempotencyService {
  /**
   * Atomically claims an idempotency key before executing the business action.
   *
   * Contract:
   * - COMPLETED: return cached response; never execute the action.
   * - PROCESSING and fresh: reject concurrent duplicate execution.
   * - PROCESSING and stale: reclaim exactly once under row lock and execute.
   * - FAILED: reset to PROCESSING and execute.
   * - missing: create PROCESSING atomically and execute.
   */
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
        const startedAtMs =
          existing.createdAt instanceof Date
            ? existing.createdAt.getTime()
            : new Date(existing.createdAt).getTime();
        const stale =
          Number.isFinite(startedAtMs) &&
          Date.now() - startedAtMs >= PROCESSING_STALE_AFTER_MS;

        if (!stale) {
          throw new Error(`Idempotency key ${idempotencyKey} is currently PROCESSING.`);
        }
      }

      // FAILED or stale PROCESSING: reclaim the key. Clear stale result data
      // so the eventual COMPLETED response belongs only to this attempt.
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

      await db
        .update(idempotencyRecords)
        .set({
          status: "COMPLETED",
          responsePayload: result !== undefined ? result : null,
          completedAt: new Date(),
        })
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));

      return result;
    } catch (err: any) {
      const errorMsg = err.message || String(err);

      await db
        .update(idempotencyRecords)
        .set({
          status: "FAILED",
          responsePayload: { error: errorMsg },
          completedAt: new Date(),
        })
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));

      throw err;
    }
  }
}

export const idempotencyService = new IdempotencyService();