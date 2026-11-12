import { db } from "@core/config/db";
import { 
  itemTypes,
  receivedDevices,
  users,
  type ItemType,
  type InsertItemType
} from "@shared/schema";
import { eq, and, sql, count, desc } from "drizzle-orm";

/**
 * Item Types Management Service
 * Handles item types and their configurations
 */
export class ItemTypesService {
  private itemTypeColumnExists: boolean | null = null;

  private getDemoSerialTrackingRows(itemTypeId: string) {
    if (itemTypeId !== "rollPaper") {
      return [] as Array<{
        id: string;
        itemTypeId: string;
        terminalId: string;
        serialNumber: string;
        status: "pending" | "approved" | "rejected";
        technicianId: string;
        technicianName: string;
        regionId: string | null;
        createdAt: Date;
      }>;
    }

    const now = Date.now();
    return [
      {
        id: "demo-rp-1",
        itemTypeId,
        terminalId: "RP-TM-1001",
        serialNumber: "RP-SN-900001",
        status: "pending" as const,
        technicianId: "demo-tech-1",
        technicianName: "أحمد محمد",
        regionId: "riyadh",
        createdAt: new Date(now - 1 * 60 * 60 * 1000),
      },
      {
        id: "demo-rp-2",
        itemTypeId,
        terminalId: "RP-TM-1002",
        serialNumber: "RP-SN-900002",
        status: "pending" as const,
        technicianId: "demo-tech-2",
        technicianName: "سعد عبدالله",
        regionId: "riyadh",
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
      },
      {
        id: "demo-rp-3",
        itemTypeId,
        terminalId: "RP-TM-1003",
        serialNumber: "RP-SN-900003",
        status: "approved" as const,
        technicianId: "demo-tech-3",
        technicianName: "خالد الدوسري",
        regionId: "qassim",
        createdAt: new Date(now - 3 * 60 * 60 * 1000),
      },
      {
        id: "demo-rp-4",
        itemTypeId,
        terminalId: "RP-TM-1004",
        serialNumber: "RP-SN-900004",
        status: "approved" as const,
        technicianId: "demo-tech-4",
        technicianName: "محمود القحطاني",
        regionId: "eastern",
        createdAt: new Date(now - 5 * 60 * 60 * 1000),
      },
      {
        id: "demo-rp-5",
        itemTypeId,
        terminalId: "RP-TM-1005",
        serialNumber: "RP-SN-900005",
        status: "rejected" as const,
        technicianId: "demo-tech-5",
        technicianName: "ناصر الحربي",
        regionId: "eastern",
        createdAt: new Date(now - 7 * 60 * 60 * 1000),
      },
      {
        id: "demo-rp-6",
        itemTypeId,
        terminalId: "RP-TM-1006",
        serialNumber: "RP-SN-900006",
        status: "pending" as const,
        technicianId: "demo-tech-6",
        technicianName: "ياسر العتيبي",
        regionId: "jeddah",
        createdAt: new Date(now - 9 * 60 * 60 * 1000),
      },
    ];
  }

  private filterDemoRows(
    rows: ReturnType<ItemTypesService["getDemoSerialTrackingRows"]>,
    options?: {
      status?: "pending" | "approved" | "rejected";
      regionId?: string;
    },
  ) {
    return rows.filter((row) => {
      if (options?.status && row.status !== options.status) {
        return false;
      }

      if (options?.regionId && row.regionId !== options.regionId) {
        return false;
      }

      return true;
    });
  }

  private async hasReceivedDeviceItemTypeColumn(): Promise<boolean> {
    if (this.itemTypeColumnExists !== null) {
      return this.itemTypeColumnExists;
    }

    const result = await db.execute(sql`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'received_devices'
        AND column_name = 'item_type_id'
      LIMIT 1
    `);

    const rows = (result as any).rows || [];
    this.itemTypeColumnExists = rows.length > 0;
    return this.itemTypeColumnExists;
  }

  private getLegacyTerminalPrefix(itemTypeId: string): string {
    return `IT-${String(itemTypeId || "").toUpperCase()}-`;
  }

