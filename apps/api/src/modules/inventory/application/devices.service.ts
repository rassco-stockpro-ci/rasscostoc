import { 
  type WithdrawnDevice,
  type ReceivedDevice,
  type InsertWithdrawnDevice,
  type InsertReceivedDevice
} from "@shared/schema";
import type { IDevicesRepository } from "./devices/contracts/IDevicesRepository";

/**
 * Devices Management Service
 * Handles withdrawn and received devices operations
 */
export class DevicesService {
  constructor(
    private readonly devicesRepository: IDevicesRepository
  ) {}

  private async hasItemTypeColumn(): Promise<boolean> {
    return this.devicesRepository.hasItemTypeColumn();
  }

  /**
   * Get all withdrawn and received devices combined
   */
  async getWithdrawnDevices(): Promise<any[]> {
    const withdrawnList = await this.devicesRepository.getWithdrawnDevices();
    const receivedList = await this.devicesRepository.getReceivedDevicesForWithdrawnList();

    const formattedReceivedList = receivedList.map(device => ({
      ...device,
      city: device.city || "غير محدد",
      technicianName: device.technicianName || "غير محدد",
      terminalId: device.terminalId || "غير محدد",
      battery: device.battery ? "جيدة" : "سيئة",
      chargerCable: device.chargerCable ? "موجود" : "غير موجود",
      chargerHead: device.chargerHead ? "موجود" : "غير موجود",
      hasSim: device.hasSim ? "نعم" : "لا",
    }));

    const combined = [...withdrawnList, ...formattedReceivedList];

    return combined.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  /**
   * Get all withdrawn and received devices combined by region
   */
  async getWithdrawnDevicesByRegion(regionId: string): Promise<any[]> {
    const withdrawnList = await this.devicesRepository.getWithdrawnDevicesByRegion(regionId);
    const receivedList = await this.devicesRepository.getReceivedDevicesForWithdrawnListByRegion(regionId);

    const formattedReceivedList = receivedList.map(device => ({
      ...device,
      city: device.city || "غير محدد",
      technicianName: device.technicianName || "غير محدد",
      terminalId: device.terminalId || "غير محدد",
      battery: device.battery ? "جيدة" : "سيئة",
      chargerCable: device.chargerCable ? "موجود" : "غير موجود",
      chargerHead: device.chargerHead ? "موجود" : "غير موجود",
      hasSim: device.hasSim ? "نعم" : "لا",
    }));

    const combined = [...withdrawnList, ...formattedReceivedList];

    return combined.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  /**
   * Get single withdrawn or received device details
   */
  async getWithdrawnDevice(id: string): Promise<any | undefined> {
    return this.devicesRepository.getWithdrawnDevice(id);
  }

  /**
   * Create withdrawn device
   */
  async createWithdrawnDevice(data: InsertWithdrawnDevice): Promise<WithdrawnDevice> {
    return this.devicesRepository.createWithdrawnDevice(data);
  }

  /**
   * Update withdrawn device
   */
  async updateWithdrawnDevice(id: string, updates: Partial<InsertWithdrawnDevice>): Promise<WithdrawnDevice> {
    return this.devicesRepository.updateWithdrawnDevice(id, updates);
  }

  /**
   * Delete withdrawn device
   */
  async deleteWithdrawnDevice(id: string): Promise<boolean> {
    return this.devicesRepository.deleteWithdrawnDevice(id);
  }

  /**
   * Get received devices list based on filters
   */
  async getReceivedDevices(filters?: { 
    status?: string; 
    technicianId?: string; 
    supervisorId?: string; 
    regionId?: string 
  }): Promise<ReceivedDevice[]> {
    return this.devicesRepository.getReceivedDevices(filters);
  }

  /**
   * Get single received device
   */
  async getReceivedDevice(id: string): Promise<ReceivedDevice | undefined> {
    return this.devicesRepository.getReceivedDevice(id);
  }

  /**
   * Create received device (returns pending receipt)
   */
  async createReceivedDevice(data: InsertReceivedDevice): Promise<ReceivedDevice> {
    return this.devicesRepository.createReceivedDevice(data);
  }

  /**
   * Update received device
   */
  async updateReceivedDevice(id: string, updates: Partial<InsertReceivedDevice>): Promise<ReceivedDevice> {
    return this.devicesRepository.updateReceivedDevice(id, updates);
  }

  /**
   * Update received device status
   */
  async updateReceivedDeviceStatus(
    id: string, 
    status: string, 
    approvedBy: string, 
    adminNotes?: string
  ): Promise<ReceivedDevice> {
    const existingDevice = await this.getReceivedDevice(id);
    if (!existingDevice) {
      throw new Error("Received device not found");
    }
    return this.devicesRepository.updateReceivedDeviceStatus(
      id,
      status,
      approvedBy,
      adminNotes,
      existingDevice
    );
  }

  /**
   * Delete received device
   */
  async deleteReceivedDevice(id: string): Promise<boolean> {
    return this.devicesRepository.deleteReceivedDevice(id);
  }

  /**
   * Count pending received devices
   */
  async getPendingReceivedDevicesCount(
    supervisorId?: string,
    regionId?: string | null,
  ): Promise<number> {
    return this.devicesRepository.getPendingReceivedDevicesCount(supervisorId, regionId);
  }

  /**
   * Get devices summary by region
   */
  async getDevicesSummaryByRegion(regionId: string) {
    return this.devicesRepository.getDevicesSummaryByRegion(regionId);
  }

  /**
   * Get devices by technician
   */
  async getDevicesByTechnician(technicianId: string) {
    return this.devicesRepository.getDevicesByTechnician(technicianId);
  }

  /**
   * Get pending devices for approval
   */
  async getPendingDevicesForApproval(supervisorId?: string) {
    return this.devicesRepository.getPendingDevicesForApproval(supervisorId);
  }

  /**
   * Approve multiple devices
   */
  async approveDevicesBatch(deviceIds: string[], approvedBy: string, type: 'withdrawn' | 'received') {
    return this.devicesRepository.approveDevicesBatch(deviceIds, approvedBy, type);
  }

  /**
   * Reject multiple devices
   */
  async rejectDevicesBatch(deviceIds: string[], approvedBy: string, adminNotes: string, type: 'withdrawn' | 'received') {
    return this.devicesRepository.rejectDevicesBatch(deviceIds, approvedBy, adminNotes, type);
  }

  /**
   * Deliver device by barcode (called by technician)
   */
  async deliverDeviceByBarcode(technicianId: string, barcode: string): Promise<ReceivedDevice> {
    return this.devicesRepository.deliverDeviceByBarcode(technicianId, barcode);
  }

  /**
   * Deduct devices from technician's inventory batch
   */
  async deductTechnicianInventory(data: {
    technicianCode: string;
    devices: { serialNumber: string; model?: string }[];
    notes?: string;
    actor: { id: string; username: string; role: string; regionId: string | null };
  }, externalTx?: any): Promise<any[]> {
    return this.devicesRepository.deductTechnicianInventory(data, externalTx);
  }

  /**
   * Deduct consumables delivered on a courier close (moving first, then fixed)
   */
  async deductTechnicianConsumables(data: {
    technicianId: string;
    items: { itemTypeId: string; quantity: number }[];
    actorId: string;
    notes: string;
  }, externalTx?: any): Promise<void> {
    return this.devicesRepository.deductTechnicianConsumables(data, externalTx);
  }
}