/**
 * Shared guard + idempotency-replay + audit-log helpers for every
 * bare-quantity inventory write path (fixed-inventory entries, moving-
 * inventory entries, stock-transfer, withdraw-to-warehouse). Extracted so
 * the same rules apply identically everywhere instead of being
 * reimplemented per call site.
 */
import { and, eq, sql } from "drizzle-orm";
import { itemTypes, systemLogs } from "@shared/schema";
import { ValidationError } from "@core/errors/AppError";

export type ItemTypeTrackingInfo = {
  requiresSerial: boolean;
  isActive: boolean;
  isVisible: boolean;
  nameAr: string;
};

/**
 * Tracking mode (serialized vs quantity) comes ONLY from
 * item_types.requires_serial — never from category, name, ID prefix, or
 * any other heuristic (that inference pattern was a proven defect fixed
 * elsewhere in this task). A serialized type must never be added/set by
 * bare quantity; it only ever gets a custody row via the scan-in/scan-out
 * path. Hidden/inactive types are rejected for NEW entries for the same
 * reason a hidden/inactive catalog item shouldn't be purchasable.
 */
export async function assertItemTypeQuantityTrackable(
  tx: any,
  itemTypeId: string,
): Promise<ItemTypeTrackingInfo> {
  const [itemType] = await tx
    .select({
      requiresSerial: itemTypes.requiresSerial,
      isActive: itemTypes.isActive,
      isVisible: itemTypes.isVisible,
      nameAr: itemTypes.nameAr,
    })
    .from(itemTypes)
    .where(eq(itemTypes.id, itemTypeId));

  if (!itemType) {
    throw new ValidationError(`نوع الصنف غير موجود: ${itemTypeId}`);
  }
  if (itemType.requiresSerial) {
    throw new ValidationError(
      `${itemType.nameAr} صنف مسلسل (Serial) — لا يمكن إضافته بالكمية، يجب إدخاله عبر المسح بالرقم التسلسلي`,
    );
  }
  if (!itemType.isActive || !itemType.isVisible) {
    throw new ValidationError(`${itemType.nameAr} غير متاح حالياً لإضافة مخزون جديد`);
  }

  return itemType;
}

export function assertNonNegativeInteger(value: number, labelAr: string): void {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${labelAr} يجب أن تكون أرقاماً صحيحة`);
  }
  if (value < 0) {
    throw new ValidationError(`${labelAr} لا يمكن أن تكون سالبة`);
  }
}

export async function assertQuantityWriteAllowed(
  tx: any,
  itemTypeId: string,
  boxes: number,
  units: number,
): Promise<ItemTypeTrackingInfo> {
  const itemType = await assertItemTypeQuantityTrackable(tx, itemTypeId);
  assertNonNegativeInteger(boxes, "الكمية (صناديق)");
  assertNonNegativeInteger(units, "الكمية (وحدات)");
  return itemType;
}

/**
 * Idempotency-replay dedup at the DOMAIN level (inside the same
 * transaction as the write it guards), not just the HTTP-response-cache
 * level (the global `idempotency` middleware caches the raw HTTP response,
 * which protects a client retrying over the network, but does nothing for
 * a second write that reaches the repository some other way — and more
 * importantly, a PGlite test calling the repository directly bypasses
 * Express/that middleware entirely, so without this check "retry with the
 * same key" could never be proven at the write-path level, only mocked).
 *
 * Reuses the existing system_logs audit trail (already carries
 * idempotencyKey in `details`) as the dedup source — no new table, no
 * schema change. Returns the previously-recorded `after` state if this
 * exact (entityType, idempotencyKey) pair was already applied, or null if
 * this is a genuinely new request.
 */
export async function findIdempotentReplay(
  tx: any,
  entityType: string,
  idempotencyKey: string,
): Promise<{ boxes: number; units: number; id: string } | null> {
  const [priorLog] = await tx
    .select({ details: systemLogs.details, entityId: systemLogs.entityId })
    .from(systemLogs)
    .where(
      and(
        eq(systemLogs.entityType, entityType),
        sql`${systemLogs.details} LIKE ${'%"idempotencyKey":"' + idempotencyKey + '"%'}`,
      ),
    )
    .limit(1);

  if (!priorLog) return null;

  const parsed = JSON.parse(priorLog.details);
  return { ...parsed.after, id: priorLog.entityId };
}

export async function logQuantityMovement(
  tx: any,
  params: {
    actor: { id: string; username: string; role: string };
    action: "QUANTITY_CREATE" | "QUANTITY_UPDATE";
    entityType: string;
    entityId: string;
    technicianId: string;
    itemTypeId: string;
    before: { boxes: number; units: number } | null;
    after: { boxes: number; units: number };
    idempotencyKey: string;
    descriptionAr: string;
  },
): Promise<void> {
  await tx.insert(systemLogs).values({
    userId: params.actor.id,
    userName: params.actor.username,
    userRole: params.actor.role,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    entityName: `${params.technicianId}:${params.itemTypeId}`,
    details: JSON.stringify({
      technicianId: params.technicianId,
      itemTypeId: params.itemTypeId,
      before: params.before,
      after: params.after,
      idempotencyKey: params.idempotencyKey,
    }),
    description: params.descriptionAr,
    severity: "info",
    success: true,
  });
}
