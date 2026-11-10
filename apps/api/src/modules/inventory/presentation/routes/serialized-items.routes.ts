import type { Express } from "express";
import { serializedItemsContainer } from "@server/composition/serialized-items.container";
import { requireAuth } from "@core/middlewares/auth.middleware";

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

  // Admin/supervisor substring search across serialized items (devices/SIMs)
  app.get(
    "/api/serialized-items/search",
    requireAuth,
    controller.search
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
}
