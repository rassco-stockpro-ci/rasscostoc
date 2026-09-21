import type { NextFunction, Request, Response } from "express";
import { AuthenticationError, AuthorizationError } from "@core/errors/AppError";
import { permissionsContainer } from "@server/composition/permissions.container";
import { ROLES } from "@shared/roles";

/**
 * OPS-PERM-S2 — activates real backend enforcement for a cataloged
 * (page, action) permission on an existing production route.
 *
 * Lives in core/middlewares/ (not modules/permissions/presentation/), next to
 * auth.middleware.ts — every route across every module needs to import this,
 * and the architecture lint (no-cross-module-internal-imports) correctly
 * refuses a route in one module reaching into another module's own
 * presentation internals. This depends on permissionsContainer from
 * composition/, never directly on modules/permissions/, so it does not
 * violate core-should-not-depend-on-business-modules either.
 *
 * Scope, deliberately narrow: this middleware only evaluates the Permission
 * Engine for actor.role === "supervisor" — the literal V1 target ("Admin
 * manages SUPERVISOR permissions", OPS-PERM-S1-F4 §8). Every other role
 * (admin, technician, viewer, courier_supervisor, warehouse) passes straight
 * through untouched, preserving its exact current behavior on this route.
 * This is intentional, not an oversight: the evaluator's own domain comment
 * on ROLE_HARD_CEILING.technician warns explicitly that technician's real
 * authorization must stay on its existing, regression-sensitive path and
 * must never be re-expressed through this engine; courier_supervisor and
 * warehouse have their own ceiling rows but are not yet wired to any route —
 * doing so safely requires auditing those roles' own existing access paths
 * the same way this change required auditing supervisor's, which is future
 * work (see OPS-PERM-S2 final report).
 *
 * Admin always passes (evaluatePermission itself special-cases admin as
 * system-wide for any cataloged permission).
 */
export function requireCatalogedPermission(page: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = req.user;
      if (!actor) {
        throw new AuthenticationError("Authentication required");
      }

      if (actor.role !== ROLES.SUPERVISOR) {
        return next();
      }

      const decision = await permissionsContainer.service.can(
        { id: actor.id, role: actor.role, regionId: actor.regionId },
        { page, action },
        { regionId: actor.regionId ?? null, resourceOwnerId: actor.id }
      );

      if (!decision.allowed) {
        throw new AuthorizationError("ليس لديك صلاحية للقيام بهذا الإجراء");
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
