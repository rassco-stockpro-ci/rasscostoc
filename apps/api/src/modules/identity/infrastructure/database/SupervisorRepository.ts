import { eq, and } from "drizzle-orm";
import { getDatabase } from "@core/database/connection";
import { ValidationError, NotFoundError, ConflictError } from "@core/errors/AppError";
import {
  supervisorTechnicians,
  supervisorWarehouses,
  users,
  warehouses,
  UserSafe,
  SupervisorTechnician,
  InsertSupervisorTechnician,
  SupervisorWarehouse,
  InsertSupervisorWarehouse
} from "@shared/schema";

export interface ISupervisorRepository {
  getSupervisorTechnicians(supervisorId: string): Promise<UserSafe[]>;
  assignTechnicianToSupervisor(supervisorId: string, technicianId: string): Promise<SupervisorTechnician>;
  removeTechnicianFromSupervisor(supervisorId: string, technicianId: string): Promise<boolean>;
  getSupervisorWarehouses(supervisorId: string): Promise<SupervisorWarehouse[]>;
  assignWarehouseToSupervisor(supervisorId: string, warehouseId: string): Promise<SupervisorWarehouse>;
  removeWarehouseFromSupervisor(supervisorId: string, warehouseId: string): Promise<boolean>;
}

/**
 * Supervisor Repository Implementation
 * Handles supervisor-technician and supervisor-warehouse relationships
 */
export class SupervisorRepository implements ISupervisorRepository {
  private get db() {
    return getDatabase();
  }

  async getSupervisorTechnicians(supervisorId: string): Promise<UserSafe[]> {
    const technicians = await this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        fullName: users.fullName,
        profileImage: users.profileImage,
        city: users.city,
        role: users.role,
        regionId: users.regionId,
        employeeCode: users.employeeCode,
        technicianCode: users.technicianCode,
        department: users.department,
        permissions: users.permissions,
        isActive: users.isActive,
        authGeneration: users.authGeneration,
        fcmToken: users.fcmToken,
        telegramUserId: users.telegramUserId,
        telegramUsername: users.telegramUsername,
        telegramLinkedAt: users.telegramLinkedAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .innerJoin(supervisorTechnicians, eq(users.id, supervisorTechnicians.technicianId))
      .where(eq(supervisorTechnicians.supervisorId, supervisorId));
    
    return technicians;
  }

  async assignTechnicianToSupervisor(supervisorId: string, technicianId: string): Promise<SupervisorTechnician> {
    // Check if relationship already exists
    const [existing] = await this.db
      .select()
      .from(supervisorTechnicians)
      .where(and(
        eq(supervisorTechnicians.supervisorId, supervisorId),
        eq(supervisorTechnicians.technicianId, technicianId)
      ));

    if (existing) {
      throw new Error("Technician is already assigned to this supervisor");
    }

    const [assignment] = await this.db
      .insert(supervisorTechnicians)
      .values({
        supervisorId,
        technicianId,
      })
      .returning();

    return assignment;
  }

  async removeTechnicianFromSupervisor(supervisorId: string, technicianId: string): Promise<boolean> {
    const result = await this.db
      .delete(supervisorTechnicians)
      .where(and(
        eq(supervisorTechnicians.supervisorId, supervisorId),
        eq(supervisorTechnicians.technicianId, technicianId)
      ));

    return (result.rowCount || 0) > 0;
  }

  async getSupervisorWarehouses(supervisorId: string): Promise<SupervisorWarehouse[]> {
    return await this.db
      .select()
      .from(supervisorWarehouses)
      .where(eq(supervisorWarehouses.supervisorId, supervisorId));
  }

  async assignWarehouseToSupervisor(supervisorId: string, warehouseId: string): Promise<SupervisorWarehouse> {
    // OPS-PERM-S1-F1.R2.SR2 Defect B: Regional assignment invariant.
    // A supervisor can only be assigned to a warehouse if their regionId
    // matches the warehouse's regionId. Both must be non-null.

    // Load supervisor and warehouse in parallel
    const [supervisor, warehouse] = await Promise.all([
      this.db
        .select({ regionId: users.regionId })
        .from(users)
        .where(eq(users.id, supervisorId)),
      this.db
        .select({ regionId: warehouses.regionId })
        .from(warehouses)
        .where(eq(warehouses.id, warehouseId)),
    ]);

    if (!supervisor || supervisor.length === 0) {
      throw new NotFoundError("المشرف غير موجود");
    }

    if (!warehouse || warehouse.length === 0) {
      throw new NotFoundError("المستودع غير موجود");
    }

    const supervisorRegion = supervisor[0].regionId;
    const warehouseRegion = warehouse[0].regionId;

    // Both regions must be present AND equal. A null on either side is
    // "unknown scope" and fails closed — it must never be treated as a match
    // with the other null. These are typed ValidationErrors (400), not bare
    // Errors: the route maps AppError.statusCode directly, so a new invariant
    // added here can never degrade into an uncontrolled 500.
    if (!supervisorRegion) {
      throw new ValidationError("المشرف لم يتم تعيينه إلى منطقة");
    }

    if (!warehouseRegion) {
      throw new ValidationError("المستودع لم يتم تعيينه إلى منطقة");
    }

    if (supervisorRegion !== warehouseRegion) {
      throw new ValidationError("لا يمكن تعيين مشرف من منطقة مختلفة إلى مستودع بمنطقة أخرى");
    }

    // Check if relationship already exists
    const [existing] = await this.db
      .select()
      .from(supervisorWarehouses)
      .where(and(
        eq(supervisorWarehouses.supervisorId, supervisorId),
        eq(supervisorWarehouses.warehouseId, warehouseId)
      ));

    if (existing) {
      throw new ConflictError("المستودع مرتبط بالفعل بهذا المشرف");
    }

    const [assignment] = await this.db
      .insert(supervisorWarehouses)
      .values({
        supervisorId,
        warehouseId,
      })
      .returning();

    return assignment;
  }

  async removeWarehouseFromSupervisor(supervisorId: string, warehouseId: string): Promise<boolean> {
    const result = await this.db
      .delete(supervisorWarehouses)
      .where(and(
        eq(supervisorWarehouses.supervisorId, supervisorId),
        eq(supervisorWarehouses.warehouseId, warehouseId)
      ));

    return (result.rowCount || 0) > 0;
  }
}