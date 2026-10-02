/**
 * CourierProjectionWorker
 *
 * OPS-REMED-E4-P2 — database-driven, uncapped convergence mechanism
 * (A.9 §2-§8, A.10 constants). Polls inventory_deduction_completions
 * directly for unprojected evidence rows and drives the corresponding
 * courier_executions row to CLOSED_SUCCESS. Unlike the outbox's own
 * retry/DEAD machinery, this worker has NO terminal failure state — a
 * failed projection attempt is always retried later (bounded backoff,
 * unbounded duration), so a committed success can never be permanently
 * lost even if every event-based signal is also lost.
 *
 * Same lifecycle pattern as OutboxWorker/JobsWorker (self-guarded start(),
 * awaited stop()) — see server.ts for the production wiring.
 */
import { randomUUID } from "crypto";
import { sql, eq, and } from "drizzle-orm";
import { db } from "@core/config/db";
import { inventoryDeductionCompletions, courierExecutionAuditDedup, courierAuditLogs, courierExecutions } from "@shared/schema";
import { drizzleCourierRepository } from "../repositories/drizzle-courier.repository";

// OPS-REMED-E4-A.10 §4 — frozen retry/lifecycle constants.
const POLL_INTERVAL_MS = 10_000;
const PROJECTION_LEASE_MS = 60_000;
const PROJECTION_CLAIM_BATCH = 20;
const PROJECTION_INITIAL_BACKOFF_MS = 5_000;
const PROJECTION_MAX_BACKOFF_MS = 1_800_000; // 30 minutes
const PROJECTION_ERROR_TEXT_MAX = 500;

export function computeBackoff(attemptCount: number): number {
  const base = Math.min(
    PROJECTION_INITIAL_BACKOFF_MS * Math.pow(2, attemptCount),
    PROJECTION_MAX_BACKOFF_MS
  );
  // +/-10% jitter to avoid synchronized thundering-herd reclaim across replicas.
  const jitter = base * (0.9 + Math.random() * 0.2);
  return Math.min(Math.round(jitter), PROJECTION_MAX_BACKOFF_MS);
}

class ProjectionInvariantViolationError extends Error {
  readonly code: string;
  constructor(code: string, requestId: number, message: string) {
    super(message);
    this.name = "ProjectionInvariantViolationError";
    this.code = code;
    void requestId;
  }
}

/**
 * OPS-REMED-E4-A.10 §3 — Option A: a dedup row for SUCCESS_PROJECTION
 * existing without the target state actually being CLOSED_SUCCESS is a
 * structurally-unreachable invariant violation under normal execution
 * (the dedup insert and the CAS write share one transaction below) — not
 * silently "self-healed," durably flagged instead.
 */
async function projectDeductionCompletion(
  requestId: number,
  sourceEventId: string
): Promise<{ success: true }> {
  return db.transaction(async (tx) => {
    const [dedupExists] = await tx
      .select()
      .from(courierExecutionAuditDedup)
      .where(
        and(
          eq(courierExecutionAuditDedup.sourceEventId, sourceEventId),
          eq(courierExecutionAuditDedup.operationKind, "SUCCESS_PROJECTION")
        )
      )
      .limit(1);

    const [current] = await tx
      .select()
      .from(courierExecutions)
      .where(eq(courierExecutions.requestId, requestId))
      .limit(1);

    if (dedupExists) {
      if (current?.custodyClosureStatus === "CLOSED_SUCCESS") {
        return { success: true };
      }
      throw new ProjectionInvariantViolationError(
        "PROJ_DEDUP_STATE_MISMATCH",
        requestId,
        `dedup row exists for SUCCESS_PROJECTION (request ${requestId}) but custody_closure_status='${current?.custodyClosureStatus}', expected CLOSED_SUCCESS`
      );
    }

    // RECONCILIATION_REQUIRED is included here deliberately: this function
    // is only ever reached for a row that runOnce() claimed from
    // inventory_deduction_completions, i.e. one with real, durable,
    // transactionally-atomic completion evidence already recorded
    // (inventory.engine.ts writes that row as the LAST statement of the
    // deduction transaction — it cannot exist for a partial/failed
    // deduction). RECONCILIATION_REQUIRED rows written with NO such
    // evidence (e.g. the historical bulk-import path in
    // courier.service.ts's importRawRequests) are never claimed by
    // runOnce() in the first place, so they can never reach this CAS
    // regardless of what is in this array — the evidence gate lives in
    // the discovery query, not here. This closes the one real gap: a
    // request whose deduction genuinely succeeded (e.g. via a retry) after
    // its execution had already been marked RECONCILIATION_REQUIRED could
    // previously never converge to CLOSED_SUCCESS.
    const updated = await drizzleCourierRepository.updateCustodyClosureStatus(
      requestId,
      ["PROCESSING", "FAILED_RETRYABLE", "FAILED_FINAL", "RECONCILIATION_REQUIRED"],
      "CLOSED_SUCCESS",
      tx
    );

    if (!updated && current?.custodyClosureStatus !== "CLOSED_SUCCESS") {
      throw new ProjectionInvariantViolationError(
        "PROJ_DEDUP_STATE_MISMATCH",
        requestId,
        `unexpected custody_closure_status for request ${requestId}: '${current?.custodyClosureStatus}'`
      );
    }

    try {
      await tx.insert(courierExecutionAuditDedup).values({
        sourceEventId,
        operationKind: "SUCCESS_PROJECTION",
        eventName: "CourierProjectionWorker",
      });
    } catch (err: any) {
      if (err?.code !== "23505") throw err;
      // Concurrent redelivery already inserted it — fine, our own CAS
      // above already made this call's effect idempotent either way.
    }

    if (updated) {
      await tx.insert(courierAuditLogs).values({
        tableName: "executions",
        recordId: requestId,
        fieldName: "custody_closure_status",
        oldValue: "PROCESSING",
        newValue: "CLOSED_SUCCESS",
        action: "custody_closure_projected",
        changedBy: null,
      });
    }

    return { success: true };
  });
}

