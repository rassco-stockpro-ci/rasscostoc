/**
 * CloseRequestUseCase — what a completed close commits, on every channel
 * (portal save, PDF approve, PDF apply, mobile SUCCESS attempt).
 *
 *   plan()    before the transaction: the read/validate phase of the inventory
 *             deduction for exactly the items this close validated (closeItems)
 *   run()     the close transaction; a refused deduction becomes the API error
 *   commit()  inside that transaction, after the channel saved its execution:
 *               1. bind custody-validated serials not yet linked to the request
 *               2. move this close's request items to INSTALLED (state machine)
 *               3. deduct devices, SIMs and consumables + completion record
 *               4. custody_closure_status = CLOSED_SUCCESS
 *               5. audit
 *               6. enqueue ExecutionCompletedEvent on the transactional outbox
 *             Any failure throws and the whole close rolls back.
 *
 * The channels (CourierService) own their own validation and execution save;
 * this use case owns the close semantics they share. It reaches the database
 * only through the transaction contract (domain/transaction.ts): no concrete
 * transaction, no in-memory event fallback.
 */
import type { CourierTransactionalContext, ICourierUnitOfWork } from "../../domain/repositories/ICourierUnitOfWork";
import type { ICourierInventoryPort } from "../../domain/repositories/ICourierInventoryPort";
import { assertRequestItemTransition } from "../../domain/request-item.state-machine";
import type { CloseItem, RequestItemBinding, UnitCountWarning } from "../guards/CompletionGuard";
import type { PairingSource, ResolvedCloseUnit } from "../../domain/execution-unit";
import type { CourierExecutionUnit } from "../../domain/courier.types";
import type { InventoryEngine, PreparedDeduction } from "../inventory/inventory.engine";
import { DeductionError, type DeductionErrorCode } from "../inventory/inventory.engine.types";
import { resolveConsumableQuantities } from "../inventory/consumables";
import type { ExecutionCompletedEvent } from "@core/events/events";
import { AppError } from "@core/errors/AppError";

/** Every custody_closure_status a close may be in before its deduction commits. */
const NOT_YET_CLOSED_STATES = ["PENDING_DEDUCTION", "PROCESSING", "FAILED_RETRYABLE", "FAILED_FINAL", "RECONCILIATION_REQUIRED"];

/** Why a close was refused when its deduction could not be applied. */
const DEDUCTION_REJECTION_LABELS: Record<DeductionErrorCode, string> = {
  DEDUCT_INFRA_TRANSIENT: "تعذّر خصم المخزون بسبب خطأ مؤقت، أعد المحاولة",
  DEDUCT_ASSET_MISSING: "أحد الأصناف غير موجود في المخزون",
  DEDUCT_WRONG_TECHNICIAN: "الفني المسند للطلب لا يطابق صاحب العهدة",
  DEDUCT_INTEGRITY_CONFLICT: "أحد الأرقام التسلسلية لم يعد ضمن عهدة الفني النشطة أو مرتبط بطلب آخر",
  DEDUCT_PAIR_INCOMPLETE: "زوج جهاز/شريحة غير مكتمل",
  DEDUCT_INSUFFICIENT_STOCK: "رصيد الفني لا يكفي للخصم",
  DEDUCT_SERIAL_CONFLICT: "رقم تسلسلي يطابق أكثر من صنف في المخزون",
};

/**
 * A completed close, prepared before its transaction opens. `prepared` is
 * null when this request was already deducted: a request is deducted once,
 * so a re-save commits without deducting again.
 */
export interface ClosePlan {
  prepared: PreparedDeduction | null;
  /** The serials this close validated — the only ones it installs and deducts. */
  closeItems: CloseItem[];
  requestItemsToBind: RequestItemBinding[];
  /** The installation units (device [+ SIM]) this close persists. */
  units: ResolvedCloseUnit[];
  pairingSource: PairingSource | null;
  countWarning: UnitCountWarning | null;
}

export interface PlanCloseInput {
  requestId: number;
  actorId: string;
  request: { vendorType?: string | null; customerName?: string | null; incidentNumber?: string | null };
  technicianCode: string;
  closeItems: CloseItem[];
  requestItemsToBind: RequestItemBinding[];
  units: ResolvedCloseUnit[];
  pairingSource: PairingSource | null;
  countWarning: UnitCountWarning | null;
}

export class CloseRequestUseCase {
  constructor(
    private readonly uow: ICourierUnitOfWork,
    private readonly inventoryPort: Pick<ICourierInventoryPort, "hasInventoryDeductionCompletion">,
    private readonly engine: Pick<InventoryEngine, "prepare" | "executePrepared">
  ) {}

