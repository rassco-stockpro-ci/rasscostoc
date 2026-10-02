/**
 * TechnicianGuard
 *
 * Priority:
 *   1. Resolve technician from items.currentOwnerId when SN is present (authoritative).
 *   2. Fallback: technicianCode / salesTechnician / request.tecName (exact + fuzzy).
 */

import { GuardValidationError, isCompletedStatus, type GuardContext, type TechUser } from "./guard.types";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";
import { isActiveCustodyStatus } from "../../../inventory/contracts/custody-policy";

export class TechnicianGuard {
  static async resolve(ctx: GuardContext): Promise<TechUser | null> {
    const { executionData, request } = ctx;

    if (!isCompletedStatus(executionData.installationStatus)) {
      return null;
    }

    const rawSn =
      executionData.sn?.trim() ||
      (Array.isArray(executionData.deviceSerials)
        ? executionData.deviceSerials.find((s) => String(s || "").trim())?.trim()
        : undefined);
    if (rawSn) {
      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(rawSn);
      if (candidates.length > 0) {
        let item: any = null;
        for (const candidate of candidates) {
          const found = await ctx.inventoryPort.findItemBySerial(candidate);
          if (found && found.currentOwnerId) {
            item = found;
            break;
          }
        }

        if (item?.currentOwnerId) {
          const techUser = await ctx.inventoryPort.findUserById(item.currentOwnerId);

          if (techUser) {
            if (!isActiveCustodyStatus(item.status)) {
              throw new GuardValidationError(
                `الجهاز (${rawSn}) ليس في حالة عهدة نشطة. الحالة الحالية: ${item.status}`,
                "sn"
              );
            }
            return techUser;
          }
        }
      }
    }

    const technicianCode =
      executionData.technicianCode ||
      executionData.salesTechnician ||
      request.tecName;

    if (!technicianCode || String(technicianCode).trim() === "") {
      throw new GuardValidationError(
        "لم يتم العثور على الفني المسؤول عن الطلب. يرجى إدخال الرقم التسلسلي للجهاز أو تحديد كود الفني.",
        "technicianCode"
      );
    }

    const techUser = await ctx.inventoryPort.findUserByCodeOrUsername(technicianCode);
    if (techUser) return techUser;

    const labels = TechnicianGuard.normalizeTechLabel(String(technicianCode));
    for (const label of labels) {
      const fuzzy = await ctx.inventoryPort.findUserByFuzzyName(label);
      if (fuzzy) return fuzzy;
    }

    throw new GuardValidationError(
      `الفني المسؤول "${technicianCode}" غير مسجل في نظام المستخدمين. أنشئ حساب الفني أو اربط الجهاز بعهدته أولاً.`,
      "technicianCode"
    );
  }

  /** "SALAH OMAR_Neoleap" → ["SALAH OMAR", "SALAH", "OMAR"] */
  static normalizeTechLabel(raw: string): string[] {
    const base = String(raw)
      .replace(/_/g, " ")
      .replace(/\b(neoleap|rassco|nl)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!base) return [];
    const tokens = base.split(" ").filter((t) => t.length >= 3);
    return [base, ...tokens];
  }
}
