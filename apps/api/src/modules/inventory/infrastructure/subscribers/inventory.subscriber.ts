/**
 * InventorySubscriber
 *
 * Listens to ExecutionCompletedEvent to perform physical inventory deductions.
 *
 * ARCHITECTURE NOTE (ERP-INV-001):
 * idempotencyService.execute() is called FIRST — before any serial-building or
 * early-return logic — so that every execution path inside this subscriber leaves
 * a trace in idempotency_records (PROCESSING, COMPLETED, or FAILED).  Earlier
 * versions had the idempotency call AFTER the serial-building block, which meant
 * a silent early-exit left no record and no saga compensation.
 */

import { EventBus } from "@core/events/event-bus";
import { ExecutionCompletedEvent, InventoryDeductionFailedEvent } from "@core/events/events";
import { createInventoryEngine } from "../../../courier/contracts";
import { idempotencyService } from "@core/idempotency/idempotency.service";
import { tracer } from "@core/telemetry/tracer";
import { db } from "@core/config/db";
import { courierExecutions, courierRequestItems } from "@shared/schema";
import { eq } from "drizzle-orm";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";

export class InventorySubscriber {
  public static register(): void {
    const eventBus = EventBus.getInstance();

    eventBus.subscribe(
      "ExecutionCompletedEvent",
      async (event: any) => {
        const { requestId, actorId, execution, request } = event.payload;

        // IDEMPOTENCY FIRST — any exit path after this point is permanently recorded.
        // If the callback exits without throwing, idempotency marks COMPLETED (cached).
        // If the callback throws, idempotency marks FAILED and the outbox will retry.
        const idempotencyKey = `${event.name}:REQ-${requestId}:InventorySubscriber:v${event.version}`;

        await idempotencyService.execute(
          idempotencyKey,
          event.id,
          "InventorySubscriber",
          async () => {
            console.log(
              `[InventorySubscriber] Processing ExecutionCompletedEvent for REQ-${requestId}`
            );

            // --- Build serial list ---
            const devices: { serialNumber: string; model?: string }[] = [];
            const serialsForCustody: string[] = [];

            const addSerial = async (sn?: string | null) => {
              if (!sn?.trim()) return;
              const candidates = await SerialRecognitionService.buildStoredSerialCandidates(sn);
              const serial =
                [...candidates].sort((a, b) => a.length - b.length)[0] || sn.trim();
              if (!devices.some((d) => d.serialNumber === serial)) {
                devices.push({ serialNumber: serial, model: request.vendorType ?? undefined });
              }
              if (!serialsForCustody.includes(serial)) serialsForCustody.push(serial);
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
              if (
                item.status === "RECEIVED" ||
                item.status === "DELIVERED" ||
                item.status === "INSTALLED"
              ) {
                if (item.itemType === "POS" && item.serialNumber) {
                  await addSerial(item.serialNumber);
                } else if (item.itemType === "SIM" && item.simSerial) {
                  await addSerial(item.simSerial);
                }
              }
            }

            // Guard: execution has SNs but none resolved — log and skip rather than
            // silently succeed (the saga/reconciliation will catch this).
            if (serialsForCustody.length === 0 && (execution.sn || execution.simSerial)) {
              console.error(
                `[InventorySubscriber] REQ-${requestId}: SN present but serialsForCustody resolved to empty. ` +
                `execution.sn="${execution.sn}" execution.simSerial="${execution.simSerial}". Marking SKIPPED.`
              );
              await db
                .update(courierExecutions)
                .set({ deductionStatus: "SKIPPED" })
                .where(eq(courierExecutions.requestId, requestId));
              return { success: false, reason: "NO_SERIALS_RESOLVED" };
            }

            const technicianCode =
              execution.technicianCode || execution.salesTechnician || request.tecName || "unknown";

            const span = tracer.startSpan("InventoryDeduction", { requestId, actorId, technicianCode });

            try {
              const engine = createInventoryEngine();
              const deductionResult = await engine.deduct({
                requestId,
                actorId,
                technicianCode,
                devices,
                serialsForCustody,
                paperRollQty: execution.paperRollQty ?? (execution.paperRoll === "Yes" ? 1 : 0),
                stickersQty: execution.stickersQty ?? 0,
                nulipCardsQty: execution.nulipCardsQty ?? 0,
                customerName: request.customerName ?? "عميل غير معروف",
                referenceNumber: request.incidentNumber ?? String(requestId),
                vendorType: request.vendorType,
                notes: `خصم تلقائي — مطابقة تقرير التسليم — طلب رقم: ${requestId}`,
              });

              if (deductionResult.errors.length > 0) {
                console.error(
                  `[InventorySubscriber] REQ-${requestId}: Deduction completed with errors:`,
                  deductionResult.errors
                );
                await db
                  .update(courierExecutions)
                  .set({ deductionStatus: "FAILED" })
                  .where(eq(courierExecutions.requestId, requestId));
                await eventBus.publish(
                  new InventoryDeductionFailedEvent({
                    requestId,
                    actorId,
                    technicianCode,
                    errors: deductionResult.errors,
                  })
                );
                return { success: false, errors: deductionResult.errors };
              }

              await db
                .update(courierExecutions)
                .set({ deductionStatus: "COMPLETED" })
                .where(eq(courierExecutions.requestId, requestId));

              console.log(
                `[InventorySubscriber] REQ-${requestId}: Inventory deducted successfully.`
              );
              return { success: true };
            } catch (err: any) {
              console.error(
                `[InventorySubscriber] REQ-${requestId}: Critical error during deduction:`,
                err
              );
              // Best-effort status update; don't suppress the rethrow if this fails
              await db
                .update(courierExecutions)
                .set({ deductionStatus: "FAILED" })
                .where(eq(courierExecutions.requestId, requestId))
                .catch(() => {});
              await eventBus.publish(
                new InventoryDeductionFailedEvent({
                  requestId,
                  actorId,
                  technicianCode: execution.technicianCode || "unknown",
                  errors: [err.message || "Critical deduction engine error"],
                })
              );
              throw err; // rethrow → idempotency marks FAILED → outbox retries
            } finally {
              span.end();
            }
          }
        );
      }
    );
  }
}
