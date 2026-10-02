import { and, eq, desc, sql, or } from 'drizzle-orm';
import { AppError } from '@core/errors/AppError';
import { getDatabase } from "@core/database/connection";
import {
  withdrawnDevices,
  receivedDevices,
  users,
  regions,
  itemTypes,
  technicianFixedInventoryEntries,
  technicianMovingInventoryEntries,
  stockMovements,
  type WithdrawnDevice,
  type ReceivedDevice,
  type InsertWithdrawnDevice,
  type InsertReceivedDevice
} from "@shared/schema";
import type { IDevicesRepository } from "@modules/inventory/application/devices/contracts/IDevicesRepository";
import { planConsumableDeduction } from "@modules/inventory/domain/consumables/consumable-deduction";

export class DrizzleDevicesRepository implements IDevicesRepository {
  private get db() {
    return getDatabase();
  }

  async hasItemTypeColumn(): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'received_devices'
        AND column_name = 'item_type_id'
      LIMIT 1
    `);

    const rows = (result as any).rows || [];
    return rows.length > 0;
  }

  async getWithdrawnDevices(): Promise<any[]> {
    return this.db
      .select({
        id: withdrawnDevices.id,
        city: withdrawnDevices.city,
        technicianName: withdrawnDevices.technicianName,
        terminalId: withdrawnDevices.terminalId,
        serialNumber: withdrawnDevices.serialNumber,
        battery: withdrawnDevices.battery,
        chargerCable: withdrawnDevices.chargerCable,
        chargerHead: withdrawnDevices.chargerHead,
        hasSim: withdrawnDevices.hasSim,
        simCardType: withdrawnDevices.simCardType,
        damagePart: withdrawnDevices.damagePart,
        notes: withdrawnDevices.notes,
        createdBy: withdrawnDevices.createdBy,
        regionId: withdrawnDevices.regionId,
        createdAt: withdrawnDevices.createdAt,
        updatedAt: withdrawnDevices.updatedAt,
        regionName: regions.name,
        status: sql<string>`'approved'`,
        isReceived: sql<boolean>`false`,
      })
      .from(withdrawnDevices)
      .leftJoin(regions, eq(withdrawnDevices.regionId, regions.id));
  }

  async getReceivedDevicesForWithdrawnList(): Promise<any[]> {
    return this.db
      .select({
        id: receivedDevices.id,
        city: users.city,
        technicianName: users.fullName,
        terminalId: receivedDevices.terminalId,
        serialNumber: receivedDevices.serialNumber,
        battery: receivedDevices.battery,
        chargerCable: receivedDevices.chargerCable,
        chargerHead: receivedDevices.chargerHead,
        hasSim: receivedDevices.hasSim,
        simCardType: receivedDevices.simCardType,
        damagePart: receivedDevices.damagePart,
        notes: receivedDevices.adminNotes,
        createdBy: receivedDevices.supervisorId,
        regionId: receivedDevices.regionId,
        createdAt: receivedDevices.createdAt,
        updatedAt: receivedDevices.updatedAt,
        regionName: regions.name,
        status: receivedDevices.status,
        isReceived: sql<boolean>`true`,
      })
      .from(receivedDevices)
      .leftJoin(users, eq(receivedDevices.technicianId, users.id))
      .leftJoin(regions, eq(receivedDevices.regionId, regions.id))
      .where(sql`${receivedDevices.status} IN ('pending', 'rejected')`);
  }

  async getWithdrawnDevicesByRegion(regionId: string): Promise<any[]> {
    return this.db
      .select({
        id: withdrawnDevices.id,
        city: withdrawnDevices.city,
        technicianName: withdrawnDevices.technicianName,
        terminalId: withdrawnDevices.terminalId,
        serialNumber: withdrawnDevices.serialNumber,
        battery: withdrawnDevices.battery,
        chargerCable: withdrawnDevices.chargerCable,
        chargerHead: withdrawnDevices.chargerHead,
        hasSim: withdrawnDevices.hasSim,
        simCardType: withdrawnDevices.simCardType,
        damagePart: withdrawnDevices.damagePart,
        notes: withdrawnDevices.notes,
        createdBy: withdrawnDevices.createdBy,
        regionId: withdrawnDevices.regionId,
        createdAt: withdrawnDevices.createdAt,
        updatedAt: withdrawnDevices.updatedAt,
        regionName: regions.name,
        status: sql<string>`'approved'`,
        isReceived: sql<boolean>`false`,
      })
      .from(withdrawnDevices)
      .leftJoin(regions, eq(withdrawnDevices.regionId, regions.id))
      .where(eq(withdrawnDevices.regionId, regionId));
  }

  async getReceivedDevicesForWithdrawnListByRegion(regionId: string): Promise<any[]> {
    return this.db
      .select({
        id: receivedDevices.id,
        city: users.city,
        technicianName: users.fullName,
        terminalId: receivedDevices.terminalId,
        serialNumber: receivedDevices.serialNumber,
        battery: receivedDevices.battery,
        chargerCable: receivedDevices.chargerCable,
        chargerHead: receivedDevices.chargerHead,
        hasSim: receivedDevices.hasSim,
        simCardType: receivedDevices.simCardType,
        damagePart: receivedDevices.damagePart,
        notes: receivedDevices.adminNotes,
        createdBy: receivedDevices.supervisorId,
        regionId: receivedDevices.regionId,
        createdAt: receivedDevices.createdAt,
        updatedAt: receivedDevices.updatedAt,
        regionName: regions.name,
        status: receivedDevices.status,
        isReceived: sql<boolean>`true`,
      })
      .from(receivedDevices)
      .leftJoin(users, eq(receivedDevices.technicianId, users.id))
      .leftJoin(regions, eq(receivedDevices.regionId, regions.id))
      .where(and(
        eq(receivedDevices.regionId, regionId),
        sql`${receivedDevices.status} IN ('pending', 'rejected')`
      ));
  }

  async getWithdrawnDevice(id: string): Promise<any | undefined> {
    const [withdrawnDevice] = await this.db
      .select({
        id: withdrawnDevices.id,
        city: withdrawnDevices.city,
        technicianName: withdrawnDevices.technicianName,
        terminalId: withdrawnDevices.terminalId,
        serialNumber: withdrawnDevices.serialNumber,
        battery: withdrawnDevices.battery,
        chargerCable: withdrawnDevices.chargerCable,
        chargerHead: withdrawnDevices.chargerHead,
        hasSim: withdrawnDevices.hasSim,
        simCardType: withdrawnDevices.simCardType,
        damagePart: withdrawnDevices.damagePart,
        notes: withdrawnDevices.notes,
        createdBy: withdrawnDevices.createdBy,
        regionId: withdrawnDevices.regionId,
        createdAt: withdrawnDevices.createdAt,
        updatedAt: withdrawnDevices.updatedAt,
        regionName: regions.name,
        status: sql<string>`'approved'`,
        isReceived: sql<boolean>`false`,
      })
      .from(withdrawnDevices)
      .leftJoin(regions, eq(withdrawnDevices.regionId, regions.id))
      .where(eq(withdrawnDevices.id, id))
      .limit(1);

    if (withdrawnDevice) {
      return withdrawnDevice;
    }

    const [receivedDevice] = await this.db
      .select({
        id: receivedDevices.id,
        city: users.city,
        technicianName: users.fullName,
        terminalId: receivedDevices.terminalId,
        serialNumber: receivedDevices.serialNumber,
        battery: receivedDevices.battery,
        chargerCable: receivedDevices.chargerCable,
        chargerHead: receivedDevices.chargerHead,
        hasSim: receivedDevices.hasSim,
        simCardType: receivedDevices.simCardType,
        damagePart: receivedDevices.damagePart,
        notes: receivedDevices.adminNotes,
        createdBy: receivedDevices.supervisorId,
        regionId: receivedDevices.regionId,
        createdAt: receivedDevices.createdAt,
        updatedAt: receivedDevices.updatedAt,
        regionName: regions.name,
        status: receivedDevices.status,
        isReceived: sql<boolean>`true`,
      })
      .from(receivedDevices)
      .leftJoin(users, eq(receivedDevices.technicianId, users.id))
      .leftJoin(regions, eq(receivedDevices.regionId, regions.id))
      .where(eq(receivedDevices.id, id))
      .limit(1);

    if (receivedDevice) {
      return {
        ...receivedDevice,
        city: receivedDevice.city || "غير محدد",
        technicianName: receivedDevice.technicianName || "غير محدد",
        terminalId: receivedDevice.terminalId || "غير محدد",
        battery: receivedDevice.battery ? "جيدة" : "سيئة",
        chargerCable: receivedDevice.chargerCable ? "موجود" : "غير موجود",
        chargerHead: receivedDevice.chargerHead ? "موجود" : "غير موجود",
        hasSim: receivedDevice.hasSim ? "نعم" : "لا",
      };
    }

    return undefined;
  }

  async getReceivedDevice(id: string): Promise<ReceivedDevice | undefined> {
    const hasItemTypeColumn = await this.hasItemTypeColumn();

    if (!hasItemTypeColumn) {
      const result = await this.db.execute(sql`
        SELECT
          id,
          technician_id as "technicianId",
          supervisor_id as "supervisorId",
          terminal_id as "terminalId",
          serial_number as "serialNumber",
          battery,
          charger_cable as "chargerCable",
          charger_head as "chargerHead",
          has_sim as "hasSim",
          sim_card_type as "simCardType",
          damage_part as "damagePart",
          status,
          admin_notes as "adminNotes",
          approved_by as "approvedBy",
          approved_at as "approvedAt",
          region_id as "regionId",
          created_at as "createdAt",
          updated_at as "updatedAt",
          NULL::varchar as "itemTypeId"
        FROM received_devices
        WHERE id = ${id}
        LIMIT 1
      `);

      const [device] = ((result as any).rows || []) as ReceivedDevice[];
      return device || undefined;
    }

    const [device] = await this.db
      .select()
      .from(receivedDevices)
      .where(eq(receivedDevices.id, id))
      .limit(1);

    return device || undefined;
  }

  async createWithdrawnDevice(data: InsertWithdrawnDevice): Promise<WithdrawnDevice> {
    const [newDevice] = await this.db
      .insert(withdrawnDevices)
      .values({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    if (!newDevice) {
      throw new Error("Failed to create withdrawn device entry");
    }

    return newDevice;
  }

  async updateWithdrawnDevice(id: string, updates: Partial<InsertWithdrawnDevice>): Promise<WithdrawnDevice> {
    const [updatedDevice] = await this.db
      .update(withdrawnDevices)
      .set({ 
        ...updates, 
        updatedAt: new Date() 
      })
      .where(eq(withdrawnDevices.id, id))
      .returning();

    if (!updatedDevice) {
      throw new Error("Withdrawn device not found");
    }

    return updatedDevice;
  }

  async deleteWithdrawnDevice(id: string): Promise<boolean> {
    const withdrawnResult = await this.db
      .delete(withdrawnDevices)
      .where(eq(withdrawnDevices.id, id));

    const deletedWithdrawn = ((withdrawnResult as any).rowCount || (withdrawnResult as any).changes || 0) > 0;
    if (deletedWithdrawn) {
      return true;
    }

    const receivedResult = await this.db
      .delete(receivedDevices)
      .where(eq(receivedDevices.id, id));

    return ((receivedResult as any).rowCount || (receivedResult as any).changes || 0) > 0;
  }

  async deleteReceivedDevice(id: string): Promise<boolean> {
    const result = await this.db
      .delete(receivedDevices)
      .where(eq(receivedDevices.id, id));

    return ((result as any).rowCount || (result as any).changes || 0) > 0;
  }

  async getReceivedDevices(filters?: { 
    status?: string; 
    technicianId?: string; 
    supervisorId?: string; 
    regionId?: string 
  }): Promise<ReceivedDevice[]> {
    const hasItemTypeColumn = await this.hasItemTypeColumn();

    if (!hasItemTypeColumn) {
      const result = await this.db.execute(sql`
        SELECT
          id,
          technician_id as "technicianId",
          supervisor_id as "supervisorId",
          terminal_id as "terminalId",
          serial_number as "serialNumber",
          battery,
          charger_cable as "chargerCable",
          charger_head as "chargerHead",
          has_sim as "hasSim",
          sim_card_type as "simCardType",
          damage_part as "damagePart",
          status,
          admin_notes as "adminNotes",
          approved_by as "approvedBy",
          approved_at as "approvedAt",
          region_id as "regionId",
          created_at as "createdAt",
          updated_at as "updatedAt",
          NULL::varchar as "itemTypeId"
        FROM received_devices
        WHERE (${filters?.status ?? null}::text IS NULL OR status = ${filters?.status ?? null})
          AND (${filters?.technicianId ?? null}::varchar IS NULL OR technician_id = ${filters?.technicianId ?? null})
          AND (${filters?.supervisorId ?? null}::varchar IS NULL OR supervisor_id = ${filters?.supervisorId ?? null})
          AND (${filters?.regionId ?? null}::varchar IS NULL OR region_id = ${filters?.regionId ?? null})
        ORDER BY created_at DESC
      `);

      return ((result as any).rows || []) as ReceivedDevice[];
    }

    let query = this.db
      .select()
      .from(receivedDevices)
      .$dynamic();

    const conditions: any[] = [];

    if (filters?.status) {
      conditions.push(eq(receivedDevices.status, filters.status));
    }
    if (filters?.technicianId) {
      conditions.push(eq(receivedDevices.technicianId, filters.technicianId));
    }
    if (filters?.supervisorId) {
      conditions.push(eq(receivedDevices.supervisorId, filters.supervisorId));
    }
    if (filters?.regionId) {
      conditions.push(eq(receivedDevices.regionId, filters.regionId));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    return query.orderBy(desc(receivedDevices.createdAt));
  }

  async createReceivedDevice(data: InsertReceivedDevice): Promise<ReceivedDevice> {
    // Check if there is already a pending received device request for this serial number
    const [existingPending] = await this.db
      .select({ id: receivedDevices.id })
      .from(receivedDevices)
      .where(
        and(
          eq(receivedDevices.serialNumber, data.serialNumber),
          eq(receivedDevices.status, "pending")
        )
      )
      .limit(1);

    if (existingPending) {
      throw new AppError("هذا الرقم التسلسلي بانتظار المراجعة بالفعل في الإشعارات ولا يمكن تكراره", 400);
    }

    const hasItemTypeColumn = await this.hasItemTypeColumn();

    if (!hasItemTypeColumn) {
      const result = await this.db.execute(sql`
        INSERT INTO received_devices (
          technician_id,
          supervisor_id,
          terminal_id,
          serial_number,
          battery,
          charger_cable,
          charger_head,
          has_sim,
          sim_card_type,
          damage_part,
          status,
          region_id,
          created_at,
          updated_at
        )
        VALUES (
          ${data.technicianId},
          ${data.supervisorId ?? null},
          ${data.terminalId},
          ${data.serialNumber},
          ${data.battery ?? false},
          ${data.chargerCable ?? false},
          ${data.chargerHead ?? false},
          ${data.hasSim ?? false},
          ${data.simCardType ?? null},
          ${data.damagePart ?? ""},
          'pending',
          ${data.regionId ?? null},
          NOW(),
          NOW()
        )
        RETURNING
          id,
          technician_id as "technicianId",
          supervisor_id as "supervisorId",
          terminal_id as "terminalId",
          serial_number as "serialNumber",
          battery,
          charger_cable as "chargerCable",
          charger_head as "chargerHead",
          has_sim as "hasSim",
          sim_card_type as "simCardType",
          damage_part as "damagePart",
          status,
          admin_notes as "adminNotes",
          approved_by as "approvedBy",
          approved_at as "approvedAt",
          region_id as "regionId",
          created_at as "createdAt",
          updated_at as "updatedAt",
          NULL::varchar as "itemTypeId"
      `);

      const [newDevice] = ((result as any).rows || []) as ReceivedDevice[];

      if (!newDevice) {
        throw new Error("Failed to create received device entry");
      }

      return newDevice;
    }

    const [newDevice] = await this.db
      .insert(receivedDevices)
      .values({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    if (!newDevice) {
      throw new Error("Failed to create received device entry");
    }

    return newDevice;
  }

  async updateReceivedDevice(id: string, updates: Partial<InsertReceivedDevice>): Promise<ReceivedDevice> {
    const hasItemTypeColumn = await this.hasItemTypeColumn();

    if (!hasItemTypeColumn) {
      const result = await this.db.execute(sql`
        UPDATE received_devices
        SET
          technician_id = COALESCE(${updates.technicianId ?? null}, technician_id),
          supervisor_id = COALESCE(${updates.supervisorId ?? null}, supervisor_id),
          terminal_id = COALESCE(${updates.terminalId ?? null}, terminal_id),
          serial_number = COALESCE(${updates.serialNumber ?? null}, serial_number),
          battery = COALESCE(${updates.battery ?? null}, battery),
          charger_cable = COALESCE(${updates.chargerCable ?? null}, charger_cable),
          charger_head = COALESCE(${updates.chargerHead ?? null}, charger_head),
          has_sim = COALESCE(${updates.hasSim ?? null}, has_sim),
          sim_card_type = COALESCE(${updates.simCardType ?? null}, sim_card_type),
          damage_part = COALESCE(${updates.damagePart ?? null}, damage_part),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING
          id,
          technician_id as "technicianId",
          supervisor_id as "supervisorId",
          terminal_id as "terminalId",
          serial_number as "serialNumber",
          battery,
          charger_cable as "chargerCable",
          charger_head as "chargerHead",
          has_sim as "hasSim",
          sim_card_type as "simCardType",
          damage_part as "damagePart",
          status,
          admin_notes as "adminNotes",
          approved_by as "approvedBy",
          approved_at as "approvedAt",
          region_id as "regionId",
          created_at as "createdAt",
          updated_at as "updatedAt",
          NULL::varchar as "itemTypeId"
      `);

      const [updated] = ((result as any).rows || []) as ReceivedDevice[];
      if (!updated) {
        throw new Error("Received device not found");
      }
      return updated;
    }

    const [updated] = await this.db
      .update(receivedDevices)
      .set({
        ...updates,
        updatedAt: new Date()
      })
      .where(eq(receivedDevices.id, id))
      .returning();

    if (!updated) {
      throw new Error("Received device not found");
    }
    return updated;
  }

  async updateReceivedDeviceStatus(
    id: string,
    status: string,
    approvedBy: string,
    adminNotes?: string,
    existingDevice?: any
  ): Promise<ReceivedDevice> {
    const hasItemTypeColumn = await this.hasItemTypeColumn();

    return await this.db.transaction(async (tx) => {
      let updatedDevice: ReceivedDevice;

      if (!hasItemTypeColumn) {
        const result = await tx.execute(sql`
          UPDATE received_devices
          SET
            status = ${status},
            approved_by = ${approvedBy},
            admin_notes = ${adminNotes ?? null},
            approved_at = NOW(),
            updated_at = NOW()
          WHERE id = ${id}
          RETURNING
            id,
            technician_id as "technicianId",
            supervisor_id as "supervisorId",
            terminal_id as "terminalId",
            serial_number as "serialNumber",
            battery,
            charger_cable as "chargerCable",
            charger_head as "chargerHead",
            has_sim as "hasSim",
            sim_card_type as "simCardType",
            damage_part as "damagePart",
            status,
            admin_notes as "adminNotes",
            approved_by as "approvedBy",
            approved_at as "approvedAt",
            region_id as "regionId",
            created_at as "createdAt",
            updated_at as "updatedAt",
            NULL::varchar as "itemTypeId"
        `);

        const [device] = ((result as any).rows || []) as ReceivedDevice[];
        if (!device) {
          throw new Error("Received device not found");
        }
        updatedDevice = device;
      } else {
        const [device] = await tx
          .update(receivedDevices)
          .set({
            status,
            approvedBy,
            adminNotes,
            approvedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(receivedDevices.id, id))
          .returning();

        if (!device) {
          throw new Error("Received device not found");
        }
        updatedDevice = device;
      }

      // If status transitioned to approved, create a withdrawn device entry and increment inventory
      if (status === "approved" && existingDevice?.status !== "approved") {
        const [technician] = await tx
          .select()
          .from(users)
          .where(eq(users.id, updatedDevice.technicianId))
          .limit(1);

        if (technician) {
          await tx.insert(withdrawnDevices).values({
            city: technician.city || "غير محدد",
            technicianName: technician.fullName || "غير محدد",
            terminalId: updatedDevice.terminalId || "غير محدد",
            serialNumber: updatedDevice.serialNumber,
            battery: updatedDevice.battery ? "جيدة" : "سيئة",
            chargerCable: updatedDevice.chargerCable ? "موجود" : "غير موجود",
            chargerHead: updatedDevice.chargerHead ? "موجود" : "غير موجود",
            hasSim: updatedDevice.hasSim ? "نعم" : "لا",
            simCardType: updatedDevice.simCardType || "غير محدد",
            damagePart: updatedDevice.damagePart || "سليم",
            notes: adminNotes || null,
            createdBy: approvedBy,
            regionId: updatedDevice.regionId,
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }

        // Increment inventory if itemTypeId exists
        if (updatedDevice.itemTypeId) {
          const technicianId = updatedDevice.technicianId;
          const itemTypeId = updatedDevice.itemTypeId;
          const isFixed = (updatedDevice as any).inventoryType === "moving" ? false : true;

          if (isFixed) {
            const [existingStock] = await tx
              .select()
              .from(technicianFixedInventoryEntries)
              .where(and(
                eq(technicianFixedInventoryEntries.technicianId, technicianId),
                eq(technicianFixedInventoryEntries.itemTypeId, itemTypeId)
              ));

            if (existingStock) {
              await tx
                .update(technicianFixedInventoryEntries)
                .set({
                  units: existingStock.units + 1,
                  updatedAt: new Date()
                })
                .where(eq(technicianFixedInventoryEntries.id, existingStock.id));
            } else {
              await tx
                .insert(technicianFixedInventoryEntries)
                .values({
                  technicianId,
                  itemTypeId,
                  boxes: 0,
                  units: 1
                });
            }
          } else {
            const [existingStock] = await tx
              .select()
              .from(technicianMovingInventoryEntries)
              .where(and(
                eq(technicianMovingInventoryEntries.technicianId, technicianId),
                eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
              ));

            if (existingStock) {
              await tx
                .update(technicianMovingInventoryEntries)
                .set({
                  units: existingStock.units + 1,
                  updatedAt: new Date()
                })
                .where(eq(technicianMovingInventoryEntries.id, existingStock.id));
            } else {
              await tx
                .insert(technicianMovingInventoryEntries)
                .values({
                  technicianId,
                  itemTypeId,
                  boxes: 0,
                  units: 1
                });
            }
          }
        }
      }

      return updatedDevice;
    });
  }

  async getPendingReceivedDevicesCount(supervisorId?: string, regionId?: string | null): Promise<number> {
    let query = this.db
      .select({ count: sql<number>`count(*)` })
      .from(receivedDevices)
      .$dynamic();

    const conditions = [eq(receivedDevices.status, 'pending')];

    if (supervisorId) {
      conditions.push(eq(receivedDevices.supervisorId, supervisorId));
    }

    if (regionId) {
      conditions.push(eq(receivedDevices.regionId, regionId));
    }

    query = query.where(and(...conditions));

    const [{ count }] = await query;
    return Number(count);
  }

  async getDevicesSummaryByRegion(regionId: string): Promise<any> {
    const [withdrawnSummary] = await this.db
      .select({
        totalWithdrawn: sql<number>`COUNT(*)`,
        pendingWithdrawn: sql<number>`0`,
        approvedWithdrawn: sql<number>`0`,
        rejectedWithdrawn: sql<number>`0`
      })
      .from(withdrawnDevices)
      .where(eq(withdrawnDevices.regionId, regionId));

    const [receivedSummary] = await this.db
      .select({
        totalReceived: sql<number>`COUNT(*)`,
        pendingReceived: sql<number>`COUNT(CASE WHEN ${receivedDevices.status} = 'pending' THEN 1 END)`,
        approvedReceived: sql<number>`COUNT(CASE WHEN ${receivedDevices.status} = 'approved' THEN 1 END)`,
        rejectedReceived: sql<number>`COUNT(CASE WHEN ${receivedDevices.status} = 'rejected' THEN 1 END)`
      })
      .from(receivedDevices)
      .where(eq(receivedDevices.regionId, regionId));

    return {
      ...withdrawnSummary,
      ...receivedSummary
    };
  }

  async getDevicesByTechnician(technicianId: string): Promise<{ withdrawn: any[]; received: any[] }> {
    const [technician] = await this.db
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, technicianId))
      .limit(1);

    const withdrawn = await this.db
      .select()
      .from(withdrawnDevices)
      .where(eq(withdrawnDevices.technicianName, technician?.fullName || ""))
      .orderBy(desc(withdrawnDevices.createdAt));

    const hasItemTypeColumn = await this.hasItemTypeColumn();

    const received = hasItemTypeColumn
      ? await this.db
          .select()
          .from(receivedDevices)
          .where(eq(receivedDevices.technicianId, technicianId))
          .orderBy(desc(receivedDevices.createdAt))
      : (((await this.db.execute(sql`
          SELECT
            id,
            technician_id as "technicianId",
            supervisor_id as "supervisorId",
            terminal_id as "terminalId",
            serial_number as "serialNumber",
            battery,
            charger_cable as "chargerCable",
            charger_head as "chargerHead",
            has_sim as "hasSim",
            sim_card_type as "simCardType",
            damage_part as "damagePart",
            status,
            admin_notes as "adminNotes",
            approved_by as "approvedBy",
            approved_at as "approvedAt",
            region_id as "regionId",
            created_at as "createdAt",
            updated_at as "updatedAt",
            NULL::varchar as "itemTypeId"
          FROM received_devices
          WHERE technician_id = ${technicianId}
          ORDER BY created_at DESC
        `)) as any).rows || []);

    return {
      withdrawn,
      received
    };
  }

  async getPendingDevicesForApproval(supervisorId?: string): Promise<any[]> {
    let receivedQuery = this.db
      .select({
        id: receivedDevices.id,
        technicianId: receivedDevices.technicianId,
        terminalId: receivedDevices.terminalId,
        serialNumber: receivedDevices.serialNumber,
        status: receivedDevices.status,
        createdAt: receivedDevices.createdAt,
        technicianName: users.fullName,
        technicianCity: users.city,
        type: sql<string>`'received'`
      })
      .from(receivedDevices)
      .leftJoin(users, eq(receivedDevices.technicianId, users.id))
      .where(eq(receivedDevices.status, 'pending'))
      .$dynamic();

    if (supervisorId) {
      receivedQuery = receivedQuery.where(eq(receivedDevices.supervisorId, supervisorId));
    }

    const received = await receivedQuery;

    return [...received].sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  async approveDevicesBatch(deviceIds: string[], approvedBy: string, type: 'withdrawn' | 'received'): Promise<any> {
    if (type === 'withdrawn') {
      return this.db
        .update(withdrawnDevices)
        .set({ 
          updatedAt: new Date() 
        })
        .where(sql`${withdrawnDevices.id} = ANY(${deviceIds})`);
    } else {
      return this.db
        .update(receivedDevices)
        .set({ 
          status: 'approved', 
          approvedBy,
          approvedAt: new Date(),
          updatedAt: new Date() 
        })
        .where(sql`${receivedDevices.id} = ANY(${deviceIds})`);
    }
  }

  async rejectDevicesBatch(deviceIds: string[], approvedBy: string, adminNotes: string, type: 'withdrawn' | 'received'): Promise<any> {
    if (type === 'withdrawn') {
      return this.db
        .update(withdrawnDevices)
        .set({ 
          notes: adminNotes,
          updatedAt: new Date() 
        })
        .where(sql`${withdrawnDevices.id} = ANY(${deviceIds})`);
    } else {
      return this.db
        .update(receivedDevices)
        .set({ 
          status: 'rejected', 
          approvedBy,
          adminNotes,
          approvedAt: new Date(),
          updatedAt: new Date() 
        })
        .where(sql`${receivedDevices.id} = ANY(${deviceIds})`);
    }
  }

  async deliverDeviceByBarcode(technicianId: string, barcode: string): Promise<ReceivedDevice> {
    const hasItemTypeColumn = await this.hasItemTypeColumn();

    // Find the device that is approved, belongs to the technician, and matches barcode (serialNumber or terminalId)
    let device: ReceivedDevice | undefined;

    if (!hasItemTypeColumn) {
      const result = await this.db.execute(sql`
        SELECT
          id,
          technician_id as "technicianId",
          supervisor_id as "supervisorId",
          terminal_id as "terminalId",
          serial_number as "serialNumber",
          battery,
          charger_cable as "chargerCable",
          charger_head as "chargerHead",
          has_sim as "hasSim",
          sim_card_type as "simCardType",
          damage_part as "damagePart",
          status,
          admin_notes as "adminNotes",
          approved_by as "approvedBy",
          approved_at as "approvedAt",
          region_id as "regionId",
          created_at as "createdAt",
          updated_at as "updatedAt",
          NULL::varchar as "itemTypeId"
        FROM received_devices
        WHERE technician_id = ${technicianId}
          AND status = 'approved'
          AND (serial_number = ${barcode} OR terminal_id = ${barcode})
        LIMIT 1
      `);
      const [found] = ((result as any).rows || []) as ReceivedDevice[];
      device = found;
    } else {
      const [found] = await this.db
        .select()
        .from(receivedDevices)
        .where(and(
          eq(receivedDevices.technicianId, technicianId),
          eq(receivedDevices.status, 'approved'),
          sql`(${receivedDevices.serialNumber} = ${barcode} OR ${receivedDevices.terminalId} = ${barcode})`
        ))
        .limit(1);
      device = found || undefined;
    }

    if (!device) {
      throw new Error("الجهاز غير موجود في عهدتك كـ 'مقبول' أو رمز الباركود غير مطابق");
    }

    return await this.db.transaction(async (tx) => {
      // Update status to 'delivered'
      let updatedDevice: ReceivedDevice;

      if (!hasItemTypeColumn) {
        const result = await tx.execute(sql`
          UPDATE received_devices
          SET
            status = 'delivered',
            updated_at = NOW()
          WHERE id = ${device.id}
          RETURNING
            id,
            technician_id as "technicianId",
            supervisor_id as "supervisorId",
            terminal_id as "terminalId",
            serial_number as "serialNumber",
            battery,
            charger_cable as "chargerCable",
            charger_head as "chargerHead",
            has_sim as "hasSim",
            sim_card_type as "simCardType",
            damage_part as "damagePart",
            status,
            admin_notes as "adminNotes",
            approved_by as "approvedBy",
            approved_at as "approvedAt",
            region_id as "regionId",
            created_at as "createdAt",
            updated_at as "updatedAt",
            NULL::varchar as "itemTypeId"
        `);
        const [found] = ((result as any).rows || []) as ReceivedDevice[];
        updatedDevice = found;
      } else {
        const [found] = await tx
          .update(receivedDevices)
          .set({
            status: 'delivered',
            updatedAt: new Date()
          })
          .where(eq(receivedDevices.id, device.id))
          .returning();
        updatedDevice = found;
      }

      // Decrement inventory by 1 unit
      if (updatedDevice.itemTypeId) {
        const itemTypeId = updatedDevice.itemTypeId;
        const isFixed = (updatedDevice as any).inventoryType === "moving" ? false : true;

        if (isFixed) {
          const [existingStock] = await tx
            .select()
            .from(technicianFixedInventoryEntries)
            .where(and(
              eq(technicianFixedInventoryEntries.technicianId, technicianId),
              eq(technicianFixedInventoryEntries.itemTypeId, itemTypeId)
            ));

          if (existingStock) {
            await tx
              .update(technicianFixedInventoryEntries)
              .set({
                units: Math.max(0, existingStock.units - 1),
                updatedAt: new Date()
              })
              .where(eq(technicianFixedInventoryEntries.id, existingStock.id));
          }
        } else {
          const [existingStock] = await tx
            .select()
            .from(technicianMovingInventoryEntries)
            .where(and(
              eq(technicianMovingInventoryEntries.technicianId, technicianId),
              eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
            ));

          if (existingStock) {
            await tx
              .update(technicianMovingInventoryEntries)
              .set({
                units: Math.max(0, existingStock.units - 1),
                updatedAt: new Date()
              })
              .where(eq(technicianMovingInventoryEntries.id, existingStock.id));
          }
        }
      }

      return updatedDevice;
    });
  }

  async deductTechnicianInventory(data: {
    technicianCode: string;
    devices: { serialNumber: string; model?: string }[];
    notes?: string;
    actor: { id: string; username: string; role: string; regionId: string | null };
  }, externalTx?: any): Promise<any[]> {
    const { technicianCode, devices, notes, actor } = data;

    // Helper to resolve device model to standard itemTypeId
    const resolveItemTypeId = (modelStr?: string): string => {
      const s = String(modelStr || "").toLowerCase();
      if (s.includes("n950") || s.includes("newland")) return "n950";
      if (s.includes("a920") || s.includes("pax") || s.includes("i9000")) return "i9000s";
      if (s.includes("i9100")) return "i9100";
      return "n950"; // default to n950
    };

    // Find the technician user in StockPro
    const lookupClient = externalTx || this.db;
    const [tech] = await lookupClient
      .select()
      .from(users)
      .where(
        or(
          sql`LOWER(${users.username}) = LOWER(${technicianCode.trim()})`,
          sql`LOWER(${users.fullName}) = LOWER(${technicianCode.trim()})`
        )
      )
      .limit(1);

    if (!tech) {
      throw new Error(`لم يتم العثور على المندوب بالرمز أو الاسم: ${technicianCode}`);
    }

    const runBody = async (tx: any) => {
      // OPS-REMED-E3-I.R2 (deadlock-safety correction): resolve every
      // device's target itemTypeId via a plain (unlocked) read FIRST, then
      // sort the whole batch by that stable itemTypeId before taking any
      // FOR UPDATE lock below. Two overlapping multi-asset requests naming
      // the same technician/itemType stock rows in reversed order would
      // otherwise each hold one lock while waiting on the other — a
      // classic deadlock. Locking in one global deterministic order
      // (itemTypeId, then serialNumber as a tiebreaker for same-type
      // batches) eliminates that cycle regardless of caller-supplied order.
      const resolvedDevices = [];
      for (const device of devices) {
        const [deviceRow] = await tx
          .select()
          .from(receivedDevices)
          .where(
            and(
              eq(receivedDevices.technicianId, tech.id),
              eq(receivedDevices.status, "approved"),
              or(
                eq(receivedDevices.serialNumber, device.serialNumber),
                eq(receivedDevices.terminalId, device.serialNumber)
              )
            )
          )
          .limit(1);

        const itemTypeId = deviceRow?.itemTypeId || resolveItemTypeId(device.model);
        resolvedDevices.push({ device, deviceRow, itemTypeId });
      }

      resolvedDevices.sort((a, b) => {
        if (a.itemTypeId !== b.itemTypeId) return a.itemTypeId < b.itemTypeId ? -1 : 1;
        return a.device.serialNumber < b.device.serialNumber
          ? -1
          : a.device.serialNumber > b.device.serialNumber
            ? 1
            : 0;
      });

      const results = [];
      for (const { device, deviceRow, itemTypeId: advisoryItemTypeId } of resolvedDevices) {
        // OPS-REMED-E3-F.R1 (P2 closure): the itemTypeId used above to
        // decide the GLOBAL LOCK ORDER came from an unlocked, pre-sort
        // read (advisory only — it exists purely to make lock acquisition
        // order deterministic across overlapping requests). It must never
        // be the value actually used to select/mutate the locked stock
        // row. Here, inside the write phase, re-read the SAME
        // received_devices row WITH FOR UPDATE (locking the authoritative
        // source-of-truth row itself) and re-derive itemTypeId from THAT
        // locked read. If it disagrees with the advisory value — meaning
        // the row's itemTypeId changed concurrently between the advisory
        // phase and this lock — fail closed with a structured error
        // instead of silently locking/decrementing whatever stock row the
        // now-stale advisory value points to.
        let deviceRowLocked = deviceRow;
        if (deviceRow) {
          [deviceRowLocked] = await tx
            .select()
            .from(receivedDevices)
            .where(eq(receivedDevices.id, deviceRow.id))
            .for("update");

          if (!deviceRowLocked) {
            const err: any = new Error(
              `[DrizzleDevicesRepository] received_devices row ${deviceRow.id} vanished between the advisory read and the locked write phase.`
            );
            err.code = "DEDUCT_INTEGRITY_CONFLICT";
            throw err;
          }
        }

        const itemTypeId = deviceRowLocked?.itemTypeId || resolveItemTypeId(device.model);
        if (deviceRow && itemTypeId !== advisoryItemTypeId) {
          // The advisory (pre-lock) itemTypeId no longer matches the
          // locked, authoritative value — the deterministic lock order
          // computed above may now be wrong for this row. Never proceed
          // with a stock row selected under a stale assumption.
          const err: any = new Error(
            `[DrizzleDevicesRepository] itemTypeId for received_devices row ${deviceRow.id} changed between the advisory read ("${advisoryItemTypeId}") and the locked write phase ("${itemTypeId}") — refusing to lock/decrement a potentially wrong stock row.`
          );
          err.code = "DEDUCT_INTEGRITY_CONFLICT";
          throw err;
        }

        const isFixed = deviceRowLocked ? (deviceRowLocked.inventoryType !== "moving") : false;

        if (deviceRowLocked) {
          // Update status to delivered — same locked row, no separate
          // unlocked re-fetch.
          await tx
            .update(receivedDevices)
            .set({
              status: "delivered",
              updatedAt: new Date()
            })
            .where(eq(receivedDevices.id, deviceRowLocked.id));
        } else {
          // Auto-create delivered received_device entry for logging/audit purposes
          await tx
            .insert(receivedDevices)
            .values({
              technicianId: tech.id,
              serialNumber: device.serialNumber,
              terminalId: device.serialNumber,
              itemTypeId: itemTypeId,
              status: "delivered",
              inventoryType: "moving",
              createdAt: new Date(),
              updatedAt: new Date()
            });
        }

        // Decrement units in technician inventory.
        // OPS-REMED-E3: a deduction attempt against zero (or missing) stock
        // must NOT be silently clamped to zero and reported as success — it
        // must throw DEDUCT_INSUFFICIENT_STOCK, rolling back the whole
        // request (this loop already runs inside one transaction).
        // OPS-REMED-E3 (concurrency finding, same class as scanOut): locked
        // with FOR UPDATE — two concurrent deductions against the same
        // technician/itemType stock row must never both pass the
        // zero-balance check against the same pre-commit snapshot. The
        // losing transaction now blocks here until the winner commits, then
        // re-reads the post-commit balance.
        if (isFixed) {
          const [existingStock] = await tx
            .select()
            .from(technicianFixedInventoryEntries)
            .where(
              and(
                eq(technicianFixedInventoryEntries.technicianId, tech.id),
                eq(technicianFixedInventoryEntries.itemTypeId, itemTypeId)
              )
            )
            .for("update");

          if (!existingStock || existingStock.units <= 0) {
            const err: any = new Error(
              `[DrizzleDevicesRepository] Insufficient fixed stock for technician ${tech.id}, itemType ${itemTypeId} — refusing to deduct at zero.`
            );
            err.code = "DEDUCT_INSUFFICIENT_STOCK";
            throw err;
          }

          await tx
            .update(technicianFixedInventoryEntries)
            .set({
              units: existingStock.units - 1,
              updatedAt: new Date()
            })
            .where(eq(technicianFixedInventoryEntries.id, existingStock.id));
        } else {
          const [existingStock] = await tx
            .select()
            .from(technicianMovingInventoryEntries)
            .where(
              and(
                eq(technicianMovingInventoryEntries.technicianId, tech.id),
                eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
              )
            )
            .for("update");

          if (!existingStock || existingStock.units <= 0) {
            const err: any = new Error(
              `[DrizzleDevicesRepository] Insufficient moving stock for technician ${tech.id}, itemType ${itemTypeId} — refusing to deduct at zero.`
            );
            err.code = "DEDUCT_INSUFFICIENT_STOCK";
            throw err;
          }

          await tx
            .update(technicianMovingInventoryEntries)
            .set({
              units: existingStock.units - 1,
              updatedAt: new Date()
            })
            .where(eq(technicianMovingInventoryEntries.id, existingStock.id));
        }

        // Write stock movement log
        await tx.insert(stockMovements).values({
          technicianId: tech.id,
          itemType: itemTypeId,
          packagingType: "unit",
          quantity: 1,
          fromInventory: `technician:${tech.id}:${isFixed ? 'fixed' : 'moving'}`,
          toInventory: "customer",
          reason: "rassco_delivery_ocr",
          performedBy: actor.id,
          notes: notes || `Auto deducted via PDF report OCR for Serial: ${device.serialNumber}`,
          createdAt: new Date()
        });

        results.push({
          serialNumber: device.serialNumber,
          itemTypeId,
          status: "delivered"
        });
      }
      return results;
    };

    if (externalTx) {
      return runBody(externalTx);
    }
    return await this.db.transaction(runBody);
  }

  async deductTechnicianConsumables(data: {
    technicianId: string;
    items: { itemTypeId: string; quantity: number }[];
    actorId: string;
    notes: string;
  }, externalTx?: any): Promise<void> {
    const { technicianId, actorId, notes } = data;
    // Stable lock order across overlapping deductions for the same technician.
    const items = [...data.items].sort((a, b) =>
      a.itemTypeId < b.itemTypeId ? -1 : a.itemTypeId > b.itemTypeId ? 1 : 0
    );

    const runBody = async (tx: any) => {
      for (const { itemTypeId, quantity } of items) {
        const [itemType] = await tx
          .select({ unitsPerBox: itemTypes.unitsPerBox })
          .from(itemTypes)
          .where(eq(itemTypes.id, itemTypeId))
          .limit(1);
        if (!itemType) {
          const err: any = new Error(`[DrizzleDevicesRepository] Unknown consumable item type "${itemTypeId}".`);
          err.code = "DEDUCT_INTEGRITY_CONFLICT";
          throw err;
        }

        // (technicianId, itemTypeId) is not unique on these tables, so every
        // matching row is locked and used, moving rows first.
        const movingRows = await tx
          .select()
          .from(technicianMovingInventoryEntries)
          .where(and(
            eq(technicianMovingInventoryEntries.technicianId, technicianId),
            eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId)
          ))
          .orderBy(technicianMovingInventoryEntries.id)
          .for("update");
        const fixedRows = await tx
          .select()
          .from(technicianFixedInventoryEntries)
          .where(and(
            eq(technicianFixedInventoryEntries.technicianId, technicianId),
            eq(technicianFixedInventoryEntries.itemTypeId, itemTypeId)
          ))
          .orderBy(technicianFixedInventoryEntries.id)
          .for("update");

        const sources: { row: any; kind: "moving" | "fixed" }[] = [
          ...movingRows.map((row: any) => ({ row, kind: "moving" as const })),
          ...fixedRows.map((row: any) => ({ row, kind: "fixed" as const })),
        ];
        const plan = planConsumableDeduction(
          quantity,
          itemType.unitsPerBox,
          sources.map((s) => ({ boxes: s.row.boxes, units: s.row.units }))
        );
        if (!plan.ok) {
          const err: any = new Error(
            `[DrizzleDevicesRepository] Insufficient consumable stock for technician ${technicianId}, itemType ${itemTypeId}: required ${quantity}, available ${plan.available}.`
          );
          err.code = "DEDUCT_INSUFFICIENT_STOCK";
          throw err;
        }

        const takenByKind = { moving: 0, fixed: 0 };
        for (let i = 0; i < sources.length; i++) {
          if (plan.taken[i] === 0) continue;
          const { row, kind } = sources[i];
          const table = kind === "moving" ? technicianMovingInventoryEntries : technicianFixedInventoryEntries;
          await tx
            .update(table)
            .set({ boxes: plan.after[i].boxes, units: plan.after[i].units, updatedAt: new Date() })
            .where(eq(table.id, row.id));
          takenByKind[kind] += plan.taken[i];
        }

        for (const kind of ["moving", "fixed"] as const) {
          if (takenByKind[kind] === 0) continue;
          await tx.insert(stockMovements).values({
            technicianId,
            itemType: itemTypeId,
            packagingType: "unit",
            quantity: takenByKind[kind],
            fromInventory: `technician:${technicianId}:${kind}`,
            toInventory: "customer",
            reason: "courier_consumables_delivery",
            performedBy: actorId,
            notes,
            createdAt: new Date(),
          });
        }
      }
    };

    if (externalTx) {
      return runBody(externalTx);
    }
    return await this.db.transaction(runBody);
  }
}