  /**
   * Get serial tracking rows for a specific item type
   */
  async getSerialTrackingByItemType(
    itemTypeId: string,
    options?: {
      status?: "pending" | "approved" | "rejected";
      regionId?: string;
    },
  ) {
    const hasItemTypeColumn = await this.hasReceivedDeviceItemTypeColumn();
    if (!hasItemTypeColumn) {
      const legacyPrefix = `${this.getLegacyTerminalPrefix(itemTypeId)}%`;
      const legacyResult = await db.execute(sql`
        SELECT
          rd.id,
          NULL::varchar as "itemTypeId",
          rd.terminal_id as "terminalId",
          rd.serial_number as "serialNumber",
          rd.status,
          rd.technician_id as "technicianId",
          u.full_name as "technicianName",
          rd.region_id as "regionId",
          rd.created_at as "createdAt"
        FROM received_devices rd
        LEFT JOIN users u ON rd.technician_id = u.id
        WHERE rd.terminal_id LIKE ${legacyPrefix}
          AND (${options?.status ?? null}::text IS NULL OR rd.status = ${options?.status ?? null})
          AND (${options?.regionId ?? null}::varchar IS NULL OR rd.region_id = ${options?.regionId ?? null})
        ORDER BY rd.created_at DESC
      `);

      const legacyRows = (legacyResult as any).rows || [];
      if (legacyRows.length > 0) {
        return legacyRows;
      }

      const demoRows = this.getDemoSerialTrackingRows(itemTypeId);
      return this.filterDemoRows(demoRows, options);
    }

    const conditions = [eq(receivedDevices.itemTypeId, itemTypeId)];

    if (options?.status) {
      conditions.push(eq(receivedDevices.status, options.status));
    }

    if (options?.regionId) {
      conditions.push(eq(receivedDevices.regionId, options.regionId));
    }

    const rows = await db
      .select({
        id: receivedDevices.id,
        itemTypeId: receivedDevices.itemTypeId,
        terminalId: receivedDevices.terminalId,
        serialNumber: receivedDevices.serialNumber,
        status: receivedDevices.status,
        technicianId: receivedDevices.technicianId,
        technicianName: users.fullName,
        regionId: receivedDevices.regionId,
        createdAt: receivedDevices.createdAt,
      })
      .from(receivedDevices)
      .leftJoin(users, eq(receivedDevices.technicianId, users.id))
      .where(and(...conditions))
      .orderBy(desc(receivedDevices.createdAt));

    if (rows.length === 0 && process.env.NODE_ENV !== "production") {
      const demoRows = this.getDemoSerialTrackingRows(itemTypeId);
      return this.filterDemoRows(demoRows, options);
    }

    return rows;
  }

  /**
   * Get all item types
   */
  async getItemTypes(): Promise<ItemType[]> {
    return db
      .select()
      .from(itemTypes)
      .orderBy(itemTypes.sortOrder, itemTypes.nameAr);
  }

  /**
   * Get active item types only
   */
  async getActiveItemTypes(): Promise<ItemType[]> {
    return db
      .select()
      .from(itemTypes)
      .where(and(eq(itemTypes.isActive, true), eq(itemTypes.isVisible, true)))
      .orderBy(itemTypes.sortOrder, itemTypes.nameAr);
  }

  /**
   * Get single item type by ID
   */
  async getItemTypeById(id: string): Promise<ItemType | undefined> {
    const [itemType] = await db
      .select()
      .from(itemTypes)
      .where(eq(itemTypes.id, id))
      .limit(1);

    return itemType || undefined;
  }