  /**
   * Read phase. Runs BEFORE the close transaction opens: the engine's
   * pre-reads use the outer pool and would self-deadlock a small pool if run
   * while the transaction holds a connection. Every write decision is
   * re-validated under row locks in commit().
   */
  async plan(input: PlanCloseInput): Promise<ClosePlan> {
    const { requestId, request, closeItems, requestItemsToBind, units, pairingSource, countWarning } = input;
    const base = { closeItems, requestItemsToBind, units, pairingSource, countWarning };
    if (await this.inventoryPort.hasInventoryDeductionCompletion(requestId)) {
      return { prepared: null, ...base };
    }

    const serials = closeItems.map((item) => item.serialNumber);
    const prepared = await this.engine
      .prepare({
        requestId,
        actorId: input.actorId,
        technicianCode: input.technicianCode,
        devices: serials.map((serialNumber) => ({ serialNumber, model: request.vendorType ?? undefined })),
        serialsForCustody: serials,
        // Every SIM is paired with its unit's device: the engine re-checks the
        // pairs against the request-item ledger inside the transaction.
        pairs: units
          .filter((u) => u.sim)
          .map((u) => ({ sn: u.device.serialNumber, simSerial: u.sim!.serialNumber })),
        // Consumable quantities come from the saved row, in commit().
        customerName: request.customerName ?? "عميل غير معروف",
        referenceNumber: request.incidentNumber ?? String(requestId),
        vendorType: request.vendorType,
        notes: `خصم تلقائي — إغلاق الطلب — طلب رقم: ${requestId}`,
      })
      .catch((err) => {
        throw CloseRequestUseCase.toCloseError(err);
      });
    return { prepared, ...base };
  }

  /** Runs a close transaction, refusing the close with an API error if its deduction fails. */
  async run<T>(work: (ctx: CourierTransactionalContext) => Promise<T>): Promise<T> {
    try {
      return await this.uow.execute(work);
    } catch (err) {
      throw CloseRequestUseCase.toCloseError(err);
    }
  }

  /** Write phase, inside run()'s transaction, after the channel saved its execution. */
  async commit(ctx: CourierTransactionalContext, plan: ClosePlan, event: ExecutionCompletedEvent): Promise<void> {
    const { requestId, actorId } = event.payload;
    const now = new Date();

    // 1. Custody-validated serials not yet linked to the request.
    if (plan.requestItemsToBind.length > 0) {
      for (const binding of plan.requestItemsToBind) assertRequestItemTransition(null, "BIND_AT_CLOSE", binding.status);
      await ctx.requestsRepository.insertRequestItems(
        plan.requestItemsToBind.map((binding) => ({ ...binding, scannedAt: now, receivedAt: now }))
      );
    }

    // 2. The installation units (the Device<->SIM pairing), once per request:
    //    a re-save of an already-deducted request writes none.
    const execution = event.payload.execution ?? {};
    const inserted = plan.prepared ? await this.insertUnits(ctx, requestId, execution.id, plan) : [];
    // simType is derived from inventory (not a column): carry it on the units the event and response expose.
    const simTypeOf = new Map(plan.units.map((u) => [u.unitNo, u.sim?.carrierName ?? null]));
    const persistedUnits = inserted.map((u) => ({ ...u, simType: simTypeOf.get(u.unitNo) ?? null }));
    execution.units = persistedUnits;

    // 3. This close's request items -> INSTALLED, linked to their unit;
    //    every other item keeps its status.
    await this.installCloseItems(ctx, requestId, plan.closeItems, persistedUnits, now);

    // 4. Deduction: every device and SIM locked FOR UPDATE (item-id order),
    //    custody re-validated, scanned out; consumables; completion row.
    if (plan.prepared) {
      Object.assign(plan.prepared.ctx, {
        ...resolveConsumableQuantities(execution, null),
        // The completion row's source_event_id is the event this transaction enqueues.
        sourceEventId: event.id,
      });
      await this.engine.executePrepared(plan.prepared, ctx.inventoryTransaction);
    }

    // 5. The completion row exists now (written above, or by an earlier close).
    await ctx.executionsRepository.updateCustodyClosureStatus(requestId, NOT_YET_CLOSED_STATES, "CLOSED_SUCCESS");

    // 6. Audit.
    if (plan.prepared) {
      await ctx.dashboardRepository.insertAuditLog({
        tableName: "courier_executions",
        recordId: requestId,
        fieldName: "custody_closure_status",
        newValue: "CLOSED_SUCCESS",
        action: "INVENTORY_DEDUCTED",
        changedBy: actorId,
      });
      if (plan.pairingSource === "LEGACY_INFERRED") {
        await ctx.dashboardRepository.insertAuditLog({
          tableName: "courier_execution_units",
          recordId: requestId,
          fieldName: "pairing_source",
          newValue: `LEGACY_INFERRED (${persistedUnits.length} unit(s) paired by submission order)`,
          action: "UNIT_PAIRING_INFERRED",
          changedBy: actorId,
        });
      }
      if (plan.countWarning) {
        await ctx.dashboardRepository.insertAuditLog({
          tableName: "courier_execution_units",
          recordId: requestId,
          fieldName: "unit_count",
          oldValue: String(plan.countWarning.expected),
          newValue: String(plan.countWarning.actual),
          action: "UNIT_COUNT_MISMATCH",
          changedBy: actorId,
        });
      }
    }

    // 7. On this transaction, no in-memory fallback: the close cannot commit
    // without its event row.
    await ctx.outbox.enqueue(event);
  }

