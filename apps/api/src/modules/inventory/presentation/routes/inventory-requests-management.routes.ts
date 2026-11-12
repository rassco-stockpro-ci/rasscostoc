import type { Express } from "express";
import { requireAuth, requireAdmin, requireSupervisor } from "@core/middlewares/auth.middleware";
import {
  InventoryRequestsManagementUseCaseError,
} from "@modules/inventory/application/inventory-requests/use-cases/InventoryRequestsManagement.use-case";
import { inventoryRequestsManagementContainer } from "@server/composition/inventory-requests-management.container";

/**
 * Inventory Requests Management Routes - إدارة طلبات المخزون (< 100 lines)
 * مجال المسؤولية: إدارة وتحديث حالات طلبات المخزون
 */
export function registerInventoryRequestsManagementRoutes(app: Express): void {

  // تحديث حالة طلب المخزون (موافقة/رفض)
  app.patch("/api/inventory-requests/:id/status", requireAuth, requireSupervisor, async (req, res) => {
    try {
      const user = (req as any).user;
      const { status, adminNotes } = req.body;
      await inventoryRequestsManagementContainer.inventoryRequestsManagementUseCase.assertCanUpdateStatus(
        req.params.id,
        { role: user.role, regionId: user.regionId ?? null },
      );
      const updatedRequest = await inventoryRequestsManagementContainer.inventoryRequestsManagementUseCase.updateStatus({
        id: req.params.id,
        status,
        respondedBy: user.id,
        adminNotes,
      });
      
      // Log the status update
      await inventoryRequestsManagementContainer.createSystemLogUseCase.execute({
        userId: user.id,
        userName: user.fullName || user.username || 'Unknown',
        userRole: user.role,
        regionId: user.regionId,
        action: 'update',
        entityType: 'inventory_request',
        entityId: req.params.id,
        entityName: `طلب مخزون`,
        description: `تم ${status === 'approved' ? 'الموافقة على' : 'رفض'} طلب المخزون`,
        severity: status === 'approved' ? 'info' : 'warn',
        success: true,
        details: JSON.stringify({ status, adminNotes }),
      });
      
      res.json(updatedRequest);
    } catch (error) {
      if (error instanceof InventoryRequestsManagementUseCaseError) {
        return res.status(error.statusCode).json({ message: error.message });
      }

      console.error("Error updating inventory request status:", error);
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({ message: "Inventory request not found" });
      }
      res.status(500).json({ message: "Failed to update inventory request status" });
    }
  });

  // حذف طلب المخزون
  app.delete("/api/inventory-requests/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const user = (req as any).user;
      await inventoryRequestsManagementContainer.inventoryRequestsManagementUseCase.deleteRequest(req.params.id);
      
      // Log the deletion
      await inventoryRequestsManagementContainer.createSystemLogUseCase.execute({
        userId: user.id,
        userName: user.fullName || user.username || 'Unknown',
        userRole: user.role,
        regionId: user.regionId,
        action: 'delete',
        entityType: 'inventory_request',
        entityId: req.params.id,
        entityName: `طلب مخزون`,
        description: `تم حذف طلب المخزون`,
        severity: 'warn',
        success: true,
      });
      
      res.json({ message: "Inventory request deleted successfully" });
    } catch (error) {
      if (error instanceof InventoryRequestsManagementUseCaseError) {
        return res.status(error.statusCode).json({ message: error.message });
      }

      console.error("Error deleting inventory request:", error);
      res.status(500).json({ message: "Failed to delete inventory request" });
    }
  });
}