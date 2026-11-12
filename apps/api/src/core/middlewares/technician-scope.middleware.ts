import type { Request, Response, NextFunction } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import { supervisorAssignmentsContainer } from "@server/composition/supervisor-assignments.container";

type Actor = { id: string; role: string };

/**
 * True when the actor is the technician themself, an admin, or a supervisor
 * actually assigned to that technician (via SupervisorAssignmentsUseCase — the
 * same scope source used by GET /api/technicians and /api/supervisor/technicians).
 */
export async function canActorAccessTechnician(actor: Actor, technicianId: string): Promise<boolean> {
  if (actor.id === technicianId || actor.role === "admin") return true;
  if (actor.role !== "supervisor") return false;
  const assigned =
    await supervisorAssignmentsContainer.supervisorAssignmentsUseCase.getTechnicianIdsBySupervisor(actor.id);
  return assigned.includes(technicianId);
}

/** True for admins, or supervisors assigned to that warehouse. */
export async function canActorAccessWarehouse(actor: Actor, warehouseId: string): Promise<boolean> {
  if (actor.role === "admin") return true;
  if (actor.role !== "supervisor") return false;
  const assigned =
    await supervisorAssignmentsContainer.supervisorAssignmentsUseCase.getWarehouseIdsBySupervisor(actor.id);
  return assigned.includes(warehouseId);
}

/**
 * Authorizes access to a :technicianId-scoped resource. Denies everyone else
 * with 403, including other technicians and supervisors not assigned to this
 * specific technician.
 */
export const requireTechnicianScope = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    if (await canActorAccessTechnician(req.user!, req.params.technicianId)) {
      return next();
    }
    return res.status(403).json({ message: "غير مصرح لك بالوصول لهذا المورد" });
  },
);
