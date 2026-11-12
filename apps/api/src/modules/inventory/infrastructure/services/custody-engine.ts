import { eq, and, sql } from "drizzle-orm";
import { db } from "../../../../core/config/db";
import { items, inventoryTransactions, itemHistoryLogs, custodyMovements, technicianMovingInventoryEntries } from "@shared/schema";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";
import { syncMovingInventory as syncMovingInventoryShared } from "../../contracts/moving-inventory-sync";

export class CustodyEngine {
  private static async syncMovingInventory(tx: any, technicianId: string, itemTypeId: string, delta: number) {
    return syncMovingInventoryShared(tx, technicianId, itemTypeId, delta);
  }

  /**
   * 1. استعلام لحظي عن الرقم التسلسلي S/N (يقبل الشكل الخام أو المخزَّن)
   */
  static async lookupItem(serialNumber: string, tx: any = db) {
    return SerialRecognitionService.findItemBySerial(serialNumber, tx);
  }

  /**
   * 2. مسح وتسجيل عهدة الجهاز للفني (Scan Intake)
   */
  static async scanItem(
    serialNumber: string,
    itemTypeId: string,
    technicianId: string,
    tx: any = db
  ) {
    const stored = await SerialRecognitionService.normalizeForStorage(serialNumber, itemTypeId, tx);
    const cleanSerial = stored.normalizedSerial;
    const actualTypeId = stored.itemTypeId;

    const existing = await this.lookupItem(cleanSerial, tx);

    if (existing) {
      if (existing.status === "DELIVERED") {
        throw new Error("المنتج موجود وحالته مغلق");
      } else {
        throw new Error("المنتج موجود مسبقاً وحالته نشط");
      }
    }

    // توليد باركود تلقائي مطابق للسيريال المخزَّن
    const [inserted] = await tx
      .insert(items)
      .values({
        itemTypeId: actualTypeId,
        serialNumber: cleanSerial,
        barcode: cleanSerial,
        status: "RECEIVED_BY_TECHNICIAN",
        currentOwnerId: technicianId,
        carrierName: stored.carrierName,
      })
      .returning({ id: items.id });

    // تسجيل الحركة
    await tx.insert(inventoryTransactions).values({
      itemId: inserted.id,
      transactionType: "INTAKE",
      destinationOwnerId: technicianId,
      notes: "تم إدخال جهاز جديد للعهدة لأول مرة بالمسح الميداني",
    });

    // تسجيل في دفتر العهدة الدائم (Custody Ledger)
    await tx.insert(custodyMovements).values({
      itemId: inserted.id,
      fromOwnerId: null,
      toOwnerId: technicianId,
      reason: "INTAKE",
      performedById: technicianId,
      notes: "إنشاء وتسجيل عهدة جديدة بالمسح الميداني",
    });

    await this.syncMovingInventory(tx, technicianId, actualTypeId, 1);

    return { id: inserted.id, action: "inserted" };
  }

  /**
   * 3. المعاملة الذرية لإغلاق المعاملة وتسليم الجهاز للعميل (Delivery/Install Closure)
   */
  static async deliverItem(
    itemId: string,
    orderNumber: string,
    technicianId: string,
    adminId: string,
    tx: any = db
  ) {
    // 1. استعلام للتحقق من وجود الجهاز والمالك الحالي
    const [item] = await tx
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1);

    if (!item) {
      throw new Error("الجهاز غير موجود بقواعد البيانات");
    }

    if (item.currentOwnerId !== technicianId) {
      throw new Error("الجهاز المطلوب تسليمه ليس في عهدة هذا الفني حالياً");
    }

    // 2. تحديث السيريال وتحرير العهدة
    await tx
      .update(items)
      .set({
        status: "DELIVERED",
        currentOwnerId: null, // تحرير ملكية الفني للعهدة
        updatedAt: new Date(),
      })
      .where(eq(items.id, itemId));

    // 3. تسجيل حركة المخزون التاريخية
    await tx.insert(inventoryTransactions).values({
      itemId,
      transactionType: "DELIVERY",
      sourceOwnerId: technicianId,
      destinationOwnerId: null,
      orderNumber,
      notes: "تسليم الجهاز للعميل وإغلاق العهدة الخاصة بالفني بنجاح",
    });

    // 4. كتابة سجل الرقابة التاريخي (Audit Log)
    await tx.insert(itemHistoryLogs).values({
      itemId,
      fromStatus: item.status,
      toStatus: "DELIVERED",
      changedById: adminId,
      notes: `تم الإغلاق والاعتماد الذري بواسطة المشرف (معرف: ${adminId})`,
    });

    // 5. تسجيل في دفتر العهدة الدائم (Custody Ledger)
    await tx.insert(custodyMovements).values({
      itemId,
      fromOwnerId: technicianId,
      toOwnerId: null,
      reason: "DELIVERED",
      referenceType: "COURIER_REQUEST",
      referenceId: orderNumber,
      performedById: adminId,
      notes: "تسليم العهدة وتحرير الفني بنجاح",
    });

    if (item.currentOwnerId) {
      await this.syncMovingInventory(tx, item.currentOwnerId, item.itemTypeId, -1);
    }

    return { success: true };
  }

  /**
   * 4. إرجاع العهدة للمستودع الرئيسي (Return Transfer)
   */
  static async returnItem(
    itemId: string,
    warehouseId: string,
    technicianId: string,
    adminId: string,
    tx: any = db
  ) {
    const [item] = await tx
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1);

    if (!item) {
      throw new Error("الجهاز غير موجود بقواعد البيانات");
    }

    // 1. تحديث حالة وموقع الصنف
    await tx
      .update(items)
      .set({
        status: "RETURNED",
        currentOwnerId: null,
        warehouseId,
        updatedAt: new Date(),
      })
      .where(eq(items.id, itemId));

    // 2. تسجيل حركة المخزون التاريخية
    await tx.insert(inventoryTransactions).values({
      itemId,
      transactionType: "TRANSFER",
      sourceOwnerId: technicianId,
      destinationWarehouseId: warehouseId,
      notes: "تم إرجاع الجهاز للمستودع الرئيسي وتطهير عهدة المندوب",
    });

    // 3. كتابة سجل الرقابة
    await tx.insert(itemHistoryLogs).values({
      itemId,
      fromStatus: item.status,
      toStatus: "RETURNED",
      changedById: adminId,
      notes: `إرجاع عهدة معتمد من المشرف (معرف: ${adminId})`,
    });

    // 4. تسجيل في دفتر العهدة الدائم (Custody Ledger)
    await tx.insert(custodyMovements).values({
      itemId,
      fromOwnerId: technicianId,
      toOwnerId: null,
      fromWarehouseId: null,
      toWarehouseId: warehouseId,
      reason: "RETURNED",
      performedById: adminId,
      notes: "إرجاع الأصل للمستودع وتطهير عهدة الفني",
    });

    if (item.currentOwnerId) {
      await this.syncMovingInventory(tx, item.currentOwnerId, item.itemTypeId, -1);
    }

    return { success: true };
  }
}
