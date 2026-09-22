import { db } from "@core/config/db";
import { AppError, NotFoundError } from "@core/errors/AppError";
import { items, inventoryTransactions, itemHistoryLogs, itemTypes, users, custodyMovements, technicianMovingInventoryEntries, courierRequestItems, systemLogs } from "@shared/schema";
import { eq, and, inArray, sql, or, desc } from "drizzle-orm";
import { SerialRecognitionService } from "./serial-recognition.service";

/** Item is considered "held" by a technician in one of these statuses. */
const TECHNICIAN_HELD_STATUSES = ["IN_TRANSIT_CUSTODY", "RECEIVED_BY_TECHNICIAN", "IN_TRANSIT"];
/** courier_request_items statuses that mean the request is finished (safe to ignore for the active-relation guard). */
const TERMINAL_COURIER_REQUEST_STATUSES = ["DELIVERED", "REJECTED", "MISSING"];
/** Public itemType URL segment (DEVICE|SIM) → real item_types.category value. No other values are accepted. */
const CUSTODY_DELETE_ITEM_TYPE_TO_CATEGORY: Record<string, string> = {
  DEVICE: "devices",
  SIM: "sim",
};

export class SerializedItemsService {
  private async syncMovingInventory(tx: any, technicianId: string, itemTypeId: string, delta: number) {
    if (!technicianId || !itemTypeId || delta === 0) return;

    // Serialize custody-ledger changes for one technician/item type.
    // This closes the read→insert race when the first custody event creates
    // the moving-inventory row concurrently with another custody event.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${technicianId + ":" + itemTypeId}, 0)
      )
    `);

    const existingEntries = await tx
      .select()
      .from(technicianMovingInventoryEntries)
      .where(
        and(
          eq(technicianMovingInventoryEntries.technicianId, technicianId),
          eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
        )
      );

    if (existingEntries.length > 1) {
      throw new Error(
        `Custody moving-inventory invariant violation: technician "${technicianId}" has ${existingEntries.length} rows for item type "${itemTypeId}".`
      );
    }

    const existingEntry = existingEntries[0];

    if (existingEntry) {
      const nextUnits = existingEntry.units + delta;
      if (nextUnits < 0) {
        throw new Error(
          `Custody moving-inventory underflow: technician "${technicianId}" / item type "${itemTypeId}" would become ${nextUnits}.`
        );
      }
      const newUnits = nextUnits;
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
      const [item] = await tx
        .select()
        .from(items)
        .where(
          and(
            inArray(items.serialNumber, candidates),
            eq(items.currentOwnerId, technicianId),
            inArray(items.status, ["IN_TRANSIT_CUSTODY", "RECEIVED_BY_TECHNICIAN"])
          )
        )
        .limit(1)
        .for("update");

      if (!item) {
        throw new Error("المادة غير موجودة في عهرتك النشطة أو الرقم التسلسلي غير مطابق");
      }

      // Update item to DELIVERED
      const [updatedItem] = await tx
        .update(items)
        .set({
          status: "DELIVERED",
          currentOwnerId: null, // delivered to customer
          updatedAt: new Date(),
        })
        .where(eq(items.id, item.id))
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
      if (item.currentOwnerId !== technicianId || !TECHNICIAN_HELD_STATUSES.includes(item.status)) {
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
          inArray(items.status, ["IN_TRANSIT_CUSTODY", "RECEIVED_BY_TECHNICIAN"])
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
