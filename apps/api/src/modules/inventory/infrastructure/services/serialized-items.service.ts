import { db } from "@core/config/db";
import { AppError, NotFoundError } from "@core/errors/AppError";
import { items, inventoryTransactions, itemHistoryLogs, itemTypes, users, custodyMovements, technicianMovingInventoryEntries, courierRequestItems, systemLogs } from "@shared/schema";
import { eq, and, inArray, sql, or, desc } from "drizzle-orm";
import { SerialRecognitionService } from "./serial-recognition.service";
import { ACTIVE_CUSTODY_STATUSES, isActiveCustodyStatus } from "../../domain/active-custody.policy";

/** Item is considered "held" by a technician in one of these statuses. */
// Active custody: the one shared definition (ActiveCustodyPolicy).
/** courier_request_items statuses that mean the request is finished (safe to ignore for the active-relation guard). */
const TERMINAL_COURIER_REQUEST_STATUSES = ["DELIVERED", "REJECTED", "MISSING"];
/** Public itemType URL segment (DEVICE|SIM) → real item_types.category value. No other values are accepted. */
const CUSTODY_DELETE_ITEM_TYPE_TO_CATEGORY: Record<string, string> = {
  DEVICE: "devices",
  SIM: "sim",
};
/** custody_movements.reason values that mean "this technician delivered this item to a customer". */
const DELIVERY_CUSTODY_MOVEMENT_REASONS = ["DELIVERED", "DELIVERY"];

export class SerializedItemsService {
  /**
   * ROOT FIX (TEMP-SYSTEM-STABILIZATION) — this was a read → JS arithmetic → write
   * with no row lock, on a table with NO unique constraint on (technicianId,
   * itemTypeId). Two concurrent deletes/scans for the same technician+itemType could
   * either lose an update (both read the same starting value) or create duplicate
   * rows (both see "no existing entry" and both insert). Fixed with a transaction-
   * scoped Postgres advisory lock keyed on (technicianId, itemTypeId) — it fully
   * serializes concurrent callers for that exact pair without requiring a schema
   * migration (this table has no such duplicate data), and auto-releases on
   * commit/rollback. The increment itself is also done as atomic SQL arithmetic
   * rather than JS, so the row's own value can never be read twice.
   */
  private async syncMovingInventory(tx: any, technicianId: string, itemTypeId: string, delta: number) {
    if (!technicianId || !itemTypeId || delta === 0) return;

    // Serialize all concurrent callers for this exact (technicianId, itemTypeId) pair.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${technicianId} || ':' || ${itemTypeId}))`
    );

    const [existingEntry] = await tx
      .select({ id: technicianMovingInventoryEntries.id })
      .from(technicianMovingInventoryEntries)
      .where(
        and(
          eq(technicianMovingInventoryEntries.technicianId, technicianId),
          eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
        )
      )
      .limit(1);

