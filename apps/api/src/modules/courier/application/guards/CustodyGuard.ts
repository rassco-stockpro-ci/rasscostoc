/**
 * CustodyGuard
 *
 * Resolves the installation units of a completed close against inventory and
 * validates, for every device and SIM:
 *   1. it is owned by the resolved technician, in active custody
 *      (ActiveCustodyPolicy — IN_TRANSIT included);
 *   2. its item category matches its role (device -> "devices", SIM -> "sim");
 *   3. all of them belong to the SAME technician;
 *   4. no physical item appears twice (two spellings of one serial);
 *   5. it is linked to the courier request, or returned as a binding the
 *      close transaction creates.
 *
 * Read-only: returns the resolved units and the bindings instead of writing,
 * so a later guard's rejection leaves no state behind. The one write is the
 * append-only audit row of a rejection.
 */

import {
  GuardValidationError,
  isCompletedStatus,
  looksLikeInventorySerial,
  normalizeSerialList,
  type GuardContext,
  type TechUser,
} from "./guard.types";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";
import { isInActiveCustodyOf } from "../../../inventory/contracts/custody-policy";
import {
  CloseUnitError,
  ROLE_CATEGORY,
  assertResolvedUnits,
  type CloseUnitsPlan,
  type PairingSource,
  type ResolvedCloseUnit,
} from "../../domain/execution-unit";
import { explicitPairingRequired, unitsFromLegacyLists } from "../close/close-units";

/** A serial validated for THIS close, by its stored (canonical) form. */
export interface CloseItem {
  serialNumber: string;
  role: "device" | "sim";
  itemId: string;
}

/** courier_request_items row the close must create; applied by the caller inside its transaction. */
export interface RequestItemBinding {
  requestId: number;
  itemType: "POS" | "SIM";
  serialNumber?: string;
  simSerial?: string;
  itemId: string;
  quantity: number;
  status: "RECEIVED";
  technicianId: string;
}

/** Installed unit count differs from the request's expected device count: recorded, never rejected. */
export interface UnitCountWarning {
  expected: number;
  actual: number;
}

export interface CustodyDecision {
  items: CloseItem[];
  units: ResolvedCloseUnit[];
  pairingSource: PairingSource | null;
  countWarning: UnitCountWarning | null;
  requestItemsToBind: RequestItemBinding[];
}

const EMPTY: CustodyDecision = { items: [], units: [], pairingSource: null, countWarning: null, requestItemsToBind: [] };

