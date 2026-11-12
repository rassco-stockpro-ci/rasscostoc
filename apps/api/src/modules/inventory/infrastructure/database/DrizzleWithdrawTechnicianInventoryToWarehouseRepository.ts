import type { IUserRepository } from "@stockpro/contracts";
import type {
  IWithdrawTechnicianInventoryToWarehouseRepository,
} from "@modules/inventory/application/inventory/use-cases/WithdrawTechnicianInventoryToWarehouse.use-case";
import { repositories } from "@modules/inventory/infrastructure/database";
import { WarehouseRepository } from "./WarehouseRepository";
import { WarehouseInventoryRepository } from "./WarehouseInventoryRepository";
import { TechnicianInventoryRepository } from "./TechnicianInventoryRepository";
import { getDatabase } from "@core/database/connection";
import { assertItemTypeQuantityTrackable, assertNonNegativeInteger, findIdempotentReplay } from "./quantity-entry-guards";

export class DrizzleWithdrawTechnicianInventoryToWarehouseRepository
  implements IWithdrawTechnicianInventoryToWarehouseRepository
{
  private readonly warehouses = new WarehouseRepository();
  private readonly warehouseInventory = new WarehouseInventoryRepository();
  private readonly technicianInventory = new TechnicianInventoryRepository();

  constructor(
    private readonly userRepository: IUserRepository
  ) {}

  async getUser(id: string) {
    const user = await this.userRepository.getUser(id);
    if (!user) return undefined;
    return {
      id: user.id,
      role: user.role,
      fullName: user.fullName || user.username,
      regionId: user.regionId
    };
  }

  getWarehouse(id: string) {
    return this.warehouses.getWarehouse(id);
  }

  getTechnicianMovingInventoryEntries(technicianId: string) {
    return this.technicianInventory.getTechnicianMovingInventoryEntries(technicianId);
  }

  getWarehouseInventoryEntries(warehouseId: string) {
    return this.warehouseInventory.getWarehouseInventoryEntries(warehouseId);
  }

  getTechnicianInventory(technicianId: string) {
    return this.technicianInventory.getTechnicianInventory(technicianId) as Promise<Record<string, unknown> | undefined>;
  }

  getWarehouseInventory(warehouseId: string) {
    return this.warehouses.getWarehouseInventory(warehouseId) as Promise<Record<string, unknown> | null | undefined>;
  }

  upsertTechnicianMovingInventoryEntry(technicianId: string, itemTypeId: string, boxes: number, units: number) {
    return this.technicianInventory.upsertTechnicianMovingInventoryEntry(technicianId, itemTypeId, boxes, units);
  }

  upsertWarehouseInventoryEntry(warehouseId: string, itemTypeId: string, boxes: number, units: number) {
    return this.warehouseInventory.upsertWarehouseInventoryEntry(warehouseId, itemTypeId, boxes, units);
  }

  updateTechnicianInventory(technicianId: string, updates: Record<string, number>) {
    return this.technicianInventory.updateTechnicianInventory(technicianId, updates as any);
  }

  updateWarehouseInventory(warehouseId: string, updates: Record<string, number>) {
    return this.warehouses.updateWarehouseInventory(warehouseId, updates as any);
  }

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
  }) {
    return repositories.systemLogs.createSystemLog(payload as any);
  }

  async assertItemsQuantityTrackable(items: { itemTypeId: string; quantity: number }[]): Promise<void> {
    const db = getDatabase();
    for (const item of items) {
      await assertItemTypeQuantityTrackable(db, item.itemTypeId);
      assertNonNegativeInteger(item.quantity, `الكمية (${item.itemTypeId})`);
    }
  }

  async isIdempotentWithdrawReplay(idempotencyKey: string): Promise<boolean> {
    const db = getDatabase();
    const replay = await findIdempotentReplay(db, "technician_withdraw_to_warehouse", idempotencyKey);
    return replay !== null;
  }
}
