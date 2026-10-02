import { randomUUID } from "crypto";
import { and, eq, or, sql } from "drizzle-orm";
import {
  idempotencyKeys,
  itemTypes,
  stockMovements,
  systemLogs,
  technicianMovingInventoryEntries,
  techniciansInventory,
  users,
  warehouseInventory,
  warehouseInventoryEntries,
  warehouses,
} from "@shared/schema";
import { db } from "@core/config/db";

export type ScanSource = "scanner" | "mobile";
export type ScanPackagingType = "box" | "unit";
export type ScanOperationType =
  | "ADD_STOCK"
  | "DEDUCT_STOCK"
  | "TRANSFER_TO_TECHNICIAN"
  | "WITHDRAW_FROM_TECHNICIAN";
export type ScanOwnerType = "warehouse" | "technician";

export type InventoryScanActor = {
  id: string;
  username: string;
  role: string;
  regionId: string | null;
};

export type ExecuteInventoryScanInput = {
  source: ScanSource;
  operationType: ScanOperationType;
  itemCode: string;
  packagingType: ScanPackagingType;
  quantity: number;
  ownerType?: ScanOwnerType;
  ownerId?: string;
  warehouseId?: string;
  technicianId?: string;
  reasonCode?: string;
  idempotencyKey?: string;
  notes?: string;
};

export class InventoryScanError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "InventoryScanError";
  }
}

const LEGACY_FIELD_MAPPING: Record<string, { boxes: string; units: string }> = {
  n950: { boxes: "n950Boxes", units: "n950Units" },
  i9000s: { boxes: "i9000sBoxes", units: "i9000sUnits" },
  i9100: { boxes: "i9100Boxes", units: "i9100Units" },
  rollPaper: { boxes: "rollPaperBoxes", units: "rollPaperUnits" },
  stickers: { boxes: "stickersBoxes", units: "stickersUnits" },
  newBatteries: { boxes: "newBatteriesBoxes", units: "newBatteriesUnits" },
  mobilySim: { boxes: "mobilySimBoxes", units: "mobilySimUnits" },
  stcSim: { boxes: "stcSimBoxes", units: "stcSimUnits" },
  zainSim: { boxes: "zainSimBoxes", units: "zainSimUnits" },
  lebaraSim: { boxes: "lebaraBoxes", units: "lebaraUnits" },
  lebara: { boxes: "lebaraBoxes", units: "lebaraUnits" },
};

export class InventoryScanService {
  async execute(input: ExecuteInventoryScanInput, actor: InventoryScanActor) {
    const normalizedInput = this.normalizeInput(input);
    this.validateInput(normalizedInput);
    this.validateActorPermissions(normalizedInput, actor);

    const itemType = await this.resolveItemTypeByCode(normalizedInput.itemCode);
    if (!itemType) {
      throw new InventoryScanError(404, "لم يتم العثور على نوع المنتج عبر كود المسح");
    }

    // ERP-008-class fix: the previous idempotency check ran a plain SELECT
    // against systemLogs before the transaction opened, with the durable
    // record written only after commit -- concurrent requests with the same
    // key could all observe "not processed yet" and all execute. This reuses
    // the same DB-backed atomic primitive already proven in
    // core/middlewares/idempotency.middleware.ts (idempotency_keys, key as
    // PRIMARY KEY, 23505 on the claim insert = another request is already
    // handling it), namespaced so this service's body-supplied keys cannot
    // collide with that header-based middleware's keys on other routes.
    const idempotencyKey = normalizedInput.idempotencyKey
      ? `inventory-scan:${normalizedInput.idempotencyKey}`
      : null;

    if (idempotencyKey) {
      const cached = await this.claimIdempotencyKey(idempotencyKey);
      if (cached) {
        return cached;
      }
    }

    const operationId = randomUUID();

    try {
      const result = await db.transaction(async (tx) => {
        await this.lockMutationAnchor(tx, normalizedInput);

        if (normalizedInput.operationType === "ADD_STOCK" || normalizedInput.operationType === "DEDUCT_STOCK") {
          return this.executeSingleOwnerMovement(tx, {
            itemTypeId: itemType.id,
            operationType: normalizedInput.operationType,
            ownerType: normalizedInput.ownerType!,
            ownerId: normalizedInput.ownerId!,
            packagingType: normalizedInput.packagingType,
            quantity: normalizedInput.quantity,
          });
        }

        return this.executeBetweenWarehouseAndTechnician(tx, {
          itemTypeId: itemType.id,
          operationType: normalizedInput.operationType,
          warehouseId: normalizedInput.warehouseId!,
          technicianId: normalizedInput.technicianId!,
          packagingType: normalizedInput.packagingType,
          quantity: normalizedInput.quantity,
        });
      });

      await this.insertStockMovement({
        actor,
        input: normalizedInput,
        itemTypeId: itemType.id,
      });

      await this.logScanEvent({
        actor,
        operationId,
        itemTypeId: itemType.id,
        itemTypeNameAr: itemType.nameAr,
        success: true,
        input: normalizedInput,
        result,
      });

      const response = {
        success: true,
        duplicate: false,
        operationId,
        itemType: {
          id: itemType.id,
          nameAr: itemType.nameAr,
          nameEn: itemType.nameEn,
        },
        movement: result,
      };

      if (idempotencyKey) {
        await this.completeIdempotencyKey(idempotencyKey, response);
      }

      return response;
    } catch (error: any) {
      await this.logScanEvent({
        actor,
        operationId,
        itemTypeId: itemType.id,
        itemTypeNameAr: itemType.nameAr,
        success: false,
        input: normalizedInput,
        errorMessage: error?.message || "Unknown error",
      });

      if (idempotencyKey) {
        await this.releaseIdempotencyKeyOnFailure(idempotencyKey);
      }

      if (error instanceof InventoryScanError) {
        throw error;
      }

      throw new InventoryScanError(500, error?.message || "فشل تنفيذ حركة المسح");
    }
  }

