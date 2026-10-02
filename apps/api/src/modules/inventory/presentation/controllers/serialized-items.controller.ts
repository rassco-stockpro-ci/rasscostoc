import type { Request, Response } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import { AppError, AuthorizationError, NotFoundError } from "@core/errors/AppError";
import { z } from "zod";
import type { SerializedItemsService } from "../../infrastructure/services/serialized-items.service";
import { ROLES } from "@shared/roles";
import {
  isTechnicianCustodyDeleteEnabled,
  isTechnicianDeleteByIdEnabled,
} from "../../config/technician-custody-delete.flag";

const scanInSchema = z.object({
  serialNumber: z.string().trim().min(1, "الرقم التسلسلي مطلوب"),
  itemTypeId: z.string().trim().min(1, "نوع الصنف مطلوب"),
  carrierName: z.string().trim().optional(),
  simPackageType: z.string().trim().optional(),
});

const batchScanInSchema = z.object({
  items: z.array(
    z.object({
      serialNumber: z.string().trim().min(1, "الرقم التسلسلي مطلوب"),
      itemTypeId: z.string().trim().min(1, "نوع الصنف مطلوب"),
      carrierName: z.string().trim().optional(),
      simPackageType: z.string().trim().optional(),
    })
  ).min(1, "الرجاء إدخال مادة واحدة على الأقل"),
});

