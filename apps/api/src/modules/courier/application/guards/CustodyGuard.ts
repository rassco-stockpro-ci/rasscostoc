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

/** Active technician custody — keep in sync with inventory custody semantics (no FSM import). */
const ACTIVE_CUSTODY_STATUSES = [
  "IN_TRANSIT_CUSTODY",
  "RECEIVED_BY_TECHNICIAN",
  "IN_TRANSIT",
] as const;

interface ResolvedSerial {
  raw: string;
  itemId: string;
  serialNumber: string;
  status: string;
  currentOwnerId: string | null;
  role: "device" | "sim";
}

export class CustodyGuard {
  /**
   * Validate custody for all serial numbers in the execution.
   * Must be called AFTER TechnicianGuard resolves the techUser.
   *
   * @throws GuardValidationError if any check fails
   */
  static async validate(ctx: GuardContext, techUser: TechUser): Promise<void> {
    const { executionData, requestId } = ctx;

    if (!isCompletedStatus(executionData.installationStatus)) {
      return;
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
        if (found && found.currentOwnerId === techUser.id && (ACTIVE_CUSTODY_STATUSES as readonly string[]).includes(found.status)) {
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

    // Auto-bind when portal closes without Flutter pre-assigning request items
    for (const entry of resolved.filter((r) => r.role === "device")) {
      const link = requestItems.find(
        (item: any) => item.serialNumber === entry.serialNumber || item.simSerial === entry.serialNumber
      );

      if (!link) {
        try {
          await ctx.requestsRepo.insertRequestItems([{
            requestId,
            itemType: "POS",
            serialNumber: entry.serialNumber,
            quantity: 1,
            status: "RECEIVED",
            scannedAt: new Date(),
            receivedAt: new Date(),
            technicianId: techUser.id,
          }]);
        } catch {
          // Auto-bind is best-effort; a duplicate or FK conflict should not block closure
        }
      }
    }

    for (const entry of resolved.filter((r) => r.role === "sim")) {
      const simLink = requestItems.find(
        (item: any) => item.simSerial === entry.serialNumber || item.serialNumber === entry.serialNumber
      );

      if (!simLink) {
        try {
          await ctx.requestsRepo.insertRequestItems([{
            requestId,
            itemType: "SIM",
            simSerial: entry.serialNumber,
            quantity: 1,
            status: "RECEIVED",
            scannedAt: new Date(),
            receivedAt: new Date(),
            technicianId: techUser.id,
          }]);
        } catch {
          // Auto-bind is best-effort; a duplicate or FK conflict should not block closure
        }
      }
    }
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
