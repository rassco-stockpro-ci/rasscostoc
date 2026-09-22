/**
 * InventorySubscriber
 *
 * Listens to ExecutionCompletedEvent to perform physical inventory deductions.
 * If the deduction fails, publishes an InventoryDeductionFailedEvent.
 */

import { EventBus } from "@core/events/event-bus";
import { ExecutionCompletedEvent, InventoryDeductionFailedEvent } from "@core/events/events";
import { createInventoryEngine, updateCustodyClosureStatus } from "../../../courier/contracts";
import { idempotencyService, IdempotencyInProgressError } from "@core/idempotency/idempotency.service";
import { tracer } from "@core/telemetry/tracer";
import { db } from "@core/config/db";
import { courierRequestItems, inventoryDeductionCompletions } from "@shared/schema";
import { eq } from "drizzle-orm";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";

export class InventorySubscriber {
  /**
   * Initialize and register the subscriber to listen to ExecutionCompletedEvent.
   *
   * NOTE (OPS-REMED-E3-F.R1): EventBus.subscribe() does not deduplicate —
   * calling register() more than once against the SAME EventBus instance
   * attaches multiple handlers and causes every event to be processed more
   * than once concurrently (confirmed via a real duplicate-registration
   * race in a test). A static "already registered" guard was tried and
   * reverted: several existing tests (e.g.
   * courier.workflow.test.ts) intentionally clear the EventBus's listeners
   * between cases and re-call register() to get a fresh subscription each
   * time — a static guard broke that pattern by silently skipping the
   * re-registration after the first call, in a way that isn't visible to
   * the caller. Correct fix belongs at each CALL SITE: call register()
   * exactly once per EventBus lifetime, not per test case.
   */
  public static register(): void {
    const eventBus = EventBus.getInstance();

    eventBus.subscribe(
      "ExecutionCompletedEvent",
      async (event: any) => {
        const { requestId, actorId, execution, request } = event.payload;

        console.log(
          `[InventorySubscriber] Received ExecutionCompletedEvent for request ID: ${requestId}`
        );

        // Build serial list first so deduction can resolve technician from custody owner
        const devices: { serialNumber: string; model?: string }[] = [];
        const serialsForCustody: string[] = [];

        const addSerial = async (sn?: string | null) => {
          if (!sn?.trim()) return;
          const candidates = await SerialRecognitionService.buildStoredSerialCandidates(sn);
          // Central Serial Engine contract: candidates[0] is the canonical
          // storage representation when recognition succeeds. Never choose
          // by length; prefixed device serials (e.g. NCD/NCC) can have a
          // shorter legacy stripped representation that is not the
          // authoritative value used by custody storage.
          const serial = candidates[0] || sn.trim();
          if (!devices.some((d) => d.serialNumber === serial)) {
            devices.push({ serialNumber: serial, model: request.vendorType ?? undefined });
          }
          if (!serialsForCustody.includes(serial)) {
            serialsForCustody.push(serial);
          }
          for (const c of candidates) {
            if (!serialsForCustody.includes(c)) serialsForCustody.push(c);
          }
        };

        const looksLikeSerial = (s?: string | null) => {
          if (!s?.trim()) return false;
          const t = s.trim();
          return t.length >= 6 && !t.startsWith("{") && !t.startsWith("[");
        };

        await addSerial(execution.sn);
        if (looksLikeSerial(execution.extraField1)) await addSerial(execution.extraField1);
        if (looksLikeSerial(execution.extraField2)) await addSerial(execution.extraField2);
        if (looksLikeSerial(execution.simSerial)) await addSerial(execution.simSerial);

        const requestItemsList = await db
          .select()
          .from(courierRequestItems)
          .where(eq(courierRequestItems.requestId, requestId));

        for (const item of requestItemsList) {
          if (item.status === "RECEIVED" || item.status === "DELIVERED" || item.status === "INSTALLED") {
            if (item.itemType === "POS" && item.serialNumber) {
              await addSerial(item.serialNumber);
            } else if (item.itemType === "SIM" && item.simSerial) {
              await addSerial(item.simSerial);
            }
          }
        }

        // Prefer username stamped from custody owner; fall back to assignment only if needed
        let technicianCode =
          execution.technicianCode || execution.salesTechnician || request.tecName || "unknown";

        const idempotencyKey = `${event.name}:REQ-${requestId}:InventorySubscriber:v${event.version}`;

        // OPS-REMED-E4-P2: PENDING_DEDUCTION|FAILED_RETRYABLE -> PROCESSING.
        // Runs once per delivery attempt (including outbox retries — this
        // IS the mechanism driving FAILED_RETRYABLE back into PROCESSING,
        // A.3 §6), BEFORE the idempotency gate, so a redelivery that hits
        // the idempotency PROCESSING-guard still correctly reflects
        // "processing" in the projection even though deduct() itself is
        // not re-invoked. A losing/duplicate call affects zero rows —
        // never an error, never retried on its own.
        await updateCustodyClosureStatus(
          requestId,
          ["PENDING_DEDUCTION", "FAILED_RETRYABLE"],
          "PROCESSING"
        );

        await idempotencyService.execute(
          idempotencyKey,
          event.id,
          "InventorySubscriber",
          async () => {
            const span = tracer.startSpan("InventoryDeduction", { requestId, actorId, technicianCode });

            try {
              const engine = createInventoryEngine();
              // OPS-REMED-E3: pass through the explicit device/SIM pairs
              // preserved from the authoritative approval-time submission,
              // if present. InventoryEngine.deduct() validates them before
              // any write per the approved pairing rule.
              const pairs = Array.isArray((execution as any)?.pairs)
                ? (execution as any).pairs
                : undefined;
              const deductionResult = await engine.deduct({
                requestId,
                actorId,
                technicianCode,
                devices,
                serialsForCustody,
                pairs,
                paperRollQty: execution.paperRollQty ?? (execution.paperRoll === "Yes" ? 1 : 0),
                stickersQty: execution.stickersQty ?? 0,
                nulipCardsQty: execution.nulipCardsQty ?? 0,
                customerName: request.customerName ?? "عميل غير معروف",
                referenceNumber: request.incidentNumber ?? String(requestId),
                vendorType: request.vendorType,
                notes: `خصم تلقائي — مطابقة تقرير التسليم — طلب رقم: ${requestId}`,
                // OPS-REMED-E4-P2: event.id equals its own outbox row id
                // (set at enqueue() time, proven end-to-end A.8 §4) — the
                // one stable causal identifier for this deduction attempt.
                sourceEventId: event.id,
              });

              // OPS-REMED-E3: a non-empty errors array from a successfully
              // *returned* DeductionResult should not occur anymore — the
              // engine now throws a structured DeductionError on any
              // failure (see below). This branch is retained defensively
              // in case a future engine change reintroduces a soft-error
              // shape; it now THROWS rather than returning, so the
              // idempotency layer correctly marks FAILED, never COMPLETED,
              // for this case too.
              if (deductionResult.errors.length > 0) {
                console.error(
                  `[InventorySubscriber] Deduction completed with errors:`,
                  deductionResult.errors
                );

                // OPS-REMED-E4-P2: PROCESSING -> FAILED_RETRYABLE. Note
                // `final` is absent (AttemptFailurePayload) — this is a
                // per-attempt signal, never the terminal one; that is
                // OutboxWorker's DEAD block's job alone.
                await updateCustodyClosureStatus(requestId, ["PROCESSING"], "FAILED_RETRYABLE");
                await eventBus.publish(
                  new InventoryDeductionFailedEvent({
                    requestId,
                    actorId,
                    technicianCode,
                    errors: deductionResult.errors,
                  })
                );
                throw new Error(
                  `[InventorySubscriber] Deduction reported errors without throwing: ${deductionResult.errors.join("; ")}`
                );
              }

              console.log(
                `[InventorySubscriber] Inventory successfully deducted for request ${requestId}.`
              );
              // OPS-REMED-E4-P2: PROCESSING -> CLOSED_SUCCESS. Reached only
              // after engine.deduct() has already committed its own
              // transaction, including the durable completion-evidence row
              // (inventory.engine.ts) — this write is a best-effort, fast
              // path; if it's lost (crash right here), CourierProjectionWorker
              // independently converges to the same state using that
              // already-durable evidence (A.9 §5-§7), no dependency on E5.
              await updateCustodyClosureStatus(requestId, ["PROCESSING"], "CLOSED_SUCCESS");
              return { success: true };
            } catch (err: any) {
              // A concurrent duplicate delivery that loses the idempotency
              // claim is NOT a deduction failure. Do not mutate custody state
              // or publish InventoryDeductionFailedEvent; let the OutboxWorker
              // retry the duplicate delivery while the winning attempt remains
              // authoritative in PROCESSING.
              if (err instanceof IdempotencyInProgressError || err?.code === "IDEMPOTENCY_IN_PROGRESS") {
                // Crash window: the business transaction may already have
                // committed while the idempotency row remained PROCESSING.
                // Recovery is allowed only when the same outbox event has a
                // durable completion-evidence row. Without evidence, leave
                // PROCESSING untouched and let the outbox retry later.
                const [completion] = await db
                  .select({ id: inventoryDeductionCompletions.id })
                  .from(inventoryDeductionCompletions)
                  .where(
                    and(
                      eq(inventoryDeductionCompletions.requestId, requestId),
                      eq(inventoryDeductionCompletions.sourceEventId, event.id)
                    )
                  )
                  .limit(1);

                if (completion) {
                  await idempotencyService.completeIfProcessing(
                    idempotencyKey,
                    event.id,
                    { success: true, recoveredFromDurableCompletion: true }
                  );
                  return;
                }

                throw err;
              }

              console.error(
                `[InventorySubscriber] Critical error during inventory deduction:`,
                err
              );

              await updateCustodyClosureStatus(requestId, ["PROCESSING"], "FAILED_RETRYABLE");
              await eventBus.publish(
                new InventoryDeductionFailedEvent({
                  requestId,
                  actorId,
                  technicianCode,
                  errors: [err.message || "Critical deduction engine error"],
                })
              );
              // OPS-REMED-E3: always throw — this is the single load-bearing
              // fix that routes every deduction failure (structured
              // DeductionError or unexpected infra exception) through
              // idempotencyService.execute's FAILED path, engaging the
              // existing outbox retry/backoff/DEAD-letter machinery, and
              // guaranteeing a failed/partial deduction can never be
              // recorded as idempotency COMPLETED.
              throw err;
            } finally {
              span.end();
            }
          }
        );
      }
    );
  }
}
