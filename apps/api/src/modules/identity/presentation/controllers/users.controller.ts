/**
 * Users controller
 */

import type { Request, Response } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import { insertUserSchema, systemLogs } from "@shared/schema";
import { AuthorizationError, NotFoundError } from "@core/errors/AppError";
import { hashPassword } from "@server/utils/password";
import { usersContainer } from "@server/composition/users.container";
import { getDatabase } from "@core/database/connection";
import { ROLES, isAdmin, isSupervisor } from "@shared/roles";

/** PLATFORM-P0 — minimum necessary public user fields with profileImage & extraProfile */
export function toMinimalUserView(user: any) {
  let extraProfile = null;
  if (user.permissions) {
    try {
      extraProfile = typeof user.permissions === "string" ? JSON.parse(user.permissions) : user.permissions;
    } catch {
      extraProfile = null;
    }
  }

  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    profileImage: user.profileImage ?? null,
    role: user.role,
    regionId: user.regionId ?? null,
    employeeCode: user.employeeCode ?? null,
    technicianCode: user.technicianCode ?? null,
    isActive: user.isActive,
    city: user.city ?? null,
    email: user.email ?? null,
    telegramUserId: user.telegramUserId ?? null,
    telegramUsername: user.telegramUsername ?? null,
    telegramLinked: !!user.telegramUserId,
    telegramLinkedAt: user.telegramLinkedAt ?? null,
    telegramLastSeenAt: user.telegramLastSeenAt ?? null,
    extraProfile,
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
  };
}

/**
 * OPS-PERM-S1-F1.R2.SR1 — GET /api/users/:id is a generic identity-directory
 * read, not a scoped operational endpoint. It must stay narrow: an admin may
 * read any user, and a user may always read their own record; every other
 * actor (including supervisor) is denied here regardless of region —
 * subordinate operational reads belong to the already-scoped Supervisor
 * endpoints (e.g. GET /api/supervisor/users/:userId), which independently
 * enforce region membership. Widening this endpoint to a same-region
 * directory API was never an intended contract and must not be reintroduced
 * as a side effect of a future permission grant.
 */
function canReadUser(
  actor: Express.Request["user"],
  target: { id: string; regionId: string | null },
): boolean {
  if (!actor) return false;
  if (isAdmin(actor.role)) return true;
  return actor.id === target.id;
}

export class UsersController {
  private async logActivity(log: typeof systemLogs.$inferInsert) {
    try {
      await getDatabase().insert(systemLogs).values(log);
    } catch (error) {
      console.error("Failed to write system audit log:", error);
    }
  }

  /**
   * GET /api/users
   * Get all users
   */
  getAll = asyncHandler(async (req: Request, res: Response) => {
    const users = await usersContainer.userManagementUseCase.findAll();
    res.json(users.map(toMinimalUserView));
  });

  /**
   * GET /api/users/:id
   * PLATFORM-P0: authenticated + authorized; minimal fields; audit log
   */
  getById = asyncHandler(async (req: Request, res: Response) => {
    const actor = req.user!;
    const target = await usersContainer.userManagementUseCase.findById(req.params.id);
    if (!target) {
      throw new NotFoundError("User not found");
    }

    if (!canReadUser(actor, target)) {
      await this.logActivity({
        userId: actor.id,
        userName: actor.username,
        userRole: actor.role,
        regionId: actor.regionId,
        action: "read_denied",
        entityType: "user",
        entityId: req.params.id,
        entityName: target.fullName,
        description: `رفض قراءة مستخدم: ${target.username}`,
        severity: "warn",
        success: false,
      });
      throw new AuthorizationError("ليس لديك صلاحية لعرض هذا المستخدم");
    }

    await this.logActivity({
      userId: actor.id,
      userName: actor.username,
      userRole: actor.role,
      regionId: actor.regionId,
      action: "read",
      entityType: "user",
      entityId: target.id,
      entityName: target.fullName,
      description: `قراءة بيانات مستخدم: ${target.username}`,
      severity: "info",
      success: true,
    });

    res.json(toMinimalUserView(target));
  });

