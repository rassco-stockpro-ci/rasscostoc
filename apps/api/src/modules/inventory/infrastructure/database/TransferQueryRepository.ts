import { eq, desc, and, sql } from "drizzle-orm";
import { getDatabase } from "@core/database/connection";
import {
  warehouseTransfers,
  warehouses,
  users,
  WarehouseTransferWithDetails
} from "@shared/schema";

export interface ITransferQueryRepository {
  getWarehouseTransfers(
    warehouseId?: string,
    technicianId?: string,
    regionId?: string,
    limit?: number
  ): Promise<WarehouseTransferWithDetails[]>;
}

/**
 * Transfer Query Repository Implementation
 * Handles all transfer-related read operations
 */
export class TransferQueryRepository implements ITransferQueryRepository {
  private get db() {
    return getDatabase();
  }

  async getWarehouseTransfers(
    warehouseId?: string, 
    technicianId?: string, 
    regionId?: string, 
    limit?: number
  ): Promise<WarehouseTransferWithDetails[]> {
    // Item name mapping for Arabic display
    const itemNameMap: Record<string, string> = {
      'n950': 'N950',
      'i9000s': 'I9000s',
      'i9100': 'I9100',
      'rollPaper': 'ورق حراري',
      'stickers': 'ملصقات',
      'newBatteries': 'بطاريات جديدة',
      'mobilySim': 'شريحة موبايلي',
      'stcSim': 'شريحة STC',
      'zainSim': 'شريحة زين',
      'lebara': 'شريحة ليبارا',
      'lebaraSim': 'شريحة ليبارا',
    };

    let query = this.db
      .select({
        id: warehouseTransfers.id,
        requestId: warehouseTransfers.requestId,
        warehouseId: warehouseTransfers.warehouseId,
        technicianId: warehouseTransfers.technicianId,
        itemType: warehouseTransfers.itemType,
        packagingType: warehouseTransfers.packagingType,
        quantity: warehouseTransfers.quantity,
        performedBy: warehouseTransfers.performedBy,
        notes: warehouseTransfers.notes,
        status: warehouseTransfers.status,
        transferType: warehouseTransfers.transferType,
        rejectionReason: warehouseTransfers.rejectionReason,
        respondedAt: warehouseTransfers.respondedAt,
        createdAt: warehouseTransfers.createdAt,
        warehouseName: warehouses.name,
        technicianName: users.fullName,
        performedByName: sql<string>`performer.full_name`,
      })
      .from(warehouseTransfers)
      .leftJoin(warehouses, eq(warehouseTransfers.warehouseId, warehouses.id))
      .leftJoin(users, eq(warehouseTransfers.technicianId, users.id))
      .leftJoin(sql`${users} as performer`, sql`${warehouseTransfers.performedBy} = performer.id`)
      .orderBy(desc(warehouseTransfers.createdAt));

    const conditions = [];
    if (warehouseId) {
      conditions.push(eq(warehouseTransfers.warehouseId, warehouseId));
    }
    if (technicianId) {
      conditions.push(eq(warehouseTransfers.technicianId, technicianId));
    }
    if (regionId) {
      conditions.push(eq(warehouses.regionId, regionId));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    if (limit) {
      query = query.limit(limit) as any;
    }

    const transfers = await query;

    return transfers.map(transfer => ({
      ...transfer,
      // LEGACY COMPAT: the portal UI (built before the serial-scan documentation
      // workflow existed) has always treated 'accepted' as the single terminal
      // "done" status for a transfer, in dozens of call sites. We keep collapsing
      // the newer 'approved' DB status into 'accepted' here so none of that
      // existing portal behavior changes.
      //
      // ROOT FIX: this collapse made it IMPOSSIBLE for the fani-web technician
      // app (which needs to tell "accepted but still awaiting serial-scan
      // documentation" apart from "genuinely fully confirmed/approved") to ever
      // see a real 'approved' status from this list endpoint — every completed
      // transfer looked identical to a still-open one, so completed transfers
      // kept showing as "needs action". `rawStatus` exposes the true,
      // un-collapsed DB status for that purpose without touching the legacy
      // `status` field any existing consumer relies on.
      status: transfer.status === 'approved' ? 'accepted' : transfer.status,
      rawStatus: transfer.status,
      itemNameAr: itemNameMap[transfer.itemType] || transfer.itemType,
      warehouseName: transfer.warehouseName || undefined,
      technicianName: transfer.technicianName || undefined,
      performedByName: transfer.performedByName || undefined,
    }));
  }
}