  private normalizeInput(input: ExecuteInventoryScanInput): ExecuteInventoryScanInput {
    return {
      ...input,
      itemCode: String(input.itemCode || "").trim(),
      quantity: Number(input.quantity),
      ownerId: input.ownerId?.trim(),
      warehouseId: input.warehouseId?.trim(),
      technicianId: input.technicianId?.trim(),
      reasonCode: input.reasonCode?.trim(),
      idempotencyKey: input.idempotencyKey?.trim(),
      notes: input.notes?.trim(),
    };
  }

  private validateInput(input: ExecuteInventoryScanInput) {
    if (!input.itemCode) {
      throw new InventoryScanError(400, "كود المنتج مطلوب");
    }

    if (!Number.isFinite(input.quantity) || input.quantity <= 0 || !Number.isInteger(input.quantity)) {
      throw new InventoryScanError(400, "الكمية يجب أن تكون رقمًا صحيحًا أكبر من صفر");
    }

    const singleOwnerOps: ScanOperationType[] = ["ADD_STOCK", "DEDUCT_STOCK"];

    if (singleOwnerOps.includes(input.operationType)) {
      if (!input.ownerType || !input.ownerId) {
        throw new InventoryScanError(400, "يجب تحديد جهة الهدف (مستودع أو مندوب) لهذه العملية");
      }
      return;
    }

    if (!input.warehouseId || !input.technicianId) {
      throw new InventoryScanError(400, "يجب تحديد المستودع والمندوب لعمليات التحويل/السحب");
    }
  }

  private validateActorPermissions(input: ExecuteInventoryScanInput, actor: InventoryScanActor) {
    if (actor.role !== "technician") {
      return;
    }

    if (input.operationType === "ADD_STOCK" || input.operationType === "DEDUCT_STOCK") {
      if (input.ownerType !== "technician" || input.ownerId !== actor.id) {
        throw new InventoryScanError(403, "المندوب يمكنه التعديل على مخزونه فقط");
      }
      return;
    }

    if (input.technicianId !== actor.id) {
      throw new InventoryScanError(403, "المندوب يمكنه تنفيذ العمليات على عهدته فقط");
    }
  }

  private async resolveItemTypeByCode(code: string) {
    const [byId] = await db
      .select()
      .from(itemTypes)
      .where(eq(itemTypes.id, code))
      .limit(1);

    if (byId) return byId;

    const [byName] = await db
      .select()
      .from(itemTypes)
      .where(
        or(
          sql`lower(${itemTypes.nameAr}) = lower(${code})`,
          sql`lower(${itemTypes.nameEn}) = lower(${code})`,
        ),
      )
      .limit(1);

    return byName || undefined;
  }

