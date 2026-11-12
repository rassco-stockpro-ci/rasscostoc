import type { Request, Response } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import { AppError, AuthorizationError, NotFoundError } from "@core/errors/AppError";
import { z } from "zod";
import type { SerializedItemsService } from "../../infrastructure/services/serialized-items.service";
import { ROLES } from "@shared/roles";
import { isTechnicianCustodyDeleteEnabled } from "../../config/technician-custody-delete.flag";
import { supervisorAssignmentsContainer } from "@server/composition/supervisor-assignments.container";

/**
 * Can this authenticated user see the given item's current owner's custody
 * details? Admin: always. Supervisor: only technicians actually assigned to
 * them (SupervisorAssignmentsUseCase — same scope source as requireTechnicianScope).
 * Technician: only themself. No currentOwnerId (unassigned item) — admin/supervisor
 * only, never a plain technician.
 */
async function canViewOwnerDetails(
  user: { id: string; role: string },
  currentOwnerId: string | null
): Promise<boolean> {
  if (user.role === ROLES.ADMIN) return true;
  if (currentOwnerId && user.id === currentOwnerId) return true;
  if (user.role === ROLES.SUPERVISOR) {
    if (!currentOwnerId) return false;
    const assigned = await supervisorAssignmentsContainer.supervisorAssignmentsUseCase.getTechnicianIdsBySupervisor(user.id);
    return assigned.includes(currentOwnerId);
  }
  return false;
}

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

    const allowed = await canViewOwnerDetails(req.user!, item.currentOwnerId ?? null);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: "غير مصرح لك بالوصول لبيانات هذه المادة",
      });
    }

    const { currentOwnerId, ...safeItem } = item;

    res.status(200).json({
      success: true,
      data: safeItem,
    });
  });

  /**
   * GET /api/serialized-items/search?q=...
   * Admin-facing substring search (the counterpart to lookup()'s exact match),
   * used by the portal's operations-search page. Results are scoped exactly
   * like getTechnicianCustody/lookup: admin sees everything, a supervisor only
   * their assigned technicians' items, a technician only their own.
   */
  search = asyncHandler(async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      return res.status(200).json({ success: true, data: [] });
    }

    const user = req.user!;
    let ownerIdFilter: string[] | undefined;

    if (user.role === ROLES.SUPERVISOR) {
      ownerIdFilter = await supervisorAssignmentsContainer.supervisorAssignmentsUseCase.getTechnicianIdsBySupervisor(user.id);
    } else if (user.role !== ROLES.ADMIN) {
      // Technician (or any other non-admin, non-supervisor role): self only.
      ownerIdFilter = [user.id];
    }
    // ROLES.ADMIN: ownerIdFilter stays undefined => unrestricted.

    const results = await this.serializedItemsService.searchItems(q, ownerIdFilter);

    res.status(200).json({
      success: true,
      data: results,
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
