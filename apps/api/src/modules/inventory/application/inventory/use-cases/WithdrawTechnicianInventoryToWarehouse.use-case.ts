import { NotFoundError } from "@core/errors/AppError";

export type WithdrawPackagingType = "box" | "unit";

export type WithdrawItemInput = {
  itemTypeId: string;
  packagingType: WithdrawPackagingType;
  quantity: number;
};

export type WithdrawToWarehouseActor = {
  id: string;
  username: string;
  role: string;
  regionId?: string | null;
};

export type WithdrawTechnicianInventoryToWarehouseInput = {
  actor: WithdrawToWarehouseActor;
  technicianId: string;
  warehouseId: string;
  notes?: string;
  items: WithdrawItemInput[];
  idempotencyKey: string;
};

export type WithdrawTechnicianInventoryToWarehouseOutput = {
  success: true;
  message: string;
  itemsCount: number;
  totalQuantity: number;
};

type InventoryEntry = {
  itemTypeId: string;
  boxes: number;
  units: number;
};

type Warehouse = {
  id: string;
  name: string;
  regionId?: string | null;
};

type TechnicianUser = {
  id: string;
  role: string;
  fullName: string;
  regionId?: string | null;
};

export class WithdrawToWarehouseUseCaseError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "WithdrawToWarehouseUseCaseError";
  }
}

export interface IWithdrawTechnicianInventoryToWarehouseRepository {
  getUser(id: string): Promise<TechnicianUser | undefined>;
  getWarehouse(id: string): Promise<Warehouse | undefined>;
  getTechnicianMovingInventoryEntries(technicianId: string): Promise<InventoryEntry[]>;
  getWarehouseInventoryEntries(warehouseId: string): Promise<InventoryEntry[]>;
  getTechnicianInventory(technicianId: string): Promise<Record<string, unknown> | undefined>;
  getWarehouseInventory(warehouseId: string): Promise<Record<string, unknown> | null | undefined>;
  upsertTechnicianMovingInventoryEntry(
    technicianId: string,
    itemTypeId: string,
    boxes: number,
    units: number
  ): Promise<unknown>;
  upsertWarehouseInventoryEntry(
    warehouseId: string,
    itemTypeId: string,
    boxes: number,
    units: number
  ): Promise<unknown>;
  updateTechnicianInventory(
    technicianId: string,
    updates: Record<string, number>
  ): Promise<unknown>;
  updateWarehouseInventory(
    warehouseId: string,
    updates: Record<string, number>
  ): Promise<unknown>;
  logSystemActivity(payload: {
    userId: string;
    userName: string;
    userRole: string;
    regionId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    entityName: string;
    description: string;
    details?: string;
    severity: string;
    success: boolean;
  }): Promise<unknown>;

  /** Same tracking-mode/quantity-integrity guard shared with every other quantity-write path (see quantity-entry-guards.ts). Throws for the first offending item found. */
  assertItemsQuantityTrackable(items: { itemTypeId: string; quantity: number }[]): Promise<void>;

  /** Domain-level idempotency-replay check — true if this exact key was already applied for a withdraw-to-warehouse action. */
  isIdempotentWithdrawReplay(idempotencyKey: string): Promise<boolean>;
}

export class WithdrawTechnicianInventoryToWarehouseUseCase {
  constructor(
    private readonly repository: IWithdrawTechnicianInventoryToWarehouseRepository
  ) {}

