import { eq, and, sql } from "drizzle-orm";
import { db } from "../../../../core/config/db";
import { items, inventoryTransactions, itemHistoryLogs, custodyMovements, technicianMovingInventoryEntries } from "@shared/schema";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";

export class CustodyEngine {
  private static async syncMovingInventory(tx: any, technicianId: string, itemTypeId: string, delta: number) {
    if (!technicianId || !itemTypeId || delta === 0) return;

    const [existingEntry] = await tx
      .select()
      .from(technicianMovingInventoryEntries)
      .where(
        and(
          eq(technicianMovingInventoryEntries.technicianId, technicianId),
          eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
        )
      )
      .limit(1);

    if (existingEntry) {
      const newUnits = Math.max(0, existingEntry.units + delta);
      await tx
        .update(technicianMovingInventoryEntries)
        .set({
          units: newUnits,
          updatedAt: new Date(),
        })
        .where(eq(technicianMovingInventoryEntries.id, existingEntry.id));
    } else if (delta > 0) {
      await tx.insert(technicianMovingInventoryEntries).values({
        technicianId,
        itemTypeId,
        units: delta,
        boxes: 0,
      });
    }
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
    // D5-class fix (same defect class fixed in returnItem below): a plain
    // unlocked SELECT here let two concurrent deliverItem calls for the
    // SAME item both read currentOwnerId===technicianId as true before
    // either wrote, then both proceed to write -- double delivery, double
    // inventoryTransactions/custodyMovements rows, double
    // syncMovingInventory decrement. FOR UPDATE closes that race window.
    const [item] = await tx
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1)
      .for("update");

    if (!item) {
      throw new Error("الجهاز غير موجود بقواعد البيانات");
    }

    // Explicit split null-owner vs wrong-owner rejection, no fallthrough
    // -- matches returnItem's D5 fix exactly.
    if (item.currentOwnerId === null) {
      throw new Error("الجهاز غير موجود حالياً في عهدة أي فني (تم تسليمه مسبقاً أو لم يُستلم بعد)");
    }
    if (item.currentOwnerId !== technicianId) {
      throw new Error("الجهاز المطلوب تسليمه ليس في عهدة هذا الفني حالياً");
    }

    // 2. تحديث السيريال وتحرير العهدة -- CAS defense-in-depth فوق FOR UPDATE:
    // الشرط يعيد التحقق من currentOwnerId وقت الكتابة نفسه، فإن خسر طرف
    // متزامن السباق فإن UPDATE يطابق صفر صفوف ويُرفض أدناه.
    const [updatedItem] = await tx
      .update(items)
      .set({
        status: "DELIVERED",
        currentOwnerId: null, // تحرير ملكية الفني للعهدة
        updatedAt: new Date(),
      })
      .where(and(eq(items.id, itemId), eq(items.currentOwnerId, technicianId)))
      .returning({ id: items.id });

    if (!updatedItem) {
      throw new Error("فشل تسليم الجهاز — تم تغيير حالة العهدة بواسطة عملية أخرى بالتزامن");
    }

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
      .limit(1)
      .for("update");

    if (!item) {
      throw new Error("الجهاز غير موجود بقواعد البيانات");
    }

    // D5 fix (backported from cert/db-backend-phase3-20260923 @ 2758a42e):
    // the locked row is authoritative, and a return is valid ONLY while
    // the item is currently owned by the requesting technician -- an
    // explicit equality check, not a nullable-owner conditional. A null
    // owner (already returned / never received) is a distinct rejection
    // reason from a non-null, non-matching owner; neither reaches a
    // write via fallthrough.
    if (item.currentOwnerId === null) {
      throw new Error("الجهاز غير موجود حالياً في عهدة أي فني (تم إرجاعه مسبقاً أو لم يُستلم بعد)");
    }
    if (item.currentOwnerId !== technicianId) {
      throw new Error("الجهاز المطلوب إرجاعه ليس في عهدة هذا الفني حالياً");
    }

    // 1. تحديث حالة وموقع الصنف
    // D5 fix: CAS defense-in-depth on top of the FOR UPDATE lock and the
    // pre-check above -- the WHERE clause re-asserts currentOwnerId at
    // write time (matching the existing DB-R9 pattern in
    // DrizzleCourierRepository.transferCustodyToTechnician). A losing
    // concurrent request's UPDATE matches zero rows and is rejected here.
    const [updatedItem] = await tx
      .update(items)
      .set({
        status: "RETURNED",
        currentOwnerId: null,
        warehouseId,
        updatedAt: new Date(),
      })
      .where(and(eq(items.id, itemId), eq(items.currentOwnerId, technicianId)))
      .returning({ id: items.id });

    if (!updatedItem) {
      throw new Error("فشل إرجاع الجهاز — تم تغيير حالة العهدة بواسطة عملية أخرى بالتزامن");
    }

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