  /**
   * RECEIVED -> INSTALLED for the request items of this close. A linked item
   * still PENDING_RECEIPT is received first (implied: the close guard has just
   * validated that the technician holds it). Already INSTALLED: unchanged.
   * Anything else is not a defined transition and refuses the close (422).
   */
  private async insertUnits(
    ctx: CourierTransactionalContext,
    requestId: number,
    executionId: number,
    plan: ClosePlan
  ): Promise<CourierExecutionUnit[]> {
    if (plan.units.length === 0) return [];
    return ctx.executionsRepository.insertExecutionUnits(
      plan.units.map((u) => ({
        requestId,
        executionId,
        unitNo: u.unitNo,
        deviceItemId: u.device.itemId,
        deviceSerial: u.device.serialNumber,
        simItemId: u.sim?.itemId ?? null,
        simSerial: u.sim?.serialNumber ?? null,
        simWaived: u.simWaived,
        tid: u.tid,
        pairingSource: plan.pairingSource ?? "EXPLICIT",
      }))
    );
  }

  private async installCloseItems(
    ctx: CourierTransactionalContext,
    requestId: number,
    closeItems: CloseItem[],
    units: CourierExecutionUnit[],
    now: Date
  ) {
    if (closeItems.length === 0) return;
    const closeSerials = new Set(closeItems.map((item) => item.serialNumber));
    const unitOf = new Map<string, CourierExecutionUnit>();
    for (const u of units) {
      unitOf.set(u.deviceSerial, u);
      if (u.simSerial) unitOf.set(u.simSerial, u);
    }
    const itemIdOf = new Map(closeItems.map((item) => [item.serialNumber, item.itemId]));
    const items = await ctx.requestsRepository.findRequestItems(requestId);
    for (const item of items) {
      const inClose =
        (!!item.serialNumber && closeSerials.has(item.serialNumber)) || (!!item.simSerial && closeSerials.has(item.simSerial));
      if (!inClose || item.status === "INSTALLED") continue;

      let from = item.status;
      if (from === "PENDING_RECEIPT") {
        assertRequestItemTransition(from, "RECEIVE", "RECEIVED");
        from = "RECEIVED";
      }
      assertRequestItemTransition(from, "INSTALL", "INSTALLED");
      const serial = (item.serialNumber && closeSerials.has(item.serialNumber) ? item.serialNumber : item.simSerial) as string;
      await ctx.requestsRepository.updateRequestItem(item.id, {
        status: "INSTALLED",
        receivedAt: (item as any).receivedAt ?? now,
        installedAt: now,
        deliveredAt: now,
        ...(unitOf.get(serial) ? { executionUnitId: unitOf.get(serial)!.id } : {}),
        ...(itemIdOf.get(serial) ? { itemId: itemIdOf.get(serial) } : {}),
      });
    }
  }

  /** Maps a deduction failure to the API error that refuses the close. */
  static toCloseError(err: unknown): unknown {
    if (!(err instanceof DeductionError)) return err;
    console.error(`[CloseRequest] Close of request ${err.requestId} refused: ${err.code} ${err.message}`);
    const detail = err.message.replace(/^\[InventoryEngine\]\s*/, "");
    const message = `لم يُغلق الطلب: ${DEDUCTION_REJECTION_LABELS[err.code]}. (${detail})`;
    return err.code === "DEDUCT_INFRA_TRANSIENT"
      ? new AppError(message, 503, true, "INVENTORY_DEDUCTION_TRANSIENT")
      : new AppError(message, 422, true, "INVENTORY_DEDUCTION_REJECTED");
  }

  /** A completed close always has a resolved technician (TechnicianGuard throws otherwise). */
  static requireTechnician<T>(techUser: T | null): T {
    if (!techUser) {
      throw new AppError("تعذّر تحديد الفني المسؤول عن الإغلاق؛ لم يُغلق الطلب.", 422, true, "INVENTORY_DEDUCTION_REJECTED");
    }
    return techUser;
  }
}