  /**
   * Atomically claims an idempotency key using the same primitive already
   * proven race-free in core/middlewares/idempotency.middleware.ts (ERP-008
   * Phase 4): the key column is a real PRIMARY KEY, so when two concurrent
   * requests both see no existing row and both attempt the claim insert,
   * exactly one succeeds and the other gets a 23505 unique-violation --
   * which is treated as "another request is already handling this", not a
   * generic error. Returns the cached response for an already-completed key,
   * or null when this call has won the claim and the caller should proceed.
   */
  private async claimIdempotencyKey(key: string): Promise<unknown | null> {
    const now = new Date();
    const [existing] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)).limit(1);

    if (existing) {
      if (existing.expiresAt < now) {
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
      } else if (existing.responseStatus === 102) {
        throw new InventoryScanError(409, "الطلب قيد المعالجة حالياً بنفس مفتاح منع التكرار، يرجى المحاولة بعد قليل.");
      } else {
        return { ...JSON.parse(existing.responseBody), duplicate: true };
      }
    }

    const lockExpiry = new Date(Date.now() + 5 * 60 * 1000);
    try {
      await db.insert(idempotencyKeys).values({
        key,
        responseStatus: 102,
        responseBody: "",
        expiresAt: lockExpiry,
      });
    } catch (insertError: any) {
      if (insertError?.code === "23505") {
        throw new InventoryScanError(409, "الطلب قيد المعالجة حالياً بنفس مفتاح منع التكرار، يرجى المحاولة بعد قليل.");
      }
      throw insertError;
    }

    return null;
  }

  private async completeIdempotencyKey(key: string, response: unknown) {
    await db
      .update(idempotencyKeys)
      .set({
        responseStatus: 200,
        responseBody: JSON.stringify(response),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .where(eq(idempotencyKeys.key, key));
  }

  private async releaseIdempotencyKeyOnFailure(key: string) {
    try {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    } catch (releaseError) {
      console.error("Failed to release idempotency key after failure", releaseError);
    }
  }

  /**
   * DB-R1 pattern (see DrizzleWithdrawTechnicianInventoryToWarehouseUnitOfWork,
   * Phase C4.6C.2): locks an always-existing parent row (the warehouse, or
   * the technician's own users row) FIRST, before any entry lookup. This
   * serializes concurrent requests for the same (warehouse|technician,
   * itemType) pair even when the balance entry row does not exist yet --
   * a bare SELECT ... FOR UPDATE on a possibly-absent row locks nothing.
   */
  private async lockMutationAnchor(tx: any, input: ExecuteInventoryScanInput) {
    const isSingleOwnerOp = input.operationType === "ADD_STOCK" || input.operationType === "DEDUCT_STOCK";

    if (isSingleOwnerOp) {
      if (input.ownerType === "warehouse") {
        await tx.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.id, input.ownerId!)).for("update");
      } else {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, input.ownerId!)).for("update");
      }
      return;
    }

    // TRANSFER_TO_TECHNICIAN / WITHDRAW_FROM_TECHNICIAN: locking the
    // warehouse anchor alone is sufficient to serialize both sides of the
    // transfer for a given (warehouse, technician, itemType), matching the
    // sibling withdrawal unit-of-work exactly.
    await tx.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.id, input.warehouseId!)).for("update");
  }

  private async executeSingleOwnerMovement(
    tx: any,
    args: {
      itemTypeId: string;
      operationType: "ADD_STOCK" | "DEDUCT_STOCK";
      ownerType: ScanOwnerType;
      ownerId: string;
      packagingType: ScanPackagingType;
      quantity: number;
    },
  ) {
    const signedQuantity = args.operationType === "ADD_STOCK" ? args.quantity : -args.quantity;

    if (args.ownerType === "warehouse") {
      await this.assertWarehouseExists(tx, args.ownerId);
      const balance = await this.adjustWarehouseBalance(tx, {
        warehouseId: args.ownerId,
        itemTypeId: args.itemTypeId,
        packagingType: args.packagingType,
        delta: signedQuantity,
      });

      return {
        operationType: args.operationType,
        ownerType: args.ownerType,
        ownerId: args.ownerId,
        packagingType: args.packagingType,
        quantity: args.quantity,
        balances: {
          warehouse: balance,
        },
      };
    }

    await this.assertTechnicianExists(tx, args.ownerId);
    const balance = await this.adjustTechnicianMovingBalance(tx, {
      technicianId: args.ownerId,
      itemTypeId: args.itemTypeId,
      packagingType: args.packagingType,
      delta: signedQuantity,
    });

    return {
      operationType: args.operationType,
      ownerType: args.ownerType,
      ownerId: args.ownerId,
      packagingType: args.packagingType,
      quantity: args.quantity,
      balances: {
        technician: balance,
      },
    };
  }

  private async executeBetweenWarehouseAndTechnician(
    tx: any,
    args: {
      itemTypeId: string;
      operationType: "TRANSFER_TO_TECHNICIAN" | "WITHDRAW_FROM_TECHNICIAN";
      warehouseId: string;
      technicianId: string;
      packagingType: ScanPackagingType;
      quantity: number;
    },
  ) {
    await this.assertWarehouseExists(tx, args.warehouseId);
    await this.assertTechnicianExists(tx, args.technicianId);

    const warehouseDelta = args.operationType === "TRANSFER_TO_TECHNICIAN" ? -args.quantity : args.quantity;
    const technicianDelta = -warehouseDelta;

    const warehouseBalance = await this.adjustWarehouseBalance(tx, {
      warehouseId: args.warehouseId,
      itemTypeId: args.itemTypeId,
      packagingType: args.packagingType,
      delta: warehouseDelta,
    });

    const technicianBalance = await this.adjustTechnicianMovingBalance(tx, {
      technicianId: args.technicianId,
      itemTypeId: args.itemTypeId,
      packagingType: args.packagingType,
      delta: technicianDelta,
    });

    return {
      operationType: args.operationType,
      packagingType: args.packagingType,
      quantity: args.quantity,
      warehouseId: args.warehouseId,
      technicianId: args.technicianId,
      balances: {
        warehouse: warehouseBalance,
        technician: technicianBalance,
      },
    };
  }

  private async adjustWarehouseBalance(
    tx: any,
    args: {
      warehouseId: string;
      itemTypeId: string;
      packagingType: ScanPackagingType;
      delta: number;
    },
  ) {
    // Race-free insert-if-missing: warehouse_inventory_entries has a real
    // UNIQUE(warehouseId, itemTypeId) constraint
    // (warehouse_inventory_entries_warehouse_item_unique), and the caller
    // already holds the warehouse anchor lock (lockMutationAnchor), so this
    // cannot race with another transaction touching the same row.
    await tx
      .insert(warehouseInventoryEntries)
      .values({ warehouseId: args.warehouseId, itemTypeId: args.itemTypeId, boxes: 0, units: 0 })
      .onConflictDoNothing({
        target: [warehouseInventoryEntries.warehouseId, warehouseInventoryEntries.itemTypeId],
      });

    const [entry] = await tx
      .select()
      .from(warehouseInventoryEntries)
      .where(
        and(
          eq(warehouseInventoryEntries.warehouseId, args.warehouseId),
          eq(warehouseInventoryEntries.itemTypeId, args.itemTypeId),
        ),
      )
      .for("update");

    const before = args.packagingType === "box" ? Number(entry?.boxes || 0) : Number(entry?.units || 0);
    const after = before + args.delta;

    if (after < 0) {
      throw new InventoryScanError(400, `الرصيد غير كافٍ في المستودع. المتاح: ${before}`);
    }

    const nextBoxes = args.packagingType === "box" ? after : Number(entry?.boxes || 0);
    const nextUnits = args.packagingType === "unit" ? after : Number(entry?.units || 0);

    await tx
      .update(warehouseInventoryEntries)
      .set({
        boxes: nextBoxes,
        units: nextUnits,
        updatedAt: new Date(),
      })
      .where(eq(warehouseInventoryEntries.id, entry.id));

    await this.syncWarehouseLegacyBalance(tx, {
      warehouseId: args.warehouseId,
      itemTypeId: args.itemTypeId,
      packagingType: args.packagingType,
      after,
    });

    return { before, after, delta: args.delta };
  }

  private async adjustTechnicianMovingBalance(
    tx: any,
    args: {
      technicianId: string;
      itemTypeId: string;
      packagingType: ScanPackagingType;
      delta: number;
    },
  ) {
    // No unique constraint exists on (technicianId, itemTypeId) for this
    // table (see DrizzleWithdrawTechnicianInventoryToWarehouseUnitOfWork,
    // Phase C4.6C.2 -- schema-change-free zone for that remediation slice,
    // tracked separately). The caller's anchor lock (lockMutationAnchor --
    // the warehouse row when a warehouse is involved, otherwise the
    // technician's own users row) serializes the realistic same-technician
    // race; a first-ever-row race for the same technician across two
    // different warehouses simultaneously is the same narrow, already-
    // accepted residual edge as the sibling withdrawal path.
    let [entry] = await tx
      .select()
      .from(technicianMovingInventoryEntries)
      .where(
        and(
          eq(technicianMovingInventoryEntries.technicianId, args.technicianId),
          eq(technicianMovingInventoryEntries.itemTypeId, args.itemTypeId),
        ),
      )
      .for("update");

    if (!entry) {
      await tx.insert(technicianMovingInventoryEntries).values({
        technicianId: args.technicianId,
        itemTypeId: args.itemTypeId,
        boxes: 0,
        units: 0,
      });

      [entry] = await tx
        .select()
        .from(technicianMovingInventoryEntries)
        .where(
          and(
            eq(technicianMovingInventoryEntries.technicianId, args.technicianId),
            eq(technicianMovingInventoryEntries.itemTypeId, args.itemTypeId),
          ),
        )
        .for("update");
    }

    const before = args.packagingType === "box" ? Number(entry?.boxes || 0) : Number(entry?.units || 0);
    const after = before + args.delta;

    if (after < 0) {
      throw new InventoryScanError(400, `الرصيد غير كافٍ في مخزون المندوب. المتاح: ${before}`);
    }

    const nextBoxes = args.packagingType === "box" ? after : Number(entry?.boxes || 0);
    const nextUnits = args.packagingType === "unit" ? after : Number(entry?.units || 0);

    await tx
      .update(technicianMovingInventoryEntries)
      .set({
        boxes: nextBoxes,
        units: nextUnits,
        updatedAt: new Date(),
      })
      .where(eq(technicianMovingInventoryEntries.id, entry.id));

    await this.syncTechnicianLegacyBalance(tx, {
      technicianId: args.technicianId,
      itemTypeId: args.itemTypeId,
      packagingType: args.packagingType,
      after,
    });

    return { before, after, delta: args.delta };
  }

  private async syncWarehouseLegacyBalance(
    tx: any,
    args: {
      warehouseId: string;
      itemTypeId: string;
      packagingType: ScanPackagingType;
      after: number;
    },
  ) {
    const fieldMap = LEGACY_FIELD_MAPPING[args.itemTypeId];
    if (!fieldMap) {
      return;
    }

    const fieldName = args.packagingType === "box" ? fieldMap.boxes : fieldMap.units;

    let [legacyWarehouseInventory] = await tx
      .select()
      .from(warehouseInventory)
      .where(eq(warehouseInventory.warehouseId, args.warehouseId))
      .limit(1);

    if (!legacyWarehouseInventory) {
      const [created] = await tx
        .insert(warehouseInventory)
        .values({ warehouseId: args.warehouseId })
        .returning();
      legacyWarehouseInventory = created;
    }

    await tx
      .update(warehouseInventory)
      .set({
        [fieldName]: args.after,
        updatedAt: new Date(),
      })
      .where(eq(warehouseInventory.id, legacyWarehouseInventory.id));
  }

  private async syncTechnicianLegacyBalance(
    tx: any,
    args: {
      technicianId: string;
      itemTypeId: string;
      packagingType: ScanPackagingType;
      after: number;
    },
  ) {
    const fieldMap = LEGACY_FIELD_MAPPING[args.itemTypeId];
    if (!fieldMap) {
      return;
    }

    const fieldName = args.packagingType === "box" ? fieldMap.boxes : fieldMap.units;

    let [legacyInventory] = await tx
      .select()
      .from(techniciansInventory)
      .where(eq(techniciansInventory.createdBy, args.technicianId))
      .limit(1);

    if (!legacyInventory) {
      const [techUser] = await tx
        .select({
          fullName: users.fullName,
          city: users.city,
          regionId: users.regionId,
        })
        .from(users)
        .where(eq(users.id, args.technicianId))
        .limit(1);

      const [created] = await tx
        .insert(techniciansInventory)
        .values({
          technicianName: techUser?.fullName || "Unknown Technician",
          city: techUser?.city || "غير محدد",
          createdBy: args.technicianId,
          regionId: techUser?.regionId || null,
        })
        .returning();

      legacyInventory = created;
    }

    await tx
      .update(techniciansInventory)
      .set({
        [fieldName]: args.after,
        updatedAt: new Date(),
      })
      .where(eq(techniciansInventory.id, legacyInventory.id));
  }

  private async insertStockMovement(args: {
    actor: InventoryScanActor;
    input: ExecuteInventoryScanInput;
    itemTypeId: string;
  }) {
    const { actor, input, itemTypeId } = args;

    const technicianIdForRow =
      input.technicianId ||
      (input.ownerType === "technician" ? input.ownerId : undefined) ||
      actor.id;

    const fromInventory = this.resolveFromInventoryLabel(input);
    const toInventory = this.resolveToInventoryLabel(input);

    await db.insert(stockMovements).values({
      technicianId: technicianIdForRow,
      itemType: itemTypeId,
      packagingType: input.packagingType,
      quantity: input.quantity,
      fromInventory,
      toInventory,
      reason: input.reasonCode || "scan_operation",
      performedBy: actor.id,
      notes: input.notes || null,
    });
  }

  private resolveFromInventoryLabel(input: ExecuteInventoryScanInput): string {
    if (input.operationType === "ADD_STOCK") return "external";
    if (input.operationType === "DEDUCT_STOCK") {
      if (input.ownerType === "warehouse") return `warehouse:${input.ownerId}`;
      return `technician:${input.ownerId}:moving`;
    }
    if (input.operationType === "TRANSFER_TO_TECHNICIAN") return `warehouse:${input.warehouseId}`;
    return `technician:${input.technicianId}:moving`;
  }

  private resolveToInventoryLabel(input: ExecuteInventoryScanInput): string {
    if (input.operationType === "DEDUCT_STOCK") return "external";
    if (input.operationType === "ADD_STOCK") {
      if (input.ownerType === "warehouse") return `warehouse:${input.ownerId}`;
      return `technician:${input.ownerId}:moving`;
    }
    if (input.operationType === "TRANSFER_TO_TECHNICIAN") return `technician:${input.technicianId}:moving`;
    return `warehouse:${input.warehouseId}`;
  }

  /**
   * Takes `tx`, not the global `db`, and MUST keep doing so: this is called
   * from inside the mutation transaction, which -- since lockMutationAnchor
   * -- can genuinely block waiting for a row lock while holding its pool
   * connection. Using the global pool here would need a SECOND connection
   * from the same finite pool to finish a transaction that is itself the
   * thing other queued transactions are waiting to release; with enough
   * concurrent callers that pool-starves (proven empirically: N=20
   * concurrent distinct-key requests hung indefinitely, not merely slowly,
   * before this was scoped to tx).
   */
  private async assertWarehouseExists(tx: any, warehouseId: string) {
    const [warehouse] = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(eq(warehouses.id, warehouseId))
      .limit(1);

    if (!warehouse) {
      throw new InventoryScanError(404, "المستودع غير موجود");
    }
  }

  private async assertTechnicianExists(tx: any, technicianId: string) {
    const [technician] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, technicianId),
          or(eq(users.role, "technician"), eq(users.role, "employee")),
        ),
      )
      .limit(1);

    if (!technician) {
      throw new InventoryScanError(404, "المندوب غير موجود");
    }
  }

  private async logScanEvent(args: {
    actor: InventoryScanActor;
    operationId: string;
    itemTypeId: string;
    itemTypeNameAr: string;
    success: boolean;
    input: ExecuteInventoryScanInput;
    result?: unknown;
    errorMessage?: string;
  }) {
    const { actor, operationId, itemTypeId, itemTypeNameAr, success, input, result, errorMessage } = args;

    try {
      await db.insert(systemLogs).values({
        userId: actor.id,
        userName: actor.username,
        userRole: actor.role,
        regionId: actor.regionId,
        action: "inventory_scan_execute",
        entityType: "inventory_scan",
        entityId: itemTypeId,
        entityName: itemTypeNameAr,
        description: success
          ? `تم تنفيذ حركة مسح ${input.operationType} بنجاح`
          : `فشل تنفيذ حركة مسح ${input.operationType}`,
        details: JSON.stringify({
          operationId,
          source: input.source,
          operationType: input.operationType,
          itemCode: input.itemCode,
          itemTypeId,
          packagingType: input.packagingType,
          quantity: input.quantity,
          ownerType: input.ownerType || null,
          ownerId: input.ownerId || null,
          warehouseId: input.warehouseId || null,
          technicianId: input.technicianId || null,
          reasonCode: input.reasonCode || null,
          idempotencyKey: input.idempotencyKey || null,
          notes: input.notes || null,
          result: result || null,
          errorMessage: errorMessage || null,
        }),
        severity: success ? "info" : "error",
        success,
      });
    } catch (logError) {
      console.error("Failed to write inventory scan log", logError);
    }
  }
}

export const inventoryScanService = new InventoryScanService();

