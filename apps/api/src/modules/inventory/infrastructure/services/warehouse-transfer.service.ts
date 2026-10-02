import { db } from "@core/config/db";
import { items, itemTypes, inventoryTransactions, itemHistoryLogs, warehouseTransfers, technicianMovingInventoryEntries, custodyMovements, users } from "@shared/schema";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import { CustodyEngine } from "./custody-engine";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";
import { ACTIVE_CUSTODY_STATUSES } from "../../domain/active-custody.policy";
import { AppError, NotFoundError, AuthorizationError } from "@core/errors/AppError";

export class WarehouseTransferService {
  async getWarehouseTransferById(id: string) {
    const [transfer] = await db
      .select()
      .from(warehouseTransfers)
      .where(eq(warehouseTransfers.id, id))
      .limit(1);
    return transfer || null;
  }

  async scanSerial(userId: string, transferId: string, serialNumber: string, itemType: string) {
    const sn = serialNumber.trim();

    // 1. recognize serial
    const recognition = await SerialRecognitionService.recognize(sn, itemType, db);
    const cleanSerial = recognition.normalizedSerial;
    const actualItemTypeId = recognition.itemTypeId;

    // 2. check if active serial exists
    const [existingItem] = await db
      .select()
      .from(items)
      .where(eq(items.serialNumber, cleanSerial))
      .limit(1);

    if (existingItem) {
      // BUGFIX: these were plain Error throws — asyncHandler's default error
      // mapping turns any non-AppError into a generic 500 "Internal server
      // error", hiding this legitimate, expected validation message (a
      // duplicate serial scan is a normal occurrence, not a server fault)
      // from the technician. Now a proper 409 Conflict with the real message.
      if (existingItem.status === "DELIVERED") {
        throw new AppError(`المنتج (${cleanSerial}) موجود وحالته مغلق`, 409, true, "SERIAL_ALREADY_DELIVERED");
      } else {
        throw new AppError(`المنتج (${cleanSerial}) موجود مسبقاً وحالته نشط`, 409, true, "SERIAL_ALREADY_ACTIVE");
      }
    }

    const simCarrierMap: Record<string, string> = {
      mobilySim: "Mobily",
      stcSim: "STC",
      zainSim: "Zain",
      lebara: "Lebara",
      lebaraSim: "Lebara",
    };
    const carrierName = recognition.carrierName || (simCarrierMap[itemType] ?? null);

    // 3. create the item
    const [newItem] = await db
      .insert(items)
      .values({
        itemTypeId: actualItemTypeId,
        serialNumber: cleanSerial,
        barcode: cleanSerial,
        status: "RECEIVED_BY_TECHNICIAN",
        currentOwnerId: userId,
        warehouseId: null,
        carrierName,
      })
      .returning();

    const item = newItem;
    const prevStatus = "NONE";

    // 4. log transaction
    await db.insert(inventoryTransactions).values({
      itemId: item.id,
      transactionType: "INTAKE",
      destinationOwnerId: userId,
      notes: `مسح فردي - استلام العهدة (transfer: ${transferId})`,
    });

    await db.insert(itemHistoryLogs).values({
      itemId: item.id,
      fromStatus: prevStatus,
      toStatus: "RECEIVED_BY_TECHNICIAN",
      changedById: userId,
      notes: `تم المسح والاستلام الفردي`,
    });

    return {
      success: true,
      serialNumber: cleanSerial,
      itemId: item.id,
      message: `✓ تم استلام ${cleanSerial} بنجاح`,
    };
  }

