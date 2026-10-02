/**
 * CustodyGuard
 *
 * Validates that every serial number in the execution data:
 *   1. Currently owned by the resolved technician (currentOwnerId === techUser.id)
 *   2. Is in an active custody state
 *   3. Device and SIM belong to the SAME technician (no ownership mismatch)
 *   4. Device/SIM linked to the courier request (auto-binds when portal closes without Flutter assign)
 *
 * Supports multiple devices and SIMs via deviceSerials / simSerials.
 * Serials are matched via Central Serial Engine (prefixed or stored forms).
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

interface ResolvedSerial {
  raw: string;
  itemId: string;
  serialNumber: string;
  status: string;
  currentOwnerId: string | null;
  role: "device" | "sim";
}

/** A serial validated for THIS close, by its stored (canonical) form. */
export interface CloseItem {
  serialNumber: string;
  role: "device" | "sim";
}

/** courier_request_items row the close must create; applied by the caller inside its transaction. */
export interface RequestItemBinding {
  requestId: number;
  itemType: "POS" | "SIM";
  serialNumber?: string;
  simSerial?: string;
  quantity: number;
  status: "RECEIVED";
  technicianId: string;
}

export interface CustodyDecision {
  items: CloseItem[];
  requestItemsToBind: RequestItemBinding[];
}

export class CustodyGuard {
  /**
   * Validate custody for all serial numbers in the execution.
   * Must be called AFTER TechnicianGuard resolves the techUser.
   *
   * Read-only: returns the request items the close must bind instead of
   * writing them, so a later guard's rejection leaves no state behind.
   *
   * @throws GuardValidationError if any check fails
   */
  static async validate(ctx: GuardContext, techUser: TechUser): Promise<CustodyDecision> {
    const { executionData, requestId } = ctx;

    if (!isCompletedStatus(executionData.installationStatus)) {
      return { items: [], requestItemsToBind: [] };
    }

    const deviceSerials = normalizeSerialList(executionData.deviceSerials, executionData.sn);
    const simSerials = normalizeSerialList(executionData.simSerials, executionData.simSerial);

    // Legacy extra fields only when they look like serials (not Flutter JSON metadata)
    const legacyExtras = [executionData.extraField1, executionData.extraField2]
      .filter((v) => looksLikeInventorySerial(v))
      .map((v) => String(v).trim());

    const serialEntries: Array<{ raw: string; role: "device" | "sim" }> = [
      ...deviceSerials.map((raw) => ({ raw, role: "device" as const })),
      ...simSerials.map((raw) => ({ raw, role: "sim" as const })),
      // Treat leftover extras as devices for custody validation (legacy single-close path)
      ...legacyExtras
        .filter((raw) => !deviceSerials.includes(raw) && !simSerials.includes(raw))
        .map((raw) => ({ raw, role: "device" as const })),
    ];

    const resolved: ResolvedSerial[] = [];

    for (const entry of serialEntries) {
      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(entry.raw);

      let item: any = null;
      for (const candidate of candidates) {
        const found = await ctx.inventoryPort.findItemBySerial(candidate);
        if (found && isInActiveCustodyOf(found, techUser.id)) {
          item = found;
          break;
        }
      }

      if (!item) {
        await CustodyGuard.writeAuditFailure(ctx, techUser, entry.raw);
        throw new GuardValidationError(
          `الرقم التسلسلي "${entry.raw}" ليس ضمن عهدة الفني المسؤول (${techUser.fullName}) حالياً، أو ليس في حالة عهدة نشطة.`,
          entry.role === "sim" ? "simSerial" : "sn"
        );
      }

      resolved.push({
        raw: entry.raw,
        itemId: item.id,
        serialNumber: item.serialNumber,
        status: item.status,
        currentOwnerId: item.currentOwnerId,
        role: entry.role,
      });
    }

    const ownerIds = new Set(
      resolved.map((r) => r.currentOwnerId).filter((id): id is string => !!id)
    );
    if (ownerIds.size > 1) {
      await CustodyGuard.writeAuditFailure(
        ctx,
        techUser,
        resolved.map((r) => r.raw).join(" / ")
      );
      throw new GuardValidationError(
        "الأجهزة والشرائح المدخلة تنتمي لفنيين مختلفين. يجب أن يكون المالك واحداً لإغلاق الطلب.",
        "simSerial"
      );
    }

    const requestItems = await ctx.requestsRepo.findRequestItems(requestId);
    const isLinked = (serial: string) =>
      requestItems.some((item: any) => item.serialNumber === serial || item.simSerial === serial);

    // Auto-bind when portal closes without Flutter pre-assigning request items
    const requestItemsToBind: RequestItemBinding[] = resolved
      .filter((entry) => !isLinked(entry.serialNumber))
      .map((entry) =>
        entry.role === "device"
          ? { requestId, itemType: "POS", serialNumber: entry.serialNumber, quantity: 1, status: "RECEIVED", technicianId: techUser.id }
          : { requestId, itemType: "SIM", simSerial: entry.serialNumber, quantity: 1, status: "RECEIVED", technicianId: techUser.id }
      );

    return {
      items: resolved.map((r) => ({ serialNumber: r.serialNumber, role: r.role })),
      requestItemsToBind,
    };
  }

  private static async writeAuditFailure(
    ctx: GuardContext,
    techUser: TechUser,
    serial: string
  ): Promise<void> {
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
