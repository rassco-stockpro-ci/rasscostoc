import type { Request, Response, NextFunction } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import { supervisorAssignmentsContainer } from "@server/composition/supervisor-assignments.container";

/**
 * Authorizes access to a :technicianId-scoped resource.
 * Allows: the technician themself, admins, or supervisors actually assigned
 * to that technician (via SupervisorAssignmentsUseCase — the same scope
 * source used by GET /api/technicians and /api/supervisor/technicians).
 * Denies everyone else with 403, including other technicians and
 * supervisors not assigned to this specific technician.
 */
export const requireTechnicianScope = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user!;
    const { technicianId } = req.params;

    if (user.id === technicianId || user.role === "admin") {
      return next();
    }

    if (user.role === "supervisor") {
      const assignedTechnicianIds =
        await supervisorAssignmentsContainer.supervisorAssignmentsUseCase.getTechnicianIdsBySupervisor(
          user.id,
        );
      if (assignedTechnicianIds.includes(technicianId)) {
        return next();
      }
    }

    return res.status(403).json({ message: "غير مصرح لك بالوصول لهذا المورد" });
  },
);
