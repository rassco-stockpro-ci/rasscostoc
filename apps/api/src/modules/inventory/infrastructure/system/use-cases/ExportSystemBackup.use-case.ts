import { getDatabase } from "@core/database/connection";
import {
  inventoryItems,
  itemTypes,
  regions,
  supervisorWarehouses,
  transactions,
  users,
  inventoryRequests,
  warehouseInventory,
  warehouseInventoryEntries,
  warehouseTransfers,
  warehouses,
} from "@shared/schema";

export class ExportSystemBackupUseCase {
  async execute(): Promise<{ exportedAt: string; data: Record<string, unknown> }> {
    const db = getDatabase();

    const [
      allUsers,
      allRegions,
      allItemTypes,
      allItems,
      allTransactions,
      allWarehouses,
      allWarehouseInventory,
      allWarehouseInventoryEntries,
      allSupervisorWarehouses,
      allInventoryRequests,
      allWarehouseTransfers,
    ] = await Promise.all([
      // ROOT FIX (TEMP-SYSTEM-STABILIZATION): the previous `select().from(users)` pulled
      // every column, including the bcrypt password hash, into a downloadable backup
      // file. No restore use case exists in this codebase that consumes `users.password`
      // from a backup, so there is no documented technical need to include it — it is
      // excluded explicitly rather than stripped after the fact.
      db.select({
        id: users.id,
        username: users.username,
        email: users.email,
        fullName: users.fullName,
        profileImage: users.profileImage,
        city: users.city,
        role: users.role,
        regionId: users.regionId,
        employeeCode: users.employeeCode,
        technicianCode: users.technicianCode,
        department: users.department,
        permissions: users.permissions,
        isActive: users.isActive,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      }).from(users),
      db.select().from(regions),
      db.select().from(itemTypes),
      db.select().from(inventoryItems),
      db.select().from(transactions),
      db.select().from(warehouses),
      db.select().from(warehouseInventory),
      db.select().from(warehouseInventoryEntries),
      db.select().from(supervisorWarehouses),
      db.select().from(inventoryRequests),
      db.select().from(warehouseTransfers),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      data: {
        users: allUsers,
        regions: allRegions,
        itemTypes: allItemTypes,
        inventoryItems: allItems,
        transactions: allTransactions,
        warehouses: allWarehouses,
        warehouseInventory: allWarehouseInventory,
        warehouseInventoryEntries: allWarehouseInventoryEntries,
        supervisorWarehouses: allSupervisorWarehouses,
        inventoryRequests: allInventoryRequests,
        warehouseTransfers: allWarehouseTransfers,
      },
    };
  }
}
