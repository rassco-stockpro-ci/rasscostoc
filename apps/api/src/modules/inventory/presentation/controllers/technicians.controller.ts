/**
 * Technicians controller
 */

import type { Request, Response } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import { AppError, NotFoundError, AuthorizationError } from "@core/errors/AppError";
import { systemLogs } from "@shared/schema";
import { getDatabase } from "@core/database/connection";
import { z } from "zod";
import { technicianDeactivationGuardService } from "@modules/inventory/infrastructure/services/technician-deactivation-guard.service";
import {
  WithdrawToWarehouseUseCaseError,
} from "@modules/inventory/application/inventory/use-cases/WithdrawTechnicianInventoryToWarehouse.use-case";
import {
  GetTechniciansInventoryByActorUseCaseError,
} from "@modules/inventory/application/technicians/use-cases/GetTechniciansInventoryByActor.use-case";
import { techniciansContainer } from "@server/composition/technicians.container";
import { stockFixedInventoryContainer } from "@server/composition/stock-fixed-inventory.container";
import { stockTransferContainer } from "@server/composition/stock-transfer.container";
import { usersContainer } from "@server/composition/users.container";
import { supervisorAssignmentsContainer } from "@server/composition/supervisor-assignments.container";
import { inventoryEntriesContainer } from "@server/composition/inventory-entries.container";
import { createGetTechnicianMovingInventoryUseCase } from "@server/composition/technicians-moving-inventory.container";
import { createWithdrawTechnicianInventoryToWarehouseUseCase } from "@server/composition/technicians-withdraw.container";

const withdrawTechnicianInventoryToWarehouseUseCase =
  createWithdrawTechnicianInventoryToWarehouseUseCase();

const getTechnicianMovingInventoryUseCase =
  createGetTechnicianMovingInventoryUseCase();

/**
 * SECURITY FIX — raw user rows (from userManagementUseCase) include the password
 * hash and other internal fields with no built-in filtering; this controller was
 * returning them to the client as-is (getAll/getById, and the new update/delete
 * below). Mirrors the same minimal view users.controller.ts already uses for the
 * equivalent /api/users endpoints.
 */
export function toMinimalTechnicianView(user: any) {
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
    extraProfile,
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
  };
}

export class TechniciansController {
  private async logActivity(log: typeof systemLogs.$inferInsert) {
    try {
      await getDatabase().insert(systemLogs).values(log);
    } catch (error) {
      console.error("Failed to write system audit log:", error);
    }
  }

  /**
   * GET /api/technicians
   * Get all technicians
   */
  getAll = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    let technicians;

    if (user.role === "supervisor") {
      const technicianIds =
        await supervisorAssignmentsContainer.supervisorAssignmentsUseCase.getTechnicianIdsBySupervisor(
          user.id,
        );

      const assignedUsers = await Promise.all(
        technicianIds.map((technicianId) => usersContainer.userManagementUseCase.findById(technicianId)),
      );

      technicians = assignedUsers.filter(
        (assignedUser: any) => assignedUser?.role === "technician",
      );
    } else {
      // Admin gets all
      const users = await usersContainer.userManagementUseCase.findAll();
      technicians = users.filter((u) => u.role === "technician");
    }

