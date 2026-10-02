import type { Request, Response } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import type { WarehouseTransferService } from "../../infrastructure/services/warehouse-transfer.service";
import { inventoryContainer } from "@server/composition/inventory.container";
import { warehouseScopeContainer } from "@server/composition/warehouse-scope.container";
import { AuthorizeWarehouseTransferMutationError } from "@modules/inventory/application/warehouse/use-cases/AuthorizeWarehouseTransferMutation.use-case";

export class WarehouseTransferController {
  constructor(
    private readonly warehouseTransferService: WarehouseTransferService
  ) {}

  /**
   * OPS-PERM-S1-F1.R2.SR2/SR3 — single authorization gate for every transfer
   * mutation. This controller performs NO role logic of its own: the entire
   * decision (admin / supervisor warehouse-scope / technician-own, deny
   * everything else) lives in the seam's pure policy, so a role added to the
   * system later cannot silently inherit an authorization path here.
   *
   * Returns the loaded transfer on allow, or null after having already sent the
   * denial response.
   */
  private authorizeTransferMutation = async (req: Request, res: Response) => {
    const user = req.user!;

    try {
      return await warehouseScopeContainer.authorizeWarehouseTransferMutationUseCase.execute({
        actor: { id: user.id, role: user.role, regionId: user.regionId },
        transferId: req.params.id,
      });
    } catch (error) {
      if (error instanceof AuthorizeWarehouseTransferMutationError) {
        res.status(error.statusCode).json({ message: error.message });
        return null;
      }
      throw error;
    }
  };

  updateStatus = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const transfer = await this.authorizeTransferMutation(req, res);
    if (!transfer) return;

    const status = String(req.body?.status || "").toLowerCase();
    if (status === "approved" || status === "accepted") {
      const result = await inventoryContainer.acceptWarehouseTransferUseCase.execute({
        transferId: id,
      });
      return res.json(result);
    }
    if (status === "rejected") {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "Rejected via status endpoint";
      const result = await inventoryContainer.rejectWarehouseTransferUseCase.execute({
        transferId: id,
        reason,
      });
      return res.json(result);
    }

    return res.status(400).json({ message: "Invalid status. Use approved|accepted|rejected" });
  });

  accept = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const transfer = await this.authorizeTransferMutation(req, res);
    if (!transfer) return;

    const result = await inventoryContainer.acceptWarehouseTransferUseCase.execute({
      transferId: id,
    });
    res.json(result);
  });

  reject = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const transfer = await this.authorizeTransferMutation(req, res);
    if (!transfer) return;

    const { reason } = req.body;
    const result = await inventoryContainer.rejectWarehouseTransferUseCase.execute({
      transferId: id,
      reason,
    });
    res.json(result);
  });

  scanSerial = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const transferId = req.params.id;
    const { serialNumber } = req.body;

    if (!serialNumber || typeof serialNumber !== "string" || !serialNumber.trim()) {
      return res.status(400).json({ message: "الرقم التسلسلي مطلوب" });
    }

    const transfer = await this.authorizeTransferMutation(req, res);
    if (!transfer) return;

    if (transfer.status !== "accepted") {
      return res.status(400).json({ message: "يجب قبول الطلب أولاً قبل بدء المسح" });
    }

    const result = await this.warehouseTransferService.scanSerial(
      user.id,
      transferId,
      serialNumber,
      transfer.itemType
    );
    res.status(200).json(result);
  });

  confirmReceipt = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const transferId = req.params.id;

    const transfer = await this.authorizeTransferMutation(req, res);
    if (!transfer) return;

    if (transfer.status !== "accepted") {
      return res.status(400).json({ message: "الطلب يجب أن يكون مقبولاً ليتم تأكيد استلامه" });
    }

    const result = await this.warehouseTransferService.confirmReceipt(
      user.id,
      transferId,
      transfer.itemType,
      transfer.quantity,
      transfer.packagingType
    );
    res.status(200).json(result);
  });

  getTechnicianSerializedItems = asyncHandler(async (req: Request, res: Response) => {
    const { technicianId } = req.params;
    const items = await this.warehouseTransferService.getTechnicianSerializedItems(technicianId);
    res.json(items);
  });

  getTechnicianDeliveredItems = asyncHandler(async (req: Request, res: Response) => {
    const { technicianId } = req.params;
    const itemTypeId = typeof req.query.itemTypeId === "string" ? req.query.itemTypeId : undefined;
    const items = await this.warehouseTransferService.getTechnicianDeliveredItems(technicianId, itemTypeId);
    res.json(items);
  });

  lookupSerial = asyncHandler(async (req: Request, res: Response) => {
    const { serialNumber } = req.params;
    const result = await this.warehouseTransferService.lookupItemBySerial(serialNumber);

    if (!result) {
      return res.status(404).json({ message: `لم يُعثر على سيريال: ${serialNumber}` });
    }

    res.json(result);
  });

  lookupAssetTracking = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    const { assetTrackingService } = await import("../../infrastructure/services/asset-tracking.service");
    const result = await assetTrackingService.getUnifiedAssetTracking(identifier);

    // Audit Log for search query
    try {
      const { db } = await import("@core/config/db");
      const { systemLogs } = await import("@shared/schema");
      const user = req.user;
      await db.insert(systemLogs).values({
        userId: user?.id || null,
        userName: user?.username || "زائر الميدان / نظام التحقق",
        userRole: user?.role || "user",
        action: "search",
        entityType: "search_query",
        entityId: identifier,
        entityName: result?.asset?.itemTypeName || "استعلام تتبع أصل",
        description: result 
          ? `تم الاستعلام والبحث عن الرقم التسلسلي/الباركود (${identifier}) - النتيجة: معثور عليه (${result.asset.itemTypeName || 'أصل'})`
          : `تم الاستعلام والبحث عن الرقم التسلسلي/الباركود (${identifier}) - النتيجة: غير موجود بالنظام`,
        details: JSON.stringify({
          query: identifier,
          found: !!result,
          assetId: result?.asset?.id || null,
          currentCustodian: result?.currentCustodian?.fullName || null,
          status: result?.asset?.status || null,
          ip: req.ip || req.headers["x-forwarded-for"] || "127.0.0.1",
          userAgent: req.headers["user-agent"] || "Browser",
        }),
        severity: result ? "info" : "warn",
        success: !!result,
      });
    } catch (logErr) {
      console.error("Failed to insert system log for search:", logErr);
    }

    if (!result) {
      return res.status(404).json({ message: `لم يُعثر على أصل بالسيريال / الباركود: ${identifier}` });
    }

    res.json(result);
  });

  updateItemStatus = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { status, orderNumber, warehouseId } = req.body;
    // The person who INITIATED this request -- never to be confused with
    // an item's own currentOwnerId inside the service. requireAdmin on the
    // route already gates this, but the service independently re-verifies
    // the role from the DB using only this id.
    const callerId = req.user!.id;

    if (!status) {
      return res.status(400).json({ message: "الحالة مطلوبة" });
    }

    const result = await this.warehouseTransferService.updateItemStatus(
      callerId,
      id,
      status,
      orderNumber,
      warehouseId
    );
    res.json(result);
  });
}