  async confirmReceipt(userId: string, transferId: string, itemType: string, quantity: number, packagingType: string | null) {
    // ROOT FIX: this used to be a hardcoded, case-sensitive string list — broken
    // twice in production: "A960" (real device) was missing from the list, and
    // separately a Lebara SIM item type created via the admin panel with an
    // auto-generated UUID id ("ec4bf5c0-...") could never match any hardcoded
    // string at all. item_types.requiresSerial is the real, purpose-built,
    // always-correct source of truth for this — query it directly instead of
    // maintaining a parallel list that inevitably drifts out of sync with real
    // item-type data.
    const [itemTypeRow] = await db
      .select({ requiresSerial: itemTypes.requiresSerial })
      .from(itemTypes)
      .where(eq(itemTypes.id, itemType))
      .limit(1);
    const isSerialized = itemTypeRow?.requiresSerial ?? false;

    if (isSerialized) {
      const scannedItems = await db
        .select()
        .from(items)
        .where(
          and(
            eq(items.currentOwnerId, userId),
            eq(items.status, "RECEIVED_BY_TECHNICIAN"),
            eq(items.itemTypeId, itemType)
          )
        );

      const recentlyScanned = scannedItems.filter(item => {
        if (!item.createdAt) return false;
        const diff = Date.now() - new Date(item.createdAt).getTime();
        return diff < 48 * 60 * 60 * 1000;
      });

      if (recentlyScanned.length < quantity) {
        throw new AppError(
          `تم مسح ${recentlyScanned.length} فقط من أصل ${quantity} مطلوبة. أكمل المسح أولاً.`,
          400,
          true,
          "INCOMPLETE_SCAN"
        );
      }
    }

    const [transfer] = await db
      .select()
      .from(warehouseTransfers)
      .where(eq(warehouseTransfers.id, transferId))
      .limit(1);

    if (transfer && (transfer.status === 'pending' || transfer.status === 'in_transit')) {
      const { DrizzleInventoryUnitOfWork } = await import("../database/DrizzleInventoryUnitOfWork");
      const { processWarehouseTransferBatch } = await import("@modules/inventory/application/inventory/use-cases/warehouse-transfer-batch.processor");
      const unitOfWork = new DrizzleInventoryUnitOfWork();
      await unitOfWork.execute(async (context) => {
        await processWarehouseTransferBatch(context, [transferId]);
      });
    } else {
      await db.transaction(async (tx) => {
        await tx
          .update(warehouseTransfers)
          .set({ status: "approved", respondedAt: new Date() })
          .where(eq(warehouseTransfers.id, transferId));

        const [existingEntry] = await tx
          .select()
          .from(technicianMovingInventoryEntries)
          .where(
            and(
              eq(technicianMovingInventoryEntries.technicianId, userId),
              eq(technicianMovingInventoryEntries.itemTypeId, itemType)
            )
          )
          .limit(1);

        const isBoxes = packagingType === "box" || packagingType === "boxes";
        const addUnits = isBoxes ? 0 : quantity;
        const addBoxes = isBoxes ? quantity : 0;

        if (existingEntry) {
          await tx
            .update(technicianMovingInventoryEntries)
            .set({
              units: sql`${technicianMovingInventoryEntries.units} + ${addUnits}`,
              boxes: sql`${technicianMovingInventoryEntries.boxes} + ${addBoxes}`,
              updatedAt: new Date(),
            })
            .where(eq(technicianMovingInventoryEntries.id, existingEntry.id));
        } else {
          await tx.insert(technicianMovingInventoryEntries).values({
            technicianId: userId,
            itemTypeId: itemType,
            units: addUnits,
            boxes: addBoxes,
          });
        }
      });
    }

    return {
      success: true,
      message: "تم تأكيد استلام العهدة وتحديث المخزون المتحرك بنجاح",
    };
  }

  async getTechnicianSerializedItems(technicianId: string) {
    return await db
      .select({
        id: items.id,
        serialNumber: items.serialNumber,
        barcode: items.barcode,
        status: items.status,
        itemTypeId: items.itemTypeId,
        carrierName: items.carrierName,
        createdAt: items.createdAt,
        itemTypeName: itemTypes.nameAr,
        itemTypeCategory: itemTypes.category,
      })
      .from(items)
      .leftJoin(itemTypes, eq(items.itemTypeId, itemTypes.id))
      .where(
        and(
          eq(items.currentOwnerId, technicianId),
          inArray(items.status, [...ACTIVE_CUSTODY_STATUSES])
        )
      )
      .orderBy(items.createdAt);
  }

