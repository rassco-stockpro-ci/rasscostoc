import type { Express } from "express";
import { serializedItemsContainer } from "@server/composition/serialized-items.container";
import { requireAuth, requireAdmin } from "@core/middlewares/auth.middleware";

/**
 * Serialized Items Routing Configuration
 */
export function registerSerializedItemsRoutes(app: Express): void {
  const controller = serializedItemsContainer.serializedItemsController;

  // Get active serialized custody for a technician
  app.get(
    "/api/technicians/:technicianId/serialized-custody",
    requireAuth,
    controller.getTechnicianCustody
  );

  // Get MY serialized custody (authenticated user shortcut)
  app.get(
    "/api/my-serialized-custody",
    requireAuth,
    controller.getMySerializedCustody
  );


  // Add item to custody
  app.post(
    "/api/serialized-items/scan-in",
    requireAuth,
    controller.scanIn
  );

  // Batch add items to custody
  app.post(
    "/api/serialized-items/batch-scan-in",
    requireAuth,
    controller.batchScanIn
  );

  // Deliver item from custody
  app.post(
    "/api/serialized-items/scan-out",
    requireAuth,
    controller.scanOut
  );

  // Lookup item custody and lifecycle history
  app.get(
    "/api/serialized-items/lookup/:serialNumber",
    requireAuth,
    controller.lookup
  );

  // TEMPORARY FEATURE — remove or disable after final customer handover.
  // Permanently delete a DEVICE or SIM from the authenticated technician's own active
  // custody. itemType is an explicit URL segment ("DEVICE"|"SIM") so the two can never
  // be confused. Gated by ENABLE_TECHNICIAN_CUSTODY_DELETE (see technician-custody-delete.flag.ts).
  app.delete(
    "/api/inventory/my-custody/items/:itemType/:identifier",
    requireAuth,
    controller.deleteFromMyCustody
  );

  // ADMIN ONLY — permanently delete any technician's serialized item (device/SIM) by
  // its own database id. Used by the admin technician-item-details page, which
  // previously called this exact path but no route existed for it (404 on every
  // attempt — the bug behind "can't delete some products").
  app.delete(
    "/api/serialized-items/:id",
    requireAuth,
    requireAdmin,
    controller.adminDeleteById
  );

  // ADMIN ONLY — correct serial number / carrier data-entry mistakes. Used by
  // technician-item-details.tsx and verification.tsx, both of which previously
  // called this exact path with no route registered for it (silent 404).
  app.patch(
    "/api/serialized-items/:id",
    requireAuth,
    requireAdmin,
    controller.adminUpdateById
  );
}
