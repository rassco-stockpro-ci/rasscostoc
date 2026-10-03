import { type InventoryItem, type InsertInventoryItem, type Transaction, type InsertTransaction, type InventoryItemWithStatus, type DashboardStats, type Region, type InsertRegion, type User, type InsertUser, type UserSafe, type RegionWithStats, type AdminStats, type TransactionWithDetails, type WithdrawnDevice, type InsertWithdrawnDevice, type ReceivedDevice, type InsertReceivedDevice, type TechnicianFixedInventory, type InsertTechnicianFixedInventory, type StockMovement, type InsertStockMovement, type TechnicianWithFixedInventory, type FixedInventorySummary, type StockMovementWithDetails, type Warehouse, type WarehouseInventory, type WarehouseTransfer, type InsertWarehouse, type InsertWarehouseInventory, type InsertWarehouseTransfer, type WarehouseWithStats, type WarehouseWithInventory, type WarehouseTransferWithDetails, type SupervisorTechnician, type SupervisorWarehouse, type SystemLog, type InsertSystemLog, type ItemType, type InsertItemType, type WarehouseInventoryEntry, type InsertWarehouseInventoryEntry, type TechnicianFixedInventoryEntry, type InsertTechnicianFixedInventoryEntry, type TechnicianMovingInventoryEntry, type InsertTechnicianMovingInventoryEntry } from "@shared/schema";
import { randomUUID } from "crypto";
import type { IStorage } from "../interfaces/IStorage";

export class MemStorage implements IStorage {
  private inventoryItems: Map<string, InventoryItem>;
  private transactions: Map<string, Transaction>;
  private regions: Map<string, Region>;
  private users: Map<string, User>;
  private withdrawnDevices: Map<string, WithdrawnDevice>;
  private receivedDevices: Map<string, ReceivedDevice>;
  private technicianFixedInventories: Map<string, TechnicianFixedInventory>;
  private stockMovements: Map<string, StockMovement>;
  private technicians: Map<string, any>;

  constructor() {
    this.inventoryItems = new Map();
    this.transactions = new Map();
    this.regions = new Map();
    this.users = new Map();
    this.withdrawnDevices = new Map();
    this.receivedDevices = new Map();
    this.technicianFixedInventories = new Map();
    this.stockMovements = new Map();
    this.technicians = new Map();
    
    this.initializeDefaults();
  }
  