  async getTechnicianDeliveredItems(technicianId: string, itemTypeId?: string) {
    const conditions = [
      eq(custodyMovements.fromOwnerId, technicianId),
      inArray(custodyMovements.reason, ["DELIVERED", "DELIVERY"]),
    ];
    if (itemTypeId) {
      conditions.push(eq(items.itemTypeId, itemTypeId));
    }

    const delivered = await db
      .select({
        id: items.id,
        serialNumber: items.serialNumber,
        barcode: items.barcode,
        status: items.status,
        itemTypeId: items.itemTypeId,
        carrierName: items.carrierName,
        createdAt: items.createdAt,
        deliveredAt: custodyMovements.performedAt,
        referenceType: custodyMovements.referenceType,
        referenceId: custodyMovements.referenceId,
        notes: custodyMovements.notes,
        movementId: custodyMovements.id,
        itemTypeName: itemTypes.nameAr,
        itemTypeCategory: itemTypes.category,
      })
      .from(custodyMovements)
      .innerJoin(items, eq(custodyMovements.itemId, items.id))
      .leftJoin(itemTypes, eq(items.itemTypeId, itemTypes.id))
      .where(and(...conditions))
      .orderBy(desc(custodyMovements.performedAt));

    const seen = new Set<string>();
    return delivered.filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }

  async lookupItemBySerial(serialNumber: string) {
    const candidates = await SerialRecognitionService.buildStoredSerialCandidates(serialNumber);

    if (candidates.length === 0) {
      throw new AppError("الرقم التسلسلي فارغ بعد التنظيف", 400, true, "INVALID_SERIAL");
    }

    const [itemResult] = await db
      .select({
        id: items.id,
        serialNumber: items.serialNumber,
        status: items.status,
        itemTypeId: items.itemTypeId,
        carrierName: items.carrierName,
        createdAt: items.createdAt,
        updatedAt: items.updatedAt,
        itemTypeName: itemTypes.nameAr,
        itemTypeCategory: itemTypes.category,
        ownerId: items.currentOwnerId,
        ownerName: sql<string>`(SELECT full_name FROM users WHERE id = ${items.currentOwnerId})`,
        ownerUsername: sql<string>`(SELECT username FROM users WHERE id = ${items.currentOwnerId})`,
        ownerProfileImage: sql<string>`(SELECT profile_image FROM users WHERE id = ${items.currentOwnerId})`,
        ownerCity: sql<string>`(SELECT city FROM users WHERE id = ${items.currentOwnerId})`,
        ownerRegionName: sql<string>`(SELECT r.name FROM users u LEFT JOIN regions r ON u.region_id = r.id WHERE u.id = ${items.currentOwnerId})`,
        ownerPhone: sql<string>`(SELECT profile_data->>'phoneNumber' FROM employee_profiles WHERE user_id = ${items.currentOwnerId})`,
      })
      .from(items)
      .leftJoin(itemTypes, eq(items.itemTypeId, itemTypes.id))
      .where(inArray(items.serialNumber, candidates))
      .limit(1);

    if (!itemResult) return null;

    // Fetch Delivery / Closure / Last action info
    const [closureResult] = await db
      .select({
        closedById: custodyMovements.performedById,
        closedByName: sql<string>`(SELECT full_name FROM users WHERE id = ${custodyMovements.performedById})`,
        closedByUsername: sql<string>`(SELECT username FROM users WHERE id = ${custodyMovements.performedById})`,
        closedByProfileImage: sql<string>`(SELECT profile_image FROM users WHERE id = ${custodyMovements.performedById})`,
        deliveredAt: custodyMovements.performedAt,
        orderNumber: custodyMovements.notes,
      })
      .from(custodyMovements)
      .where(and(eq(custodyMovements.itemId, itemResult.id), inArray(custodyMovements.reason, ["DELIVERY", "DELIVERED"])))
      .orderBy(desc(custodyMovements.performedAt))
      .limit(1);

    // Fetch History Logs timeline for item lifecycle sequence
    const logs = await db
      .select({
        id: itemHistoryLogs.id,
        fromStatus: itemHistoryLogs.fromStatus,
        toStatus: itemHistoryLogs.toStatus,
        changedById: itemHistoryLogs.changedById,
        changedByName: sql<string>`(SELECT full_name FROM users WHERE id = ${itemHistoryLogs.changedById})`,
        changedByUsername: sql<string>`(SELECT username FROM users WHERE id = ${itemHistoryLogs.changedById})`,
        changedByProfileImage: sql<string>`(SELECT profile_image FROM users WHERE id = ${itemHistoryLogs.changedById})`,
        notes: itemHistoryLogs.notes,
        changedAt: itemHistoryLogs.changedAt,
      })
      .from(itemHistoryLogs)
      .where(eq(itemHistoryLogs.itemId, itemResult.id))
      .orderBy(desc(itemHistoryLogs.changedAt));

    return {
      ...itemResult,
      technicianId: itemResult.ownerId,
      technicianName: itemResult.ownerName,
      technicianUsername: itemResult.ownerUsername,
      technicianProfileImage: itemResult.ownerProfileImage,
      technicianCity: itemResult.ownerCity,
      technicianRegionName: itemResult.ownerRegionName,
      technicianPhone: itemResult.ownerPhone,
      closedById: closureResult?.closedById ?? null,
      closedByName: closureResult?.closedByName ?? null,
      closedByUsername: closureResult?.closedByUsername ?? null,
      closedByProfileImage: closureResult?.closedByProfileImage ?? null,
      deliveredAt: closureResult?.deliveredAt ?? itemResult.updatedAt,
      orderNumber: closureResult?.orderNumber ?? null,
      historyLogs: logs || [],
    };
  }

