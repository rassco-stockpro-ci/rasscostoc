import type { Express } from "express";
import { techniciansController } from "@modules/inventory/presentation/controllers/technicians.controller";
import { requireAuth, requireSupervisor } from "@core/middlewares/auth.middleware";
import { requireTechnicianScope } from "@core/middlewares/technician-scope.middleware";
import { validateBody } from "@core/middlewares/validation";
import { z } from "zod";

const stockTransferSchema = z.object({
  technicianId: z.string(),
  itemType: z.string(),
  packagingType: z.enum(["box", "unit"]),
  quantity: z.number().positive(),
  fromInventory: z.enum(["fixed", "moving"]),
  toInventory: z.enum(["fixed", "moving"]),
  reason: z.string().optional(),
  notes: z.string().optional(),
});

const inventoryEntrySchema = z.object({
  itemTypeId: z.string(),
  boxes: z.number().min(0),
  units: z.number().min(0),
});

/**
 * Technicians Inventory Routes - نقاط نهاية المخزون للمندوبين (<100 سطر)
 */
export function registerTechniciansInventoryRoutes(app: Express): void {
  // Get my fixed inventory
  app.get(
    "/api/my-fixed-inventory",
    requireAuth,
    techniciansController.getMyFixedInventory
  );

  // Get my moving inventory
  app.get(
    "/api/my-moving-inventory",
    requireAuth,
    techniciansController.getMyMovingInventory
  );

  // Get technician's fixed inventory
  app.get(
    "/api/technician-fixed-inventory/:technicianId",
    requireAuth,
    async (req, res, next) => {
      const user = req.user!;
      const { technicianId } = req.params;
      if (user.role !== 'admin' && user.role !== 'supervisor' && user.id !== technicianId) {
        return res.status(403).json({ message: "غير مصرح لك بالوصول لمخزون هذا الفني" });
      }
      next();
    },
    techniciansController.getFixedInventory
  );

  // Update technician's fixed inventory
  app.put(
    "/api/technician-fixed-inventory/:technicianId",
    requireAuth,
    async (req, res, next) => {
      const user = req.user!;
      const { technicianId } = req.params;
      if (user.role !== 'admin' && user.role !== 'supervisor' && user.id !== technicianId) {
        return res.status(403).json({ message: "غير مصرح لك بتعديل مخزون هذا الفني" });
      }
      next();
    },
    techniciansController.updateFixedInventory
  );

  // Delete technician's fixed inventory
  app.delete(
    "/api/technician-fixed-inventory/:technicianId",
    requireAuth,
    async (req, res, next) => {
      const user = req.user!;
      const { technicianId } = req.params;
      if (user.role !== 'admin' && user.role !== 'supervisor' && user.id !== technicianId) {
        return res.status(403).json({ message: "غير مصرح لك بحذف مخزون هذا الفني" });
      }
      next();
    },
    techniciansController.deleteFixedInventory
  );

  // Get stock movements
  app.get(
    "/api/stock-movements",
    requireAuth,
    techniciansController.getStockMovements
  );

  // Transfer stock
  app.post(
    "/api/stock-transfer",
    requireAuth,
    validateBody(stockTransferSchema),
    async (req, res, next) => {
      const user = req.user!;
      const { technicianId } = req.body;
      if (user.role !== 'admin' && user.role !== 'supervisor' && user.id !== technicianId) {
        return res.status(403).json({ message: "غير مصرح لك بإجراء مناقلة لهذا الفني" });
      }
      next();
    },
    techniciansController.transferStock
  );

  // Withdraw from technician moving inventory to warehouse
  app.post(
    "/api/technicians/:technicianId/withdraw-to-warehouse",
    requireAuth,
    requireSupervisor,
    techniciansController.withdrawToWarehouse
  );

  // Get technician's fixed inventory entries
  app.get(
    "/api/technicians/:technicianId/fixed-inventory-entries",
    requireAuth,
    requireTechnicianScope,
    techniciansController.getFixedInventoryEntries
  );

  // Upsert technician's fixed inventory entry
  app.post(
    "/api/technicians/:technicianId/fixed-inventory-entries",
    requireAuth,
    requireTechnicianScope,
    validateBody(inventoryEntrySchema),
    techniciansController.upsertFixedInventoryEntry
  );

  // Get technician's moving inventory entries
  app.get(
    "/api/technicians/:technicianId/moving-inventory-entries",
    requireAuth,
    requireTechnicianScope,
    techniciansController.getMovingInventoryEntries
  );

  // Upsert technician's moving inventory entry (supports both single and batch)
  app.post(
    "/api/technicians/:technicianId/moving-inventory-entries",
    requireAuth,
    requireTechnicianScope,
    techniciansController.upsertMovingInventoryEntry
  );

  // admin/supervisor endpoints moved to technicians-admin.routes.ts to keep this file small
}
