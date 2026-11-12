import type { Request, Response, NextFunction } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import { itemCustodyLookupContainer } from "@server/composition/item-custody-lookup.container";
import { canActorAccessTechnician, canActorAccessWarehouse } from "./technician-scope.middleware";

/**
 * Guards PATCH /api/items/:id/status. Admin: any item. Technician: only an item
 * they currently hold. Supervisor: an item held by an assigned technician, or
 * an unheld item sitting in an assigned warehouse. Everyone else: 403.
 */
export const requireItemStatusAuthority = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const actor = req.user!;
    const item = await itemCustodyLookupContainer.itemCustodyLookupRepository.getCustodyById(req.params.id);

    if (!item) {
      return res.status(404).json({ message: "العنصر غير موجود" });
    }

    let allowed: boolean;
    if (actor.role === "admin") {
      allowed = true;
    } else if (actor.role === "technician") {
      allowed = item.currentOwnerId === actor.id;
    } else if (item.currentOwnerId) {
      allowed = actor.role === "supervisor" && (await canActorAccessTechnician(actor, item.currentOwnerId));
    } else if (item.warehouseId) {
      allowed = await canActorAccessWarehouse(actor, item.warehouseId);
    } else {
      allowed = false;
    }

    if (!allowed) {
      return res.status(403).json({ message: "غير مصرح لك بتغيير حالة هذا العنصر" });
    }
    next();
  },
);