  /**
   * SECURITY FIX (backported from cert/db-backend-phase3-20260923 @
   * f5ce2328): this is an administrative override that can force ANY item
   * to any status regardless of who currently owns it. Previously the
   * route (requireAuth only) and this method both trusted the caller
   * implicitly -- any authenticated user, of any role, could call this
   * against an item they did not own. The route now also requires
   * requireAdmin, but per the "service must not assume route middleware
   * already proved authorization" contract, this method independently
   * re-verifies the caller's role fresh from the DB using only their id --
   * never a role/claim passed in as a parameter, which an internal/reused
   * call path could set incorrectly.
   *
   * callerId is the person who INITIATED this request (req.user.id) --
   * never confuse this with existing.currentOwnerId, the item's own
   * current custodian, which is a completely different concept. The two
   * remain intentionally separate below: callerId is who is recorded as
   * having performed the action (changedById/performedById); the
   * "existing.currentOwnerId || callerId" passed to
   * CustodyEngine.deliverItem/returnItem is not an authorization check --
   * it is the concurrency-safety row-consistency check those methods
   * already perform against their own FOR UPDATE-locked read, guarding
   * against the row having changed between this read and that lock, not
   * against an unauthorized caller (that boundary is enforced here,
   * before either method is ever reached).
   */
  async updateItemStatus(callerId: string, id: string, status: string, orderNumber?: string, warehouseId?: string) {
    const [caller] = await db.select().from(users).where(eq(users.id, callerId)).limit(1);
    if (!caller || caller.role !== "admin") {
      throw new AuthorizationError("هذا الإجراء متاح للأدمن فقط");
    }

    const [existing] = await db
      .select()
      .from(items)
      .where(eq(items.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundError("العنصر غير موجود");
    }

    await db.transaction(async (tx) => {
      if (status === "DELIVERED") {
        await CustodyEngine.deliverItem(
          id,
          orderNumber || "CLOSED-BY-ADMIN",
          existing.currentOwnerId || callerId,
          callerId,
          tx
        );
      } else if (status === "RETURNED") {
        await CustodyEngine.returnItem(
          id,
          warehouseId || existing.warehouseId || "primary-warehouse",
          existing.currentOwnerId || callerId,
          callerId,
          tx
        );
      } else {
        await tx
          .update(items)
          .set({
            status,
            updatedAt: new Date(),
          })
          .where(eq(items.id, id));

        await tx.insert(itemHistoryLogs).values({
          itemId: id,
          fromStatus: existing.status,
          toStatus: status,
          changedById: callerId,
          notes: `تغيير حالة مباشر بواسطة المشرف`,
        });
      }
    });

    return { success: true };
  }
}

export const warehouseTransferService = new WarehouseTransferService();
