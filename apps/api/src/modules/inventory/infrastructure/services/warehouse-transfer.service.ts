import { db } from "@core/config/db";
import { items, itemTypes, inventoryTransactions, itemHistoryLogs, warehouseTransfers, technicianMovingInventoryEntries, custodyMovements } from "@shared/schema";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import { CustodyEngine } from "./custody-engine";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";
import { ACTIVE_CUSTODY_STATUSES } from "../../domain/active-custody.policy";

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
      if (existingItem.status === "DELIVERED") {
        throw new Error(`المنتج (${cleanSerial}) موجود وحالته مغلق`);
      } else {
        throw new Error(`المنتج (${cleanSerial}) موجود مسبقاً وحالته نشط`);
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
    const serializedCategories = ["n950", "i9000s", "i9100", "mobilySim", "stcSim", "zainSim", "lebara", "lebaraSim"];
    const isSerialized = serializedCategories.includes(itemType);

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
        throw new Error(`تم مسح ${recentlyScanned.length} فقط من أصل ${quantity} مطلوبة. أكمل المسح أولاً.`);
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
      throw new Error("الرقم التسلسلي فارغ بعد التنظيف");
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

  async updateItemStatus(adminId: string, id: string, status: string, orderNumber?: string, warehouseId?: string) {
    const [existing] = await db
      .select()
      .from(items)
      .where(eq(items.id, id))
      .limit(1);

    if (!existing) {
      throw new Error("العنصر غير موجود");
    }

    await db.transaction(async (tx) => {
      if (status === "DELIVERED") {
        await CustodyEngine.deliverItem(
          id,
          orderNumber || "CLOSED-BY-ADMIN",
          existing.currentOwnerId || adminId,
          adminId,
          tx
        );
      } else if (status === "RETURNED") {
        await CustodyEngine.returnItem(
          id,
          warehouseId || existing.warehouseId || "primary-warehouse",
          existing.currentOwnerId || adminId,
          adminId,
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
          changedById: adminId,
          notes: `تغيير حالة مباشر بواسطة المشرف`,
        });
      }
    });

    return { success: true };
  }
}

export const warehouseTransferService = new WarehouseTransferService();
