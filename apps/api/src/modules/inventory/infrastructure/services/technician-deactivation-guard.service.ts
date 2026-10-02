/**
 * TEMP-SYSTEM-STABILIZATION — extracted from technicians.controller.ts to
 * satisfy the project's architecture rule (controller-should-not-depend-
 * on-repository-or-drizzle): controllers must not import drizzle/db
 * directly, that belongs in the service layer.
 */
import { db } from "@core/config/db";
import { items, warehouseTransfers, courierRequestItems } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";

const TECHNICIAN_HELD_ITEM_STATUSES = ["IN_TRANSIT_CUSTODY", "RECEIVED_BY_TECHNICIAN", "IN_TRANSIT"];
const ACTIVE_TRANSFER_STATUSES = ["pending", "accepted", "in_transit"];
// NOTE: courier_requests itself carries no technicianId/status columns —
// per-item assignment/status lives on the child table courierRequestItems
// (requestId -> courier_requests.id). This was a real bug caught by this
// session's own regression test: the original code queried
// courierRequests.technicianId/.status, which don't exist, silently
// producing malformed SQL at runtime despite passing `npm run check`.
const ACTIVE_COURIER_ITEM_STATUSES = ["PENDING_RECEIPT", "RECEIVED", "INSTALLED"];

export class TechnicianDeactivationGuardService {
  /**
   * Returns a list of human-readable blocking reasons — empty array means
   * safe to deactivate. A technician must not be deactivated while they
   * hold operational state that deactivation would silently orphan: active
   * serialized custody, an in-progress warehouse transfer, or an
   * unfinished courier request item.
   */
  async findActiveOperationBlockers(technicianId: string): Promise<string[]> {
    const blockers: string[] = [];

    const custodyItems = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.currentOwnerId, technicianId),
          inArray(items.status, TECHNICIAN_HELD_ITEM_STATUSES)
        )
      )
      .limit(1);
    if (custodyItems.length > 0) {
      blockers.push("لدى الفني عهدة مخزنية نشطة (أجهزة/شرائح) لم يتم تسليمها أو إرجاعها");
    }

    const activeTransfers = await db
      .select({ id: warehouseTransfers.id })
      .from(warehouseTransfers)
      .where(
        and(
          eq(warehouseTransfers.technicianId, technicianId),
          inArray(warehouseTransfers.status, ACTIVE_TRANSFER_STATUSES)
        )
      )
      .limit(1);
    if (activeTransfers.length > 0) {
      blockers.push("لدى الفني شحنة/مناقلة مخزنية قيد التنفيذ لم تُستلم أو تُغلق بعد");
    }

    const activeCourierItems = await db
      .select({ id: courierRequestItems.id })
      .from(courierRequestItems)
      .where(
        and(
          eq(courierRequestItems.technicianId, technicianId),
          inArray(courierRequestItems.status, ACTIVE_COURIER_ITEM_STATUSES)
        )
      )
      .limit(1);
    if (activeCourierItems.length > 0) {
      blockers.push("لدى الفني طلب تركيب/توصيل غير منتهٍ");
    }

    return blockers;
  }
}

export const technicianDeactivationGuardService = new TechnicianDeactivationGuardService();
