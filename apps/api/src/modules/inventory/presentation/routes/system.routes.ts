/**
 * System routes (logs, backup, etc.)
 */

import type { Express } from "express";
import { systemContainer } from "@server/composition/system.container";
import { requireAuth, requireAdmin, requireSupervisor } from "@core/middlewares/auth.middleware";
import { requireCatalogedPermission } from "@core/middlewares/requireCatalogedPermission.middleware";
import { validateBody } from "@core/middlewares/validation";
import { z } from "zod";

const restoreBackupSchema = z.object({
  version: z.string().optional(),
  timestamp: z.string().optional(),
  data: z.object({
    regions: z.array(z.any()).optional(),
    users: z.array(z.any()).optional(),
    inventoryItems: z.array(z.any()).optional(),
    transactions: z.array(z.any()).optional(),
    warehouses: z.array(z.any()).optional(),
    warehouseInventory: z.array(z.any()).optional(),
    warehouseInventoryEntries: z.array(z.any()).optional(),
    supervisorWarehouses: z.array(z.any()).optional(),
    techniciansInventory: z.array(z.any()).optional(),
    technicianFixedInventories: z.array(z.any()).optional(),
    inventoryRequests: z.array(z.any()).optional(),
    warehouseTransfers: z.array(z.any()).optional(),
    stockMovements: z.array(z.any()).optional(),
    receivedDevices: z.array(z.any()).optional(),
    systemLogs: z.array(z.any()).optional(),
    itemTypes: z.array(z.any()).optional(),
    withdrawnDevices: z.array(z.any()).optional(),
  }),
});

export function registerSystemRoutes(app: Express): void {
  const controller = systemContainer.systemController;

  // Get system logs
  // OPS-PERM-S2: previously requireAuth only — any authenticated role, including
  // technician/viewer, could read the full audit log. Now restricted to
  // admin+supervisor (matching this page's existing frontend nav visibility),
  // with supervisor additionally gated through the Permission Engine
  // ("system.auditLogs:view") so it is grantable/revocable per employee.
  app.get("/api/system-logs", requireAuth, requireSupervisor, requireCatalogedPermission("system.auditLogs", "view"), controller.getLogs);

  // Create backup
  app.get("/api/admin/backup", requireAuth, requireAdmin, controller.createBackup);

  // Get backup storage stats
  app.get("/api/admin/backup/storage-stats", requireAuth, requireAdmin, controller.getBackupStorageStats);

  // Get backup history
  app.get("/api/admin/backup/history", requireAuth, requireAdmin, controller.getBackupHistory);

  // Restore backup
  app.post(
    "/api/admin/restore",
    requireAuth,
    requireAdmin,
    validateBody(restoreBackupSchema),
    controller.restoreBackup
  );
}
