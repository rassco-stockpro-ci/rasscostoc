import type { Express } from "express";
import { registerWarehousesRoutes } from "./warehouses.routes";
import { registerWarehouseTransferOperationsRoutes } from "./warehouse-transfer-operations.routes";
import { registerWarehouseTransferAdminRoutes } from "./warehouse-transfer-admin.routes";
import { registerWarehouseStockMovementRoutes } from "./warehouse-stock-movements.routes";
import { registerWarehouseBatchOperationsRoutes } from "./warehouse-batch-operations.routes";
import { registerTransactionsRoutes } from "./transactions.routes";
import { registerTechniciansInventoryRoutes } from "./technicians-inventory.routes";
import { registerTechniciansAdminRoutes } from "./technicians-admin.routes";
import { registerSystemRoutes } from "./system.routes";
import { registerSupervisorUsersRoutes } from "./supervisor-users.routes";
import { registerSupervisorTechniciansListRoutes } from "./supervisor-technicians-list.routes";
import { registerSupervisorRequestsRoutes } from "./supervisor-requests.routes";
import { registerSupervisorAssignmentsRoutes } from "./supervisor-assignments.routes";
import { registerStockTransferRoutes } from "./stock-transfer.routes";
import { registerStockFixedInventoryRoutes } from "./stock-fixed-inventory.routes";
import { registerSerializedItemsRoutes } from "./serialized-items.routes";
import { registerRegionsRoutes } from "./regions.routes";
import { registerItemTypesRoutes } from "./item-types.routes";
import { registerInventoryRoutes as registerBaseInventoryRoutes } from "./inventory.routes";
import { registerInventoryScanRoutes } from "./inventory-scan.routes";
import { registerInventoryRequestsManagementRoutes } from "./inventory-requests-management.routes";
import { registerInventoryRequestsCreateRoutes } from "./inventory-requests-create.routes";
import { registerInventoryRequestsApprovalRoutes } from "./inventory-requests-approval.routes";
import { registerWarehouseInventoryEntriesRoutes } from "./inventory-entries-warehouse.routes";
import { registerInventoryEntriesMigrationRoutes } from "./inventory-entries-migration.routes";
import { registerDevicesRoutes } from "./devices.routes";
import { registerDashboardRoutes } from "./dashboard.routes";

import { registerTechniciansProfileRoutes } from "./technicians-profile.routes";
import { registerSduiFiltersRoutes } from "./sdui-filters.routes";
import { representativeInventoryContainer } from "@server/composition/representative-inventory.container";

export function registerInventoryRoutes(app: Express): void {
  registerWarehousesRoutes(app);
  registerWarehouseTransferOperationsRoutes(app);
  registerWarehouseTransferAdminRoutes(app);
  registerWarehouseStockMovementRoutes(app);
  registerWarehouseBatchOperationsRoutes(app);
  registerTransactionsRoutes(app);
  registerTechniciansInventoryRoutes(app);
  registerTechniciansAdminRoutes(app);
  registerSystemRoutes(app);
  registerSupervisorUsersRoutes(app);
  registerSupervisorTechniciansListRoutes(app);
  registerSupervisorRequestsRoutes(app);
  registerSupervisorAssignmentsRoutes(app);
  registerStockTransferRoutes(app);
  registerStockFixedInventoryRoutes(app);
  registerSerializedItemsRoutes(app);
  registerRegionsRoutes(app);
  registerItemTypesRoutes(app);
  registerBaseInventoryRoutes(app);
  registerInventoryScanRoutes(app);
  registerInventoryRequestsManagementRoutes(app);
  registerInventoryRequestsCreateRoutes(app);
  registerInventoryRequestsApprovalRoutes(app);
  registerWarehouseInventoryEntriesRoutes(app);
  // NOTE: technician fixed/moving inventory-entries routes are registered by
  // registerTechniciansInventoryRoutes() above (with requireTechnicianScope).
  // A duplicate, unguarded registration of the same 4 routes used to live in
  // inventory-entries-technician.routes.ts — removed as part of the IDOR fix.
  registerInventoryEntriesMigrationRoutes(app);
  registerDevicesRoutes(app);
  registerDashboardRoutes(app);
  registerTechniciansProfileRoutes(app);
  registerSduiFiltersRoutes(app);

  // Modern representative inventory (V2) routes
  representativeInventoryContainer.representativeRouter.register(app);
}