const scanOutSchema = z.object({
  serialNumber: z.string().trim().min(1, "الرقم التسلسلي مطلوب"),
  receiverName: z.string().trim().min(1, "اسم المستلم مطلوب"),
  orderNumber: z.string().trim().min(1, "رقم الطلب مطلوب"),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

// TEMPORARY FEATURE — remove or disable after final customer handover.
const deleteCustodySerialSchema = z.object({
  confirmation: z.string().trim().min(1, "تأكيد الرقم التسلسلي مطلوب"),
  reason: z.string().trim().optional(),
});
const CUSTODY_DELETE_ITEM_TYPES = ["DEVICE", "SIM"] as const;

export class SerializedItemsController {
  constructor(
    private readonly serializedItemsService: SerializedItemsService
  ) {}

  /**
   * POST /api/serialized-items/scan-in
   * Add item to technician's active custody
   */
  scanIn = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const body = scanInSchema.parse(req.body);

    const item = await this.serializedItemsService.scanIn(
      user.id,
      body.serialNumber,
      body.itemTypeId,
      body.carrierName,
      body.simPackageType
    );

    res.status(200).json({
      success: true,
      message: "تم تسجيل المادة في عهدتك بنجاح",
      data: item,
    });
  });

  /**
   * POST /api/serialized-items/batch-scan-in
   * Add multiple items to technician's active custody
   */
  batchScanIn = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const body = batchScanInSchema.parse(req.body);

    const items = await this.serializedItemsService.batchScanIn(
      user.id,
      body.items
    );

    res.status(200).json({
      success: true,
      message: `تم تسجيل ${items.length} من المواد في عهدتك بنجاح`,
      data: items,
    });
  });

  /**
   * POST /api/serialized-items/scan-out
   * Deliver item from technician's custody to customer
   */
  scanOut = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const body = scanOutSchema.parse(req.body);

    const item = await this.serializedItemsService.scanOut(
      user.id,
      body.serialNumber,
      body.receiverName,
      body.orderNumber,
      body.latitude,
      body.longitude
    );

    res.status(200).json({
      success: true,
      message: "تم تسليم المادة بنجاح وتحديث حالتها",
      data: item,
    });
  });

  /**
   * TEMPORARY FEATURE — remove or disable after final customer handover.
   * DELETE /api/inventory/my-custody/items/:itemType/:serialNumber
   * itemType is exactly "DEVICE" or "SIM" — an explicit, unambiguous URL segment so a
   * device serial and a SIM serial can never be confused with one another.
   * Permanently deletes that single item from the authenticated technician's own
   * active custody. Ownership is verified server-side only — never from the request body.
   */
  deleteFromMyCustody = asyncHandler(async (req: Request, res: Response) => {
    if (!isTechnicianCustodyDeleteEnabled()) {
      throw new NotFoundError("المسار غير متاح");
    }

    const user = req.user!;
    if (user.role !== ROLES.TECHNICIAN) {
      throw new AuthorizationError("هذه العملية متاحة للمندوب فقط");
    }

    const { itemType, identifier, serialNumber } = req.params;
    const targetIdentifier = identifier || serialNumber;
    if (!CUSTODY_DELETE_ITEM_TYPES.includes(itemType as any)) {
      throw new AppError("نوع العنصر يجب أن يكون DEVICE أو SIM فقط", 400, true, "INVALID_ITEM_TYPE");
    }
    if (!targetIdentifier) {
      throw new NotFoundError("الرقم التسلسلي مطلوب");
    }

    const body = deleteCustodySerialSchema.parse(req.body);

    const result = await this.serializedItemsService.deleteFromTechnicianCustody(
      user.id,
      user.username,
      user.role,
      itemType,
      targetIdentifier,
      body.confirmation,
      body.reason
    );

    res.status(200).json({
      success: true,
      itemType: result.itemType,
      serialNumber: result.serialNumber,
      deleted: result.deleted,
      removedFromCustody: true,
      productPreserved: true,
      inventoryRecalculated: true,
      alreadyDeleted: result.alreadyDeleted,
    });
  });

  /**
   * TEMPORARY FEATURE — remove after final inventory workflow is released.
   * DELETE /api/inventory/my-custody/serialized-items/:itemId
   *
   * Lets the authenticated TECHNICIAN permanently delete a single serialized
   * item (device/SIM) they currently hold OR that they themselves delivered,
   * identified by its own database id. Deliberately NOT admin-only, and
   * deliberately a different route from the admin-only DELETE
   * /api/serialized-items/:id below — that route/middleware/behavior is
   * completely unchanged by this addition.
   *
   * Ownership is verified inside the service, against the database, never
   * against anything the client claims — see technicianDeleteOwnSerializedItem's
   * own doc comment for the exact rule. A failed ownership check surfaces here
   * as 403 ITEM_NOT_IN_YOUR_CUSTODY (via AppError's statusCode/code), exactly
   * like the existing deleteFromMyCustody route above.
   */
  technicianDeleteOwnItem = asyncHandler(async (req: Request, res: Response) => {
    if (!isTechnicianDeleteByIdEnabled()) {
      throw new NotFoundError("المسار غير متاح");
    }

    const user = req.user!;
    if (user.role !== ROLES.TECHNICIAN) {
      throw new AuthorizationError("هذه العملية متاحة للمندوب فقط");
    }

    const { itemId } = req.params;
    if (!itemId) {
      throw new NotFoundError("معرّف المادة مطلوب");
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;

    const result = await this.serializedItemsService.technicianDeleteOwnSerializedItem(
      user.id,
      user.username,
      user.role,
      itemId,
      reason
    );

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  /**
   * ADMIN ONLY — DELETE /api/serialized-items/:id
   * Permanently deletes a serialized item (device/SIM) from any technician's custody
   * by its own database id. Used by the admin technician-item-details page.
   */
  adminDeleteById = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (user.role !== ROLES.ADMIN) {
      throw new AuthorizationError("هذه العملية متاحة للأدمن فقط");
    }

    const { id } = req.params;
    if (!id) {
      throw new NotFoundError("معرّف المادة مطلوب");
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;

    const result = await this.serializedItemsService.adminDeleteSerializedItemById(
      user.id,
      user.username,
      user.role,
      id,
      reason
    );

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  /**
   * ADMIN ONLY — PATCH /api/serialized-items/:id
   * Correct data-entry mistakes (serial number / carrier name) on a serialized item.
   * Status changes are intentionally rejected here — use PATCH /api/items/:id/status.
   */
  adminUpdateById = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (user.role !== ROLES.ADMIN) {
      throw new AuthorizationError("هذه العملية متاحة للأدمن فقط");
    }

    const { id } = req.params;
    if (!id) {
      throw new NotFoundError("معرّف المادة مطلوب");
    }

    const bodySchema = z.object({
      serialNumber: z.string().trim().min(1).optional(),
      carrierName: z.string().trim().optional(),
    });
    const updates = bodySchema.parse(req.body);

    const result = await this.serializedItemsService.adminUpdateSerializedItemById(
      user.id,
      user.username,
      user.role,
      id,
      updates
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  /**
   * GET /api/serialized-items/lookup/:serialNumber
   * Retrieve item status, metadata, and history
   */
  lookup = asyncHandler(async (req: Request, res: Response) => {
    const { serialNumber } = req.params;
    if (!serialNumber) {
      return res.status(400).json({
        success: false,
        message: "الرقم التسلسلي مطلوب للبحث",
      });
    }

    const item = await this.serializedItemsService.lookup(serialNumber);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "المادة غير مسجلة في النظام كعهدة حالية",
      });
    }

    res.status(200).json({
      success: true,
      data: item,
    });
  });

  /**
   * GET /api/technicians/:technicianId/serialized-custody
   */
  getTechnicianCustody = asyncHandler(async (req: Request, res: Response) => {
    const { technicianId } = req.params;
    const custodyItems = await this.serializedItemsService.getTechnicianCustody(technicianId);
    res.status(200).json(custodyItems);
  });

  /**
   * GET /api/my-serialized-custody
   */
  getMySerializedCustody = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const custodyItems = await this.serializedItemsService.getTechnicianCustody(userId);
    res.status(200).json(custodyItems);
  });
}
