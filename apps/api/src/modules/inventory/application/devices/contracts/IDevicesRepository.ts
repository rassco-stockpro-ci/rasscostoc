import type {
  WithdrawnDevice,
  ReceivedDevice,
  InsertWithdrawnDevice,
  InsertReceivedDevice
} from "@shared/schema";

export interface IDevicesRepository {
  hasItemTypeColumn(): Promise<boolean>;
  getWithdrawnDevices(): Promise<any[]>;
  getReceivedDevicesForWithdrawnList(): Promise<any[]>;
  getWithdrawnDevicesByRegion(regionId: string): Promise<any[]>;
  getReceivedDevicesForWithdrawnListByRegion(regionId: string): Promise<any[]>;
  getWithdrawnDevice(id: string): Promise<any | undefined>;
  getReceivedDevice(id: string): Promise<any | undefined>;
  createWithdrawnDevice(data: InsertWithdrawnDevice): Promise<WithdrawnDevice>;
  updateWithdrawnDevice(id: string, updates: Partial<InsertWithdrawnDevice>): Promise<WithdrawnDevice>;
  deleteWithdrawnDevice(id: string): Promise<boolean>;
  deleteReceivedDevice(id: string): Promise<boolean>;
  getReceivedDevices(filters?: { 
    status?: string; 
    technicianId?: string; 
    supervisorId?: string; 
    regionId?: string 
  }): Promise<ReceivedDevice[]>;
  createReceivedDevice(data: InsertReceivedDevice): Promise<ReceivedDevice>;
  updateReceivedDevice(id: string, updates: Partial<InsertReceivedDevice>): Promise<ReceivedDevice>;
  updateReceivedDeviceStatus(
    id: string,
    status: string,
    approvedBy: string,
    adminNotes?: string,
    existingDevice?: any
  ): Promise<ReceivedDevice>;
  getPendingReceivedDevicesCount(supervisorId?: string, regionId?: string | null): Promise<number>;
  getDevicesSummaryByRegion(regionId: string): Promise<any>;
  getDevicesByTechnician(technicianId: string): Promise<{ withdrawn: any[]; received: any[] }>;
  getPendingDevicesForApproval(supervisorId?: string): Promise<any[]>;
  approveDevicesBatch(deviceIds: string[], approvedBy: string, type: 'withdrawn' | 'received'): Promise<any>;
  rejectDevicesBatch(deviceIds: string[], approvedBy: string, adminNotes: string, type: 'withdrawn' | 'received'): Promise<any>;
  deliverDeviceByBarcode(technicianId: string, barcode: string): Promise<ReceivedDevice>;
  /**
   * OPS-REMED-E3: optional externally-supplied Drizzle transaction so this
   * batch write can join an existing request-wide transaction owned by the
   * courier deduction path. When omitted, opens its own transaction
   * (unchanged legacy behavior for the standalone
   * /api/technicians/deduct-inventory HTTP endpoint).
   */
  deductTechnicianInventory(data: {
    technicianCode: string;
    devices: { serialNumber: string; model?: string }[];
    notes?: string;
    actor: { id: string; username: string; role: string; regionId: string | null };
  }, externalTx?: any): Promise<any[]>;

  /**
   * Consumables delivered on a courier close: moving inventory first, then
   * fixed, opening sealed boxes as needed. Throws code
   * DEDUCT_INSUFFICIENT_STOCK when the total cannot cover a quantity.
   */
  deductTechnicianConsumables(data: {
    technicianId: string;
    items: { itemTypeId: string; quantity: number }[];
    actorId: string;
    notes: string;
  }, externalTx?: any): Promise<void>;
}