  /**
   * POST /api/users
   * Create new user
   */
  create = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const bodyData = { ...req.body };
    if (bodyData.extraProfile) {
      bodyData.permissions = JSON.stringify(bodyData.extraProfile);
    }
    const validatedData = insertUserSchema.parse(bodyData);

    // Hash password if provided
    if (validatedData.password) {
      validatedData.password = await hashPassword(validatedData.password);
    }

    const newUser = await usersContainer.userManagementUseCase.create(validatedData);

    // Log the activity
    await this.logActivity({
      userId: user.id,
      userName: user.username,
      userRole: user.role,
      regionId: null,
      action: "create",
      entityType: "user",
      entityId: newUser.id,
      entityName: newUser.fullName,
      description: `تم إنشاء مستخدم جديد: ${newUser.fullName}`,
      severity: "info",
      success: true,
    });

    res.status(201).json(toMinimalUserView(newUser));
  });

  /**
   * PATCH /api/users/:id
   * Update user
   */
  update = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const bodyData = { ...req.body };
    if (bodyData.extraProfile) {
      bodyData.permissions = JSON.stringify(bodyData.extraProfile);
    }
    const updates = insertUserSchema.partial().parse(bodyData);

    // Hash password if provided
    if (updates.password) {
      updates.password = await hashPassword(updates.password);
    }

    const updatedUser = await usersContainer.userManagementUseCase.update(req.params.id, updates, {
      id: user.id,
      username: user.username,
      role: user.role,
    });

    // Log the activity
    await this.logActivity({
      userId: user.id,
      userName: user.username,
      userRole: user.role,
      regionId: null,
      action: "update",
      entityType: "user",
      entityId: updatedUser.id,
      entityName: updatedUser.fullName,
      description: `تم تحديث مستخدم: ${updatedUser.fullName}`,
      severity: "info",
      success: true,
    });

    res.json(toMinimalUserView(updatedUser));
  });

  /**
   * DELETE /api/users/:id
   * Delete user
   */
  delete = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    // Get user name before deletion
    const userToDelete = await usersContainer.userManagementUseCase.findById(req.params.id);
    if (!userToDelete) {
      throw new NotFoundError("User not found");
    }

    const deleted = await usersContainer.userManagementUseCase.softDelete(req.params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
    });
    if (!deleted) {
      throw new NotFoundError("User not found");
    }

    // Log the activity
    await this.logActivity({
      userId: user.id,
      userName: user.username,
      userRole: user.role,
      regionId: null,
      action: "delete",
      entityType: "user",
      entityId: req.params.id,
      entityName: userToDelete.fullName,
      description: `تم حذف مستخدم: ${userToDelete.fullName}`,
      severity: "warn",
      success: true,
    });

    res.json({ message: "User deleted successfully" });
  });

  /**
   * POST /api/users/bulk-status
   * Activate or deactivate all users except current admin
   */
  bulkStatus = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      res.status(400).json({ message: "isActive must be a boolean" });
      return;
    }

    const count = await usersContainer.userManagementUseCase.updateAllStatus(isActive, user.id, {
      id: user.id,
      username: user.username,
      role: user.role,
    });

    // Log the activity
    await this.logActivity({
      userId: user.id,
      userName: user.username,
      userRole: user.role,
      regionId: null,
      action: "update",
      entityType: "user",
      entityId: "bulk",
      entityName: "جميع المستخدمين",
      description: `تم ${isActive ? 'تفعيل' : 'إيقاف'} جميع المستخدمين (عدد: ${count}) باستثناء مدير النظام الحالي`,
      severity: isActive ? "info" : "warn",
      success: true,
    });

    res.json({ message: `Successfully updated ${count} users`, count });
  });
}

export const usersController = new UsersController();
