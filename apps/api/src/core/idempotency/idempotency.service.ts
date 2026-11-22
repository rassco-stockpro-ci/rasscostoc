import { db } from "../config/db";
import { idempotencyRecords } from "@shared/schema";
import { eq } from "drizzle-orm";
import { metrics } from "../telemetry/metrics";
import { IdempotencyCollisionError } from "../errors/AppError";

export class IdempotencyService {
  /**
   * Executes a callback within an idempotency check block.
   * If the record is PROCESSING: throws an error (to trigger a retry later).
   * If the record is COMPLETED: returns the cached response payload (no-op).
   * If the record is FAILED or doesn't exist: executes the callback and updates status.
   *
   * @param idempotencyKey The unique key for this execution.
   * @param eventId The domain event ID.
   * @param subscriberName The subscriber's name.
   * @param action The callback representing the business logic/transaction.
   */
  async execute<T = any>(
    idempotencyKey: string,
    eventId: string,
    subscriberName: string,
    action: () => Promise<T>
  ): Promise<T | null> {
    let record: any = null;
    let alreadyExists = false;

    // 1. Check and lock status using a small transaction
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey))
        .limit(1);

      if (existing) {
        alreadyExists = true;
        record = existing;
        if (existing.status === "COMPLETED") {
          return;
        }
        if (existing.status === "PROCESSING") {
          throw new IdempotencyCollisionError(`Idempotency key ${idempotencyKey} is currently PROCESSING.`);
        }
        // If status is FAILED, retry: reset status back to PROCESSING
        await tx
          .update(idempotencyRecords)
          .set({ status: "PROCESSING", createdAt: new Date() })
          .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
      } else {
        // Create new record with status PROCESSING
        await tx.insert(idempotencyRecords).values({
          idempotencyKey,
          eventId,
          subscriberName,
          status: "PROCESSING",
        });
      }
    });

    // 2. If it was already completed, return cached response
    if (alreadyExists && record && record.status === "COMPLETED") {
      console.log(`[IdempotencyService] Duplicate execution detected and skipped for key: ${idempotencyKey}`);
      metrics.incrementCounter("idempotency_hits_total");
      return record.responsePayload as T;
    }

    metrics.incrementCounter("idempotency_misses_total");

    // 3. Execute the actual action/callback
    try {
      const result = await action();

      // 4. Mark as COMPLETED on success
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
      // 5. Mark as FAILED on error
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
