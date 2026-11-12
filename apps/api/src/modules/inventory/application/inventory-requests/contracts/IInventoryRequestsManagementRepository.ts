import type { InventoryRequest } from "@shared/schema";

export type UpdateInventoryRequestStatusInput = {
  id: string;
  status: string;
  respondedBy: string;
  adminNotes?: string;
};

export type InventoryRequestScope = {
  technicianId: string;
  technicianRegionId: string | null;
};

export interface IInventoryRequestsManagementRepository {
  updateStatus(input: UpdateInventoryRequestStatusInput): Promise<InventoryRequest>;
  deleteById(id: string): Promise<boolean>;
  getRequestScope(id: string): Promise<InventoryRequestScope | undefined>;
}