export class CourierProjectionWorker {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private inFlightRun: Promise<void> | null = null;
  private readonly workerId = `projection-worker-${randomUUID()}`;

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.info(`[CourierProjectionWorker] Started instance: ${this.workerId}`);

    this.inFlightRun = this.runOnce().catch((err) =>
      console.error("[CourierProjectionWorker] Error during initial run:", err)
    );

    this.intervalId = setInterval(() => {
      this.inFlightRun = this.runOnce().catch((err) => {
        console.error("[CourierProjectionWorker] Error during loop run:", err);
      });
    }, POLL_INTERVAL_MS);
  }

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
    console.info(`[CourierProjectionWorker] Stopped instance: ${this.workerId}`);
  }

  async runOnce(): Promise<void> {
    // OPS-REMED-E4-A.9 §2 (Pattern A): claim due PENDING/FAILED_RETRYABLE
    // work AND expired CLAIMED work in one query. Fresh fencing token
    // issued on every claim (A.9 §3).
    const leaseSeconds = Math.round(PROJECTION_LEASE_MS / 1000);
    const claimResult = await db.execute(sql`
      UPDATE inventory_deduction_completions
      SET projection_status = 'CLAIMED',
          projection_lease_owner = ${this.workerId},
          projection_lease_token = gen_random_uuid()::text,
          projection_lease_expires_at = now() + (${leaseSeconds}::int * interval '1 second')
      WHERE id IN (
        SELECT id FROM inventory_deduction_completions
        WHERE (
            (projection_status IN ('PENDING','FAILED_RETRYABLE') AND projection_next_attempt_at <= now())
            OR (projection_status = 'CLAIMED' AND projection_lease_expires_at < now())
          )
        ORDER BY completed_at
        LIMIT ${PROJECTION_CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, request_id, source_event_id, projection_lease_token, projection_attempt_count
    `);
    const claimed: any[] = (claimResult as any).rows ?? [];

    if (!claimed || claimed.length === 0) return;

    for (const row of claimed) {
      const requestId = row.request_id;
      const sourceEventId = row.source_event_id;
      const token = row.projection_lease_token;
      try {
        await projectDeductionCompletion(requestId, sourceEventId);
        // Fencing-gated acknowledgment: only marks PROJECTED if we still
        // own this exact lease/token — a stale worker whose lease moved
        // to someone else affects zero rows here (safe stop, not an error).
        await db.execute(sql`
          UPDATE inventory_deduction_completions
          SET projection_status = 'PROJECTED', projected_at = now(),
              projection_lease_owner = NULL, projection_lease_token = NULL, projection_lease_expires_at = NULL
          WHERE id = ${row.id} AND projection_lease_owner = ${this.workerId}
            AND projection_lease_token = ${token} AND projection_status = 'CLAIMED'
        `);
      } catch (err: any) {
        const errorMsg = String(err?.message ?? err).slice(0, PROJECTION_ERROR_TEXT_MAX);
        const nextAttempt = (row.projection_attempt_count ?? 0) + 1;
        const delaySeconds = Math.round(computeBackoff(nextAttempt) / 1000);
        await db.execute(sql`
          UPDATE inventory_deduction_completions
          SET projection_status = 'FAILED_RETRYABLE',
              projection_attempt_count = ${nextAttempt},
              projection_next_attempt_at = now() + (${delaySeconds}::int * interval '1 second'),
              projection_last_error = ${errorMsg},
              projection_lease_owner = NULL, projection_lease_token = NULL, projection_lease_expires_at = NULL
          WHERE id = ${row.id} AND projection_lease_owner = ${this.workerId} AND projection_lease_token = ${token}
        `);
      }
    }
  }
}

export const courierProjectionWorker = new CourierProjectionWorker();