  private async initializeDefaults() {
    const defaultRegion: Region = {
      id: randomUUID(),
      name: "المنطقة الرئيسية",
      description: "المنطقة الافتراضية للنظام",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.regions.set(defaultRegion.id, defaultRegion);
    
    // ERP-008 P1.1: MemStorage must not seed admin/admin123 (or any default credentials).
    // Tests and local in-memory mode create users explicitly when needed.
  }

  private getItemStatus(item: InventoryItem): 'available' | 'low' | 'out' {
    if (item.quantity === 0) return 'out';
    if (item.quantity <= item.minThreshold) return 'low';
    return 'available';
  }

  async getInventoryItems(): Promise<InventoryItemWithStatus[]> {
    return Array.from(this.inventoryItems.values()).map(item => {
      const region = item.regionId ? this.regions.get(item.regionId) : null;
      return {
        ...item,
        status: this.getItemStatus(item),
        regionName: region?.name || "غير محدد"
      };
    });
  }

  async getInventoryItem(id: string): Promise<InventoryItem | undefined> {
    return this.inventoryItems.get(id);
  }

  async createInventoryItem(insertItem: InsertInventoryItem): Promise<InventoryItem> {
    const id = randomUUID();
    let regionId = insertItem.regionId;
    if (!regionId) {
      const firstRegion = Array.from(this.regions.values())[0];
      regionId = firstRegion?.id || null;
    }
    
    const item: InventoryItem = {
      id,
      name: insertItem.name,
      type: insertItem.type,
      unit: insertItem.unit,
      quantity: insertItem.quantity ?? 0,
      minThreshold: insertItem.minThreshold ?? 5,
      technicianName: insertItem.technicianName ?? null,
      city: insertItem.city ?? null,
      regionId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.inventoryItems.set(id, item);
    return item;
  }

  async updateInventoryItem(id: string, updates: Partial<InsertInventoryItem>): Promise<InventoryItem> {
    const existingItem = this.inventoryItems.get(id);
    if (!existingItem) {
      throw new Error(`Item with id ${id} not found`);
    }
    
    const updatedItem: InventoryItem = {
      ...existingItem,
      ...updates,
      updatedAt: new Date(),
    };
    this.inventoryItems.set(id, updatedItem);
    return updatedItem;
  }

  async deleteInventoryItem(id: string): Promise<boolean> {
    return this.inventoryItems.delete(id);
  }

  async getTransactions(filters?: {
    page?: number;
    limit?: number;
    type?: string;
    userId?: string;
    regionId?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
  }): Promise<{
    transactions: TransactionWithDetails[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const page = filters?.page || 1;
    const limit = filters?.limit || 10;

    let allTransactions = Array.from(this.transactions.values())
      .map(transaction => {
        const item = this.inventoryItems.get(transaction.itemId);
        const user = transaction.userId ? this.users.get(transaction.userId) : null;
        const region = item?.regionId ? this.regions.get(item.regionId) : null;
        
        return {
          ...transaction,
          itemName: item?.name || "صنف محذوف",
          userName: user?.fullName || "غير محدد",
          regionName: region?.name || "غير محدد"
        };
      })
      .sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime());

    if (filters?.type) {
      allTransactions = allTransactions.filter(t => t.type === filters.type);
    }
    if (filters?.userId) {
      allTransactions = allTransactions.filter(t => t.userId === filters.userId);
    }
    if (filters?.regionId) {
      allTransactions = allTransactions.filter(t => {
        const item = this.inventoryItems.get(t.itemId);
        return item?.regionId === filters.regionId;
      });
    }
    if (filters?.startDate) {
      const startDate = new Date(filters.startDate);
      allTransactions = allTransactions.filter(t => t.createdAt && new Date(t.createdAt) >= startDate);
    }
    if (filters?.endDate) {
      const endDate = new Date(filters.endDate);
      allTransactions = allTransactions.filter(t => t.createdAt && new Date(t.createdAt) <= endDate);
    }
    if (filters?.search) {
      const searchLower = filters.search.toLowerCase();
      allTransactions = allTransactions.filter(t => 
        t.itemName?.toLowerCase().includes(searchLower) ||
        t.userName?.toLowerCase().includes(searchLower) ||
        t.reason?.toLowerCase().includes(searchLower)
      );
    }

    const total = allTransactions.length;
    const offset = (page - 1) * limit;
    const transactions = allTransactions.slice(offset, offset + limit);

    return {
      transactions,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async createTransaction(insertTransaction: InsertTransaction): Promise<Transaction> {
    const id = randomUUID();
    const transaction: Transaction = {
      id,
      itemId: insertTransaction.itemId,
      userId: insertTransaction.userId ?? null,
      type: insertTransaction.type,
      quantity: insertTransaction.quantity,
      reason: insertTransaction.reason ?? null,
      createdAt: new Date(),
    };
    this.transactions.set(id, transaction);
    return transaction;
  }

  async getRecentTransactions(limit: number = 10): Promise<TransactionWithDetails[]> {
    const result = await this.getTransactions({ limit });
    return result.transactions;
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const items = Array.from(this.inventoryItems.values());
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayTransactions = Array.from(this.transactions.values()).filter(
      t => new Date(t.createdAt!).getTime() >= today.getTime()
    );

    return {
      totalItems: items.length,
      lowStockItems: items.filter(item => item.quantity > 0 && item.quantity <= item.minThreshold).length,
      outOfStockItems: items.filter(item => item.quantity === 0).length,
      todayTransactions: todayTransactions.length,
    };
  }

  async addStock(itemId: string, quantity: number, reason?: string, userId?: string): Promise<InventoryItem> {
    const item = this.inventoryItems.get(itemId);
    if (!item) {
      throw new Error(`Item with id ${itemId} not found`);
    }

    const updatedItem = await this.updateInventoryItem(itemId, {
      quantity: item.quantity + quantity,
    });

    await this.createTransaction({
      itemId,
      userId: userId || null,
      type: "add",
      quantity,
      reason,
    });

    return updatedItem;
  }

  async withdrawStock(itemId: string, quantity: number, reason?: string, userId?: string): Promise<InventoryItem> {
    const item = this.inventoryItems.get(itemId);
    if (!item) {
      throw new Error(`Item with id ${itemId} not found`);
    }

    if (item.quantity < quantity) {
      throw new Error(`Insufficient stock. Available: ${item.quantity}, Requested: ${quantity}`);
    }

    const updatedItem = await this.updateInventoryItem(itemId, {
      quantity: item.quantity - quantity,
    });

    await this.createTransaction({
      itemId,
      userId: userId || null,
      type: "withdraw",
      quantity,
      reason,
    });

    return updatedItem;
  }

  async getRegions(): Promise<RegionWithStats[]> {
    return Array.from(this.regions.values()).map(region => {
      const regionItems = Array.from(this.inventoryItems.values())
        .filter(item => item.regionId === region.id);
      
      return {
        ...region,
        itemCount: regionItems.length,
        totalQuantity: regionItems.reduce((sum, item) => sum + item.quantity, 0),
        lowStockCount: regionItems.filter(item => this.getItemStatus(item) === 'low' || this.getItemStatus(item) === 'out').length
      };
    });
  }

  async getRegion(id: string): Promise<Region | undefined> {
    return this.regions.get(id);
  }

  async createRegion(insertRegion: InsertRegion): Promise<Region> {
    const id = randomUUID();
    const region: Region = {
      ...insertRegion,
      id,
      description: insertRegion.description || null,
      isActive: insertRegion.isActive ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.regions.set(id, region);
    return region;
  }

  async updateRegion(id: string, updates: Partial<InsertRegion>): Promise<Region> {
    const existingRegion = this.regions.get(id);
    if (!existingRegion) {
      throw new Error(`Region with id ${id} not found`);
    }
    
    const updatedRegion: Region = {
      ...existingRegion,
      ...updates,
      updatedAt: new Date(),
    };
    this.regions.set(id, updatedRegion);
    return updatedRegion;
  }

  async deleteRegion(id: string): Promise<boolean> {
    const hasItems = Array.from(this.inventoryItems.values())
      .some(item => item.regionId === id);
    
    if (hasItems) {
      throw new Error("Cannot delete region that contains inventory items");
    }
    
    return this.regions.delete(id);
  }

  async getUsers(): Promise<UserSafe[]> {
    return Array.from(this.users.values()).map(user => {
      const { password, ...userSafe } = user;
      return userSafe;
    });
  }

  async getUser(id: string): Promise<UserSafe | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    const { password, ...userSafe } = user;
    return userSafe;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(user => user.username === username);
  }

  async createUser(insertUser: InsertUser): Promise<UserSafe> {
    const existingUserByUsername = Array.from(this.users.values())
      .find(user => user.username === insertUser.username);
    if (existingUserByUsername) {
      throw new Error("Username already exists");
    }
    
    const existingUserByEmail = Array.from(this.users.values())
      .find(user => user.email === insertUser.email);
    if (existingUserByEmail) {
      throw new Error("Email already exists");
    }
    
    const id = randomUUID();
    const user: User = {
      id,
      username: insertUser.username,
      email: insertUser.email,
      password: insertUser.password,
      fullName: insertUser.fullName,
      profileImage: insertUser.profileImage ?? null,
      city: insertUser.city ?? null,
      role: insertUser.role ?? "employee",
      regionId: insertUser.regionId ?? null,
      employeeCode: insertUser.employeeCode ?? null,
      technicianCode: insertUser.technicianCode ?? null,
      department: insertUser.department ?? null,
      permissions: insertUser.permissions ?? null,
      isActive: insertUser.isActive ?? true,
      fcmToken: insertUser.fcmToken ?? null,
      telegramUserId: insertUser.telegramUserId ?? null,
      telegramUsername: null,
      telegramLinkedAt: null,
      // OPS-PERM-S0-B1-C.I2A.I0.C1.E2: new in-memory user, so it starts at
      // generation 0 (same convention as the real DB default for new rows).
      authGeneration: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.set(id, user);
    
    const { password, ...userSafe } = user;
    return userSafe;
  }

  async updateUser(id: string, updates: Partial<InsertUser>): Promise<UserSafe> {
    const existingUser = this.users.get(id);
    if (!existingUser) {
      throw new Error(`User with id ${id} not found`);
    }
    
    if (updates.username && updates.username !== existingUser.username) {
      const existingUserByUsername = Array.from(this.users.values())
        .find(user => user.username === updates.username && user.id !== id);
      if (existingUserByUsername) {
        throw new Error("Username already exists");
      }
    }
    
    if (updates.email && updates.email !== existingUser.email) {
      const existingUserByEmail = Array.from(this.users.values())
        .find(user => user.email === updates.email && user.id !== id);
      if (existingUserByEmail) {
        throw new Error("Email already exists");
      }
    }
    
    const updatedUser: User = {
      ...existingUser,
      ...updates,
      updatedAt: new Date(),
    };
    this.users.set(id, updatedUser);
    
    const { password, ...userSafe } = updatedUser;
    return userSafe;
  }

  async deleteUser(id: string): Promise<boolean> {
    return this.users.delete(id);
  }

  async getAdminStats(): Promise<AdminStats> {
    const { transactions } = await this.getTransactions();
    
    return {
      totalRegions: this.regions.size,
      totalUsers: this.users.size,
      activeUsers: Array.from(this.users.values()).filter(user => user.isActive).length,
      totalTransactions: transactions.length,
      recentTransactions: transactions.slice(0, 10)
    };
  }

  async getWithdrawnDevices(): Promise<WithdrawnDevice[]> {
    return Array.from(this.withdrawnDevices.values());
  }

  async getWithdrawnDevice(id: string): Promise<WithdrawnDevice | undefined> {
    return this.withdrawnDevices.get(id);
  }

  async createWithdrawnDevice(insertDevice: InsertWithdrawnDevice): Promise<WithdrawnDevice> {
    const id = randomUUID();
    const device: WithdrawnDevice = {
      id,
      city: insertDevice.city,
      technicianName: insertDevice.technicianName,
      terminalId: insertDevice.terminalId,
      serialNumber: insertDevice.serialNumber,
      battery: insertDevice.battery,
      chargerCable: insertDevice.chargerCable,
      chargerHead: insertDevice.chargerHead,
      hasSim: insertDevice.hasSim,
      simCardType: insertDevice.simCardType ?? null,
      damagePart: insertDevice.damagePart ?? null,
      notes: insertDevice.notes ?? null,
      createdBy: insertDevice.createdBy ?? null,
      regionId: insertDevice.regionId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.withdrawnDevices.set(id, device);
    return device;
  }

  async updateWithdrawnDevice(id: string, updates: Partial<InsertWithdrawnDevice>): Promise<WithdrawnDevice> {
    const existingDevice = this.withdrawnDevices.get(id);
    if (!existingDevice) {
      throw new Error(`Withdrawn device with id ${id} not found`);
    }
    
    const updatedDevice: WithdrawnDevice = {
      ...existingDevice,
      ...updates,
      updatedAt: new Date(),
    };
    this.withdrawnDevices.set(id, updatedDevice);
    return updatedDevice;
  }

  async deleteWithdrawnDevice(id: string): Promise<boolean> {
    return this.withdrawnDevices.delete(id);
  }

  async getReceivedDevices(filters?: { status?: string; technicianId?: string; supervisorId?: string; regionId?: string }): Promise<ReceivedDevice[]> {
    let devices = Array.from(this.receivedDevices.values());
    
    if (filters?.status) {
      devices = devices.filter(d => d.status === filters.status);
    }
    if (filters?.technicianId) {
      devices = devices.filter(d => d.technicianId === filters.technicianId);
    }
    if (filters?.supervisorId) {
      devices = devices.filter(d => d.supervisorId === filters.supervisorId);
    }
    if (filters?.regionId) {
      devices = devices.filter(d => d.regionId === filters.regionId);
    }
    
    return devices;
  }

  async getReceivedDevice(id: string): Promise<ReceivedDevice | undefined> {
    return this.receivedDevices.get(id);
  }

  async createReceivedDevice(insertDevice: InsertReceivedDevice): Promise<ReceivedDevice> {
    const existingPending = Array.from(this.receivedDevices.values()).find(
      d => d.serialNumber === insertDevice.serialNumber && d.status === 'pending'
    );
    if (existingPending) {
      throw new Error("هذا الرقم التسلسلي بانتظار المراجعة بالفعل في الإشعارات ولا يمكن تكراره");
    }

    const id = randomUUID();
    const device: ReceivedDevice = {
      id,
      technicianId: insertDevice.technicianId,
      supervisorId: insertDevice.supervisorId ?? null,
      itemTypeId: insertDevice.itemTypeId ?? null,
      terminalId: insertDevice.terminalId ?? null,
      serialNumber: insertDevice.serialNumber,
      battery: insertDevice.battery ?? false,
      chargerCable: insertDevice.chargerCable ?? false,
      chargerHead: insertDevice.chargerHead ?? false,
      hasSim: insertDevice.hasSim ?? false,
      simCardType: insertDevice.simCardType ?? null,
      damagePart: insertDevice.damagePart ?? "",
      status: 'pending',
      inventoryType: insertDevice.inventoryType ?? "fixed",
      adminNotes: null,
      approvedBy: null,
      approvedAt: null,
      regionId: insertDevice.regionId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.receivedDevices.set(id, device);
    return device;
  }

  async updateReceivedDeviceStatus(id: string, status: string, respondedBy: string, adminNotes?: string): Promise<ReceivedDevice> {
    const existingDevice = this.receivedDevices.get(id);
    if (!existingDevice) {
      throw new Error(`Received device with id ${id} not found`);
    }
    
    const updatedDevice: ReceivedDevice = {
      ...existingDevice,
      status,
      approvedBy: respondedBy,
      adminNotes: adminNotes ?? null,
      approvedAt: new Date(),
      updatedAt: new Date(),
    };
    this.receivedDevices.set(id, updatedDevice);
    return updatedDevice;
  }

  async deleteReceivedDevice(id: string): Promise<boolean> {
    return this.receivedDevices.delete(id);
  }

  async getPendingReceivedDevicesCount(supervisorId?: string, regionId?: string | null): Promise<number> {
    let devices = Array.from(this.receivedDevices.values()).filter(d => d.status === 'pending');
    
    if (supervisorId) {
      devices = devices.filter(d => d.supervisorId === supervisorId);
    }

    if (regionId) {
      devices = devices.filter(d => d.regionId === regionId);
    }
    
    return devices.length;
  }

  async getTechnicianFixedInventory(technicianId: string): Promise<TechnicianFixedInventory | undefined> {
    return Array.from(this.technicianFixedInventories.values())
      .find(inv => inv.technicianId === technicianId);
  }

  async createTechnicianFixedInventory(insertInventory: InsertTechnicianFixedInventory): Promise<TechnicianFixedInventory> {
    const id = randomUUID();
    const inventory: TechnicianFixedInventory = {
      id,
      technicianId: insertInventory.technicianId,
      n950Boxes: insertInventory.n950Boxes ?? 0,
      n950Units: insertInventory.n950Units ?? 0,
      i9000sBoxes: insertInventory.i9000sBoxes ?? 0,
      i9000sUnits: insertInventory.i9000sUnits ?? 0,
      i9100Boxes: insertInventory.i9100Boxes ?? 0,
      i9100Units: insertInventory.i9100Units ?? 0,
      rollPaperBoxes: insertInventory.rollPaperBoxes ?? 0,
      rollPaperUnits: insertInventory.rollPaperUnits ?? 0,
      stickersBoxes: insertInventory.stickersBoxes ?? 0,
      stickersUnits: insertInventory.stickersUnits ?? 0,
      newBatteriesBoxes: insertInventory.newBatteriesBoxes ?? 0,
      newBatteriesUnits: insertInventory.newBatteriesUnits ?? 0,
      mobilySimBoxes: insertInventory.mobilySimBoxes ?? 0,
      mobilySimUnits: insertInventory.mobilySimUnits ?? 0,
      stcSimBoxes: insertInventory.stcSimBoxes ?? 0,
      stcSimUnits: insertInventory.stcSimUnits ?? 0,
      zainSimBoxes: insertInventory.zainSimBoxes ?? 0,
      zainSimUnits: insertInventory.zainSimUnits ?? 0,
      lebaraBoxes: insertInventory.lebaraBoxes ?? 0,
      lebaraUnits: insertInventory.lebaraUnits ?? 0,
      lowStockThreshold: insertInventory.lowStockThreshold ?? 30,
      criticalStockThreshold: insertInventory.criticalStockThreshold ?? 70,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.technicianFixedInventories.set(id, inventory);
    return inventory;
  }

  async updateTechnicianFixedInventory(technicianId: string, updates: Partial<InsertTechnicianFixedInventory>): Promise<TechnicianFixedInventory> {
    const existingInventory = Array.from(this.technicianFixedInventories.values())
      .find(inv => inv.technicianId === technicianId);
    
    if (!existingInventory) {
      throw new Error(`Technician fixed inventory for technician ${technicianId} not found`);
    }
    
    const updatedInventory: TechnicianFixedInventory = {
      ...existingInventory,
      ...updates,
      updatedAt: new Date(),
    };
    this.technicianFixedInventories.set(existingInventory.id, updatedInventory);
    return updatedInventory;
  }

  async deleteTechnicianFixedInventory(technicianId: string): Promise<void> {
    const existingInventory = Array.from(this.technicianFixedInventories.values())
      .find(inv => inv.technicianId === technicianId);
    
    if (existingInventory) {
      this.technicianFixedInventories.delete(existingInventory.id);
    }
  }

  async getAllTechniciansWithFixedInventory(): Promise<TechnicianWithFixedInventory[]> {
    const technicians = Array.from(this.users.values())
      .filter(user => user.role === 'technician' || user.role === 'employee');
    
    return technicians.map(tech => {
      const fixedInventory = Array.from(this.technicianFixedInventories.values())
        .find(inv => inv.technicianId === tech.id);
      
      return {
        technicianId: tech.id,
        technicianName: tech.fullName,
        city: tech.city || "غير محدد",
        fixedInventory: fixedInventory || null,
        alertLevel: 'good' as const,
      };
    });
  }

  async getFixedInventorySummary(): Promise<FixedInventorySummary> {
    const allInventories = Array.from(this.technicianFixedInventories.values());
    
    return {
      totalN950: allInventories.reduce((sum, inv) => sum + inv.n950Boxes + inv.n950Units, 0),
      totalI9000s: allInventories.reduce((sum, inv) => sum + inv.i9000sBoxes + inv.i9000sUnits, 0),
      totalI9100: allInventories.reduce((sum, inv) => sum + inv.i9100Boxes + inv.i9100Units, 0),
      totalRollPaper: allInventories.reduce((sum, inv) => sum + inv.rollPaperBoxes + inv.rollPaperUnits, 0),
      totalStickers: allInventories.reduce((sum, inv) => sum + inv.stickersBoxes + inv.stickersUnits, 0),
      totalNewBatteries: allInventories.reduce((sum, inv) => sum + inv.newBatteriesBoxes + inv.newBatteriesUnits, 0),
      totalMobilySim: allInventories.reduce((sum, inv) => sum + inv.mobilySimBoxes + inv.mobilySimUnits, 0),
      totalStcSim: allInventories.reduce((sum, inv) => sum + inv.stcSimBoxes + inv.stcSimUnits, 0),
      totalZainSim: allInventories.reduce((sum, inv) => sum + inv.zainSimBoxes + inv.zainSimUnits, 0),
      totalLebaraSim: allInventories.reduce((sum, inv) => sum + inv.lebaraBoxes + inv.lebaraUnits, 0),
      techniciansWithCriticalStock: 0,
      techniciansWithWarningStock: 0,
      techniciansWithGoodStock: allInventories.length,
    };
  }

  async getAllTechniciansWithBothInventories(): Promise<any[]> {
    const technicians = Array.from(this.users.values())
      .filter(user => user.role === 'technician' || user.role === 'employee');
    
    return technicians.map(tech => {
      const fixedInventory = Array.from(this.technicianFixedInventories.values())
        .find(inv => inv.technicianId === tech.id);
      const movingInventory = this.technicians.get(tech.id);
      
      let alertLevel: 'good' | 'warning' | 'critical' = 'good';
      
      if (fixedInventory) {
        const totalItems = 
          fixedInventory.n950Boxes + fixedInventory.n950Units +
          fixedInventory.i9000sBoxes + fixedInventory.i9000sUnits +
          fixedInventory.i9100Boxes + fixedInventory.i9100Units +
          fixedInventory.rollPaperBoxes + fixedInventory.rollPaperUnits +
          fixedInventory.stickersBoxes + fixedInventory.stickersUnits +
          fixedInventory.newBatteriesBoxes + fixedInventory.newBatteriesUnits +
          fixedInventory.mobilySimBoxes + fixedInventory.mobilySimUnits +
          fixedInventory.stcSimBoxes + fixedInventory.stcSimUnits +
          fixedInventory.zainSimBoxes + fixedInventory.zainSimUnits;
        
        const threshold = fixedInventory.criticalStockThreshold || 70;
        const lowThreshold = fixedInventory.lowStockThreshold || 30;
        
        if (totalItems === 0 || totalItems < lowThreshold) {
          alertLevel = 'critical';
        } else if (totalItems < threshold) {
          alertLevel = 'warning';
        }
      }
      
      return {
        technicianId: tech.id,
        technicianName: tech.fullName,
        city: tech.city || "غير محدد",
        regionId: tech.regionId,
        fixedInventory: fixedInventory || null,
        movingInventory: movingInventory || null,
        alertLevel,
      };
    });
  }

  async getRegionTechniciansWithInventories(regionId: string): Promise<any[]> {
    const allTechnicians = await this.getAllTechniciansWithBothInventories();
    return allTechnicians.filter(tech => tech.regionId === regionId);
  }

  async createStockMovement(insertMovement: InsertStockMovement): Promise<StockMovement> {
    const id = randomUUID();
    const movement: StockMovement = {
      id,
      technicianId: insertMovement.technicianId,
      itemType: insertMovement.itemType,
      packagingType: insertMovement.packagingType,
      quantity: insertMovement.quantity,
      fromInventory: insertMovement.fromInventory,
      toInventory: insertMovement.toInventory,
      reason: insertMovement.reason ?? null,
      performedBy: insertMovement.performedBy,
      notes: insertMovement.notes ?? null,
      createdAt: new Date(),
    };
    this.stockMovements.set(id, movement);
    return movement;
  }

  async getStockMovements(technicianId?: string, limit?: number): Promise<StockMovementWithDetails[]> {
    let movements = Array.from(this.stockMovements.values());
    
    if (technicianId) {
      movements = movements.filter(m => m.technicianId === technicianId);
    }
    
    movements.sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime());
    
    if (limit) {
      movements = movements.slice(0, limit);
    }
    
    return movements.map(movement => {
      const technician = this.users.get(movement.technicianId);
      const performedBy = this.users.get(movement.performedBy);
      
      return {
        ...movement,
        technicianName: technician?.fullName || "غير محدد",
        performedByName: performedBy?.fullName || "غير محدد",
        itemNameAr: movement.itemType,
      };
    });
  }

  async transferStock(params: {
    technicianId: string;
    itemType: string;
    packagingType: string;
    quantity: number;
    fromInventory: string;
    toInventory: string;
    performedBy: string;
    reason?: string;
    notes?: string;
  }): Promise<{ movement: StockMovement; updatedInventory: TechnicianFixedInventory }> {
    const movement = await this.createStockMovement({
      technicianId: params.technicianId,
      itemType: params.itemType,
      packagingType: params.packagingType,
      quantity: params.quantity,
      fromInventory: params.fromInventory,
      toInventory: params.toInventory,
      performedBy: params.performedBy,
      reason: params.reason,
      notes: params.notes,
    });
    
    let inventory = await this.getTechnicianFixedInventory(params.technicianId);
    
    if (!inventory) {
      inventory = await this.createTechnicianFixedInventory({
        technicianId: params.technicianId,
      });
    }
    
    return { movement, updatedInventory: inventory };
  }

  async getWarehouses(): Promise<WarehouseWithStats[]> {
    return [];
  }

  async getWarehousesByRegion(regionId: string): Promise<WarehouseWithStats[]> {
    return [];
  }

  async getWarehouse(id: string): Promise<WarehouseWithInventory | undefined> {
    return undefined;
  }

  async createWarehouse(warehouse: InsertWarehouse, createdBy: string): Promise<Warehouse> {
    const id = randomUUID();
    const newWarehouse: Warehouse = {
      id,
      name: warehouse.name,
      location: warehouse.location,
      description: warehouse.description ?? null,
      isActive: warehouse.isActive ?? true,
      createdBy,
      regionId: warehouse.regionId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return newWarehouse;
  }

  async updateWarehouse(id: string, updates: Partial<InsertWarehouse>): Promise<Warehouse> {
    throw new Error("MemStorage does not support warehouse operations. Use DatabaseStorage instead.");
  }

  async deleteWarehouse(id: string): Promise<boolean> {
    return false;
  }

  async getWarehouseInventory(warehouseId: string): Promise<WarehouseInventory | undefined> {
    return undefined;
  }

  async updateWarehouseInventory(warehouseId: string, updates: Partial<InsertWarehouseInventory>): Promise<WarehouseInventory> {
    throw new Error("MemStorage does not support warehouse operations. Use DatabaseStorage instead.");
  }

  async transferFromWarehouse(data: InsertWarehouseTransfer): Promise<WarehouseTransfer> {
    throw new Error("MemStorage does not support warehouse operations. Use DatabaseStorage instead.");
  }

  async getWarehouseTransfers(warehouseId?: string, technicianId?: string, regionId?: string, limit?: number): Promise<WarehouseTransferWithDetails[]> {
    return [];
  }

  async acceptWarehouseTransfer(transferId: string): Promise<WarehouseTransfer> {
    throw new Error("MemStorage does not support warehouse operations. Use DatabaseStorage instead.");
  }

  async rejectWarehouseTransfer(transferId: string, reason?: string): Promise<WarehouseTransfer> {
    throw new Error("MemStorage does not support warehouse operations. Use DatabaseStorage instead.");
  }

  async assignTechnicianToSupervisor(supervisorId: string, technicianId: string): Promise<SupervisorTechnician> {
    throw new Error("MemStorage does not support supervisor operations. Use DatabaseStorage instead.");
  }

  async removeTechnicianFromSupervisor(supervisorId: string, technicianId: string): Promise<boolean> {
    return false;
  }

  async getSupervisorTechnicians(supervisorId: string): Promise<string[]> {
    return [];
  }

  async assignWarehouseToSupervisor(supervisorId: string, warehouseId: string): Promise<SupervisorWarehouse> {
    throw new Error("MemStorage does not support supervisor operations. Use DatabaseStorage instead.");
  }

  async removeWarehouseFromSupervisor(supervisorId: string, warehouseId: string): Promise<boolean> {
    return false;
  }

  async getSupervisorWarehouses(supervisorId: string): Promise<string[]> {
    return [];
  }

  async getTechnicianSupervisor(technicianId: string): Promise<string | null> {
    return null;
  }

  async getSystemLogs(filters: {
    limit?: number;
    offset?: number;
    userId?: string;
    regionId?: string;
    action?: string;
    entityType?: string;
    entityId?: string;
    severity?: string;
  }): Promise<SystemLog[]> {
    return [];
  }

  async createSystemLog(log: InsertSystemLog): Promise<SystemLog> {
    throw new Error("MemStorage does not support system log operations. Use DatabaseStorage instead.");
  }

  async getItemTypes(): Promise<ItemType[]> {
    throw new Error("MemStorage does not support item type operations. Use DatabaseStorage instead.");
  }

  async getActiveItemTypes(): Promise<ItemType[]> {
    throw new Error("MemStorage does not support item type operations. Use DatabaseStorage instead.");
  }

  async getItemTypeById(id: string): Promise<ItemType | undefined> {
    throw new Error("MemStorage does not support item type operations. Use DatabaseStorage instead.");
  }

  async createItemType(data: InsertItemType): Promise<ItemType> {
    throw new Error("MemStorage does not support item type operations. Use DatabaseStorage instead.");
  }

  async updateItemType(id: string, data: Partial<InsertItemType>): Promise<ItemType | undefined> {
    throw new Error("MemStorage does not support item type operations. Use DatabaseStorage instead.");
  }

  async deleteItemType(id: string): Promise<boolean> {
    throw new Error("MemStorage does not support item type operations. Use DatabaseStorage instead.");
  }

  async toggleItemTypeActive(id: string, isActive: boolean): Promise<ItemType | undefined> {
    throw new Error("MemStorage does not support item type operations. Use DatabaseStorage instead.");
  }

  async toggleItemTypeVisibility(id: string, isVisible: boolean): Promise<ItemType | undefined> {
    throw new Error("MemStorage does not support item type operations. Use DatabaseStorage instead.");
  }

  async seedDefaultItemTypes(): Promise<void> {
    throw new Error("MemStorage does not support item type operations. Use DatabaseStorage instead.");
  }

  async getWarehouseInventoryEntries(warehouseId: string): Promise<WarehouseInventoryEntry[]> {
    throw new Error("MemStorage does not support dynamic inventory entries. Use DatabaseStorage instead.");
  }

  async upsertWarehouseInventoryEntry(warehouseId: string, itemTypeId: string, boxes: number, units: number): Promise<WarehouseInventoryEntry> {
    throw new Error("MemStorage does not support dynamic inventory entries. Use DatabaseStorage instead.");
  }

  async getTechnicianFixedInventoryEntries(technicianId: string): Promise<TechnicianFixedInventoryEntry[]> {
    throw new Error("MemStorage does not support dynamic inventory entries. Use DatabaseStorage instead.");
  }

  async upsertTechnicianFixedInventoryEntry(technicianId: string, itemTypeId: string, boxes: number, units: number): Promise<TechnicianFixedInventoryEntry> {
    throw new Error("MemStorage does not support dynamic inventory entries. Use DatabaseStorage instead.");
  }

  async getTechnicianMovingInventoryEntries(technicianId: string): Promise<TechnicianMovingInventoryEntry[]> {
    throw new Error("MemStorage does not support dynamic inventory entries. Use DatabaseStorage instead.");
  }

  async upsertTechnicianMovingInventoryEntry(technicianId: string, itemTypeId: string, boxes: number, units: number): Promise<TechnicianMovingInventoryEntry> {
    throw new Error("MemStorage does not support dynamic inventory entries. Use DatabaseStorage instead.");
  }

  async migrateToInventoryEntries(): Promise<void> {
    throw new Error("MemStorage does not support migration. Use DatabaseStorage instead.");
  }
}