export class CustodyGuard {
  /**
   * Must be called AFTER TechnicianGuard resolves the techUser.
   * @throws GuardValidationError (custody) / CloseUnitError (unit rules)
   */
  static async validate(ctx: GuardContext, techUser: TechUser): Promise<CustodyDecision> {
    const { executionData, requestId } = ctx;
    if (!isCompletedStatus(executionData.installationStatus)) return EMPTY;

    const plan = executionData.units ?? CustodyGuard.legacyPlan(ctx);
    if (!plan) return EMPTY;

    const ownerIds = new Set<string>();
    const resolve = async (raw: string, role: "device" | "sim", unitNo: number) => {
      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(raw);
      let item: any = null;
      for (const candidate of candidates) {
        const found = await ctx.inventoryPort.findItemBySerial(candidate);
        if (found && isInActiveCustodyOf(found, techUser.id)) {
          item = found;
          break;
        }
      }
      if (!item) {
        await CustodyGuard.writeAuditFailure(ctx, techUser, raw);
        throw new GuardValidationError(
          `الرقم التسلسلي "${raw}" ليس ضمن عهدة الفني المسؤول (${techUser.fullName}) حالياً، أو ليس في حالة عهدة نشطة.`,
          role === "sim" ? "simSerial" : "sn"
        );
      }
      const itemType = await ctx.inventoryPort.findItemTypeById(item.itemTypeId);
      if (itemType?.category !== ROLE_CATEGORY[role]) {
        await CustodyGuard.writeAuditFailure(ctx, techUser, raw);
        throw new CloseUnitError(
          "UNIT_ROLE_MISMATCH",
          role === "device"
            ? `الوحدة ${unitNo}: الرقم ${raw} ليس جهازًا (التصنيف: ${itemType?.category ?? "غير معروف"}).`
            : `الوحدة ${unitNo}: الرقم ${raw} ليس شريحة (التصنيف: ${itemType?.category ?? "غير معروف"}).`,
          unitNo
        );
      }
      if (item.currentOwnerId) ownerIds.add(item.currentOwnerId);
      return { itemId: item.id as string, serialNumber: item.serialNumber as string };
    };

    const units: ResolvedCloseUnit[] = [];
    for (const u of plan.units) {
      const device = await resolve(u.deviceSerial, "device", u.unitNo);
      const sim = u.simSerial ? await resolve(u.simSerial, "sim", u.unitNo) : null;
      units.push({ unitNo: u.unitNo, device, sim, simWaived: u.simWaived, tid: u.tid });
    }

    if (ownerIds.size > 1) {
      await CustodyGuard.writeAuditFailure(ctx, techUser, plan.units.map((u) => u.deviceSerial).join(" / "));
      throw new GuardValidationError(
        "الأجهزة والشرائح المدخلة تنتمي لفنيين مختلفين. يجب أن يكون المالك واحداً لإغلاق الطلب.",
        "simSerial"
      );
    }
    assertResolvedUnits(units);

    const items: CloseItem[] = units.flatMap((u) => [
      { serialNumber: u.device.serialNumber, role: "device" as const, itemId: u.device.itemId },
      ...(u.sim ? [{ serialNumber: u.sim.serialNumber, role: "sim" as const, itemId: u.sim.itemId }] : []),
    ]);

    const requestItems = await ctx.requestsRepo.findRequestItems(requestId);
    const isLinked = (serial: string) =>
      requestItems.some((item: any) => item.serialNumber === serial || item.simSerial === serial);

    // Auto-bind when the close names a serial the request does not list yet.
    const requestItemsToBind: RequestItemBinding[] = items
      .filter((entry) => !isLinked(entry.serialNumber))
      .map((entry) =>
        entry.role === "device"
          ? { requestId, itemType: "POS", serialNumber: entry.serialNumber, itemId: entry.itemId, quantity: 1, status: "RECEIVED", technicianId: techUser.id }
          : { requestId, itemType: "SIM", simSerial: entry.serialNumber, itemId: entry.itemId, quantity: 1, status: "RECEIVED", technicianId: techUser.id }
      );

    // Expected devices = POS lines the request was assigned; a difference is a warning only.
    const expected = requestItems.filter((item: any) => item.itemType === "POS").length;
    const countWarning = expected > 0 && expected !== units.length ? { expected, actual: units.length } : null;

    return { items, units, pairingSource: plan.pairingSource, countWarning, requestItemsToBind };
  }

  /**
   * No units[] submitted: the legacy fields (sn / simSerial / lists /
   * serial-like extra fields) become units here — the single place the
   * legacy contract is interpreted.
   */
  private static legacyPlan(ctx: GuardContext): CloseUnitsPlan | null {
    const { executionData } = ctx;
    const deviceSerials = normalizeSerialList(executionData.deviceSerials, executionData.sn);
    const simSerials = normalizeSerialList(executionData.simSerials, executionData.simSerial);
    const extras = [executionData.extraField1, executionData.extraField2]
      .filter((v) => looksLikeInventorySerial(v))
      .map((v) => String(v).trim())
      .filter((raw) => !deviceSerials.includes(raw) && !simSerials.includes(raw));
    return unitsFromLegacyLists([...deviceSerials, ...extras], simSerials, { requireExplicitPairing: explicitPairingRequired() });
  }

  private static async writeAuditFailure(ctx: GuardContext, techUser: TechUser, serial: string): Promise<void> {
    const { requestId, enteredBy, existingExecution } = ctx;
    try {
      await ctx.dashboardRepo.insertAuditLog({
        tableName: "executions",
        recordId: requestId,
        fieldName: "status",
        oldValue: existingExecution?.installationStatus ?? null,
        newValue: `فشل التحقق: الرقم التسلسلي ${serial} ليس في عهدة الفني ${techUser.fullName}`,
        action: "verification_failed",
        changedBy: enteredBy,
      });
    } catch {
      // Non-critical
    }
  }
}
