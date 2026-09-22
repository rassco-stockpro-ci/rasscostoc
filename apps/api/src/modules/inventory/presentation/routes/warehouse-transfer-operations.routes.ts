import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "@core/middlewares/auth.middleware";
import { requireCatalogedPermission } from "@core/middlewares/requireCatalogedPermission.middleware";
import { inventoryContainer } from "@server/composition/inventory.container";
import { normalizeCreateWarehouseTransferPayload } from "@modules/inventory/application/inventory/use-cases/WarehouseTransferOperations.use-case";

/**
 * Warehouse Transfer Operations Routing Configuration
 * مجال المسؤولية: تعريف المسارات وتوجيه الطلبات إلى الـ Controller أو Use Cases المناسبة
 */
export function registerWarehouseTransferOperationsRoutes(app: Express): void {
  const controller = inventoryContainer.warehouseTransferController;

  // عرض جميع المناقلات
  // OPS-PERM-S2: real Permission Engine enforcement for "warehouse.transfers:view" —
  // supervisor-role only; admin/technician keep their existing access unchanged (see
  // requireCatalogedPermission's own doc comment).
  app.get("/api/warehouse-transfers", requireAuth, requireCatalogedPermission("warehouse.transfers", "view"), async (req, res) => {
    try {
      const user = req.user!;
      const filters = user.role === 'admin' || user.role === 'supervisor'
        ? {}
        : { technicianId: user.id };

      const transfers = await inventoryContainer.getWarehouseTransfersUseCase.execute(filters);
      res.json(transfers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error fetching warehouse transfers:", message);
      res.status(500).json({ message: "Failed to fetch warehouse transfers" });
    }
  });

  // إنشاء مناقلة جديدة
  app.post("/api/warehouse-transfers", requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const normalized = normalizeCreateWarehouseTransferPayload(req.body);

      if (user.role !== 'admin' && user.role !== 'supervisor' && normalized.technicianId !== user.id) {
        return res.status(403).json({ message: "غير مصرح لك بإنشاء مناقلة لهذا الفني" });
      }

      const result = await inventoryContainer.createWarehouseTransfersUseCase.execute({
        warehouseId: normalized.warehouseId,
        technicianId: normalized.technicianId,
        notes: normalized.notes,
        items: normalized.items,
        performedBy: user.id,
      });

      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error creating warehouse transfer:", message);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      if (error instanceof Error && error.message === "No items to transfer") {
        return res.status(400).json({ message: "No items to transfer" });
      }
      res.status(500).json({ message: "Failed to create warehouse transfer" });
    }
  });

  // تحديث حالة المناقلة
  app.patch("/api/warehouse-transfers/:id/status", requireAuth, controller.updateStatus);

  // قبول مناقلة
  app.post("/api/warehouse-transfers/:id/accept", requireAuth, controller.accept);

  // رفض مناقلة
  app.post("/api/warehouse-transfers/:id/reject", requireAuth, controller.reject);

  // مسح سيريال مفرد (real-time, فوري)
  app.post("/api/warehouse-transfers/:id/scan-serial", requireAuth, controller.scanSerial);

  // تأكيد الاستلام النهائي (بعد اكتمال المسح)
  app.post("/api/warehouse-transfers/:id/confirm-receipt", requireAuth, controller.confirmReceipt);

  // جلب الأرقام التسلسلية لعهدة الفني
  app.get("/api/technicians/:technicianId/serialized-items", requireAuth, controller.getTechnicianSerializedItems);

  // سجل التسليم من عهدة الفني (items + custody_movements)
  app.get("/api/technicians/:technicianId/delivered-items", requireAuth, controller.getTechnicianDeliveredItems);

  // بحث الأدمن بالسيريال (لصفحة التحقق) — عبر Central Serial Engine
  app.get("/api/items/lookup/:serialNumber", requireAuth, controller.lookupSerial);

  // بوابة التحقق المتقدمة والأصل — تتبع شامل وبصري للدورة الحياتية
  app.get("/api/verification/assets/:identifier", requireAuth, controller.lookupAssetTracking);

  // تحديث حالة السيريال من الأدمن (باستخدام محرك العهدة الموحد)
  app.patch("/api/items/:id/status", requireAuth, controller.updateItemStatus);
}