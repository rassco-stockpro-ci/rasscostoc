/**
 * Warehouses routes
 */

import type { Express } from "express";
import { warehousesContainer } from "@server/composition/warehouses.container";
import { requireAuth, requireAdmin, requireSupervisor } from "@core/middlewares/auth.middleware";
import { requireCatalogedPermission } from "@core/middlewares/requireCatalogedPermission.middleware";
import { validateBody } from "@core/middlewares/validation";
import { insertWarehouseSchema } from "@shared/schema";
import { z } from "zod";

const inventoryEntrySchema = z.object({
  itemTypeId: z.string(),
  boxes: z.number().min(0),
  units: z.number().min(0),
});

export function registerWarehousesRoutes(app: Express): void {
  const controller = warehousesContainer.warehousesController;

  // Get all warehouses (admin)
  app.get(
    "/api/warehouses",
    requireAuth,
    requireAdmin,
    controller.getAll
  );

  // Get supervisor warehouses
  app.get(
    "/api/supervisor/warehouses",
    requireAuth,
    requireSupervisor,
    controller.getSupervisorWarehouses
  );

  // Get single warehouse
  app.get(
    "/api/warehouses/:id",
    requireAuth,
    requireSupervisor,
    controller.getById
  );

  // Create warehouse
  app.post(
    "/api/warehouses",
    requireAuth,
    requireAdmin,
    validateBody(insertWarehouseSchema),
    controller.create
  );

  // Update warehouse
  app.put(
    "/api/warehouses/:id",
    requireAuth,
    requireAdmin,
    validateBody(insertWarehouseSchema.partial()),
    controller.update
  );

  // Delete warehouse
  app.delete(
    "/api/warehouses/:id",
    requireAuth,
    requireAdmin,
    controller.delete
  );

  // Get warehouse inventory
  // OPS-PERM-S2: real Permission Engine enforcement for "warehouse.inventory:view" —
  // supervisor-role only; admin/courier_supervisor keep their existing requireSupervisor
  // access unchanged (see requireCatalogedPermission's own doc comment).
  app.get(
    "/api/warehouse-inventory/:warehouseId",
    requireAuth,
    requireSupervisor,
    requireCatalogedPermission("warehouse.inventory", "view"),
    controller.getInventory
  );

  // Update warehouse inventory
  app.put(
    "/api/warehouse-inventory/:warehouseId",
    requireAuth,
    requireSupervisor,
    controller.updateInventory
  );

  // Get warehouse inventory entries
  app.get(
    "/api/warehouses/:warehouseId/inventory-entries",
    requireAuth,
    controller.getInventoryEntries
  );

  // Upsert warehouse inventory entry
  app.post(
    "/api/warehouses/:warehouseId/inventory-entries",
    requireAuth,
    validateBody(inventoryEntrySchema),
    controller.upsertInventoryEntry
  );
}