  async execute(
    input: WithdrawTechnicianInventoryToWarehouseInput
  ): Promise<WithdrawTechnicianInventoryToWarehouseOutput> {
    if (!input.idempotencyKey || input.idempotencyKey.trim().length < 10) {
      throw new WithdrawToWarehouseUseCaseError(
        400,
        "يتطلب السحب إلى المستودع ترويسة X-Idempotency-Key صالحة (10 أحرف على الأقل) لمنع تنفيذ العملية مرتين",
      );
    }

    if (await this.repository.isIdempotentWithdrawReplay(input.idempotencyKey)) {
      return {
        success: true,
        message: "تم سحب المخزون إلى المستودع بنجاح (عملية مكررة، لم يُعاد تنفيذها)",
        itemsCount: 0,
        totalQuantity: 0,
      };
    }

    // Same tracking-mode guard as every other quantity-write path:
    // requires_serial=true types can never be withdrawn through this
    // bare-quantity path.
    await this.repository.assertItemsQuantityTrackable(
      input.items.map((i) => ({ itemTypeId: i.itemTypeId, quantity: i.quantity })),
    );

    const technician = await this.repository.getUser(input.technicianId);
    if (!technician || technician.role !== "technician") {
      throw new NotFoundError("Technician not found");
    }

    const warehouse = await this.repository.getWarehouse(input.warehouseId);
    if (!warehouse) {
      throw new NotFoundError("Warehouse not found");
    }

    if (input.actor.role === "supervisor") {
      if (!input.actor.regionId) {
        throw new WithdrawToWarehouseUseCaseError(400, "المشرف يجب أن يكون مرتبط بمنطقة");
      }

      if (technician.regionId !== input.actor.regionId) {
        throw new WithdrawToWarehouseUseCaseError(403, "لا يمكنك السحب من مندوب خارج منطقتك");
      }

      if (warehouse.regionId !== input.actor.regionId) {
        throw new WithdrawToWarehouseUseCaseError(403, "لا يمكنك السحب إلى مستودع خارج منطقتك");
      }
    }

    const movingEntries = await this.repository.getTechnicianMovingInventoryEntries(input.technicianId);
    const warehouseEntries = await this.repository.getWarehouseInventoryEntries(input.warehouseId);
    const legacyTechnicianInventory = await this.repository.getTechnicianInventory(input.technicianId);
    const legacyWarehouseInventory = await this.repository.getWarehouseInventory(input.warehouseId);

    const movingMap = new Map(movingEntries.map((entry) => [entry.itemTypeId, entry]));
    const warehouseMap = new Map(warehouseEntries.map((entry) => [entry.itemTypeId, entry]));

    const legacyFieldMapping: Record<string, { boxes: string; units: string }> = {
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

    const aggregated = new Map<string, WithdrawItemInput>();
    for (const item of input.items) {
      const key = `${item.itemTypeId}:${item.packagingType}`;
      const existing = aggregated.get(key);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        aggregated.set(key, { ...item });
      }
    }

    const touched = new Map<string, {
      technicianBoxes: number;
      technicianUnits: number;
      warehouseBoxes: number;
      warehouseUnits: number;
    }>();

    const technicianLegacyUpdates: Record<string, number> = {};
    const warehouseLegacyUpdates: Record<string, number> = {};

    for (const item of Array.from(aggregated.values())) {
      const { itemTypeId, packagingType, quantity } = item;
      const legacyFields = legacyFieldMapping[itemTypeId];

      const currentTechnician = touched.get(itemTypeId) || {
        technicianBoxes: movingMap.get(itemTypeId)?.boxes ?? (
          legacyFields && legacyTechnicianInventory
            ? Number(legacyTechnicianInventory[legacyFields.boxes] || 0)
            : 0
        ),
        technicianUnits: movingMap.get(itemTypeId)?.units ?? (
          legacyFields && legacyTechnicianInventory
            ? Number(legacyTechnicianInventory[legacyFields.units] || 0)
            : 0
        ),
        warehouseBoxes: warehouseMap.get(itemTypeId)?.boxes ?? (
          legacyFields && legacyWarehouseInventory
            ? Number(legacyWarehouseInventory[legacyFields.boxes] || 0)
            : 0
        ),
        warehouseUnits: warehouseMap.get(itemTypeId)?.units ?? (
          legacyFields && legacyWarehouseInventory
            ? Number(legacyWarehouseInventory[legacyFields.units] || 0)
            : 0
        ),
      };

      if (packagingType === "box") {
        if (currentTechnician.technicianBoxes < quantity) {
          throw new WithdrawToWarehouseUseCaseError(
            400,
            `الكمية غير كافية للصنف ${itemTypeId}. المتاح: ${currentTechnician.technicianBoxes} كرتون`
          );
        }
        currentTechnician.technicianBoxes -= quantity;
        currentTechnician.warehouseBoxes += quantity;
      } else {
        if (currentTechnician.technicianUnits < quantity) {
          throw new WithdrawToWarehouseUseCaseError(
            400,
            `الكمية غير كافية للصنف ${itemTypeId}. المتاح: ${currentTechnician.technicianUnits} وحدة`
          );
        }
        currentTechnician.technicianUnits -= quantity;
        currentTechnician.warehouseUnits += quantity;
      }

      touched.set(itemTypeId, currentTechnician);

      if (legacyFields && legacyTechnicianInventory && legacyWarehouseInventory) {
        if (packagingType === "box") {
          const currentTechLegacy = Number(legacyTechnicianInventory[legacyFields.boxes] || 0);
          const currentWarehouseLegacy = Number(legacyWarehouseInventory[legacyFields.boxes] || 0);
          technicianLegacyUpdates[legacyFields.boxes] = Math.max(0, currentTechLegacy - quantity);
          warehouseLegacyUpdates[legacyFields.boxes] = currentWarehouseLegacy + quantity;
        } else {
          const currentTechLegacy = Number(legacyTechnicianInventory[legacyFields.units] || 0);
          const currentWarehouseLegacy = Number(legacyWarehouseInventory[legacyFields.units] || 0);
          technicianLegacyUpdates[legacyFields.units] = Math.max(0, currentTechLegacy - quantity);
          warehouseLegacyUpdates[legacyFields.units] = currentWarehouseLegacy + quantity;
        }
      }
    }

    for (const [itemTypeId, values] of Array.from(touched.entries())) {
      await this.repository.upsertTechnicianMovingInventoryEntry(
        input.technicianId,
        itemTypeId,
        values.technicianBoxes,
        values.technicianUnits
      );

      await this.repository.upsertWarehouseInventoryEntry(
        input.warehouseId,
        itemTypeId,
        values.warehouseBoxes,
        values.warehouseUnits
      );
    }

    if (legacyTechnicianInventory && Object.keys(technicianLegacyUpdates).length > 0) {
      await this.repository.updateTechnicianInventory(input.technicianId, technicianLegacyUpdates);
    }

    if (legacyWarehouseInventory && Object.keys(warehouseLegacyUpdates).length > 0) {
      await this.repository.updateWarehouseInventory(input.warehouseId, warehouseLegacyUpdates);
    }

    const totalQuantity = Array.from(aggregated.values()).reduce((sum, item) => sum + item.quantity, 0);

    await this.repository.logSystemActivity({
      userId: input.actor.id,
      userName: input.actor.username,
      userRole: input.actor.role,
      regionId: input.actor.regionId || null,
      action: "transfer",
      entityType: "technician_withdraw_to_warehouse",
      entityId: input.warehouseId,
      entityName: warehouse.name,
      description: `تم سحب ${totalQuantity} من مخزون المندوب ${technician.fullName} إلى المستودع ${warehouse.name}`,
      details: JSON.stringify({
        technicianId: input.technicianId,
        technicianName: technician.fullName,
        warehouseId: input.warehouseId,
        warehouseName: warehouse.name,
        items: Array.from(aggregated.values()),
        notes: input.notes || null,
        idempotencyKey: input.idempotencyKey,
      }),
      severity: "info",
      success: true,
    });

    return {
      success: true,
      message: "تم سحب المخزون إلى المستودع بنجاح",
      itemsCount: aggregated.size,
      totalQuantity,
    };
  }
}

