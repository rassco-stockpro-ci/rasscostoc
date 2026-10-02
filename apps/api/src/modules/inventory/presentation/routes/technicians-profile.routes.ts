import type { Express } from "express";
import { techniciansController } from "../controllers/technicians.controller";
import { requireAuth, requireSupervisor } from "@core/middlewares/auth.middleware";

/**
 * Technicians Profile Routes
 */
export function registerTechniciansProfileRoutes(app: Express): void {
  // Get all technicians
  app.get("/api/technicians", requireAuth, techniciansController.getAll);

  // Get supervisor's technicians
  app.get(
    "/api/supervisor/technicians",
    requireAuth,
    requireSupervisor,
    techniciansController.getSupervisorTechnicians
  );

  // Get single technician
  app.get("/api/technicians/:id", requireAuth, techniciansController.getById);

  // Update a technician's profile (admin: any technician, supervisor: only assigned).
  // Was previously called by the frontend with no matching route (silent no-op / 404).
  app.patch("/api/technicians/:id", requireAuth, techniciansController.update);

  // Delete a technician (admin: any technician, supervisor: only assigned).
  // Was previously called by the frontend with no matching route (silent no-op / 404).
  app.delete("/api/technicians/:id", requireAuth, techniciansController.delete);
}
