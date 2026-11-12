import type { InventoryRequest } from "@shared/schema";
import type {
  IInventoryRequestsManagementRepository,
  UpdateInventoryRequestStatusInput,
} from '../contracts/IInventoryRequestsManagementRepository';

const VALID_STATUSES = ['approved', 'rejected'];

export class InventoryRequestsManagementUseCaseError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'InventoryRequestsManagementUseCaseError';
  }
}

export class InventoryRequestsManagementUseCase {
  constructor(private readonly repository: IInventoryRequestsManagementRepository) {}

  /**
   * Same scope model as ApproveInventoryRequestUseCase: admin, or a supervisor
   * whose region matches the request's technician. Everyone else is denied.
   */
  async assertCanUpdateStatus(id: string, actor: { role: string; regionId: string | null }): Promise<void> {
    if (actor.role !== 'admin' && actor.role !== 'supervisor') {
      throw new InventoryRequestsManagementUseCaseError(403, 'غير مصرح لك بمعالجة طلبات المخزون');
    }

    const scope = await this.repository.getRequestScope(id);
    if (!scope) {
      throw new InventoryRequestsManagementUseCaseError(404, 'Inventory request not found');
    }

    if (actor.role === 'supervisor' && (!actor.regionId || scope.technicianRegionId !== actor.regionId)) {
      throw new InventoryRequestsManagementUseCaseError(403, 'لا يمكنك معالجة طلبات من خارج منطقتك');
    }
  }

  async updateStatus(input: UpdateInventoryRequestStatusInput): Promise<InventoryRequest> {
    if (!VALID_STATUSES.includes(input.status)) {
      throw new InventoryRequestsManagementUseCaseError(
        400,
        "Invalid status. Must be 'approved' or 'rejected'"
      );
    }

    try {
      return await this.repository.updateStatus(input);
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        throw new InventoryRequestsManagementUseCaseError(404, 'Inventory request not found');
      }

      throw error;
    }
  }

  async deleteRequest(id: string): Promise<void> {
    const deleted = await this.repository.deleteById(id);
    if (!deleted) {
      throw new InventoryRequestsManagementUseCaseError(404, 'Inventory request not found');
    }
  }
}
