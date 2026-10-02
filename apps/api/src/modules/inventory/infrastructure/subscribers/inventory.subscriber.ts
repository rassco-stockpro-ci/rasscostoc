/**
 * InventorySubscriber
 *
 * Listens to ExecutionCompletedEvent.
 *
 * COMPATIBILITY PATH ONLY. Every close commits its own deduction inside the
 * close transaction (CloseRequestUseCase.commit), which also writes the
 * inventory_deduction_completions row and enqueues this event; for those the
 * subscriber only acknowledges the event. It deducts only for an event that
 * has no completion row, i.e. one enqueued before that change. Proven
 * producers (2026-10-02): CloseRequestUseCase.commit only (CourierWorkflow's
 * publisher has no production caller); production outbox held 0 pending or
 * failed ExecutionCompletedEvent rows.
 *
 * Even on that path it deducts exactly the serials carried in the event's own
 * execution snapshot — never a set rebuilt from courier_request_items, which
 * could include an earlier RECEIVED device this close did not install.
 *
 * Retirement: once a release has run with zero events reaching the deduction
 * branch (log line "LEGACY deduction"), remove that branch and keep this
 * subscriber acknowledge-only; then drop the subscription.
 *
 * If the deduction fails, publishes an InventoryDeductionFailedEvent.
 */

import { EventBus } from "@core/events/event-bus";
import { ExecutionCompletedEvent, InventoryDeductionFailedEvent } from "@core/events/events";
import {
  createInventoryEngine,
  hasInventoryDeductionCompletion,
  resolveConsumableQuantities,
  updateCustodyClosureStatus,
} from "../../../courier/contracts";
import { idempotencyService } from "@core/idempotency/idempotency.service";
import { tracer } from "@core/telemetry/tracer";
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

        // Closes deduct inside their own transaction, which also enqueues
        // this event; the deduction is already committed, so there is
        // nothing left to do. Only events enqueued before that change (or
        // by any other writer) reach the deduction below.
        if (await hasInventoryDeductionCompletion(requestId)) {
          console.log(
            `[InventorySubscriber] Request ${requestId} already deducted — event ${event.id} acknowledged without deducting.`
          );
          return;
        }

        // Build serial list first so deduction can resolve technician from custody owner
        const devices: { serialNumber: string; model?: string }[] = [];
        const serialsForCustody: string[] = [];

        const addSerial = async (sn?: string | null) => {
          if (!sn?.trim()) return;
          // FIX (2026-09-24): this used to pick the SHORTEST candidate string
          // (e.g. stripping an alphabetic prefix like NCD/NCC/SAS/SAW) and then
          // push EVERY candidate form into serialsForCustody as a "safety net".
          // For items actually stored WITH their prefix intact (confirmed live:
          // item NCD700022155 is stored as "NCD700022155", not "700022155"),
          // this put a phantom, non-existent serial ("700022155") into the
          // deduction list alongside the real one. deductSerializedCustody()
          // processes every entry in one transaction and throws on the first
          // one that doesn't resolve to an item in active custody -- so the
          // phantom entry aborted the WHOLE deduction, rolling back the
          // already-correct scan-out too (observed: "ScanOut skipped for
          // \"700022155\" — not found in technician active custody", ROOT
          // CAUSE of a real production custody-deduction failure for this
          // item). Fixed by resolving against the actual stored item (trying
          // every candidate form, same as scanOut itself will) and using ITS
          // real serialNumber -- never a derived/guessed variant. Falls back
          // to the raw input only when no stored item matches under any
          // candidate, preserving the existing "let scanOut report a clean
          // not-found" behavior for genuinely missing items.
          const existingItem = await SerialRecognitionService.findItemBySerial(sn);
          const serial = existingItem?.serialNumber || sn.trim();
          if (!devices.some((d) => d.serialNumber === serial)) {
            devices.push({ serialNumber: serial, model: request.vendorType ?? undefined });
          }
          if (!serialsForCustody.includes(serial)) {
            serialsForCustody.push(serial);
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

        // Deliberately NOT rebuilt from courier_request_items (see header).
        console.warn(
          `[InventorySubscriber] LEGACY deduction for request ${requestId} (event ${event.id}): no completion row; deducting the event's own serials only.`
        );

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
                // The one consumables rule (same as the guard and the close).
                ...resolveConsumableQuantities(execution, null),
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