    res.json(technicians.map(toMinimalTechnicianView));
  });

  /**
   * GET /api/supervisor/technicians
   * Get supervisor's assigned technicians
   */
  getSupervisorTechnicians = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const technicianIds =
      await supervisorAssignmentsContainer.supervisorAssignmentsUseCase.getTechnicianIdsBySupervisor(
        user.id,
      );

    const assignedUsers = await Promise.all(
      technicianIds.map((technicianId) => usersContainer.userManagementUseCase.findById(technicianId)),
    );

    const technicians = assignedUsers.filter(
      (assignedUser: any) => assignedUser?.role === "technician",
    );

    res.json(technicians.map(toMinimalTechnicianView));
  });

  /**
   * GET /api/technicians/:id
   * Get single technician details
   */
  getById = asyncHandler(async (req: Request, res: Response) => {
    const technician = await usersContainer.userManagementUseCase.findById(req.params.id);
    if (!technician) {
      throw new NotFoundError("Technician not found");
    }
    res.json(toMinimalTechnicianView(technician));
  });

  /** Admin: any technician. Supervisor: only technicians assigned to them. */
  private async assertCanManageTechnician(req: Request, technicianId: string): Promise<void> {
    const user = req.user!;
    if (user.role === "admin") return;

    if (user.role === "supervisor") {
      const assignedIds =
        await supervisorAssignmentsContainer.supervisorAssignmentsUseCase.getTechnicianIdsBySupervisor(
          user.id,
        );
      if (assignedIds.includes(technicianId)) return;
    }

    throw new AuthorizationError("غير مصرح لك بإدارة بيانات هذا الفني");
  }

  /**
   * PATCH /api/technicians/:id
   * Update a technician's profile. Technicians are users with role="technician" —
   * this delegates to the same user-management use case as PATCH /api/users/:id,
   * but scoped to admin (any technician) or supervisor (only assigned technicians).
   */
  update = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const existing = await usersContainer.userManagementUseCase.findById(id);
    if (!existing || existing.role !== "technician") {
      throw new NotFoundError("Technician not found");
    }

    await this.assertCanManageTechnician(req, id);

    // ROOT FIX (TEMP-SYSTEM-STABILIZATION) — explicit allowlist DTO instead of passing
    // insertUserSchema.partial() through broadly. Only profile fields a technician edit
    // screen has any business editing. password/role/permissions/isActive and any other
    // administrative or authentication field can NEVER be touched via this endpoint,
    // regardless of what the request body contains.
    const updateTechnicianSchema = z.object({
      fullName: z.string().trim().min(1).optional(),
      email: z.string().trim().email().optional(),
      city: z.string().trim().optional(),
      employeeCode: z.string().trim().optional(),
      technicianCode: z.string().trim().optional(),
      department: z.string().trim().optional(),
      regionId: z.string().trim().optional(),
      profileImage: z.string().optional(),
    });
    const updates = updateTechnicianSchema.parse(req.body);

    const actor = req.user!;
    const updatedUser = await usersContainer.userManagementUseCase.update(id, updates, {
      id: actor.id,
      username: actor.username,
      role: actor.role,
    });

    await this.logActivity({
      userId: actor.id,
      userName: actor.username,
      userRole: actor.role,
      regionId: null,
      action: "update",
      entityType: "technician",
      entityId: id,
      entityName: updatedUser.fullName,
      description: `تم تحديث بيانات الفني: ${updatedUser.fullName}`,
      // Never log raw user/technician entities — they carry the password hash.
      // Only the already-sanitized "before" view and the explicit update payload
      // (which the allowlist schema above already guarantees excludes password/role).
      details: JSON.stringify({ before: toMinimalTechnicianView(existing), after: updates }),
      severity: "info",
      success: true,
    });

    res.json(toMinimalTechnicianView(updatedUser));
  });

  /**
   * DELETE /api/technicians/:id
   * Delete a technician (soft delete, same as DELETE /api/users/:id), scoped to
   * admin (any technician) or supervisor (only assigned technicians).
   */
  delete = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const existing = await usersContainer.userManagementUseCase.findById(id);
    if (!existing || existing.role !== "technician") {
      throw new NotFoundError("Technician not found");
    }

    await this.assertCanManageTechnician(req, id);

    const blockers = await technicianDeactivationGuardService.findActiveOperationBlockers(id);
    if (blockers.length > 0) {
      throw new AppError(
        `لا يمكن تعطيل هذا الفني حاليًا: ${blockers.join("، ")}`,
        409,
        true,
        "TECHNICIAN_HAS_ACTIVE_OPERATIONS"
      );
    }

    const deleted = await usersContainer.userManagementUseCase.softDelete(id, {
      id: req.user!.id,
      username: req.user!.username,
      role: req.user!.role,
    });
    if (!deleted) {
      throw new NotFoundError("Technician not found");
    }

    const actor = req.user!;
    await this.logActivity({
      userId: actor.id,
      userName: actor.username,
      userRole: actor.role,
      regionId: null,
      action: "deactivate",
      entityType: "technician",
      entityId: id,
      entityName: existing.fullName,
      description: `تم تعطيل الفني: ${existing.fullName} (soft delete — isActive=false)`,
      details: JSON.stringify({ before: toMinimalTechnicianView(existing) }),
      severity: "warn",
      success: true,
    });

    res.json({ message: "Technician deleted successfully" });
  });

  /**
   * GET /api/my-fixed-inventory
   * Get technician's fixed inventory
   */
  getMyFixedInventory = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const inventory = await stockFixedInventoryContainer.stockFixedInventoryUseCase.get(
      user.id,
    );
    res.json(inventory);
  });

  /**
   * GET /api/my-moving-inventory
   * Get technician's moving inventory (legacy + dynamic entries)
   */
  getMyMovingInventory = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const inventory = await getTechnicianMovingInventoryUseCase.execute(user.id);
    res.json(inventory);
  });

  /**
   * GET /api/technician-fixed-inventory/:technicianId
   * Get technician's fixed inventory
   */
  getFixedInventory = asyncHandler(async (req: Request, res: Response) => {
    const inventory = await stockFixedInventoryContainer.stockFixedInventoryUseCase.get(
      req.params.technicianId
    );
    res.json(inventory);
  });

  /**
   * PUT /api/technician-fixed-inventory/:technicianId
   * Update technician's fixed inventory
   */
  updateFixedInventory = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const updates = req.body;
    const inventory = await stockFixedInventoryContainer.stockFixedInventoryUseCase.update(
      req.params.technicianId,
      updates
    );

    // Log the activity
    await stockFixedInventoryContainer.createSystemLogUseCase.execute({
      userId: user.id,
      userName: user.username,
      userRole: user.role,
      regionId: null,
      action: "update",
      entityType: "inventory",
      entityId: req.params.technicianId,
      entityName: "المخزون الثابت",
      description: `تم تحديث المخزون الثابت للمندوب`,
      severity: "info",
      success: true,
    });

    res.json(inventory);
  });

  /**
   * DELETE /api/technician-fixed-inventory/:technicianId
   * Delete technician's fixed inventory
   */
  deleteFixedInventory = asyncHandler(async (req: Request, res: Response) => {
    await stockFixedInventoryContainer.stockFixedInventoryUseCase.delete(req.params.technicianId);
    res.json({ message: "Fixed inventory deleted successfully" });
  });

  /**
   * GET /api/stock-movements
   * Get stock movements
   */
  getStockMovements = asyncHandler(async (req: Request, res: Response) => {
    const { technicianId, limit } = req.query;
    const movements = await stockTransferContainer.stockTransferUseCase.getMovements(
      technicianId as string | undefined,
      limit ? parseInt(limit as string) : undefined
    );
    res.json(movements);
  });

  /**
   * POST /api/stock-transfer
   * Transfer stock between inventories
   */
  transferStock = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const schema = z.object({
      technicianId: z.string(),
      itemType: z.string(),
      packagingType: z.enum(["box", "unit"]),
      quantity: z.number().positive(),
      fromInventory: z.enum(["fixed", "moving"]),
      toInventory: z.enum(["fixed", "moving"]),
      reason: z.string().optional(),
      notes: z.string().optional(),
    });

    const data = schema.parse(req.body);
    const result = await stockTransferContainer.stockTransferUseCase.transfer({
      ...data,
      performedBy: user.id,
    });

    // Log the activity
    await stockTransferContainer.createSystemLogUseCase.execute({
      userId: user.id,
      userName: user.username,
      userRole: user.role,
      regionId: null,
      action: "transfer",
      entityType: "inventory",
      entityId: data.technicianId,
      entityName: data.itemType,
      description: `تم نقل ${data.quantity} ${data.packagingType} من ${data.fromInventory} إلى ${data.toInventory}`,
      severity: "info",
      success: true,
    });

    res.json(result);
  });

  /**
   * POST /api/technicians/:technicianId/withdraw-to-warehouse
   * Withdraw stock from technician moving inventory back to warehouse
   */
  withdrawToWarehouse = asyncHandler(async (req: Request, res: Response) => {
    const actor = req.user!;
    const { technicianId } = req.params;

    const schema = z.object({
      warehouseId: z.string().min(1),
      notes: z.string().optional(),
      items: z.array(z.object({
        itemTypeId: z.string().min(1),
        packagingType: z.enum(["box", "unit"]),
        quantity: z.number().int().positive(),
      })).min(1),
    });

    const data = schema.parse(req.body);
    try {
      const result = await withdrawTechnicianInventoryToWarehouseUseCase.execute({
        actor: {
          id: actor.id,
          username: actor.username,
          role: actor.role,
          regionId: actor.regionId,
        },
        technicianId,
        warehouseId: data.warehouseId,
        notes: data.notes,
        items: data.items,
      });

      res.json(result);
    } catch (error) {
      if (error instanceof WithdrawToWarehouseUseCaseError) {
        return res.status((error as any).statusCode).json({ message: (error as any).message });
      }

      throw error;
    }
  });

  /**
   * GET /api/technicians/:technicianId/fixed-inventory-entries
   * Get technician's fixed inventory entries
   */
  getFixedInventoryEntries = asyncHandler(async (req: Request, res: Response) => {
    const entries = await inventoryEntriesContainer.inventoryEntriesUseCase.getTechnicianFixedEntries(
      req.params.technicianId
    );
    res.json(entries);
  });

  /**
   * POST /api/technicians/:technicianId/fixed-inventory-entries
   * Upsert technician's fixed inventory entry
   */
  upsertFixedInventoryEntry = asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      itemTypeId: z.string(),
      boxes: z.number().min(0),
      units: z.number().min(0),
    });
    const data = schema.parse(req.body);
    const entry = await inventoryEntriesContainer.inventoryEntriesUseCase.upsertTechnicianFixedEntry(req.params.technicianId, {
      itemTypeId: data.itemTypeId,
      boxes: data.boxes,
      units: data.units,
    });
    res.json(entry);
  });

  /**
   * GET /api/technicians/:technicianId/moving-inventory-entries
   * Get technician's moving inventory entries
   */
  getMovingInventoryEntries = asyncHandler(async (req: Request, res: Response) => {
    const entries = await inventoryEntriesContainer.inventoryEntriesUseCase.getTechnicianMovingEntries(
      req.params.technicianId
    );
    res.json(entries);
  });

  /**
   * POST /api/technicians/:technicianId/moving-inventory-entries
   * Upsert technician's moving inventory entry (supports single or batch)
   */
  upsertMovingInventoryEntry = asyncHandler(async (req: Request, res: Response) => {
    const singleSchema = z.object({
      itemTypeId: z.string(),
      boxes: z.number().min(0),
      units: z.number().min(0),
    });
    
    const batchSchema = z.object({
      entries: z.array(singleSchema),
    });
    
    const { technicianId } = req.params;
    
    // Check if it's a batch request with { entries: [...] }
    if (req.body.entries && Array.isArray(req.body.entries)) {
      const { entries } = batchSchema.parse(req.body);
      const results = await inventoryEntriesContainer.inventoryEntriesUseCase.upsertTechnicianMovingEntriesBatch(
        technicianId,
        entries,
      );
      return res.json(results);
    }
    
    // Single entry format
    const data = singleSchema.parse(req.body);
    const entry = await inventoryEntriesContainer.inventoryEntriesUseCase.upsertTechnicianMovingEntry(technicianId, {
      itemTypeId: data.itemTypeId,
      boxes: data.boxes,
      units: data.units,
    });
    res.json(entry);
  });

  /**
   * GET /api/admin/all-technicians-inventory
   * Get all technicians with both inventories (admin)
   */
  getAllTechniciansInventory = asyncHandler(async (req: Request, res: Response) => {
    const result = await techniciansContainer.getAllTechniciansInventoryUseCase.execute();
    res.json(result);
  });

  /**
   * GET /api/supervisor/technicians-inventory
   * Get supervisor's technicians with inventories
   */
  getSupervisorTechniciansInventory = asyncHandler(
    async (req: Request, res: Response) => {
      const user = req.user!;

      try {
        const result = await techniciansContainer.getTechniciansInventoryByActorUseCase.execute({
          actor: {
            role: user.role,
            regionId: user.regionId,
          },
        });

        res.json(result);
      } catch (error) {
        if (error instanceof GetTechniciansInventoryByActorUseCaseError) {
          return res.status((error as any).statusCode).json({
            success: false,
            message: (error as any).message,
          });
        }

        throw error;
      }
    }
  );
}

export const techniciansController = new TechniciansController();