  /**
   * Create new item type
   */
  async createItemType(data: InsertItemType): Promise<ItemType> {
    const [newItemType] = await db
      .insert(itemTypes)
      .values({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    if (!newItemType) {
      throw new Error("Failed to create item type");
    }

    return newItemType;
  }

  /**
   * Update item type
   */
  async updateItemType(id: string, updates: Partial<InsertItemType>): Promise<ItemType> {
    const [updatedItemType] = await db
      .update(itemTypes)
      .set({ 
        ...updates, 
        updatedAt: new Date() 
      })
      .where(eq(itemTypes.id, id))
      .returning();

    if (!updatedItemType) {
      throw new Error("Item type not found");
    }

    return updatedItemType;
  }

  /**
   * Delete item type (soft delete by setting isActive to false)
   */
  async deleteItemType(id: string): Promise<ItemType> {
    return this.updateItemType(id, { isActive: false });
  }

  /**
   * Toggle item type visibility
   */
  async toggleItemTypeVisibility(id: string): Promise<ItemType> {
    const itemType = await this.getItemTypeById(id);
    if (!itemType) {
      throw new Error("Item type not found");
    }

    return this.updateItemType(id, { isVisible: !itemType.isVisible });
  }

  /**
   * Toggle item type active status
   */
  async toggleItemTypeStatus(id: string): Promise<ItemType> {
    const itemType = await this.getItemTypeById(id);
    if (!itemType) {
      throw new Error("Item type not found");
    }

    return this.updateItemType(id, { isActive: !itemType.isActive });
  }

  /**
   * Get item types by category
   */
  async getItemTypesByCategory(category: string): Promise<ItemType[]> {
    return db
      .select()
      .from(itemTypes)
      .where(and(eq(itemTypes.category, category), eq(itemTypes.isActive, true)))
      .orderBy(itemTypes.sortOrder, itemTypes.nameAr);
  }

  /**
   * Reorder item types
   */
  async reorderItemTypes(reorderedItems: { id: string; sortOrder: number }[]): Promise<void> {
    const updates = reorderedItems.map(item => 
      db.update(itemTypes)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(eq(itemTypes.id, item.id))
    );

    await Promise.all(updates);
  }

  /**
   * Search item types
   */
  async searchItemTypes(query: string): Promise<ItemType[]> {
    return db
      .select()
      .from(itemTypes)
      .where(
        and(
          eq(itemTypes.isActive, true),
          sql`(${itemTypes.nameAr} ILIKE ${`%${query}%`} OR ${itemTypes.nameEn} ILIKE ${`%${query}%`})`
        )
      )
      .orderBy(itemTypes.sortOrder, itemTypes.nameAr);
  }

  /**
   * Seed default item types
   */
  async seedDefaultItemTypes(): Promise<void> {
    const defaultItemTypes = [
      {
        id: 'n950',
        nameAr: 'N950',
        nameEn: 'N950',
        category: 'devices' as const,
        unitsPerBox: 1,
        isActive: true,
        isVisible: true,
        sortOrder: 1,
        icon: '📱',
        color: '#3B82F6',
        requiresSerial: true,
        serialPrefix: 'NCC,NCD',
        serialLength: 9,
        serialRegex: '^(NCC|NCD)[0-9]{9}$'
      },
      {
        id: 'i9000s',
        nameAr: 'I9000S',
        nameEn: 'I9000S',
        category: 'devices' as const,
        unitsPerBox: 1,
        isActive: true,
        isVisible: true,
        sortOrder: 2,
        icon: '📱',
        color: '#10B981',
        requiresSerial: true,
        serialPrefix: 'SAS',
        serialLength: 14,
        serialRegex: '^SAS[0-9]{11}$'
      },
      {
        id: 'i9100',
        nameAr: 'I9100',
        nameEn: 'I9100',
        category: 'devices' as const,
        unitsPerBox: 1,
        isActive: true,
        isVisible: true,
        sortOrder: 3,
        icon: '📱',
        color: '#8B5CF6',
        requiresSerial: true,
        serialPrefix: 'SAW',
        serialLength: 14,
        serialRegex: '^SAW[0-9]{11}$'
      },
      {
        id: 'a960',
        nameAr: 'A960',
        nameEn: 'PAX A960',
        category: 'devices' as const,
        unitsPerBox: 1,
        isActive: true,
        isVisible: true,
        sortOrder: 4,
        icon: '📱',
        color: '#6366F1',
        requiresSerial: true,
        serialPrefix: null,
        serialLength: 10,
        serialRegex: '^[0-9]{10}$'
      },
      {
        id: 'rollPaper',
        nameAr: 'ورق الطباعة',
        nameEn: 'rollPaper',
        category: 'papers' as const,
        unitsPerBox: 50,
        isActive: true,
        isVisible: true,
        sortOrder: 4,
        icon: '📄',
        color: '#F59E0B',
        requiresSerial: false,
        serialPrefix: null,
        serialLength: null,
        serialRegex: null
      },
      {
        id: 'stickers',
        nameAr: 'الملصقات',
        nameEn: 'stickers',
        category: 'papers' as const,
        unitsPerBox: 100,
        isActive: true,
        isVisible: true,
        sortOrder: 5,
        icon: '🏷️',
        color: '#EF4444',
        requiresSerial: false,
        serialPrefix: null,
        serialLength: null,
        serialRegex: null
      },
      {
        id: 'newBatteries',
        nameAr: 'البطاريات الجديدة',
        nameEn: 'newBatteries',
        category: 'accessories' as const,
        unitsPerBox: 10,
        isActive: true,
        isVisible: true,
        sortOrder: 6,
        icon: '🔋',
        color: '#06B6D4',
        requiresSerial: false,
        serialPrefix: null,
        serialLength: null,
        serialRegex: null
      },
      {
        id: 'mobilySim',
        nameAr: 'شرائح موبايلي',
        nameEn: 'mobilySim',
        category: 'sim' as const,
        unitsPerBox: 20,
        isActive: true,
        isVisible: true,
        sortOrder: 7,
        icon: '📲',
        color: '#84CC16',
        requiresSerial: true,
        serialPrefix: '89966',
        serialLength: 19,
        serialRegex: '^89966[0-9]{14}$'
      },
      {
        id: 'stcSim',
        nameAr: 'شرائح STC',
        nameEn: 'stcSim',
        category: 'sim' as const,
        unitsPerBox: 20,
        isActive: true,
        isVisible: true,
        sortOrder: 8,
        icon: '📲',
        color: '#F97316',
        requiresSerial: true,
        serialPrefix: '89966',
        serialLength: 18,
        serialRegex: '^89966[0-9]{13}$'
      },
      {
        id: 'zainSim',
        nameAr: 'شرائح زين',
        nameEn: 'zainSim',
        category: 'sim' as const,
        unitsPerBox: 20,
        isActive: true,
        isVisible: true,
        sortOrder: 9,
        icon: '📲',
        color: '#EC4899',
        requiresSerial: true,
        serialPrefix: '89966',
        serialLength: 19,
        serialRegex: '^89966[0-9]{14}$'
      },
      {
        id: 'lebaraSim',
        nameAr: 'شرائح ليبارا',
        nameEn: 'lebaraSim',
        category: 'sim' as const,
        unitsPerBox: 20,
        isActive: true,
        isVisible: true,
        sortOrder: 10,
        icon: '📲',
        color: '#E02424',
        requiresSerial: true,
        serialPrefix: '89966',
        serialLength: 19,
        serialRegex: '^89966[0-9]{14}$'
      }
    ];

    for (const itemType of defaultItemTypes) {
      // Check if item type already exists
      const existing = await this.getItemTypeById(itemType.id);
      if (!existing) {
        await this.createItemType(itemType);
      } else {
        // Update existing record to match seed properties (e.g. nameAr/nameEn)
        await this.updateItemType(itemType.id, {
          nameAr: itemType.nameAr,
          nameEn: itemType.nameEn,
          category: itemType.category,
          unitsPerBox: itemType.unitsPerBox,
          isActive: itemType.isActive,
          isVisible: itemType.isVisible,
          sortOrder: itemType.sortOrder,
          icon: itemType.icon,
          color: itemType.color,
          requiresSerial: itemType.requiresSerial,
          serialPrefix: itemType.serialPrefix,
          serialLength: itemType.serialLength,
          serialRegex: itemType.serialRegex,
        });
      }
    }
  }

  /**
   * Get item type statistics
   */
  async getItemTypeStatistics() {
    const [stats] = await db
      .select({
        totalItemTypes: sql<number>`COUNT(*)`,
        activeItemTypes: sql<number>`COUNT(CASE WHEN ${itemTypes.isActive} = true THEN 1 END)`,
        visibleItemTypes: sql<number>`COUNT(CASE WHEN ${itemTypes.isVisible} = true THEN 1 END)`,
        deviceTypes: sql<number>`COUNT(CASE WHEN ${itemTypes.category} = 'devices' THEN 1 END)`,
        paperTypes: sql<number>`COUNT(CASE WHEN ${itemTypes.category} = 'papers' THEN 1 END)`,
        simTypes: sql<number>`COUNT(CASE WHEN ${itemTypes.category} = 'sim' THEN 1 END)`,
        accessoryTypes: sql<number>`COUNT(CASE WHEN ${itemTypes.category} = 'accessories' THEN 1 END)`
      })
      .from(itemTypes);

    return stats;
  }

  /**
   * Bulk update item types
   */
  async bulkUpdateItemTypes(updates: { id: string; updates: Partial<InsertItemType> }[]): Promise<void> {
    const updatePromises = updates.map(({ id, updates: itemUpdates }) =>
      this.updateItemType(id, itemUpdates)
    );

    await Promise.all(updatePromises);
  }

  /**
   * Get item types with pagination
   */
  async getItemTypesWithPagination(
    page: number = 1, 
    pageSize: number = 10,
    filters?: {
      category?: string;
      isActive?: boolean;
      isVisible?: boolean;
    }
  ) {
    const offset = (page - 1) * pageSize;
    const conditions = [];

    if (filters?.category) {
      conditions.push(eq(itemTypes.category, filters.category));
    }
    if (filters?.isActive !== undefined) {
      conditions.push(eq(itemTypes.isActive, filters.isActive));
    }
    if (filters?.isVisible !== undefined) {
      conditions.push(eq(itemTypes.isVisible, filters.isVisible));
    }

    let query = db.select().from(itemTypes).$dynamic();
    let countQuery = db.select({ count: count() }).from(itemTypes).$dynamic();

    if (conditions.length > 0) {
      const whereClause = and(...conditions);
      query = query.where(whereClause);
      countQuery = countQuery.where(whereClause);
    }

    const [totalCount] = await countQuery;
    const itemTypesData = await query
      .orderBy(itemTypes.sortOrder, itemTypes.nameAr)
      .limit(pageSize)
      .offset(offset);

    return {
      data: itemTypesData,
      pagination: {
        page,
        pageSize,
        total: totalCount.count,
        totalPages: Math.ceil(totalCount.count / pageSize)
      }
    };
  }
}

export const itemTypesService = new ItemTypesService();