    if (existingEntry) {
      await tx
        .update(technicianMovingInventoryEntries)
        .set({
          units: sql`GREATEST(0, ${technicianMovingInventoryEntries.units} + ${delta})`,
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
   * Scan-in (Add Custody)
   */
  async scanIn(
    technicianId: string,
    serialNumber: string,
    itemTypeId: string,
    carrierName?: string,
    simPackageType?: string
  ) {
    return await db.transaction(async (tx: any) => {
      // Central Serial Engine: normalize → identify → validate
      const recognition = await SerialRecognitionService.normalizeForStorage(serialNumber, itemTypeId, tx);
      const cleanSerial = recognition.normalizedSerial;
      const actualItemTypeId = recognition.itemTypeId;
      const actualCarrierName = carrierName || recognition.carrierName;

      // Check if item already exists
      const [existingItem] = await tx
        .select()
        .from(items)
        .where(eq(items.serialNumber, cleanSerial))
        .limit(1);

      if (existingItem) {
        if (existingItem.status === "DELIVERED") {
          throw new AppError("المنتج موجود وحالته مغلق", 400);
        } else {
          throw new AppError("المنتج موجود مسبقاً وحالته نشط", 400);
        }
      }

      // Create new item
      const [newItem] = await tx
        .insert(items)
        .values({
          itemTypeId: actualItemTypeId,
          serialNumber: cleanSerial,
          barcode: cleanSerial, // default barcode to cleanSerial
          status: "IN_TRANSIT_CUSTODY",
          currentOwnerId: technicianId,
          warehouseId: null,
          carrierName: actualCarrierName,
          simPackageType: simPackageType || null,
        })
        .returning();

      if (!newItem) {
        throw new Error("فشل إنشاء سجل للمادة المسلسلة");
      }
      const item = newItem;
      const previousStatus = "NONE";

      // Log transaction
      await tx.insert(inventoryTransactions).values({
        itemId: item.id,
        transactionType: "INTAKE",
        destinationOwnerId: technicianId,
        notes: `تم إضافة العهدة للمندوب بواسطة مسح الباركود`,
      });

      // Log history
      await tx.insert(itemHistoryLogs).values({
        itemId: item.id,
        fromStatus: previousStatus,
        toStatus: "IN_TRANSIT_CUSTODY",
        changedById: technicianId,
        notes: "تم استلام العهدة في سيارة/حقيبة الفني",
      });

      // Log to Custody Ledger (custodyMovements)
      await tx.insert(custodyMovements).values({
        itemId: item.id,
        fromOwnerId: null,
        toOwnerId: technicianId,
        reason: "INTAKE",
        performedById: technicianId,
        notes: "استلام عهدة بالمسح الميداني",
      });

      await this.syncMovingInventory(tx, technicianId, actualItemTypeId, 1);

      return item;
    });
  }

  /**
   * Batch Scan-in (Add Multiple Custodies)
   */
  async batchScanIn(
    technicianId: string,
    scannedItems: Array<{
      serialNumber: string;
      itemTypeId: string;
      carrierName?: string;
      simPackageType?: string;
    }>
  ) {
    // Validate uniqueness of serial numbers in the batch after normalization
    const cleanSerialsList = scannedItems.map(s => SerialRecognitionService.normalizeRawBarcode(s.serialNumber));
    const uniqueSerials = new Set(cleanSerialsList);
    if (uniqueSerials.size !== scannedItems.length) {
      throw new AppError("توجد أرقام تسلسلية مكررة في الدفعة المرسلة بعد التنظيف", 400);
    }

    return await db.transaction(async (tx: any) => {
      const results = [];

      for (const scanned of scannedItems) {
        const { serialNumber, itemTypeId, carrierName, simPackageType } = scanned;

        // التعرف على السيريال والتحقق من صحته
        const recognition = await SerialRecognitionService.recognize(serialNumber, itemTypeId, tx);
        const cleanSerial = recognition.normalizedSerial;
        const actualItemTypeId = recognition.itemTypeId;
        const actualCarrierName = carrierName || recognition.carrierName;

        // Check if item already exists
        const [existingItem] = await tx
          .select()
          .from(items)
          .where(eq(items.serialNumber, cleanSerial))
          .limit(1);

        if (existingItem) {
          if (existingItem.status === "DELIVERED") {
            throw new AppError(`المنتج موجود وحالته مغلق (${cleanSerial})`, 400);
          } else {
            throw new AppError(`المنتج موجود مسبقاً وحالته نشط (${cleanSerial})`, 400);
          }
        }

        // Create new item — status RECEIVED_BY_TECHNICIAN (direct batch receipt)
        const [newItem] = await tx
          .insert(items)
          .values({
            itemTypeId: actualItemTypeId,
            serialNumber: cleanSerial,
            barcode: cleanSerial,
            status: "RECEIVED_BY_TECHNICIAN",
            currentOwnerId: technicianId,
            warehouseId: null,
            carrierName: actualCarrierName,
            simPackageType: simPackageType || null,
          })
          .returning();

        if (!newItem) {
          throw new Error(`فشل إنشاء سجل للمادة المسلسلة: ${cleanSerial}`);
        }
        const item = newItem;
        const previousStatus = "NONE";
        const previousOwnerId = null;

        // Log transaction
        await tx.insert(inventoryTransactions).values({
          itemId: item.id,
          transactionType: "INTAKE",
          destinationOwnerId: technicianId,
          notes: `تم إضافة العهدة للمندوب بواسطة مسح الباركود (دفعة واحدة)`,
        });

        // Log history
        await tx.insert(itemHistoryLogs).values({
          itemId: item.id,
          fromStatus: previousStatus,
          toStatus: "RECEIVED_BY_TECHNICIAN",
          changedById: technicianId,
          notes: "تم استلام العهدة مباشرة من قبل الفني (دفعة واحدة)",
        });

        // Log to Custody Ledger (custodyMovements)
        await tx.insert(custodyMovements).values({
          itemId: item.id,
          fromOwnerId: previousOwnerId,
          toOwnerId: technicianId,
          reason: previousOwnerId ? "TRANSFER" : "INTAKE",
          performedById: technicianId,
          notes: "استلام عهدة بالمسح الميداني (دفعة واحدة)",
        });

        await this.syncMovingInventory(tx, technicianId, actualItemTypeId, 1);

        results.push(item);
      }

      return results;
    });
  }

  /**
   * Scan-out (Deliver Custody / Checkout)
   */
  async scanOut(
    technicianId: string,
    serialNumber: string,
    receiverName: string,
    orderNumber: string,
    latitude?: number,
    longitude?: number,
    externalTx?: any
  ) {
    // OPS-REMED-E3: when an external transaction is supplied (by the courier
    // multi-asset deduction path via InventoryEngine), join it instead of
    // opening an independent transaction, so this write rolls back together
    // with every other asset in the same request. When omitted (the
    // standalone /api/serialized-items/scan-out HTTP endpoint), behavior is
    // unchanged — this method opens its own transaction as before.
    const runBody = async (tx: any) => {
      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(serialNumber, undefined, tx);
      if (candidates.length === 0) {
        throw new Error("الرقم التسلسلي فارغ بعد التنظيف");
      }

      // Find the item in technician's custody (prefixed or stored form).
      // OPS-REMED-E3: locked with FOR UPDATE — two concurrent scanOut calls
      // for the same physical asset (same request submitted twice, or a
      // genuine race) must never both succeed. Without the lock, both
      // transactions see the same pre-commit snapshot under READ COMMITTED
      // and both pass this check, producing a silent double deduction. The
      // second transaction now blocks here until the first commits, then
      // this SELECT re-runs against the post-commit state and correctly
      // finds nothing (status already DELIVERED) — same pattern already
      // used by deleteFromTechnicianCustody below.
      //
      // ROOT FIX: the same lock closes the double-tap/two-request race on
      // the exact serial so only one transaction can transition it out of
      // active technician custody.
      const [item] = await tx
        .select()
        .from(items)
        .where(
          and(
            inArray(items.serialNumber, candidates),
            eq(items.currentOwnerId, technicianId),
            inArray(items.status, [...ACTIVE_CUSTODY_STATUSES])
          )
        )
        .limit(1)
        .for("update");

      if (!item) {
        throw new Error("المادة غير موجودة في عهرتك النشطة أو الرقم التسلسلي غير مطابق");
      }

      // Update item to DELIVERED — WHERE re-checks status/owner (not just
      // id) as defense-in-depth alongside the FOR UPDATE lock above: this
      // statement only ever "succeeds" against the exact row state just
      // locked and verified, never a stale id alone.
      const [updatedItem] = await tx
        .update(items)
        .set({
          status: "DELIVERED",
          currentOwnerId: null, // delivered to customer
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(items.id, item.id),
            eq(items.currentOwnerId, technicianId),
            // same active-custody set the SELECT above locked the row under
            inArray(items.status, [...ACTIVE_CUSTODY_STATUSES])
          )
        )
        .returning();

      if (!updatedItem) {
        throw new Error("فشل إتمام عملية تسليم المادة");
      }

      // Log transaction
      await tx.insert(inventoryTransactions).values({
        itemId: item.id,
        transactionType: "DELIVERY",
        sourceOwnerId: technicianId,
        receiverName,
        orderNumber,
        latitude: latitude || null,
        longitude: longitude || null,
        notes: `تم تسليم العهدة للعميل والتركيب بنجاح`,
      });

      // Log history
      await tx.insert(itemHistoryLogs).values({
        itemId: item.id,
        fromStatus: item.status,
        toStatus: "DELIVERED",
        changedById: technicianId,
        notes: `تم تسليم العهدة وتثبيتها للعميل: ${receiverName}`,
      });

      // Log to Custody Ledger (custodyMovements)
      await tx.insert(custodyMovements).values({
        itemId: item.id,
        fromOwnerId: technicianId,
        toOwnerId: null,
        reason: "DELIVERED",
        referenceType: "COURIER_REQUEST",
        referenceId: orderNumber,
        performedById: technicianId,
        latitude: latitude || null,
        longitude: longitude || null,
        notes: `تسليم العهدة للعميل: ${receiverName}`,
      });

      await this.syncMovingInventory(tx, technicianId, item.itemTypeId, -1);

      return updatedItem;
    };

    if (externalTx) {
      return runBody(externalTx);
    }
    return await db.transaction(runBody);
  }

  /**
   * TEMPORARY FEATURE — remove or disable after final customer handover.
   *
   * Permanently deletes a single serialized item from the *authenticated* technician's
   * own active custody. Ownership is re-derived from `items.currentOwnerId` inside a
   * locked transaction — the caller-supplied technicianId always comes from req.user
   * (JWT/session), never from the request body.
   */
  async deleteFromTechnicianCustody(
    technicianId: string,
    technicianUsername: string,
    technicianRole: string,
    rawItemType: string,
    rawSerialNumber: string,
    confirmation: string,
    reason?: string
  ) {
    const itemType = (rawItemType || "").trim().toUpperCase();
    const expectedCategory = CUSTODY_DELETE_ITEM_TYPE_TO_CATEGORY[itemType];
    if (!expectedCategory) {
      throw new AppError(
        "نوع العنصر يجب أن يكون DEVICE أو SIM فقط",
        400,
        true,
        "INVALID_ITEM_TYPE"
      );
    }

    const trimmedInput = (rawSerialNumber || "").trim();
    const trimmedConfirmation = (confirmation || "").trim();
    const auditReason = (reason || "").trim() || "temporary_cleanup_before_customer_handover";

    if (!trimmedInput) {
      throw new AppError("الرقم التسلسلي مطلوب", 400, true, "INVALID_SERIAL");
    }

    if (!trimmedConfirmation || trimmedConfirmation !== trimmedInput) {
      throw new AppError(
        "رقم التأكيد لا يطابق الرقم التسلسلي المطلوب حذفه",
        400,
        true,
        "CONFIRMATION_MISMATCH"
      );
    }

    return await db.transaction(async (tx: any) => {
      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(
        trimmedInput,
        undefined,
        tx
      );

      if (candidates.length === 0) {
        throw new AppError("الرقم التسلسلي غير صالح", 400, true, "INVALID_SERIAL");
      }

      // Lock the target row for the duration of the transaction to prevent concurrent
      // custody transfer / delivery while we validate and delete it.
      const [item] = await tx
        .select()
        .from(items)
        .where(inArray(items.serialNumber, candidates))
        .for("update");

      if (!item) {
        // Idempotency: a retried request after a prior *successful* delete should not
        // error out — it should clearly report the item as already deleted, without
        // touching inventory again or creating a new audit entry.
        const [priorDeletion] = await tx
          .select({ id: systemLogs.id })
          .from(systemLogs)
          .where(
            and(
              eq(systemLogs.entityType, "item"),
              eq(systemLogs.entityName, trimmedInput),
              eq(systemLogs.action, "delete_custody_serial"),
              eq(systemLogs.userId, technicianId),
              eq(systemLogs.success, true)
            )
          )
          .orderBy(desc(systemLogs.createdAt))
          .limit(1);

        if (priorDeletion) {
          return {
            itemType,
            serialNumber: trimmedInput,
            deleted: true,
            alreadyDeleted: true,
          };
        }

        throw new NotFoundError("العنصر غير موجود في النظام");
      }

      // Custody check: never trust a client-supplied owner id — compare against the
      // row we just locked. Do not reveal who the actual current owner is.
      if (item.currentOwnerId !== technicianId || !isActiveCustodyStatus(item.status)) {
        throw new AppError(
          "لا يمكنك حذف عنصر غير موجود في عهدتك",
          403,
          true,
          "ITEM_NOT_IN_YOUR_CUSTODY"
        );
      }

      const [itemTypeRow] = await tx
        .select({ nameAr: itemTypes.nameAr, nameEn: itemTypes.nameEn, category: itemTypes.category })
        .from(itemTypes)
        .where(eq(itemTypes.id, item.itemTypeId))
        .limit(1);

      // The URL's itemType (DEVICE/SIM) must match what this serial actually is —
      // never let a mismatched type segment delete (or even confirm the existence of)
      // an item of a different kind.
      if (itemTypeRow?.category !== expectedCategory) {
        throw new NotFoundError(
          itemType === "SIM"
            ? "لا توجد شريحة بهذا الرقم في عهدتك"
            : "لا يوجد جهاز بهذا الرقم في عهدتك"
        );
      }

      // Active-operation guard: an open courier delivery/installation request for this
      // exact serial blocks deletion entirely (no cascade, no partial cleanup).
      const linkedCourierRows = await tx
        .select({ status: courierRequestItems.status })
        .from(courierRequestItems)
        .where(inArray(courierRequestItems.serialNumber, candidates));

      const hasActiveCourierRequest = linkedCourierRows.some(
        (row: any) => !TERMINAL_COURIER_REQUEST_STATUSES.includes(row.status)
      );

      if (hasActiveCourierRequest) {
        throw new AppError(
          "لا يمكن حذف العنصر لارتباطه بعملية نشطة",
          409,
          true,
          "ITEM_HAS_ACTIVE_RELATIONS"
        );
      }

      // Durable audit record FIRST. system_logs.entityId/entityName carry no foreign key
      // to items.id, so this row survives the cascade delete of the item's own
      // inventory_transactions / item_history_logs / custody_movements rows below.
      await tx.insert(systemLogs).values({
        userId: technicianId,
        userName: technicianUsername,
        userRole: technicianRole,
        action: "delete_custody_serial",
        entityType: "item",
        entityId: item.id,
        entityName: item.serialNumber,
        details: JSON.stringify({
          itemType,
          itemId: item.id,
          serialNumber: item.serialNumber,
          itemTypeId: item.itemTypeId,
          itemTypeNameAr: itemTypeRow?.nameAr,
          itemTypeNameEn: itemTypeRow?.nameEn,
          category: itemTypeRow?.category,
          previousStatus: item.status,
          previousOwnerId: item.currentOwnerId,
          warehouseId: item.warehouseId,
          reason: auditReason,
          affectedTables: [
            "items",
            "inventory_transactions",
            "item_history_logs",
            "custody_movements",
            "technician_moving_inventory_entries",
          ],
        }),
        description: `تم حذف ${itemType === "SIM" ? "الشريحة" : "الجهاز"} ${item.serialNumber} نهائيًا من عهدة الفني (ميزة مؤقتة قبل التسليم النهائي للعميل)`,
        severity: "warn",
        success: true,
      });

      const deletedRows = await tx.delete(items).where(eq(items.id, item.id)).returning();
      if (!deletedRows || deletedRows.length === 0) {
        throw new Error("فشل حذف العنصر");
      }

      // Recalculate the technician's moving-inventory balance via the same official
      // path used by scanIn/scanOut — never decrement counters with raw SQL.
      await this.syncMovingInventory(tx, technicianId, item.itemTypeId, -1);

      return {
        itemType,
        serialNumber: item.serialNumber,
        deleted: true,
        alreadyDeleted: false,
      };
    });
  }

  /**
   * ADMIN hard delete of a serialized item by its own database id — used by the
   * technician-item-details admin page. Unlike deleteFromTechnicianCustody, this is
   * not restricted to the caller's own custody (an admin may delete any technician's
   * item), takes the row's real id directly (no serial-recognition ambiguity), and the
   * confirmation UX is the caller's own AlertDialog rather than a retyped serial.
   * Carries the same safeguards: active-courier-relation guard, audit-first, cascade
   * delete, and official moving-inventory resync.
   *
   * UNCHANGED from before the technicianDeleteOwnSerializedItem feature below was
   * added — deliberately NOT refactored to share code with it. The small amount of
   * overlapping logic is duplicated in technicianDeleteOwnSerializedItem instead of
   * extracting a shared helper, so this admin path's production code/behavior stays
   * byte-for-byte what it was.
   */
  async adminDeleteSerializedItemById(
    adminId: string,
    adminUsername: string,
    adminRole: string,
    itemId: string,
    reason?: string
  ) {
    const auditReason = (reason || "").trim() || "admin_hard_delete";

    return await db.transaction(async (tx: any) => {
      const [item] = await tx
        .select()
        .from(items)
        .where(eq(items.id, itemId))
        .for("update");

      if (!item) {
        throw new NotFoundError("العنصر غير موجود");
      }

      const [itemTypeRow] = await tx
        .select({ nameAr: itemTypes.nameAr, nameEn: itemTypes.nameEn, category: itemTypes.category })
        .from(itemTypes)
        .where(eq(itemTypes.id, item.itemTypeId))
        .limit(1);

      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(
        item.serialNumber,
        undefined,
        tx
      );

      const linkedCourierRows = candidates.length
        ? await tx
            .select({ status: courierRequestItems.status })
            .from(courierRequestItems)
            .where(inArray(courierRequestItems.serialNumber, candidates))
        : [];

      const hasActiveCourierRequest = linkedCourierRows.some(
        (row: any) => !TERMINAL_COURIER_REQUEST_STATUSES.includes(row.status)
      );

      if (hasActiveCourierRequest) {
        throw new AppError(
          "لا يمكن حذف العنصر لارتباطه بعملية نشطة",
          409,
          true,
          "ITEM_HAS_ACTIVE_RELATIONS"
        );
      }

      await tx.insert(systemLogs).values({
        userId: adminId,
        userName: adminUsername,
        userRole: adminRole,
        action: "admin_delete_serialized_item",
        entityType: "item",
        entityId: item.id,
        entityName: item.serialNumber,
        details: JSON.stringify({
          itemId: item.id,
          serialNumber: item.serialNumber,
          itemTypeId: item.itemTypeId,
          itemTypeNameAr: itemTypeRow?.nameAr,
          itemTypeNameEn: itemTypeRow?.nameEn,
          category: itemTypeRow?.category,
          previousStatus: item.status,
          previousOwnerId: item.currentOwnerId,
          warehouseId: item.warehouseId,
          reason: auditReason,
          affectedTables: [
            "items",
            "inventory_transactions",
            "item_history_logs",
            "custody_movements",
            "technician_moving_inventory_entries",
          ],
        }),
        description: `حذف الأدمن ${itemTypeRow?.category === "sim" ? "الشريحة" : "الجهاز"} ${item.serialNumber} نهائيًا من عهدة الفني`,
        severity: "warn",
        success: true,
      });

      const deletedRows = await tx.delete(items).where(eq(items.id, item.id)).returning();
      if (!deletedRows || deletedRows.length === 0) {
        throw new Error("فشل حذف العنصر");
      }

      if (item.currentOwnerId && isActiveCustodyStatus(item.status)) {
        await this.syncMovingInventory(tx, item.currentOwnerId, item.itemTypeId, -1);
      }

      return {
        itemId: item.id,
        serialNumber: item.serialNumber,
        deleted: true,
      };
    });
  }

  /**
   * TEMPORARY FEATURE — remove after final inventory workflow is released.
   *
   * Lets the *authenticated* technician permanently delete a single serialized
   * item (device/SIM) by its own database id — either one they currently hold,
   * or one they themselves already delivered — as a stopgap until the real
   * inventory-workflow rewrite (separate track) ships.
   *
   * Order of operations is deliberate: Authentication (the caller's identity,
   * already established by requireAuth before this is ever invoked, and taken
   * only from req.user — never from anything the client's request body/Flutter
   * app supplies) → Ownership verification (below, against the row this
   * transaction just locked) → the same delete logic adminDeleteSerializedItemById
   * uses. Deliberately does NOT call adminDeleteSerializedItemById or share a
   * helper with it — the small amount of overlapping logic (courier-relation
   * guard, audit log, delete, conditional resync) is duplicated here on purpose,
   * so admin's existing production code path is never touched by this feature.
   *
   * Ownership is re-derived from the database, never trusted from the client:
   *   - Actively-held item (status in TECHNICIAN_HELD_STATUSES): the locked
   *     row's `currentOwnerId` must equal this technician's id.
   *   - DELIVERED item (currentOwnerId is NULL by then — scanOut/custody-engine
   *     already cleared it at delivery time): ownership is proven via the
   *     custody_movements ledger — but specifically the MOST RECENT
   *     delivery-reason movement recorded for this exact item, not just any
   *     historical row naming this technician. A serial can pass through
   *     multiple technicians over its lifetime (custody transfers, or an
   *     earlier delivery that was later reversed and redelivered); only the
   *     single movement that actually produced the CURRENT "DELIVERED" state
   *     is authoritative. If technician A once delivered this exact item but
   *     it was later returned, transferred to technician B, and B performed
   *     the delivery that produced today's DELIVERED status, A must get 403
   *     even though A's name still appears somewhere in this item's history.
   * Any other case (wrong technician, or a status that is neither actively
   * held nor DELIVERED, e.g. RETURNED/WITHDRAWN) is rejected — 403
   * ITEM_NOT_IN_YOUR_CUSTODY — without revealing who the real owner is.
   *
   * Quantity behavior is byte-for-byte the same conditional rule
   * adminDeleteSerializedItemById already used: decrement by 1 only when the
   * item was actively held at deletion time. A DELIVERED item is deleted with
   * NO further decrement — scanOut/custody-engine already decremented moving
   * inventory once, at delivery time, so this never double-decrements (9
   * delivered devices deleted here must still read as 9, not 8, on both this
   * app and the main system).
   *
   * Does NOT touch scanOut, custody-engine, or the delivery mechanism at all.
   */
  async technicianDeleteOwnSerializedItem(
    technicianId: string,
    technicianUsername: string,
    technicianRole: string,
    itemId: string,
    reason?: string
  ) {
    const auditReason = (reason || "").trim() || "technician_cleanup_before_final_workflow";

    return await db.transaction(async (tx: any) => {
      // Lock the target row for the duration of the transaction — a concurrent
      // scan-out/transfer/second-delete-attempt for the same row must serialize
      // behind this one, not race it.
      const [item] = await tx
        .select()
        .from(items)
        .where(eq(items.id, itemId))
        .for("update");

      if (!item) {
        throw new NotFoundError("العنصر غير موجود");
      }

      const isActivelyHeldByThisTechnician =
        item.currentOwnerId === technicianId && isActiveCustodyStatus(item.status);

      let ownershipVerified = isActivelyHeldByThisTechnician;

      if (!ownershipVerified && item.status === "DELIVERED") {
        // currentOwnerId is NULL at this point (cleared by scanOut/custody-engine at
        // delivery time) — the custody ledger is the only authoritative record of
        // who actually delivered it. Deliberately NOT filtered by fromOwnerId here:
        // we first find the single MOST RECENT delivery-reason movement for this
        // item (whoever performed it), and only THEN compare its fromOwnerId to
        // this technician — never the reverse (searching for "any row naming this
        // technician"), which could match a stale movement from an earlier custody
        // cycle that is not what actually produced the item's current DELIVERED
        // status (e.g. delivered once by A, later returned, redelivered by B).
        const [latestDeliveryMovement] = await tx
          .select({ fromOwnerId: custodyMovements.fromOwnerId })
          .from(custodyMovements)
          .where(
            and(
              eq(custodyMovements.itemId, item.id),
              inArray(custodyMovements.reason, DELIVERY_CUSTODY_MOVEMENT_REASONS)
            )
          )
          .orderBy(desc(custodyMovements.performedAt))
          .limit(1);

        ownershipVerified =
          !!latestDeliveryMovement && latestDeliveryMovement.fromOwnerId === technicianId;
      }

      if (!ownershipVerified) {
        throw new AppError(
          "لا يمكنك حذف عنصر غير موجود في عهدتك",
          403,
          true,
          "ITEM_NOT_IN_YOUR_CUSTODY"
        );
      }

      const [itemTypeRow] = await tx
        .select({ nameAr: itemTypes.nameAr, nameEn: itemTypes.nameEn, category: itemTypes.category })
        .from(itemTypes)
        .where(eq(itemTypes.id, item.itemTypeId))
        .limit(1);

      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(
        item.serialNumber,
        undefined,
        tx
      );

      const linkedCourierRows = candidates.length
        ? await tx
            .select({ status: courierRequestItems.status })
            .from(courierRequestItems)
            .where(inArray(courierRequestItems.serialNumber, candidates))
        : [];

      const hasActiveCourierRequest = linkedCourierRows.some(
        (row: any) => !TERMINAL_COURIER_REQUEST_STATUSES.includes(row.status)
      );

      if (hasActiveCourierRequest) {
        throw new AppError(
          "لا يمكن حذف العنصر لارتباطه بعملية نشطة",
          409,
          true,
          "ITEM_HAS_ACTIVE_RELATIONS"
        );
      }

      await tx.insert(systemLogs).values({
        userId: technicianId,
        userName: technicianUsername,
        userRole: technicianRole,
        action: "technician_delete_own_serialized_item",
        entityType: "item",
        entityId: item.id,
        entityName: item.serialNumber,
        details: JSON.stringify({
          itemId: item.id,
          serialNumber: item.serialNumber,
          itemTypeId: item.itemTypeId,
          itemTypeNameAr: itemTypeRow?.nameAr,
          itemTypeNameEn: itemTypeRow?.nameEn,
          category: itemTypeRow?.category,
          previousStatus: item.status,
          previousOwnerId: item.currentOwnerId,
          warehouseId: item.warehouseId,
          reason: auditReason,
          affectedTables: [
            "items",
            "inventory_transactions",
            "item_history_logs",
            "custody_movements",
            "technician_moving_inventory_entries",
          ],
        }),
        description: `حذف الفني ${itemTypeRow?.category === "sim" ? "الشريحة" : "الجهاز"} ${item.serialNumber} نهائيًا من عهدته الخاصة (ميزة مؤقتة قبل إطلاق نظام المخزون النهائي)`,
        severity: "warn",
        success: true,
      });

      const deletedRows = await tx.delete(items).where(eq(items.id, item.id)).returning();
      if (!deletedRows || deletedRows.length === 0) {
        throw new Error("فشل حذف العنصر");
      }

      if (item.currentOwnerId && isActiveCustodyStatus(item.status)) {
        await this.syncMovingInventory(tx, item.currentOwnerId, item.itemTypeId, -1);
      }

      return {
        itemId: item.id,
        serialNumber: item.serialNumber,
        deleted: true,
      };
    });
  }

  /**
   * ADMIN ONLY — correct data-entry mistakes (serial number typo, carrier name) on an
   * existing serialized item. Deliberately does NOT accept a status change — lifecycle
   * transitions must go through PATCH /api/items/:id/status (CustodyEngine), which keeps
   * custody_movements / item_history_logs invariants correct; this endpoint is scoped to
   * plain field corrections only.
   */
  async adminUpdateSerializedItemById(
    adminId: string,
    adminUsername: string,
    adminRole: string,
    itemId: string,
    updates: { serialNumber?: string; carrierName?: string }
  ) {
    const newSerial = updates.serialNumber?.trim();
    const newCarrier = updates.carrierName?.trim();

    if (!newSerial && newCarrier === undefined) {
      throw new AppError("لا توجد بيانات لتحديثها", 400, true, "NO_UPDATES");
    }

    return await db.transaction(async (tx: any) => {
      const [item] = await tx
        .select()
        .from(items)
        .where(eq(items.id, itemId))
        .for("update");

      if (!item) {
        throw new NotFoundError("العنصر غير موجود");
      }

      if (newSerial && newSerial !== item.serialNumber) {
        const [conflict] = await tx
          .select({ id: items.id })
          .from(items)
          .where(eq(items.serialNumber, newSerial))
          .limit(1);
        if (conflict) {
          throw new AppError("الرقم التسلسلي مستخدم بالفعل لمادة أخرى", 409, true, "SERIAL_ALREADY_EXISTS");
        }
      }

      const setValues: Record<string, any> = { updatedAt: new Date() };
      if (newSerial) {
        setValues.serialNumber = newSerial;
        setValues.barcode = newSerial;
      }
      if (newCarrier !== undefined) {
        setValues.carrierName = newCarrier || null;
      }

      const [updated] = await tx
        .update(items)
        .set(setValues)
        .where(eq(items.id, itemId))
        .returning();

      await tx.insert(itemHistoryLogs).values({
        itemId: item.id,
        fromStatus: item.status,
        toStatus: item.status,
        changedById: adminId,
        notes: `تعديل بيانات بواسطة الأدمن: ${
          newSerial && newSerial !== item.serialNumber ? `الرقم التسلسلي ${item.serialNumber} → ${newSerial}` : ""
        }${newCarrier !== undefined ? ` الشركة الناقلة → ${newCarrier || "—"}` : ""}`.trim(),
      });

      await tx.insert(systemLogs).values({
        userId: adminId,
        userName: adminUsername,
        userRole: adminRole,
        action: "admin_update_serialized_item",
        entityType: "item",
        entityId: item.id,
        entityName: updated.serialNumber,
        details: JSON.stringify({
          itemId: item.id,
          previousSerialNumber: item.serialNumber,
          newSerialNumber: updated.serialNumber,
          previousCarrierName: item.carrierName,
          newCarrierName: updated.carrierName,
        }),
        description: `تم تعديل بيانات المادة ${updated.serialNumber} بواسطة الأدمن`,
        severity: "info",
        success: true,
      });

      return updated;
    });
  }

  /**
   * Lookup serial number status and history
   * Accepts prefixed (NCD…) or stored (digits) forms via Central Serial Engine.
   */
  async lookup(serialNumber: string) {
    const candidates = await SerialRecognitionService.buildStoredSerialCandidates(serialNumber);

    const [item] = await db
      .select({
        id: items.id,
        serialNumber: items.serialNumber,
        barcode: items.barcode,
        status: items.status,
        carrierName: items.carrierName,
        simPackageType: items.simPackageType,
        createdAt: items.createdAt,
        updatedAt: items.updatedAt,
        itemTypeNameAr: itemTypes.nameAr,
        itemTypeNameEn: itemTypes.nameEn,
        ownerName: users.fullName,
        ownerUsername: users.username,
      })
      .from(items)
      .leftJoin(itemTypes, eq(items.itemTypeId, itemTypes.id))
      .leftJoin(users, eq(items.currentOwnerId, users.id))
      .where(
        or(
          inArray(items.serialNumber, candidates),
          inArray(items.barcode, candidates)
        )
      )
      .limit(1);

    if (!item) {
      return null;
    }

    // Get audit trail history
    const history = await db
      .select({
        id: itemHistoryLogs.id,
        fromStatus: itemHistoryLogs.fromStatus,
        toStatus: itemHistoryLogs.toStatus,
        changedAt: itemHistoryLogs.changedAt,
        notes: itemHistoryLogs.notes,
        changedByName: users.fullName,
      })
      .from(itemHistoryLogs)
      .leftJoin(users, eq(itemHistoryLogs.changedById, users.id))
      .where(eq(itemHistoryLogs.itemId, item.id))
      .orderBy(itemHistoryLogs.changedAt);

    return {
      ...item,
      history,
    };
  }

  async getTechnicianCustody(technicianId: string) {
    return await db
      .select({
        id: items.id,
        serialNumber: items.serialNumber,
        status: items.status,
        carrierName: items.carrierName,
        createdAt: items.createdAt,
        itemTypeNameAr: itemTypes.nameAr,
        itemTypeNameEn: itemTypes.nameEn,
        itemTypeId: items.itemTypeId,
      })
      .from(items)
      .leftJoin(itemTypes, eq(items.itemTypeId, itemTypes.id))
      .where(
        and(
          eq(items.currentOwnerId, technicianId),
          inArray(items.status, [...ACTIVE_CUSTODY_STATUSES])
        )
      );
  }

  /** Optional external tx — joins courier Unit-of-Work when provided. */
  private client(tx?: any) {
    return tx || db;
  }

  /**
   * Find serialized item by serial (prefixed or stored). Used by courier via composition adapter.
   */
  async findBySerial(serial: string, tx?: any): Promise<any | null> {
    return SerialRecognitionService.findItemBySerial(serial, this.client(tx));
  }

  /**
   * Transfer existing item into technician custody / in-transit (courier receiving & start-task).
   * Must accept courier UoW `tx` to preserve atomicity with courier request writes.
   */
  async transferCustodyToTechnician(
    params: {
      itemId: string;
      technicianId: string;
      requestId: number;
      oldStatus: string;
      newStatus: "RECEIVED_BY_TECHNICIAN" | "IN_TRANSIT";
    },
    tx?: any
  ): Promise<void> {
    const client = this.client(tx);

    await client
      .update(items)
      .set({
        status: params.newStatus,
        currentOwnerId: params.technicianId,
        updatedAt: new Date(),
      })
      .where(eq(items.id, params.itemId));

    await client.insert(inventoryTransactions).values({
      itemId: params.itemId,
      transactionType: "TRANSFER",
      destinationOwnerId: params.technicianId,
      orderNumber: params.requestId.toString(),
      notes: params.newStatus === "RECEIVED_BY_TECHNICIAN"
        ? `استلام عهدة بالطلب رقم ${params.requestId}`
        : `بدء مهمة التوصيل بالطلب رقم ${params.requestId}`,
    });

    await client.insert(itemHistoryLogs).values({
      itemId: params.itemId,
      fromStatus: params.oldStatus,
      toStatus: params.newStatus,
      changedById: params.technicianId,
      notes: params.newStatus === "RECEIVED_BY_TECHNICIAN"
        ? `تحويل عهدة للفني بالمسح الضوئي - طلب رقم ${params.requestId}`
        : `مغادرة المستودع والبدء بالتوصيل - طلب رقم ${params.requestId}`,
    });
  }

  /**
   * Mint a new serialized item and assign to technician custody (courier scan mint path).
   * Same-db atomic with courier UoW when `tx` is supplied.
   */
  async mintAndAssignToTechnician(
    params: {
      serial: string;
      itemTypeId: string;
      carrierName: string | null;
      technicianId: string;
      requestId: number;
    },
    tx?: any
  ): Promise<{ id: string; serialNumber: string }> {
    const client = this.client(tx);

    const [newItem] = await client
      .insert(items)
      .values({
        itemTypeId: params.itemTypeId,
        serialNumber: params.serial,
        barcode: params.serial,
        status: "RECEIVED_BY_TECHNICIAN",
        currentOwnerId: params.technicianId,
        warehouseId: null,
        carrierName: params.carrierName,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    if (newItem) {
      await client.insert(inventoryTransactions).values({
        itemId: newItem.id,
        transactionType: "INTAKE",
        destinationOwnerId: params.technicianId,
        orderNumber: params.requestId.toString(),
        notes: `تسجيل أصل جديد بالمسح الضوئي - طلب رقم ${params.requestId}`,
      });

      await client.insert(itemHistoryLogs).values({
        itemId: newItem.id,
        fromStatus: "NONE",
        toStatus: "RECEIVED_BY_TECHNICIAN",
        changedById: params.technicianId,
        notes: `إنشاء أصل جديد عهدة للفني لأول مرة - طلب رقم ${params.requestId}`,
      });
    }

    return {
      id: newItem.id,
      serialNumber: newItem.serialNumber,
    };
  }

  /**
   * Scan-out that returns false when serial is not in active custody (courier InventoryEngine contract).
   */
  async tryScanOut(
    technicianId: string,
    serialNumber: string,
    receiverName: string,
    orderNumber: string,
    latitude?: number,
    longitude?: number
  ): Promise<boolean> {
    try {
      await this.scanOut(technicianId, serialNumber, receiverName, orderNumber, latitude, longitude);
      return true;
    } catch {
      return false;
    }
  }
}

export const serializedItemsService = new SerializedItemsService();
